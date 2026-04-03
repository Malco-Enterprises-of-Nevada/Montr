//! Self-update module for the Montr client.
//!
//! On startup, checks the GitHub Releases API for a newer build.
//! If found, downloads the binary, verifies its checksum, replaces
//! the current executable, and signals the caller to restart.

use crate::error::Result;
use sha2::{Digest, Sha256};
use std::path::Path;

/// Build commit SHA embedded at compile time by build.rs
pub const BUILD_SHA: &str = env!("BUILD_SHA");

/// GitHub Releases API URL for the most recent published release
const RELEASE_URL: &str =
    "https://api.github.com/repos/Malco-Enterprises-of-Nevada/Montr/releases/latest";

/// Returns the platform-specific binary asset name
fn binary_asset_name() -> &'static str {
    if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        "montr-client-darwin-arm64"
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "x86_64") {
        "montr-client-darwin-amd64"
    } else {
        "montr-client-linux-amd64"
    }
}

/// Returns the platform-specific checksum asset name
fn checksum_asset_name() -> &'static str {
    if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        "montr-client-darwin-arm64.sha256"
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "x86_64") {
        "montr-client-darwin-amd64.sha256"
    } else {
        "montr-client-linux-amd64.sha256"
    }
}

#[derive(Debug, serde::Deserialize)]
struct GitHubRelease {
    body: Option<String>,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, serde::Deserialize)]
struct GitHubAsset {
    name: String,
    browser_download_url: String,
}

/// Check for updates and apply if available.
///
/// Returns `Ok(true)` if an update was applied and the process should restart.
/// Returns `Ok(false)` if no update is needed.
/// Errors are non-fatal — the caller should log and continue.
pub async fn check_and_update(auto_update: bool) -> Result<bool> {
    if !auto_update {
        tracing::debug!("Auto-update disabled");
        return Ok(false);
    }

    if BUILD_SHA == "unknown" {
        tracing::debug!("Build SHA unknown (dev build), skipping update check");
        return Ok(false);
    }

    tracing::info!(
        "Checking for updates (current build: {})",
        &BUILD_SHA[..8.min(BUILD_SHA.len())]
    );

    let client = reqwest::Client::builder()
        .user_agent(format!("montr-client/{}", crate::VERSION))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| crate::error::MontrError::HttpRequest(e.to_string()))?;

    // Fetch latest release metadata
    let response = client
        .get(RELEASE_URL)
        .header("Accept", "application/vnd.github.v3+json")
        .send()
        .await
        .map_err(|e| crate::error::MontrError::HttpRequest(e.to_string()))?;

    if !response.status().is_success() {
        tracing::debug!("GitHub API returned {}, skipping update", response.status());
        return Ok(false);
    }

    let release: GitHubRelease = response
        .json()
        .await
        .map_err(|e| crate::error::MontrError::HttpRequest(e.to_string()))?;

    // Extract commit SHA from release body (format: "Automated build from commit <sha>")
    let remote_sha = release
        .body
        .as_deref()
        .and_then(|body| {
            body.lines()
                .find(|line| line.starts_with("Automated build from commit "))
                .map(|line| {
                    line.trim_start_matches("Automated build from commit ")
                        .trim()
                })
        })
        .unwrap_or("");

    if remote_sha.is_empty() {
        tracing::info!("Could not parse commit SHA from release body, skipping update");
        return Ok(false);
    }

    if remote_sha == BUILD_SHA {
        tracing::info!(
            "Already up to date (build {})",
            &BUILD_SHA[..8.min(BUILD_SHA.len())]
        );
        return Ok(false);
    }

    tracing::info!(
        "Update available: {} -> {}",
        &BUILD_SHA[..8.min(BUILD_SHA.len())],
        &remote_sha[..8.min(remote_sha.len())]
    );

    // Find binary and checksum assets for this platform
    let binary_asset = release
        .assets
        .iter()
        .find(|a| a.name == binary_asset_name());
    let checksum_asset = release
        .assets
        .iter()
        .find(|a| a.name == checksum_asset_name());

    let binary_asset = match binary_asset {
        Some(a) => a,
        None => {
            tracing::warn!(
                "Binary asset '{}' not found in release (available: {:?})",
                binary_asset_name(),
                release.assets.iter().map(|a| &a.name).collect::<Vec<_>>()
            );
            return Ok(false);
        }
    };

    // Download binary to temp file
    let current_exe =
        std::env::current_exe().map_err(|e| crate::error::MontrError::FileAccess {
            path: std::path::PathBuf::from("current_exe"),
            source: e,
        })?;
    let temp_path = current_exe.with_extension("new");

    tracing::info!("Downloading update...");
    download_file(&client, &binary_asset.browser_download_url, &temp_path).await?;

    // Verify checksum if available
    if let Some(checksum_asset) = checksum_asset {
        let checksum_text = client
            .get(&checksum_asset.browser_download_url)
            .send()
            .await
            .map_err(|e| crate::error::MontrError::HttpRequest(e.to_string()))?
            .text()
            .await
            .map_err(|e| crate::error::MontrError::HttpRequest(e.to_string()))?;

        // sha256sum format: "<hash>  <filename>" or "<hash> <filename>"
        let expected_hash = checksum_text.split_whitespace().next().unwrap_or("");

        let actual_hash = file_sha256(&temp_path).await?;

        if actual_hash != expected_hash {
            let _ = tokio::fs::remove_file(&temp_path).await;
            tracing::error!(
                "Checksum mismatch: expected {}, got {}",
                expected_hash,
                actual_hash
            );
            return Ok(false);
        }

        tracing::info!("Checksum verified");
    } else {
        tracing::warn!("No checksum file in release, skipping verification");
    }

    // Replace current binary
    replace_binary(&temp_path, &current_exe)?;

    tracing::info!("Update applied successfully");
    Ok(true)
}

/// Download a file from a URL to a local path.
async fn download_file(client: &reqwest::Client, url: &str, dest: &Path) -> Result<()> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| crate::error::MontrError::HttpRequest(e.to_string()))?;

    if !response.status().is_success() {
        return Err(crate::error::MontrError::HttpRequest(format!(
            "Download failed with status {}",
            response.status()
        )));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| crate::error::MontrError::HttpRequest(e.to_string()))?;

    tokio::fs::write(dest, &bytes)
        .await
        .map_err(|e| crate::error::MontrError::FileAccess {
            path: dest.to_path_buf(),
            source: e,
        })?;

    Ok(())
}

/// Compute SHA-256 hash of a file.
async fn file_sha256(path: &Path) -> Result<String> {
    let data = tokio::fs::read(path)
        .await
        .map_err(|e| crate::error::MontrError::CacheRead {
            path: path.to_path_buf(),
            source: e,
        })?;

    let mut hasher = Sha256::new();
    hasher.update(&data);
    Ok(format!("{:x}", hasher.finalize()))
}

/// Replace the current executable with a new binary.
///
/// Strategy: rename current → .old, move new → current, chmod +x, delete .old.
fn replace_binary(new_path: &Path, current_path: &Path) -> Result<()> {
    let backup_path = current_path.with_extension("old");

    // Rename current -> .old
    std::fs::rename(current_path, &backup_path).map_err(|e| {
        crate::error::MontrError::FileAccess {
            path: current_path.to_path_buf(),
            source: e,
        }
    })?;

    // Move new -> current
    if let Err(e) = std::fs::rename(new_path, current_path) {
        // Restore backup on failure
        let _ = std::fs::rename(&backup_path, current_path);
        return Err(crate::error::MontrError::FileAccess {
            path: current_path.to_path_buf(),
            source: e,
        });
    }

    // Set executable permissions on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(current_path, std::fs::Permissions::from_mode(0o755));
    }

    // Clean up backup
    let _ = std::fs::remove_file(&backup_path);

    Ok(())
}
