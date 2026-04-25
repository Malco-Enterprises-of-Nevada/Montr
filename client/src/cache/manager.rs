//! Cache manager for downloading and storing media files
//!
//! Manages concurrent downloads with semaphore limits, retry logic, and checksum
//! verification. Downloads are atomic (write to .tmp, rename on success).

use crate::cache::checksum;
use crate::cache::lru::LruCacheManager;
use crate::error::{MontrError, Result};
use crate::network::http::{DownloadOptions, HttpClient};
use crate::network::PlaylistItem;
use crate::state::AppState;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs;
use tokio::sync::{mpsc, Semaphore};
use tokio_util::sync::CancellationToken;

/// Maximum concurrent downloads
const MAX_CONCURRENT_DOWNLOADS: usize = 2;

/// Maximum length of the sanitized filename component, in bytes.
/// Keeps cache paths well under common filesystem limits (typically 255 bytes).
const MAX_SANITIZED_FILENAME_BYTES: usize = 200;

/// Strip directory components, control characters, and other unsafe sequences
/// from a server-supplied filename so it's safe to append to a cache path.
///
/// The cache path is `{cache_dir}/{id}_{sanitized}`, so `id` already provides
/// uniqueness — the filename is decorative and may safely be replaced with a
/// placeholder if the input is hostile (path traversal, NUL byte, absolute
/// path, etc.). This guarantees the resulting `PathBuf::file_name()` is a
/// single component contained inside `cache_dir`.
fn sanitize_filename(raw: &str) -> String {
    // Treat both `/` and `\` as separators regardless of host OS — the
    // filename comes from the server, which may run on a different platform
    // than the client. Take only the trailing segment so leading directory
    // components (and traversal segments) are dropped.
    let last = raw.rsplit(['/', '\\']).next().unwrap_or("").trim();

    // Drop NUL bytes and ASCII control chars (newlines, tabs, etc.).
    let cleaned: String = last
        .chars()
        .filter(|c| !c.is_control() && *c != '\0')
        .collect();

    let candidate = if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "file".to_string()
    } else {
        cleaned
    };

    if candidate.len() <= MAX_SANITIZED_FILENAME_BYTES {
        candidate
    } else {
        // Truncate on a UTF-8 boundary so we never produce an invalid string.
        let mut end = MAX_SANITIZED_FILENAME_BYTES;
        while end > 0 && !candidate.is_char_boundary(end) {
            end -= 1;
        }
        candidate[..end].to_string()
    }
}

/// Download progress information
#[derive(Debug, Clone)]
pub struct DownloadProgress {
    /// Media ID being downloaded
    pub media_id: u32,
    /// Total downloads in progress
    pub total_downloads: usize,
    /// Completed downloads
    pub completed_downloads: usize,
    /// Failed downloads
    pub failed_downloads: usize,
}

/// Cache manager for media downloads
pub struct CacheManager {
    /// HTTP client for downloads
    http_client: Arc<HttpClient>,
    /// Cache directory path
    cache_dir: PathBuf,
    /// Semaphore to limit concurrent downloads
    download_semaphore: Arc<Semaphore>,
    /// Cancellation token for shutdown
    cancel_token: CancellationToken,
    /// Optional API key for server authentication
    api_key: Option<String>,
    /// Optional shared application state — when set, the manager bumps
    /// `bytes_downloaded_total` after every successful download for telemetry.
    app_state: Option<AppState>,
    /// Optional LRU manager — when set, `download_media` calls
    /// `ensure_room_for(expected_bytes)` before writing, so the cache stays
    /// under its quota and the partition keeps headroom.
    lru_manager: Option<Arc<LruCacheManager>>,
}

impl CacheManager {
    /// Create a new cache manager
    pub fn new(
        http_client: Arc<HttpClient>,
        cache_dir: PathBuf,
        cancel_token: CancellationToken,
    ) -> Result<Self> {
        Ok(Self {
            http_client,
            cache_dir,
            download_semaphore: Arc::new(Semaphore::new(MAX_CONCURRENT_DOWNLOADS)),
            cancel_token,
            api_key: None,
            app_state: None,
            lru_manager: None,
        })
    }

    /// Set the API key for authenticated downloads
    pub fn with_api_key(mut self, api_key: Option<String>) -> Self {
        self.api_key = api_key;
        self
    }

    /// Wire in shared application state so the manager can update telemetry
    /// counters (e.g. cumulative bytes downloaded) after each download.
    pub fn with_app_state(mut self, state: AppState) -> Self {
        self.app_state = Some(state);
        self
    }

    /// Wire in the LRU manager so `download_media` can pre-flight cache space
    /// and partition headroom before writing.
    pub fn with_lru_manager(mut self, lru: Arc<LruCacheManager>) -> Self {
        self.lru_manager = Some(lru);
        self
    }

    /// Pin the given playlist items in the LRU so they survive eviction
    /// during long offline windows. Replaces any previously-pinned set in
    /// one atomic swap. No-op if no LRU manager is wired (test fixtures).
    pub async fn pin_playlist_items(&self, items: &[PlaylistItem]) {
        let Some(ref lru) = self.lru_manager else {
            return;
        };
        let ids: Vec<u32> = items.iter().map(|i| i.media_id).collect();
        tracing::debug!("Pinning {} playlist items in cache", ids.len());
        lru.replace_pins(ids).await;
    }

    /// Initialize cache directory
    pub async fn init(&self) -> Result<()> {
        if !self.cache_dir.exists() {
            fs::create_dir_all(&self.cache_dir).await.map_err(|e| {
                MontrError::DirectoryCreation {
                    path: self.cache_dir.clone(),
                    source: e,
                }
            })?;
        }

        tracing::info!("Cache manager initialized at {:?}", self.cache_dir);
        Ok(())
    }

    /// Get path for a media file in cache
    pub fn get_cache_path(&self, media_id: u32, filename: &str) -> PathBuf {
        self.cache_dir
            .join(format!("{}_{}", media_id, sanitize_filename(filename)))
    }

    /// Directory for cached subtitle sidecars, kept separate so file-listing
    /// over the media cache doesn't have to distinguish subtitle `.srt` / `.vtt`
    /// files from real media downloads.
    fn subtitle_dir(&self) -> PathBuf {
        self.cache_dir.join("subs")
    }

    /// Get path for a subtitle sidecar in cache. Keeping subtitle id in the
    /// filename makes the (id, filename) tuple uniquely addressable and
    /// collision-free if two subtitles happen to share an original filename.
    pub fn get_subtitle_cache_path(&self, subtitle_id: u32, filename: &str) -> PathBuf {
        self.subtitle_dir()
            .join(format!("{}_{}", subtitle_id, sanitize_filename(filename)))
    }

    /// Check if media file exists in cache
    pub async fn is_cached(&self, media_id: u32, filename: &str) -> bool {
        let path = self.get_cache_path(media_id, filename);
        path.exists()
    }

    /// Check if media file exists and has valid checksum
    pub async fn is_cached_valid(&self, media_id: u32, filename: &str, checksum: &str) -> bool {
        let path = self.get_cache_path(media_id, filename);

        if !path.exists() {
            return false;
        }

        match checksum::verify_checksum(&path, checksum).await {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!(
                    "Cached file {} failed checksum verification: {}",
                    path.display(),
                    e
                );
                false
            }
        }
    }

    /// Download a single media file
    ///
    /// Uses atomic file operations: downloads to .tmp file, then renames on success.
    /// Best-effort pre-flight via the LRU manager evicts older entries before
    /// the write so we don't blow the cache quota or the partition headroom.
    pub async fn download_media(
        &self,
        media_id: u32,
        filename: &str,
        checksum: &str,
    ) -> Result<PathBuf> {
        // Check if already cached with valid checksum
        if self.is_cached_valid(media_id, filename, checksum).await {
            tracing::debug!("Media {} already cached and valid", media_id);
            return Ok(self.get_cache_path(media_id, filename));
        }

        // Acquire semaphore permit to limit concurrent downloads
        let _permit =
            self.download_semaphore
                .acquire()
                .await
                .map_err(|_| MontrError::DownloadFailed {
                    url: format!("media/{}", media_id),
                    reason: "Failed to acquire download permit".to_string(),
                })?;

        let final_path = self.get_cache_path(media_id, filename);
        let temp_path = final_path.with_extension("tmp");

        // Best-effort pre-flight: probe Content-Length via HEAD and tell the
        // LRU manager to make room. If HEAD fails (chunked transfer, server
        // doesn't support it), we proceed without the pre-flight — the LRU
        // post-write eviction in `add()` is a safety net.
        if let Some(ref lru) = self.lru_manager {
            if let Some(expected) = self
                .http_client
                .head_media_size(media_id, self.api_key.as_deref())
                .await
            {
                lru.ensure_room_for(expected).await?;
            }
        }

        tracing::info!("Downloading media {} to {:?}", media_id, final_path);

        // Download to temporary file
        let options = DownloadOptions {
            show_progress: false, // Disable terminal progress for background downloads
            resume: true,
            timeout_secs: 300,
            max_retries: 3,
            api_key: self.api_key.clone(),
        };

        // Wrap the download+verify+rename in an inner closure so any failure
        // path can clean up the temp file before returning. Without this, a
        // partial `.tmp` would linger on disk after every failed attempt and
        // accumulate over time.
        let result: Result<()> = async {
            self.http_client
                .download_media(media_id, &temp_path, options)
                .await?;

            tracing::debug!("Verifying checksum for media {}", media_id);
            checksum::verify_checksum(&temp_path, checksum).await?;

            fs::rename(&temp_path, &final_path)
                .await
                .map_err(|e| MontrError::CacheWrite {
                    path: final_path.clone(),
                    source: e,
                })?;

            Ok(())
        }
        .await;

        if let Err(e) = result {
            // Best-effort cleanup — ignore failures (file may already be gone,
            // or the partition may be full, in which case we already errored).
            let _ = fs::remove_file(&temp_path).await;
            return Err(e);
        }

        // Best-effort telemetry: bump the cumulative downloaded-bytes counter
        // by the size of the file we just wrote. We tolerate stat failures
        // since they only affect a metric, not correctness.
        if let Some(ref state) = self.app_state {
            if let Ok(meta) = fs::metadata(&final_path).await {
                state.add_bytes_downloaded(meta.len()).await;
            }
        }

        tracing::info!("Successfully downloaded media {} to cache", media_id);
        Ok(final_path)
    }

    /// Download multiple media files concurrently
    ///
    /// Returns paths to successfully downloaded files. Failed downloads are logged
    /// but don't fail the entire operation.
    pub async fn download_batch(
        &self,
        items: Vec<PlaylistItem>,
        progress_tx: Option<mpsc::UnboundedSender<DownloadProgress>>,
    ) -> Vec<(u32, Result<PathBuf>)> {
        let total = items.len();
        let mut handles = Vec::new();
        let mut completed = 0usize;
        let mut failed = 0usize;

        tracing::info!("Starting batch download of {} items", total);

        for item in items {
            let media_id = item.media_id;
            let filename = item.filename.clone();
            let checksum = item.checksum.clone().unwrap_or_default();
            let manager = self.clone();
            let progress_tx = progress_tx.clone();
            let cancel_token = self.cancel_token.clone();
            let item_for_subs = item.clone();

            let handle = tokio::spawn(async move {
                // Check for cancellation
                if cancel_token.is_cancelled() {
                    return (
                        media_id,
                        Err(MontrError::DownloadFailed {
                            url: format!("media/{}", media_id),
                            reason: "Download cancelled".to_string(),
                        }),
                    );
                }

                let result = manager.download_media(media_id, &filename, &checksum).await;

                // Prefetch any external subtitle sidecars for this item. We don't
                // surface individual failures — the engine will simply skip
                // subtitles it can't find on disk and log.
                if result.is_ok() {
                    let _ = manager.download_subtitles_for_item(&item_for_subs).await;
                }

                // Send progress update if channel provided
                if let Some(tx) = progress_tx {
                    let _ = tx.send(DownloadProgress {
                        media_id,
                        total_downloads: 0, // Will be updated by caller
                        completed_downloads: 0,
                        failed_downloads: 0,
                    });
                }

                (media_id, result)
            });

            handles.push(handle);
        }

        // Collect results
        let mut results = Vec::new();
        for handle in handles {
            if self.cancel_token.is_cancelled() {
                break;
            }

            match handle.await {
                Ok((media_id, result)) => {
                    if result.is_ok() {
                        completed += 1;
                        tracing::debug!("Download completed: media {}", media_id);
                    } else {
                        failed += 1;
                        tracing::warn!("Download failed: media {} - {:?}", media_id, result);
                    }
                    results.push((media_id, result));
                }
                Err(e) => {
                    tracing::error!("Download task panicked: {}", e);
                    failed += 1;
                }
            }
        }

        tracing::info!(
            "Batch download complete: {}/{} successful, {} failed",
            completed,
            total,
            failed
        );

        results
    }

    /// Download and cache a subtitle sidecar by subtitle-track ID. Mirrors
    /// `download_media` but targets a separate `subs/` subdirectory so the
    /// LRU / eviction paths keyed on media IDs don't have to reason about
    /// sidecar files.
    pub async fn download_subtitle(
        &self,
        subtitle_id: u32,
        filename: &str,
        expected_checksum: Option<&str>,
    ) -> Result<PathBuf> {
        let final_path = self.get_subtitle_cache_path(subtitle_id, filename);

        // If cached and checksum still matches, short-circuit.
        if final_path.exists() {
            match expected_checksum {
                Some(cs) if !cs.is_empty() => {
                    match checksum::verify_checksum(&final_path, cs).await {
                        Ok(()) => {
                            tracing::debug!("Subtitle {} already cached and valid", subtitle_id);
                            return Ok(final_path);
                        }
                        Err(e) => {
                            tracing::warn!(
                                "Cached subtitle {} failed checksum ({}); refetching",
                                subtitle_id,
                                e
                            );
                            let _ = fs::remove_file(&final_path).await;
                        }
                    }
                }
                _ => return Ok(final_path),
            }
        }

        // Ensure subs dir exists lazily.
        let subs_dir = self.subtitle_dir();
        if !subs_dir.exists() {
            fs::create_dir_all(&subs_dir)
                .await
                .map_err(|e| MontrError::DirectoryCreation {
                    path: subs_dir.clone(),
                    source: e,
                })?;
        }

        let _permit =
            self.download_semaphore
                .acquire()
                .await
                .map_err(|_| MontrError::DownloadFailed {
                    url: format!("subtitles/{}", subtitle_id),
                    reason: "Failed to acquire download permit".to_string(),
                })?;

        let temp_path = final_path.with_extension("tmp");
        tracing::info!("Downloading subtitle {} to {:?}", subtitle_id, final_path);

        let options = DownloadOptions {
            show_progress: false,
            resume: false, // subtitles are small; keep path simple
            timeout_secs: 60,
            max_retries: 3,
            api_key: self.api_key.clone(),
        };

        self.http_client
            .download_subtitle(subtitle_id, &temp_path, options)
            .await?;

        if let Some(cs) = expected_checksum.filter(|c| !c.is_empty()) {
            checksum::verify_checksum(&temp_path, cs).await?;
        }

        fs::rename(&temp_path, &final_path)
            .await
            .map_err(|e| MontrError::CacheWrite {
                path: final_path.clone(),
                source: e,
            })?;

        tracing::info!("Cached subtitle {} at {:?}", subtitle_id, final_path);
        Ok(final_path)
    }

    /// Download every external subtitle referenced by a playlist item. Errors
    /// are logged but do not fail the batch — a missing subtitle must not
    /// prevent the main media from playing.
    pub async fn download_subtitles_for_item(
        &self,
        item: &PlaylistItem,
    ) -> Vec<(u32, Result<PathBuf>)> {
        let mut results = Vec::new();
        for sub in &item.subtitles {
            if !matches!(sub.kind, crate::network::protocol::SubtitleKind::External) {
                continue;
            }
            let filename = sub
                .filename
                .clone()
                .unwrap_or_else(|| match sub.format.as_deref() {
                    Some("vtt") => format!("{}.vtt", sub.id),
                    _ => format!("{}.srt", sub.id),
                });
            let checksum = sub.checksum.as_deref();
            let res = self.download_subtitle(sub.id, &filename, checksum).await;
            if let Err(ref e) = res {
                tracing::warn!("Failed to cache subtitle {}: {}", sub.id, e);
            }
            results.push((sub.id, res));
        }
        results
    }

    /// Remove a file from cache
    pub async fn remove(&self, media_id: u32, filename: &str) -> Result<()> {
        let path = self.get_cache_path(media_id, filename);

        if path.exists() {
            fs::remove_file(&path)
                .await
                .map_err(|e| MontrError::FileAccess {
                    path: path.clone(),
                    source: e,
                })?;

            tracing::info!("Removed {} from cache", path.display());
        }

        Ok(())
    }

    /// Get total cache size in bytes
    pub async fn get_cache_size(&self) -> Result<u64> {
        let mut total_size = 0u64;

        let mut entries =
            fs::read_dir(&self.cache_dir)
                .await
                .map_err(|e| MontrError::FileAccess {
                    path: self.cache_dir.clone(),
                    source: e,
                })?;

        while let Some(entry) = entries.next_entry().await.map_err(MontrError::Io)? {
            if let Ok(metadata) = entry.metadata().await {
                if metadata.is_file() {
                    total_size += metadata.len();
                }
            }
        }

        Ok(total_size)
    }

    /// List all cached media IDs
    pub async fn list_cached_media(&self) -> Result<Vec<u32>> {
        let mut media_ids = Vec::new();

        let mut entries =
            fs::read_dir(&self.cache_dir)
                .await
                .map_err(|e| MontrError::FileAccess {
                    path: self.cache_dir.clone(),
                    source: e,
                })?;

        while let Some(entry) = entries.next_entry().await.map_err(MontrError::Io)? {
            if let Ok(metadata) = entry.metadata().await {
                if metadata.is_file() {
                    // Parse filename format: {media_id}_{original_filename}
                    if let Some(filename) = entry.file_name().to_str() {
                        if let Some(media_id_str) = filename.split('_').next() {
                            if let Ok(media_id) = media_id_str.parse::<u32>() {
                                media_ids.push(media_id);
                            }
                        }
                    }
                }
            }
        }

        Ok(media_ids)
    }

    /// Clear entire cache directory
    pub async fn clear_cache(&self) -> Result<()> {
        let mut removed = 0;
        let mut entries =
            fs::read_dir(&self.cache_dir)
                .await
                .map_err(|e| MontrError::FileAccess {
                    path: self.cache_dir.clone(),
                    source: e,
                })?;
        while let Some(entry) = entries.next_entry().await.map_err(MontrError::Io)? {
            if let Ok(metadata) = entry.metadata().await {
                if metadata.is_file() {
                    if let Err(e) = fs::remove_file(entry.path()).await {
                        tracing::warn!("Failed to remove {:?}: {}", entry.path(), e);
                    } else {
                        removed += 1;
                    }
                }
            }
        }

        // Also sweep cached subtitle sidecars so Clear Cache wipes both kinds.
        let subs_dir = self.subtitle_dir();
        if subs_dir.exists() {
            let mut sub_entries =
                fs::read_dir(&subs_dir)
                    .await
                    .map_err(|e| MontrError::FileAccess {
                        path: subs_dir.clone(),
                        source: e,
                    })?;
            while let Some(entry) = sub_entries.next_entry().await.map_err(MontrError::Io)? {
                if let Ok(metadata) = entry.metadata().await {
                    if metadata.is_file() {
                        if let Err(e) = fs::remove_file(entry.path()).await {
                            tracing::warn!("Failed to remove {:?}: {}", entry.path(), e);
                        } else {
                            removed += 1;
                        }
                    }
                }
            }
        }

        tracing::info!("Cleared cache: removed {} files", removed);
        Ok(())
    }
}

// Implement Clone manually since Semaphore doesn't implement Clone
impl Clone for CacheManager {
    fn clone(&self) -> Self {
        Self {
            http_client: self.http_client.clone(),
            cache_dir: self.cache_dir.clone(),
            download_semaphore: self.download_semaphore.clone(),
            cancel_token: self.cancel_token.clone(),
            api_key: self.api_key.clone(),
            app_state: self.app_state.clone(),
            lru_manager: self.lru_manager.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_http_client() -> Arc<HttpClient> {
        Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap())
    }

    #[test]
    fn test_sanitize_filename_normal() {
        assert_eq!(sanitize_filename("video.mp4"), "video.mp4");
        assert_eq!(sanitize_filename("Some File 2.mkv"), "Some File 2.mkv");
    }

    #[test]
    fn test_sanitize_filename_strips_directories() {
        assert_eq!(sanitize_filename("../../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("/abs/path/movie.mp4"), "movie.mp4");
        assert_eq!(sanitize_filename("subdir/clip.mov"), "clip.mov");
        assert_eq!(sanitize_filename("a\\b\\c.txt"), "c.txt");
    }

    #[test]
    fn test_sanitize_filename_rejects_dangerous_input() {
        // Pure traversal — no usable component, falls back to placeholder.
        assert_eq!(sanitize_filename("../.."), "file");
        assert_eq!(sanitize_filename(""), "file");
        assert_eq!(sanitize_filename("."), "file");
        // NUL and control chars are dropped.
        assert_eq!(sanitize_filename("foo\0bar.mp4"), "foobar.mp4");
        assert_eq!(sanitize_filename("foo\nbar.mp4"), "foobar.mp4");
        assert_eq!(sanitize_filename("\t\r\n"), "file");
    }

    #[test]
    fn test_sanitize_filename_truncates_long_input() {
        let long = "a".repeat(500);
        let out = sanitize_filename(&long);
        assert!(out.len() <= MAX_SANITIZED_FILENAME_BYTES);
        assert!(out.chars().all(|c| c == 'a'));
    }

    #[test]
    fn test_sanitize_filename_truncate_preserves_utf8() {
        // Build an input where the byte at MAX boundary lands mid-codepoint.
        let mut s = "a".repeat(MAX_SANITIZED_FILENAME_BYTES - 1);
        s.push('é'); // 2 bytes
        let out = sanitize_filename(&s);
        // Must still be valid UTF-8 (String guarantees this) and within budget.
        assert!(out.len() <= MAX_SANITIZED_FILENAME_BYTES);
        assert!(out.is_char_boundary(out.len()));
    }

    #[test]
    fn test_get_cache_path_stays_under_cache_dir() {
        let temp_dir = TempDir::new().unwrap();
        let http_client = create_test_http_client();
        let cancel_token = CancellationToken::new();
        let manager =
            CacheManager::new(http_client, temp_dir.path().to_path_buf(), cancel_token).unwrap();

        // A hostile filename must not escape the cache directory.
        let p = manager.get_cache_path(7, "../../../etc/passwd");
        assert_eq!(p.parent().unwrap(), temp_dir.path());
        assert!(p.file_name().is_some());
        let name = p.file_name().unwrap().to_string_lossy();
        assert!(name.starts_with("7_"));
        assert!(!name.contains(".."));
        assert!(!name.contains('/'));
    }

    #[test]
    fn test_get_subtitle_cache_path_stays_under_subs_dir() {
        let temp_dir = TempDir::new().unwrap();
        let http_client = create_test_http_client();
        let cancel_token = CancellationToken::new();
        let manager =
            CacheManager::new(http_client, temp_dir.path().to_path_buf(), cancel_token).unwrap();

        let p = manager.get_subtitle_cache_path(3, "/etc/shadow");
        assert_eq!(p.parent().unwrap(), temp_dir.path().join("subs"));
        let name = p.file_name().unwrap().to_string_lossy();
        assert_eq!(name, "3_shadow");
    }

    #[tokio::test]
    async fn test_cache_manager_creation() {
        let temp_dir = TempDir::new().unwrap();
        let http_client = create_test_http_client();
        let cancel_token = CancellationToken::new();

        let manager = CacheManager::new(http_client, temp_dir.path().to_path_buf(), cancel_token);

        assert!(manager.is_ok());
    }

    #[tokio::test]
    async fn test_cache_manager_init() {
        let temp_dir = TempDir::new().unwrap();
        let cache_dir = temp_dir.path().join("cache");
        let http_client = create_test_http_client();
        let cancel_token = CancellationToken::new();

        let manager = CacheManager::new(http_client, cache_dir.clone(), cancel_token).unwrap();

        assert!(!cache_dir.exists());
        manager.init().await.unwrap();
        assert!(cache_dir.exists());
    }

    #[tokio::test]
    async fn test_get_cache_path() {
        let temp_dir = TempDir::new().unwrap();
        let http_client = create_test_http_client();
        let cancel_token = CancellationToken::new();

        let manager =
            CacheManager::new(http_client, temp_dir.path().to_path_buf(), cancel_token).unwrap();

        let path = manager.get_cache_path(42, "video.mp4");
        assert!(path.ends_with("42_video.mp4"));
    }

    #[tokio::test]
    async fn test_is_cached() {
        let temp_dir = TempDir::new().unwrap();
        let http_client = create_test_http_client();
        let cancel_token = CancellationToken::new();

        let manager =
            CacheManager::new(http_client, temp_dir.path().to_path_buf(), cancel_token).unwrap();
        manager.init().await.unwrap();

        // Not cached initially
        assert!(!manager.is_cached(1, "test.mp4").await);

        // Create a file
        let path = manager.get_cache_path(1, "test.mp4");
        fs::write(&path, b"test content").await.unwrap();

        // Now it should be cached
        assert!(manager.is_cached(1, "test.mp4").await);
    }

    #[tokio::test]
    async fn test_get_cache_size() {
        let temp_dir = TempDir::new().unwrap();
        let http_client = create_test_http_client();
        let cancel_token = CancellationToken::new();

        let manager =
            CacheManager::new(http_client, temp_dir.path().to_path_buf(), cancel_token).unwrap();
        manager.init().await.unwrap();

        // Empty cache
        let size = manager.get_cache_size().await.unwrap();
        assert_eq!(size, 0);

        // Add some files
        let path1 = manager.get_cache_path(1, "test1.mp4");
        let path2 = manager.get_cache_path(2, "test2.mp4");
        fs::write(&path1, vec![0u8; 1024]).await.unwrap();
        fs::write(&path2, vec![0u8; 2048]).await.unwrap();

        let size = manager.get_cache_size().await.unwrap();
        assert_eq!(size, 3072);
    }

    #[tokio::test]
    async fn test_list_cached_media() {
        let temp_dir = TempDir::new().unwrap();
        let http_client = create_test_http_client();
        let cancel_token = CancellationToken::new();

        let manager =
            CacheManager::new(http_client, temp_dir.path().to_path_buf(), cancel_token).unwrap();
        manager.init().await.unwrap();

        // Create some cached files
        let path1 = manager.get_cache_path(1, "video1.mp4");
        let path2 = manager.get_cache_path(2, "video2.mp4");
        let path3 = manager.get_cache_path(5, "image.jpg");

        fs::write(&path1, b"content1").await.unwrap();
        fs::write(&path2, b"content2").await.unwrap();
        fs::write(&path3, b"content3").await.unwrap();

        let mut media_ids = manager.list_cached_media().await.unwrap();
        media_ids.sort();

        assert_eq!(media_ids, vec![1, 2, 5]);
    }

    #[tokio::test]
    async fn test_remove() {
        let temp_dir = TempDir::new().unwrap();
        let http_client = create_test_http_client();
        let cancel_token = CancellationToken::new();

        let manager =
            CacheManager::new(http_client, temp_dir.path().to_path_buf(), cancel_token).unwrap();
        manager.init().await.unwrap();

        // Create a file
        let path = manager.get_cache_path(1, "test.mp4");
        fs::write(&path, b"test").await.unwrap();
        assert!(path.exists());

        // Remove it
        manager.remove(1, "test.mp4").await.unwrap();
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn test_clear_cache() {
        let temp_dir = TempDir::new().unwrap();
        let http_client = create_test_http_client();
        let cancel_token = CancellationToken::new();

        let manager =
            CacheManager::new(http_client, temp_dir.path().to_path_buf(), cancel_token).unwrap();
        manager.init().await.unwrap();

        // Create multiple files
        for i in 1..=5 {
            let path = manager.get_cache_path(i, &format!("test{}.mp4", i));
            fs::write(&path, format!("content{}", i)).await.unwrap();
        }

        let size_before = manager.get_cache_size().await.unwrap();
        assert!(size_before > 0);

        // Clear cache
        manager.clear_cache().await.unwrap();

        let size_after = manager.get_cache_size().await.unwrap();
        assert_eq!(size_after, 0);
    }

    #[tokio::test]
    async fn test_manager_clone() {
        let temp_dir = TempDir::new().unwrap();
        let http_client = create_test_http_client();
        let cancel_token = CancellationToken::new();

        let manager1 =
            CacheManager::new(http_client, temp_dir.path().to_path_buf(), cancel_token).unwrap();

        let manager2 = manager1.clone();

        assert_eq!(manager1.cache_dir, manager2.cache_dir);
    }

    #[tokio::test]
    async fn test_is_cached_valid_true() {
        let temp_dir = TempDir::new().unwrap();
        let http_client = create_test_http_client();
        let cancel_token = CancellationToken::new();
        let manager =
            CacheManager::new(http_client, temp_dir.path().to_path_buf(), cancel_token).unwrap();
        manager.init().await.unwrap();

        // Create file with known content
        let path = manager.get_cache_path(1, "test.mp4");
        let content = b"hello world";
        fs::write(&path, content).await.unwrap();

        // Compute expected SHA-256 using the same checksum module used in production
        let expected = checksum::calculate_checksum(&path).await.unwrap();

        assert!(manager.is_cached_valid(1, "test.mp4", &expected).await);
    }

    #[tokio::test]
    async fn test_is_cached_valid_false_wrong_checksum() {
        let temp_dir = TempDir::new().unwrap();
        let http_client = create_test_http_client();
        let cancel_token = CancellationToken::new();
        let manager =
            CacheManager::new(http_client, temp_dir.path().to_path_buf(), cancel_token).unwrap();
        manager.init().await.unwrap();

        // Create file with known content
        let path = manager.get_cache_path(1, "test.mp4");
        fs::write(&path, b"hello world").await.unwrap();

        // Provide a wrong checksum
        let wrong_checksum = "0000000000000000000000000000000000000000000000000000000000000000";

        assert!(!manager.is_cached_valid(1, "test.mp4", wrong_checksum).await);
    }

    #[tokio::test]
    async fn test_is_cached_valid_false_nonexistent() {
        let temp_dir = TempDir::new().unwrap();
        let http_client = create_test_http_client();
        let cancel_token = CancellationToken::new();
        let manager =
            CacheManager::new(http_client, temp_dir.path().to_path_buf(), cancel_token).unwrap();
        manager.init().await.unwrap();

        // No file exists — any checksum should return false
        let some_checksum = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";

        assert!(
            !manager
                .is_cached_valid(99, "nonexistent.mp4", some_checksum)
                .await
        );
    }

    #[tokio::test]
    async fn test_download_media_already_cached_valid() {
        let temp_dir = TempDir::new().unwrap();
        let http_client = create_test_http_client();
        let cancel_token = CancellationToken::new();
        let manager =
            CacheManager::new(http_client, temp_dir.path().to_path_buf(), cancel_token).unwrap();
        manager.init().await.unwrap();

        // Pre-create the file with known content
        let path = manager.get_cache_path(1, "cached.mp4");
        let content = b"already cached content";
        fs::write(&path, content).await.unwrap();

        // Compute the valid checksum for this content
        let valid_checksum = checksum::calculate_checksum(&path).await.unwrap();

        // Call download_media — it should return the cached path immediately.
        // The HTTP client points at a non-existent server, so if it attempted
        // an actual download it would fail. Success here proves the cache hit.
        let result = manager
            .download_media(1, "cached.mp4", &valid_checksum)
            .await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), path);
    }

    #[tokio::test]
    async fn test_remove_nonexistent_file() {
        let temp_dir = TempDir::new().unwrap();
        let http_client = create_test_http_client();
        let cancel_token = CancellationToken::new();
        let manager =
            CacheManager::new(http_client, temp_dir.path().to_path_buf(), cancel_token).unwrap();
        manager.init().await.unwrap();

        // Removing a file that does not exist should succeed without error
        let result = manager.remove(999, "does_not_exist.mp4").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_clear_cache_empty_dir() {
        let temp_dir = TempDir::new().unwrap();
        let http_client = create_test_http_client();
        let cancel_token = CancellationToken::new();
        let manager =
            CacheManager::new(http_client, temp_dir.path().to_path_buf(), cancel_token).unwrap();
        manager.init().await.unwrap();

        // Clearing an already-empty cache directory should succeed without error
        let result = manager.clear_cache().await;
        assert!(result.is_ok());

        // Cache size should still be zero
        let size = manager.get_cache_size().await.unwrap();
        assert_eq!(size, 0);
    }
}
