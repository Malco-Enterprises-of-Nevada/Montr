//! Playlist persistence for offline fallback.
//!
//! Snapshots the currently assigned playlist (id, items, loop flag) to a JSON
//! file next to the media cache so the client can resume the last-known
//! playlist when the server is unreachable at startup.

use crate::error::{MontrError, Result};
use crate::network::{PlaylistItem, Schedule};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "playlist.json";
const TMP_FILE_NAME: &str = "playlist.json.tmp";
const PLAYLISTS_DIR: &str = "playlists";
const SCHEDULES_FILE_NAME: &str = "schedules.json";
const SCHEDULES_TMP_FILE_NAME: &str = "schedules.json.tmp";
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

// ============================================================================
// Versioned playlist storage (multiple playlists, keyed by playlist_id)
// ============================================================================
//
// The single-file `playlist.json` above only holds the most recently assigned
// playlist. For offline schedule re-evaluation we need to be able to switch
// between any playlist that's been pushed at least once, so each is stored
// in its own file under `<cache_dir>/playlists/{playlist_id}.json`. The old
// single-file format remains supported for the offline-restore grace path.

fn playlists_dir(cache_dir: &Path) -> PathBuf {
    cache_dir.join(PLAYLISTS_DIR)
}

fn versioned_path(cache_dir: &Path, playlist_id: u32) -> PathBuf {
    playlists_dir(cache_dir).join(format!("{}.json", playlist_id))
}

fn versioned_tmp_path(cache_dir: &Path, playlist_id: u32) -> PathBuf {
    playlists_dir(cache_dir).join(format!("{}.json.tmp", playlist_id))
}

/// Persist a playlist into the versioned `playlists/<id>.json` slot. Atomic
/// (write tmp → rename). Best-effort; the in-memory state stays correct on
/// disk-write failure.
pub async fn save_playlist_versioned(
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

    let dir = playlists_dir(cache_dir);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| MontrError::CacheWrite {
            path: dir.clone(),
            source: e,
        })?;

    let tmp = versioned_tmp_path(cache_dir, playlist_id);
    let final_path = versioned_path(cache_dir, playlist_id);

    {
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::File::create(&tmp)
            .await
            .map_err(|e| MontrError::CacheWrite {
                path: tmp.clone(),
                source: e,
            })?;
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

/// Load one persisted playlist by id. `Ok(None)` for missing/corrupt/unknown
/// schema — corrupt-cache should never block normal operation.
pub async fn load_playlist_versioned(
    cache_dir: &Path,
    playlist_id: u32,
) -> Result<Option<PersistedPlaylist>> {
    let path = versioned_path(cache_dir, playlist_id);
    read_persisted_playlist(&path).await
}

/// Load every persisted playlist, keyed by playlist_id. Used by the offline
/// schedule evaluator to find a target playlist for a scheduled switch.
pub async fn load_all_playlists(cache_dir: &Path) -> Result<HashMap<u32, PersistedPlaylist>> {
    let mut out = HashMap::new();
    let dir = playlists_dir(cache_dir);
    let mut entries = match tokio::fs::read_dir(&dir).await {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => {
            tracing::warn!(
                "Failed to enumerate {}: {}; treating as empty",
                dir.display(),
                e
            );
            return Ok(out);
        }
    };

    while let Some(entry) = entries.next_entry().await.map_err(MontrError::Io)? {
        let path = entry.path();
        // Skip lingering .tmp files from a partial write.
        if path
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s == "tmp")
        {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if let Some(snapshot) = read_persisted_playlist(&path).await? {
            out.insert(snapshot.playlist_id, snapshot);
        }
    }
    Ok(out)
}

async fn read_persisted_playlist(path: &Path) -> Result<Option<PersistedPlaylist>> {
    let bytes = match tokio::fs::read(path).await {
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

/// One-time migration: if the old `playlist.json` (single-snapshot) format
/// exists and there's no entry for that id under `playlists/`, copy it
/// across so historical clients keep their offline-restore working after
/// upgrade. Best-effort; never fails operations on the new format.
pub async fn migrate_legacy_playlist_if_needed(cache_dir: &Path) -> Result<()> {
    let legacy = playlist_path(cache_dir);
    if !legacy.exists() {
        return Ok(());
    }
    let Some(snapshot) = read_persisted_playlist(&legacy).await? else {
        return Ok(());
    };
    let target = versioned_path(cache_dir, snapshot.playlist_id);
    if target.exists() {
        // Already migrated previously.
        return Ok(());
    }
    save_playlist_versioned(
        cache_dir,
        snapshot.playlist_id,
        &snapshot.items,
        snapshot.loop_enabled,
    )
    .await?;
    tracing::info!(
        "Migrated legacy playlist.json (id={}) into versioned slot",
        snapshot.playlist_id
    );
    Ok(())
}

// ============================================================================
// Schedule definitions persistence
// ============================================================================

/// Persisted schedule definitions. Tagged with the same schema version as
/// playlists so we can break compatibility cleanly if needed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PersistedSchedules {
    pub schema_version: u32,
    pub schedules: Vec<Schedule>,
}

fn schedules_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join(SCHEDULES_FILE_NAME)
}

fn schedules_tmp_path(cache_dir: &Path) -> PathBuf {
    cache_dir.join(SCHEDULES_TMP_FILE_NAME)
}

/// Persist the schedule set to `<cache_dir>/schedules.json`. Atomic.
pub async fn save_schedules(cache_dir: &Path, schedules: &[Schedule]) -> Result<()> {
    let snapshot = PersistedSchedules {
        schema_version: CURRENT_SCHEMA_VERSION,
        schedules: schedules.to_vec(),
    };
    let json = serde_json::to_vec_pretty(&snapshot)?;

    tokio::fs::create_dir_all(cache_dir)
        .await
        .map_err(|e| MontrError::CacheWrite {
            path: cache_dir.to_path_buf(),
            source: e,
        })?;

    let tmp = schedules_tmp_path(cache_dir);
    let final_path = schedules_path(cache_dir);
    {
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::File::create(&tmp)
            .await
            .map_err(|e| MontrError::CacheWrite {
                path: tmp.clone(),
                source: e,
            })?;
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

/// Load the persisted schedule set. Returns `Ok(Vec::new())` for missing,
/// corrupt, or unknown-schema files.
pub async fn load_schedules(cache_dir: &Path) -> Result<Vec<Schedule>> {
    let path = schedules_path(cache_dir);
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            tracing::warn!(
                "Failed to read persisted schedules at {}: {}",
                path.display(),
                e
            );
            return Ok(Vec::new());
        }
    };
    let snapshot: PersistedSchedules = match serde_json::from_slice(&bytes) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(
                "Persisted schedules at {} is corrupt, ignoring: {}",
                path.display(),
                e
            );
            return Ok(Vec::new());
        }
    };
    if snapshot.schema_version != CURRENT_SCHEMA_VERSION {
        tracing::info!(
            "Persisted schedules at {} has schema version {} (expected {}), ignoring",
            path.display(),
            snapshot.schema_version,
            CURRENT_SCHEMA_VERSION
        );
        return Ok(Vec::new());
    }
    Ok(snapshot.schedules)
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
            subtitles: Vec::new(),
            file_size: None,
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

    fn sample_schedule(id: u32, playlist_id: u32) -> Schedule {
        Schedule {
            id,
            name: format!("schedule_{}", id),
            playlist_id,
            client_id: None,
            group_id: None,
            start_time: Some("09:00".to_string()),
            end_time: Some("17:00".to_string()),
            days_of_week: "1,2,3,4,5".to_string(),
            priority: 50,
            enabled: true,
            cron_expression: None,
            timezone: None,
            conditions: None,
            interrupt_mode: "assign".to_string(),
            duration_seconds: None,
        }
    }

    #[tokio::test]
    async fn versioned_round_trip() {
        let tmp = TempDir::new().unwrap();
        let items_a = vec![sample_item(1, 100)];
        let items_b = vec![sample_item(1, 200), sample_item(2, 201)];

        save_playlist_versioned(tmp.path(), 10, &items_a, false)
            .await
            .unwrap();
        save_playlist_versioned(tmp.path(), 20, &items_b, true)
            .await
            .unwrap();

        let a = load_playlist_versioned(tmp.path(), 10)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(a.items, items_a);
        assert!(!a.loop_enabled);

        let b = load_playlist_versioned(tmp.path(), 20)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(b.items, items_b);
        assert!(b.loop_enabled);

        let all = load_all_playlists(tmp.path()).await.unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.contains_key(&10));
        assert!(all.contains_key(&20));
    }

    #[tokio::test]
    async fn versioned_load_missing_returns_none() {
        let tmp = TempDir::new().unwrap();
        assert!(load_playlist_versioned(tmp.path(), 999)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn load_all_skips_tmp_and_corrupt() {
        let tmp = TempDir::new().unwrap();
        save_playlist_versioned(tmp.path(), 5, &[sample_item(1, 1)], false)
            .await
            .unwrap();
        // Drop a stray .tmp file (simulating an interrupted save) — must be ignored.
        tokio::fs::write(playlists_dir(tmp.path()).join("99.json.tmp"), b"")
            .await
            .unwrap();
        // And a corrupt slot — also ignored.
        tokio::fs::write(playlists_dir(tmp.path()).join("42.json"), b"not json")
            .await
            .unwrap();

        let all = load_all_playlists(tmp.path()).await.unwrap();
        assert_eq!(all.len(), 1);
        assert!(all.contains_key(&5));
    }

    #[tokio::test]
    async fn legacy_migration_copies_into_versioned_slot() {
        let tmp = TempDir::new().unwrap();
        // Write old single-file playlist.json.
        save(tmp.path(), 7, &[sample_item(1, 1)], true)
            .await
            .unwrap();
        assert!(load_playlist_versioned(tmp.path(), 7)
            .await
            .unwrap()
            .is_none());

        migrate_legacy_playlist_if_needed(tmp.path()).await.unwrap();

        let v = load_playlist_versioned(tmp.path(), 7)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(v.playlist_id, 7);
        assert!(v.loop_enabled);
    }

    #[tokio::test]
    async fn schedules_round_trip() {
        let tmp = TempDir::new().unwrap();
        let schedules = vec![sample_schedule(1, 100), sample_schedule(2, 200)];
        save_schedules(tmp.path(), &schedules).await.unwrap();
        let loaded = load_schedules(tmp.path()).await.unwrap();
        assert_eq!(loaded, schedules);
    }

    #[tokio::test]
    async fn schedules_missing_returns_empty() {
        let tmp = TempDir::new().unwrap();
        assert!(load_schedules(tmp.path()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn schedules_corrupt_returns_empty() {
        let tmp = TempDir::new().unwrap();
        tokio::fs::write(tmp.path().join(SCHEDULES_FILE_NAME), b"{nope")
            .await
            .unwrap();
        assert!(load_schedules(tmp.path()).await.unwrap().is_empty());
    }
}
