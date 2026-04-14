//! Self-update module for the Montr client.
//!
//! On startup, checks a manifest hosted on DigitalOcean Spaces for a newer build.
//! If found, downloads the binary, verifies its checksum, replaces
//! the current executable, and signals the caller to restart.

use crate::error::Result;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Build commit SHA embedded at compile time by build.rs
pub const BUILD_SHA: &str = env!("BUILD_SHA");

/// Update manifest URL hosted on DigitalOcean Spaces
const MANIFEST_URL: &str = "https://montr-media.sfo3.digitaloceanspaces.com/releases/latest.json";

/// Staging path for updates on Linux (writable by the montr user via systemd ReadWritePaths)
const STAGING_DIR: &str = "/var/cache/montr-client";

/// How the update should be applied
enum UpdateStrategy {
    /// Client can write to binary dir — replace in-place, caller restarts via execvp (macOS)
    DirectReplace { temp_path: PathBuf },
    /// Client cannot write to binary dir — stage for systemd to apply (Linux)
    Stage { staging_path: PathBuf },
}

/// Determine whether we can replace the binary directly or must stage for systemd.
fn determine_strategy(current_exe: &Path) -> UpdateStrategy {
    let parent = current_exe.parent().unwrap_or(Path::new("/"));
    let probe = parent.join(".montr-update-probe");

    // Try to create a temp file in the binary's directory
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            UpdateStrategy::DirectReplace {
                temp_path: current_exe.with_extension("new"),
            }
        }
        Err(_) => {
            let staging_path = PathBuf::from(STAGING_DIR).join("montr-client.staged");
            UpdateStrategy::Stage { staging_path }
        }
    }
}

/// Returns the platform-specific binary asset name
fn binary_asset_name() -> &'static str {
    if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        "montr-client-darwin-arm64"
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "x86_64") {
        "montr-client-darwin-amd64"
    } else if cfg!(target_arch = "aarch64") {
        "montr-client-linux-arm64"
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

    // Determine current executable and update strategy
    let current_exe =
        std::env::current_exe().map_err(|e| crate::error::MontrError::FileAccess {
            path: std::path::PathBuf::from("current_exe"),
            source: e,
        })?;
    let strategy = determine_strategy(&current_exe);

    // Resolve the expected checksum early so we can check for an already-staged file
    let checksum_key = format!("{}.sha256", asset_name);
    let expected_hash = if let Some(checksum_url) = manifest.assets.get(&checksum_key) {
        let checksum_text = client
            .get(checksum_url)
            .send()
            .await
            .map_err(|e| crate::error::MontrError::HttpRequest(e.to_string()))?
            .text()
            .await
            .map_err(|e| crate::error::MontrError::HttpRequest(e.to_string()))?;
        let hash = checksum_text
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_string();
        Some(hash)
    } else {
        tracing::warn!("No checksum in manifest, skipping verification");
        None
    };

    match strategy {
        UpdateStrategy::DirectReplace { ref temp_path } => {
            // macOS / direct-write path: download next to binary, replace, caller restarts
            tracing::info!("Downloading update from Spaces...");
            download_file(&client, binary_url, temp_path).await?;

            if let Some(ref expected) = expected_hash {
                let actual = file_sha256(temp_path).await?;
                if actual != *expected {
                    let _ = tokio::fs::remove_file(temp_path).await;
                    tracing::error!("Checksum mismatch: expected {}, got {}", expected, actual);
                    return Ok(false);
                }
                tracing::info!("Checksum verified");
            }

            replace_binary(temp_path, &current_exe)?;
            tracing::info!("Update applied successfully");
            Ok(true)
        }
        UpdateStrategy::Stage { ref staging_path } => {
            // Linux / systemd path: stage to cache dir, path unit handles the rest

            // If already staged with the correct checksum, skip re-download
            if staging_path.exists() {
                if let Some(ref expected) = expected_hash {
                    if let Ok(existing_hash) = file_sha256(staging_path).await {
                        if existing_hash == *expected {
                            tracing::info!(
                                "Update already staged at {}, waiting for systemd to apply",
                                staging_path.display()
                            );
                            return Ok(false);
                        }
                    }
                }
            }

            // Download to a temp file first, then atomically rename
            let tmp_download = staging_path.with_extension("tmp");
            tracing::info!("Downloading update from Spaces (staging)...");
            download_file(&client, binary_url, &tmp_download).await?;

            if let Some(ref expected) = expected_hash {
                let actual = file_sha256(&tmp_download).await?;
                if actual != *expected {
                    let _ = tokio::fs::remove_file(&tmp_download).await;
                    tracing::error!("Checksum mismatch: expected {}, got {}", expected, actual);
                    return Ok(false);
                }
                tracing::info!("Checksum verified");
            }

            // Set executable permissions before staging
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ =
                    std::fs::set_permissions(&tmp_download, std::fs::Permissions::from_mode(0o755));
            }

            // Atomic rename so the systemd path unit only sees a complete file
            std::fs::rename(&tmp_download, staging_path).map_err(|e| {
                crate::error::MontrError::FileAccess {
                    path: staging_path.to_path_buf(),
                    source: e,
                }
            })?;

            tracing::info!(
                "Update staged at {}, systemd will apply and restart",
                staging_path.display()
            );
            Ok(false)
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn determine_strategy_direct_replace_when_parent_writable() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_exe = tmp.path().join("montr-client");
        std::fs::write(&fake_exe, b"").unwrap();

        match determine_strategy(&fake_exe) {
            UpdateStrategy::DirectReplace { temp_path } => {
                assert_eq!(temp_path, fake_exe.with_extension("new"));
            }
            UpdateStrategy::Stage { .. } => {
                panic!("expected DirectReplace when parent dir is writable");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn determine_strategy_stages_when_parent_unwritable() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let fake_exe = tmp.path().join("montr-client");
        std::fs::write(&fake_exe, b"").unwrap();

        // Make parent dir read+execute only. Note: this check is bypassed when
        // running as root (CAP_DAC_OVERRIDE), so this test is skipped in that
        // case to avoid a spurious failure in CI containers.
        std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o555)).unwrap();
        let probe_writable = std::fs::File::create(tmp.path().join(".root-check")).is_ok();
        if probe_writable {
            // Running as root — chmod doesn't restrict us. Restore and skip.
            std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
            eprintln!("skipping: running as root, chmod 0o555 is advisory");
            return;
        }

        let result = determine_strategy(&fake_exe);

        // Restore permissions so TempDir can clean up
        std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o755)).unwrap();

        match result {
            UpdateStrategy::Stage { staging_path } => {
                assert!(staging_path.ends_with("montr-client.staged"));
                assert!(staging_path.starts_with(STAGING_DIR));
            }
            UpdateStrategy::DirectReplace { .. } => {
                panic!("expected Stage when parent dir is unwritable");
            }
        }
    }
}
