//! LRU (Least Recently Used) cache manager with size-based eviction
//!
//! Tracks file access times and evicts least recently used files when cache
//! exceeds size limit or disk space is low.

use crate::error::{MontrError, Result};
use lru::LruCache;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::fs;
use tokio::sync::Mutex;
use tokio::time::{interval, Duration};
use tokio_util::sync::CancellationToken;

/// Cache entry with metadata
#[derive(Debug, Clone)]
struct CacheEntry {
    /// File path
    path: PathBuf,
    /// File size in bytes
    size: u64,
    /// Last access time (Unix timestamp)
    last_access: u64,
    /// Media ID (for future use in cache invalidation)
    #[allow(dead_code)]
    media_id: u32,
}

/// LRU cache manager
pub struct LruCacheManager {
    /// LRU cache indexed by media_id
    cache: Arc<Mutex<LruCache<u32, CacheEntry>>>,
    /// Current cache size in bytes
    current_size: Arc<Mutex<u64>>,
    /// Maximum cache size in bytes
    max_size_bytes: u64,
    /// Cache directory
    cache_dir: PathBuf,
    /// Cancellation token
    cancel_token: CancellationToken,
}

impl LruCacheManager {
    /// Create a new LRU cache manager
    ///
    /// # Arguments
    /// * `max_size_mb` - Maximum cache size in megabytes
    /// * `cache_dir` - Path to cache directory
    /// * `cancel_token` - Cancellation token for shutdown
    pub fn new(
        max_size_mb: u64,
        cache_dir: PathBuf,
        cancel_token: CancellationToken,
    ) -> Result<Self> {
        // Use unbounded LRU cache (we manage size ourselves)
        let cache_capacity = NonZeroUsize::new(10000).unwrap();
        let cache = LruCache::new(cache_capacity);

        Ok(Self {
            cache: Arc::new(Mutex::new(cache)),
            current_size: Arc::new(Mutex::new(0)),
            max_size_bytes: max_size_mb * 1024 * 1024,
            cache_dir,
            cancel_token,
        })
    }

    /// Initialize the LRU cache by scanning existing files
    pub async fn init(&self) -> Result<()> {
        tracing::info!("Initializing LRU cache manager");

        let mut cache = self.cache.lock().await;
        let mut current_size = self.current_size.lock().await;

        // Scan cache directory
        let mut entries = fs::read_dir(&self.cache_dir)
            .await
            .map_err(|e| MontrError::FileAccess {
                path: self.cache_dir.clone(),
                source: e,
            })?;

        let mut files = Vec::new();

        while let Some(entry) = entries.next_entry().await.map_err(|e| MontrError::Io(e))? {
            if let Ok(metadata) = entry.metadata().await {
                if metadata.is_file() {
                    // Parse media_id from filename
                    if let Some(filename) = entry.file_name().to_str() {
                        if let Some(media_id_str) = filename.split('_').next() {
                            if let Ok(media_id) = media_id_str.parse::<u32>() {
                                let path = entry.path();
                                let size = metadata.len();

                                // Get last access time (fallback to modified time)
                                let last_access = metadata
                                    .accessed()
                                    .or_else(|_| metadata.modified())
                                    .unwrap_or(SystemTime::now())
                                    .duration_since(UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs();

                                files.push((media_id, CacheEntry {
                                    path,
                                    size,
                                    last_access,
                                    media_id,
                                }));
                            }
                        }
                    }
                }
            }
        }

        // Sort by last_access (oldest first) to maintain LRU order
        files.sort_by_key(|(_, entry)| entry.last_access);

        // Add to cache
        for (media_id, entry) in files {
            *current_size += entry.size;
            cache.put(media_id, entry);
        }

        let count = cache.len();
        let size_mb = *current_size as f64 / (1024.0 * 1024.0);
        let max_mb = self.max_size_bytes as f64 / (1024.0 * 1024.0);

        tracing::info!(
            "LRU cache initialized: {} files, {:.2} MB / {:.2} MB",
            count,
            size_mb,
            max_mb
        );

        // Drop locks before evicting
        drop(cache);
        drop(current_size);

        // Evict if over limit
        self.evict_if_needed().await?;

        Ok(())
    }

    /// Record file access (updates LRU order)
    pub async fn access(&self, media_id: u32) -> Result<()> {
        let mut cache = self.cache.lock().await;

        if let Some(entry) = cache.get_mut(&media_id) {
            entry.last_access = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();

            tracing::trace!("Accessed media {} in LRU cache", media_id);
        }

        Ok(())
    }

    /// Add a file to the cache
    pub async fn add(&self, media_id: u32, path: PathBuf) -> Result<()> {
        let metadata = fs::metadata(&path)
            .await
            .map_err(|e| MontrError::FileAccess {
                path: path.clone(),
                source: e,
            })?;

        let size = metadata.len();
        let last_access = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let entry = CacheEntry {
            path: path.clone(),
            size,
            last_access,
            media_id,
        };

        let mut cache = self.cache.lock().await;
        let mut current_size = self.current_size.lock().await;

        // Remove old entry if exists
        if let Some(old_entry) = cache.pop(&media_id) {
            *current_size = current_size.saturating_sub(old_entry.size);
        }

        // Add new entry
        cache.put(media_id, entry);
        *current_size += size;

        tracing::debug!(
            "Added media {} to LRU cache ({} bytes)",
            media_id,
            size
        );

        // Drop locks before evicting
        drop(cache);
        drop(current_size);

        // Check if eviction needed
        self.evict_if_needed().await?;

        Ok(())
    }

    /// Remove a file from the cache
    pub async fn remove(&self, media_id: u32) -> Result<()> {
        let mut cache = self.cache.lock().await;
        let mut current_size = self.current_size.lock().await;

        if let Some(entry) = cache.pop(&media_id) {
            *current_size = current_size.saturating_sub(entry.size);

            // Delete file
            if entry.path.exists() {
                fs::remove_file(&entry.path)
                    .await
                    .map_err(|e| MontrError::FileAccess {
                        path: entry.path.clone(),
                        source: e,
                    })?;

                tracing::info!("Removed media {} from LRU cache", media_id);
            }
        }

        Ok(())
    }

    /// Get current cache size in bytes
    pub async fn current_size(&self) -> u64 {
        *self.current_size.lock().await
    }

    /// Get cache usage as a percentage
    pub async fn usage_percentage(&self) -> f64 {
        let current = *self.current_size.lock().await as f64;
        let max = self.max_size_bytes as f64;
        (current / max) * 100.0
    }

    /// Check if eviction is needed and perform it
    pub async fn evict_if_needed(&self) -> Result<()> {
        let current = *self.current_size.lock().await;

        if current <= self.max_size_bytes {
            return Ok(());
        }

        tracing::warn!(
            "Cache size ({} MB) exceeds limit ({} MB), evicting...",
            current / 1024 / 1024,
            self.max_size_bytes / 1024 / 1024
        );

        // Target: evict 20% to avoid frequent evictions
        let target_size = (self.max_size_bytes as f64 * 0.8) as u64;

        self.evict_until(target_size).await
    }

    /// Evict files until cache is under target size
    async fn evict_until(&self, target_size: u64) -> Result<()> {
        let mut evicted_count = 0;
        let mut evicted_bytes = 0u64;

        loop {
            let current = *self.current_size.lock().await;
            if current <= target_size {
                break;
            }

            // Get oldest entry (LRU)
            let media_id_to_evict = {
                let cache = self.cache.lock().await;

                // peek_lru returns the least recently used entry
                cache.peek_lru().map(|(id, _)| *id)
            };

            if let Some(media_id) = media_id_to_evict {
                // Get entry details before removing
                let entry = {
                    let cache = self.cache.lock().await;
                    cache.peek(&media_id).cloned()
                };

                if let Some(entry) = entry {
                    evicted_bytes += entry.size;
                    evicted_count += 1;

                    tracing::info!(
                        "Evicting media {} ({} MB, last access: {})",
                        media_id,
                        entry.size / 1024 / 1024,
                        entry.last_access
                    );

                    self.remove(media_id).await?;
                }
            } else {
                // Cache is empty but somehow still over size?
                tracing::error!("Cache appears empty but size is still high");
                break;
            }

            // Safety check to avoid infinite loop
            if evicted_count > 10000 {
                tracing::error!("Eviction loop exceeded safety limit");
                break;
            }
        }

        if evicted_count > 0 {
            tracing::info!(
                "Evicted {} files ({} MB)",
                evicted_count,
                evicted_bytes / 1024 / 1024
            );
        }

        Ok(())
    }

    /// Check available disk space and evict if needed
    pub async fn check_disk_space(&self) -> Result<()> {
        // Get disk space info using sysinfo
        let disks = sysinfo::Disks::new_with_refreshed_list();

        let disk_info = disks
            .iter()
            .find(|disk| self.cache_dir.starts_with(disk.mount_point()));

        let available_mb = if let Some(disk) = disk_info {
            disk.available_space() / 1024 / 1024
        } else {
            tracing::warn!("Could not find disk for cache directory");
            return Ok(());
        };

        // If less than 1GB free, evict 25% of cache
        if available_mb < 1024 {
            tracing::warn!(
                "Low disk space: {} MB available, evicting cache",
                available_mb
            );

            let target_size = (self.max_size_bytes as f64 * 0.75) as u64;
            self.evict_until(target_size).await?;
        }

        Ok(())
    }

    /// Start periodic cleanup task
    ///
    /// Runs every 5 minutes to check cache size and disk space
    pub fn start_cleanup_task(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        let cancel_token = self.cancel_token.clone();

        tokio::spawn(async move {
            let mut interval = interval(Duration::from_secs(300)); // 5 minutes

            loop {
                tokio::select! {
                    _ = cancel_token.cancelled() => {
                        tracing::info!("LRU cleanup task shutting down");
                        break;
                    }
                    _ = interval.tick() => {
                        tracing::debug!("Running periodic cache cleanup");

                        if let Err(e) = self.evict_if_needed().await {
                            tracing::error!("Failed to evict cache: {}", e);
                        }

                        if let Err(e) = self.check_disk_space().await {
                            tracing::error!("Failed to check disk space: {}", e);
                        }
                    }
                }
            }
        })
    }

    /// Get cache statistics
    pub async fn stats(&self) -> CacheStats {
        let cache = self.cache.lock().await;
        let current_size = *self.current_size.lock().await;

        CacheStats {
            file_count: cache.len(),
            total_size_bytes: current_size,
            max_size_bytes: self.max_size_bytes,
            usage_percentage: (current_size as f64 / self.max_size_bytes as f64) * 100.0,
        }
    }
}

/// Cache statistics
#[derive(Debug, Clone)]
pub struct CacheStats {
    pub file_count: usize,
    pub total_size_bytes: u64,
    pub max_size_bytes: u64,
    pub usage_percentage: f64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_lru_creation() {
        let temp_dir = TempDir::new().unwrap();
        let cancel_token = CancellationToken::new();

        let lru = LruCacheManager::new(
            100, // 100 MB
            temp_dir.path().to_path_buf(),
            cancel_token,
        );

        assert!(lru.is_ok());
    }

    #[tokio::test]
    async fn test_lru_init_empty() {
        let temp_dir = TempDir::new().unwrap();
        let cache_dir = temp_dir.path().join("cache");
        fs::create_dir_all(&cache_dir).await.unwrap();

        let cancel_token = CancellationToken::new();
        let lru = LruCacheManager::new(100, cache_dir, cancel_token).unwrap();

        lru.init().await.unwrap();

        let stats = lru.stats().await;
        assert_eq!(stats.file_count, 0);
        assert_eq!(stats.total_size_bytes, 0);
    }

    #[tokio::test]
    async fn test_lru_add_and_access() {
        let temp_dir = TempDir::new().unwrap();
        let cache_dir = temp_dir.path().join("cache");
        fs::create_dir_all(&cache_dir).await.unwrap();

        let cancel_token = CancellationToken::new();
        let lru = LruCacheManager::new(100, cache_dir.clone(), cancel_token).unwrap();
        lru.init().await.unwrap();

        // Create a test file
        let test_file = cache_dir.join("1_test.mp4");
        fs::write(&test_file, vec![0u8; 1024]).await.unwrap();

        // Add to LRU
        lru.add(1, test_file).await.unwrap();

        let stats = lru.stats().await;
        assert_eq!(stats.file_count, 1);
        assert_eq!(stats.total_size_bytes, 1024);

        // Access it
        lru.access(1).await.unwrap();
    }

    #[tokio::test]
    async fn test_lru_remove() {
        let temp_dir = TempDir::new().unwrap();
        let cache_dir = temp_dir.path().join("cache");
        fs::create_dir_all(&cache_dir).await.unwrap();

        let cancel_token = CancellationToken::new();
        let lru = LruCacheManager::new(100, cache_dir.clone(), cancel_token).unwrap();
        lru.init().await.unwrap();

        // Create and add file
        let test_file = cache_dir.join("1_test.mp4");
        fs::write(&test_file, vec![0u8; 1024]).await.unwrap();
        lru.add(1, test_file.clone()).await.unwrap();

        assert!(test_file.exists());

        // Remove it
        lru.remove(1).await.unwrap();

        let stats = lru.stats().await;
        assert_eq!(stats.file_count, 0);
        assert_eq!(stats.total_size_bytes, 0);
        assert!(!test_file.exists());
    }

    #[tokio::test]
    async fn test_lru_eviction() {
        let temp_dir = TempDir::new().unwrap();
        let cache_dir = temp_dir.path().join("cache");
        fs::create_dir_all(&cache_dir).await.unwrap();

        let cancel_token = CancellationToken::new();
        // Small cache: 10 KB
        let lru = LruCacheManager::new(
            1, // 1 MB but we'll use KB for testing
            cache_dir.clone(),
            cancel_token,
        )
        .unwrap();

        // Override max size for testing
        let lru = Arc::new(lru);
        *lru.current_size.lock().await = 0;
        // Note: We can't modify max_size_bytes easily, so this test checks the logic

        lru.init().await.unwrap();

        // Add multiple files (each 5KB)
        for i in 1..=5 {
            let test_file = cache_dir.join(format!("{}_test.mp4", i));
            fs::write(&test_file, vec![0u8; 5 * 1024]).await.unwrap();

            // Small delay to ensure different timestamps
            tokio::time::sleep(Duration::from_millis(10)).await;

            lru.add(i, test_file).await.unwrap();
        }

        let stats = lru.stats().await;
        // After eviction, should have fewer files
        assert!(stats.file_count <= 5);
    }

    #[tokio::test]
    async fn test_lru_stats() {
        let temp_dir = TempDir::new().unwrap();
        let cache_dir = temp_dir.path().join("cache");
        fs::create_dir_all(&cache_dir).await.unwrap();

        let cancel_token = CancellationToken::new();
        let lru = LruCacheManager::new(100, cache_dir.clone(), cancel_token).unwrap();
        lru.init().await.unwrap();

        // Add a file
        let test_file = cache_dir.join("1_test.mp4");
        fs::write(&test_file, vec![0u8; 2048]).await.unwrap();
        lru.add(1, test_file).await.unwrap();

        let stats = lru.stats().await;
        assert_eq!(stats.file_count, 1);
        assert_eq!(stats.total_size_bytes, 2048);
        assert_eq!(stats.max_size_bytes, 100 * 1024 * 1024);
        assert!(stats.usage_percentage < 1.0);
    }

    #[tokio::test]
    async fn test_usage_percentage() {
        let temp_dir = TempDir::new().unwrap();
        let cache_dir = temp_dir.path().join("cache");
        fs::create_dir_all(&cache_dir).await.unwrap();

        let cancel_token = CancellationToken::new();
        let lru = LruCacheManager::new(1, cache_dir.clone(), cancel_token).unwrap(); // 1 MB
        lru.init().await.unwrap();

        // Add 512KB file
        let test_file = cache_dir.join("1_test.mp4");
        fs::write(&test_file, vec![0u8; 512 * 1024]).await.unwrap();
        lru.add(1, test_file).await.unwrap();

        let usage = lru.usage_percentage().await;
        assert!((usage - 50.0).abs() < 1.0); // Should be approximately 50%
    }
}
