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

/// Check whether a directory allows creation of new files by the current user.
///
/// Uses `create_new` (`O_EXCL`) so a stale probe file cannot trick us into
/// thinking the directory is writable — the previous `File::create` check was
/// fooled by leftovers because truncating an existing file needs only write
/// permission on the file itself, not on its parent.
fn is_dir_writable(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let probe = dir.join(format!(".montr-probe-{}", std::process::id()));
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Determine whether we can replace the binary directly or must stage for systemd.
fn determine_strategy(current_exe: &Path) -> UpdateStrategy {
    determine_strategy_with(current_exe, Path::new(STAGING_DIR))
}

fn determine_strategy_with(current_exe: &Path, staging_dir: &Path) -> UpdateStrategy {
    // Prefer staging when the systemd deployment's cache dir is usable. This is
    // the supported Linux path: the unprivileged montr user writes into
    // /var/cache/montr-client and a root-owned path unit promotes the binary.
    if is_dir_writable(staging_dir) {
        return UpdateStrategy::Stage {
            staging_path: staging_dir.join("montr-client.staged"),
        };
    }

    // Fall back to in-place replacement when the binary's directory is writable
    // (macOS installs and dev builds running from target/).
    let parent = current_exe.parent().unwrap_or(Path::new("/"));
    if is_dir_writable(parent) {
        return UpdateStrategy::DirectReplace {
            temp_path: current_exe.with_extension("new"),
        };
    }

    // Neither destination is writable. Route to Stage so the error message
    // points at the staging path — more actionable for operators than a
    // cryptic EACCES on /usr/bin/montr-client.new.
    UpdateStrategy::Stage {
        staging_path: staging_dir.join("montr-client.staged"),
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
    fn determine_strategy_direct_replace_when_staging_unavailable() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_exe = tmp.path().join("montr-client");
        std::fs::write(&fake_exe, b"").unwrap();
        let missing_staging = tmp.path().join("does-not-exist");

        match determine_strategy_with(&fake_exe, &missing_staging) {
            UpdateStrategy::DirectReplace { temp_path } => {
                assert_eq!(temp_path, fake_exe.with_extension("new"));
            }
            UpdateStrategy::Stage { .. } => {
                panic!("expected DirectReplace when staging dir is unavailable");
            }
        }
    }

    #[test]
    fn determine_strategy_stages_when_staging_available() {
        let tmp = tempfile::tempdir().unwrap();
        let fake_exe = tmp.path().join("montr-client");
        std::fs::write(&fake_exe, b"").unwrap();
        let staging = tmp.path().join("staging");
        std::fs::create_dir(&staging).unwrap();

        match determine_strategy_with(&fake_exe, &staging) {
            UpdateStrategy::Stage { staging_path } => {
                assert_eq!(staging_path, staging.join("montr-client.staged"));
            }
            UpdateStrategy::DirectReplace { .. } => {
                panic!("expected Stage when staging dir is writable");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn determine_strategy_stages_when_binary_dir_unwritable() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let bin_dir = tmp.path().join("bin");
        std::fs::create_dir(&bin_dir).unwrap();
        let fake_exe = bin_dir.join("montr-client");
        std::fs::write(&fake_exe, b"").unwrap();

        // Staging dir deliberately absent; binary dir made read-only. Under
        // these conditions the strategy should still return Stage (so the
        // eventual error points at the staging path, not /usr/bin).
        let missing_staging = tmp.path().join("does-not-exist");
        std::fs::set_permissions(&bin_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let root_check = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(bin_dir.join(".root-check"))
            .is_ok();
        if root_check {
            std::fs::set_permissions(&bin_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
            eprintln!("skipping: running as root, chmod 0o555 is advisory");
            return;
        }

        let result = determine_strategy_with(&fake_exe, &missing_staging);

        // Restore permissions so TempDir can clean up
        std::fs::set_permissions(&bin_dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        match result {
            UpdateStrategy::Stage { staging_path } => {
                assert_eq!(staging_path, missing_staging.join("montr-client.staged"));
            }
            UpdateStrategy::DirectReplace { .. } => {
                panic!("expected Stage when neither location is writable");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn is_dir_writable_rejects_read_only_dir() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("ro");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();

        let root_check = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dir.join(".root-check"))
            .is_ok();
        if root_check {
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
            eprintln!("skipping: running as root, chmod 0o555 is advisory");
            return;
        }

        let writable = is_dir_writable(&dir);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(!writable);
    }

    #[test]
    fn is_dir_writable_accepts_writable_dir() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(is_dir_writable(tmp.path()));
    }

    #[test]
    fn is_dir_writable_rejects_missing_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("does-not-exist");
        assert!(!is_dir_writable(&missing));
    }
}
