//! Playlist persistence for offline fallback.
//!
//! Snapshots the currently assigned playlist (id, items, loop flag) to a JSON
//! file next to the media cache so the client can resume the last-known
//! playlist when the server is unreachable at startup.

use crate::error::{MontrError, Result};
use crate::network::PlaylistItem;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "playlist.json";
const TMP_FILE_NAME: &str = "playlist.json.tmp";
const CURRENT_SCHEMA_VERSION: u32 = 1;

/// Persisted playlist snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PersistedPlaylist {
    pub schema_version: u32,
    pub playlist_id: u32,
    pub items: Vec<PlaylistItem>,
    pub loop_enabled: bool,
}

fn playlist_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join(FILE_NAME)
}

fn tmp_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join(TMP_FILE_NAME)
}

/// Write the current playlist to `<cache_dir>/playlist.json` atomically.
///
/// Writes to a sibling `.tmp` file, fsyncs it, and renames over the target.
/// Best-effort: callers should log and continue on error.
pub async fn save(
    cache_dir: &Path,
    playlist_id: u32,
    items: &[PlaylistItem],
    loop_enabled: bool,
) -> Result<()> {
    let snapshot = PersistedPlaylist {
        schema_version: CURRENT_SCHEMA_VERSION,
        playlist_id,
        items: items.to_vec(),
        loop_enabled,
    };

    let json = serde_json::to_vec_pretty(&snapshot)?;

    // Ensure the cache dir exists — the cache manager creates it at startup,
    // but tests may call save() directly.
    tokio::fs::create_dir_all(cache_dir)
        .await
        .map_err(|e| MontrError::CacheWrite {
            path: cache_dir.to_path_buf(),
            source: e,
        })?;

    let tmp = tmp_path(cache_dir);
    let final_path = playlist_path(cache_dir);

    {
        let mut file = tokio::fs::File::create(&tmp)
            .await
            .map_err(|e| MontrError::CacheWrite {
                path: tmp.clone(),
                source: e,
            })?;
        use tokio::io::AsyncWriteExt;
        file.write_all(&json)
            .await
            .map_err(|e| MontrError::CacheWrite {
                path: tmp.clone(),
                source: e,
            })?;
        file.flush().await.map_err(|e| MontrError::CacheWrite {
            path: tmp.clone(),
            source: e,
        })?;
        file.sync_all().await.map_err(|e| MontrError::CacheWrite {
            path: tmp.clone(),
            source: e,
        })?;
    }

    tokio::fs::rename(&tmp, &final_path)
        .await
        .map_err(|e| MontrError::CacheWrite {
            path: final_path,
            source: e,
        })?;

    Ok(())
}

/// Load the persisted playlist from `<cache_dir>/playlist.json`.
///
/// Returns `Ok(None)` when the file is missing, corrupt, or has an unknown
/// schema version — a bad cache should never block startup.
pub async fn load(cache_dir: &Path) -> Result<Option<PersistedPlaylist>> {
    let path = playlist_path(cache_dir);

    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            tracing::warn!(
                "Failed to read persisted playlist at {}: {}",
                path.display(),
                e
            );
            return Ok(None);
        }
    };

    let snapshot: PersistedPlaylist = match serde_json::from_slice(&bytes) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(
                "Persisted playlist at {} is corrupt, ignoring: {}",
                path.display(),
                e
            );
            return Ok(None);
        }
    };

    if snapshot.schema_version != CURRENT_SCHEMA_VERSION {
        tracing::info!(
            "Persisted playlist at {} has schema version {} (expected {}), ignoring",
            path.display(),
            snapshot.schema_version,
            CURRENT_SCHEMA_VERSION
        );
        return Ok(None);
    }

    Ok(Some(snapshot))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn sample_item(id: u32, media_id: u32) -> PlaylistItem {
        PlaylistItem {
            id,
            media_id,
            filename: format!("media_{}.mp4", media_id),
            download_url: format!("http://localhost:3000/api/media/{}/download", media_id),
            media_type: "video".to_string(),
            duration: Some(30.0),
            checksum: Some(format!("cksum_{}", media_id)),
            order_index: id - 1,
            image_duration: 5,
        }
    }

    #[tokio::test]
    async fn round_trip_preserves_playlist() {
        let tmp = TempDir::new().unwrap();
        let items = vec![sample_item(1, 10), sample_item(2, 20)];

        save(tmp.path(), 42, &items, true).await.unwrap();

        let loaded = load(tmp.path()).await.unwrap().unwrap();
        assert_eq!(loaded.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(loaded.playlist_id, 42);
        assert_eq!(loaded.items, items);
        assert!(loaded.loop_enabled);
    }

    #[tokio::test]
    async fn load_returns_none_when_file_missing() {
        let tmp = TempDir::new().unwrap();
        assert!(load(tmp.path()).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn load_returns_none_on_corrupt_json() {
        let tmp = TempDir::new().unwrap();
        tokio::fs::write(tmp.path().join(FILE_NAME), b"{not valid json")
            .await
            .unwrap();
        assert!(load(tmp.path()).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn load_returns_none_on_unknown_schema_version() {
        let tmp = TempDir::new().unwrap();
        let raw = serde_json::json!({
            "schema_version": 99,
            "playlist_id": 1,
            "items": [],
            "loop_enabled": false,
        });
        tokio::fs::write(
            tmp.path().join(FILE_NAME),
            serde_json::to_vec(&raw).unwrap(),
        )
        .await
        .unwrap();
        assert!(load(tmp.path()).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn save_creates_cache_dir_if_missing() {
        let tmp = TempDir::new().unwrap();
        let nested = tmp.path().join("not").join("yet").join("created");
        save(&nested, 7, &[sample_item(1, 1)], false).await.unwrap();
        assert!(load(&nested).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn save_overwrites_existing_file() {
        let tmp = TempDir::new().unwrap();
        save(tmp.path(), 1, &[sample_item(1, 10)], false)
            .await
            .unwrap();
        save(tmp.path(), 2, &[sample_item(1, 20)], true)
            .await
            .unwrap();

        let loaded = load(tmp.path()).await.unwrap().unwrap();
        assert_eq!(loaded.playlist_id, 2);
        assert_eq!(loaded.items[0].media_id, 20);
        assert!(loaded.loop_enabled);
    }
}
