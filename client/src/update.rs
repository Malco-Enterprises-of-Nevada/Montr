//! Self-update module for the Montr client.
//!
//! On startup, checks a manifest hosted on DigitalOcean Spaces for a newer build.
//! If found, downloads the binary, verifies its checksum, replaces
//! the current executable, and signals the caller to restart.

use crate::error::Result;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;

/// Build commit SHA embedded at compile time by build.rs
pub const BUILD_SHA: &str = env!("BUILD_SHA");

/// Update manifest URL hosted on DigitalOcean Spaces
const MANIFEST_URL: &str = "https://montr-media.sfo3.digitaloceanspaces.com/releases/latest.json";

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

/// Update manifest from Spaces
#[derive(Debug, serde::Deserialize)]
struct UpdateManifest {
    #[allow(dead_code)]
    version: String,
    commit: String,
    assets: HashMap<String, String>,
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

    // Fetch update manifest from Spaces
    let response = client
        .get(MANIFEST_URL)
        .send()
        .await
        .map_err(|e| crate::error::MontrError::HttpRequest(e.to_string()))?;

    if !response.status().is_success() {
        tracing::info!(
            "Update manifest returned {}, skipping update",
            response.status()
        );
        return Ok(false);
    }

    let manifest: UpdateManifest = response
        .json()
        .await
        .map_err(|e| crate::error::MontrError::HttpRequest(e.to_string()))?;

    if manifest.commit.is_empty() {
        tracing::info!("Manifest has no commit SHA, skipping update");
        return Ok(false);
    }

    if manifest.commit == BUILD_SHA {
        tracing::info!(
            "Already up to date (build {})",
            &BUILD_SHA[..8.min(BUILD_SHA.len())]
        );
        return Ok(false);
    }

    tracing::info!(
        "Update available: {} -> {} ({})",
        &BUILD_SHA[..8.min(BUILD_SHA.len())],
        &manifest.commit[..8.min(manifest.commit.len())],
        manifest.version,
    );

    // Find binary URL for this platform
    let asset_name = binary_asset_name();
    let binary_url = match manifest.assets.get(asset_name) {
        Some(url) => url,
        None => {
            tracing::warn!(
                "Binary '{}' not found in manifest (available: {:?})",
                asset_name,
                manifest.assets.keys().collect::<Vec<_>>()
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

    tracing::info!("Downloading update from Spaces...");
    download_file(&client, binary_url, &temp_path).await?;

    // Verify checksum if available
    let checksum_key = format!("{}.sha256", asset_name);
    if let Some(checksum_url) = manifest.assets.get(&checksum_key) {
        let checksum_text = client
            .get(checksum_url)
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
        tracing::warn!("No checksum in manifest, skipping verification");
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
