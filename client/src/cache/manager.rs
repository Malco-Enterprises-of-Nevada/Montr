//! Cache manager for downloading and storing media files
//!
//! Manages concurrent downloads with semaphore limits, retry logic, and checksum
//! verification. Downloads are atomic (write to .tmp, rename on success).

use crate::cache::checksum;
use crate::error::{MontrError, Result};
use crate::network::http::{DownloadOptions, HttpClient};
use crate::network::PlaylistItem;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs;
use tokio::sync::{mpsc, Semaphore};
use tokio_util::sync::CancellationToken;

/// Maximum concurrent downloads
const MAX_CONCURRENT_DOWNLOADS: usize = 2;

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
        })
    }

    /// Set the API key for authenticated downloads
    pub fn with_api_key(mut self, api_key: Option<String>) -> Self {
        self.api_key = api_key;
        self
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
        self.cache_dir.join(format!("{}_{}", media_id, filename))
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

        tracing::info!("Downloading media {} to {:?}", media_id, final_path);

        // Download to temporary file
        let options = DownloadOptions {
            show_progress: false, // Disable terminal progress for background downloads
            resume: true,
            timeout_secs: 300,
            max_retries: 3,
            api_key: self.api_key.clone(),
        };

        self.http_client
            .download_media(media_id, &temp_path, options)
            .await?;

        // Verify checksum
        tracing::debug!("Verifying checksum for media {}", media_id);
        checksum::verify_checksum(&temp_path, checksum).await?;

        // Rename to final location (atomic operation)
        fs::rename(&temp_path, &final_path)
            .await
            .map_err(|e| MontrError::CacheWrite {
                path: final_path.clone(),
                source: e,
            })?;

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
        let mut entries =
            fs::read_dir(&self.cache_dir)
                .await
                .map_err(|e| MontrError::FileAccess {
                    path: self.cache_dir.clone(),
                    source: e,
                })?;

        let mut removed = 0;
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
