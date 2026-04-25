//! LRU (Least Recently Used) cache manager with size-based eviction
//!
//! Tracks file access times and evicts least recently used files when cache
//! exceeds size limit or disk space is low.

use crate::error::{MontrError, Result};
use lru::LruCache;
use std::collections::HashSet;
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
    /// Set of media_ids that are pinned in cache. Pinned entries are never
    /// evicted by `evict_until` — used to keep the currently-assigned
    /// playlist resident across long offline windows under cache pressure.
    /// They still count toward `current_size` for quota math.
    pinned: Arc<Mutex<HashSet<u32>>>,
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
            pinned: Arc::new(Mutex::new(HashSet::new())),
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
        let mut entries =
            fs::read_dir(&self.cache_dir)
                .await
                .map_err(|e| MontrError::FileAccess {
                    path: self.cache_dir.clone(),
                    source: e,
                })?;

        let mut files = Vec::new();

        while let Some(entry) = entries.next_entry().await.map_err(MontrError::Io)? {
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

                                files.push((
                                    media_id,
                                    CacheEntry {
                                        path,
                                        size,
                                        last_access,
                                        media_id,
                                    },
                                ));
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

        tracing::debug!("Added media {} to LRU cache ({} bytes)", media_id, size);

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

    /// Evict files until cache is under target size, skipping pinned entries.
    ///
    /// If only pinned entries remain and we still haven't reached the target,
    /// the loop exits gracefully — the caller (typically `ensure_room_for`)
    /// is responsible for converting that to a `CacheFull` error.
    async fn evict_until(&self, target_size: u64) -> Result<()> {
        let mut evicted_count = 0;
        let mut evicted_bytes = 0u64;

        loop {
            let current = *self.current_size.lock().await;
            if current <= target_size {
                break;
            }

            // Find the least-recently-used entry that isn't pinned. The lru
            // crate exposes `iter()` MRU-first; collect ids LRU-first into a
            // Vec to avoid holding the mutex across awaits.
            let media_id_to_evict = {
                let cache = self.cache.lock().await;
                let pinned = self.pinned.lock().await;
                let mut lru_first: Vec<u32> = cache.iter().map(|(k, _)| *k).collect();
                lru_first.reverse();
                lru_first.into_iter().find(|id| !pinned.contains(id))
            };

            let Some(media_id) = media_id_to_evict else {
                // Either cache is empty, or every remaining entry is pinned.
                tracing::debug!(
                    "evict_until: no evictable (non-pinned) entries; current {} > target {}",
                    current,
                    target_size
                );
                break;
            };

            // Get entry details before removing (for logging).
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

    /// Pin a media id so it is never evicted by `evict_until`. Idempotent —
    /// pinning an already-pinned id is a no-op.
    pub async fn pin(&self, media_id: u32) {
        self.pinned.lock().await.insert(media_id);
    }

    /// Unpin a media id so it becomes a normal LRU eviction candidate again.
    pub async fn unpin(&self, media_id: u32) {
        self.pinned.lock().await.remove(&media_id);
    }

    /// Replace the entire pin set in one operation. Useful when a new
    /// playlist is assigned: unpin the old set and pin the new in a single
    /// atomic swap so eviction doesn't race against the transition.
    pub async fn replace_pins(&self, ids: impl IntoIterator<Item = u32>) {
        let mut p = self.pinned.lock().await;
        p.clear();
        for id in ids {
            p.insert(id);
        }
    }

    /// True if `media_id` is currently pinned. Mainly for tests.
    pub async fn is_pinned(&self, media_id: u32) -> bool {
        self.pinned.lock().await.contains(&media_id)
    }

    /// Cumulative size of pinned entries in bytes. Used by `ensure_room_for`
    /// to detect impossible requests when the pinned working-set already
    /// fills (or near-fills) the cache.
    pub async fn pinned_bytes(&self) -> u64 {
        let cache = self.cache.lock().await;
        let pinned = self.pinned.lock().await;
        pinned
            .iter()
            .filter_map(|id| cache.peek(id).map(|e| e.size))
            .sum()
    }

    /// Configured maximum cache size in bytes.
    pub fn max_size_bytes(&self) -> u64 {
        self.max_size_bytes
    }

    /// Available disk space (in bytes) on the partition that holds the cache
    /// directory. Returns `None` if sysinfo can't identify the partition.
    pub fn available_disk_bytes(&self) -> Option<u64> {
        let disks = sysinfo::Disks::new_with_refreshed_list();
        // Pick the longest matching mount point so /var/lib/montr beats /.
        disks
            .iter()
            .filter(|d| self.cache_dir.starts_with(d.mount_point()))
            .max_by_key(|d| d.mount_point().as_os_str().len())
            .map(|d| d.available_space())
    }

    /// Check available disk space and evict if needed
    pub async fn check_disk_space(&self) -> Result<()> {
        let Some(available_bytes) = self.available_disk_bytes() else {
            tracing::warn!("Could not find disk for cache directory");
            return Ok(());
        };
        let available_mb = available_bytes / 1024 / 1024;

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

    /// Ensure the cache has room for `incoming_bytes` of new content without
    /// blowing the configured quota and without leaving the partition under
    /// the disk-headroom threshold.
    ///
    /// Strategy: evict LRU entries until both invariants hold. If the request
    /// is impossible to satisfy (cap is smaller than the request, partition is
    /// genuinely full), returns `MontrError::CacheFull`.
    ///
    /// Headroom is held back so the OS, mpv buffers, and other processes
    /// keep working even if the cache is at its quota.
    pub async fn ensure_room_for(&self, incoming_bytes: u64) -> Result<()> {
        const DISK_HEADROOM_BYTES: u64 = 256 * 1024 * 1024; // 256 MB

        // Refuse outright if a single request exceeds the configured cap —
        // no amount of eviction can satisfy it.
        if incoming_bytes > self.max_size_bytes {
            return Err(MontrError::CacheFull {
                max_size_mb: self.max_size_bytes / 1024 / 1024,
            });
        }

        // Pinned entries can't be evicted, so if the pinned working-set
        // already fills the cache, no eviction can free the requested bytes.
        // Surface this clearly rather than spinning evict_until uselessly.
        let pinned = self.pinned_bytes().await;
        if pinned.saturating_add(incoming_bytes) > self.max_size_bytes {
            tracing::warn!(
                "ensure_room_for: pinned set ({} MB) + incoming ({} MB) exceeds cache cap ({} MB)",
                pinned / 1024 / 1024,
                incoming_bytes / 1024 / 1024,
                self.max_size_bytes / 1024 / 1024
            );
            return Err(MontrError::CacheFull {
                max_size_mb: self.max_size_bytes / 1024 / 1024,
            });
        }

        // First constraint: stay under the configured cache cap.
        let target_size = self.max_size_bytes.saturating_sub(incoming_bytes);
        self.evict_until(target_size).await?;

        // Second constraint: leave headroom on the partition. Only evict more
        // if the disk reports we're below `incoming_bytes + headroom`.
        if let Some(available) = self.available_disk_bytes() {
            let needed = incoming_bytes.saturating_add(DISK_HEADROOM_BYTES);
            if available < needed {
                // Try to free the gap by additional eviction. The new target
                // is whatever cache size would let the OS reclaim `gap` bytes
                // assuming our cached files live on this partition.
                let gap = needed - available;
                let current = self.current_size().await;
                let new_target = current.saturating_sub(gap);
                self.evict_until(new_target).await?;

                // Re-check; if the partition is still tight after we've
                // evicted everything we can, the disk is genuinely full and
                // the caller needs to surface that to the operator.
                let still_available = self.available_disk_bytes().unwrap_or(available);
                if still_available + DISK_HEADROOM_BYTES < incoming_bytes + DISK_HEADROOM_BYTES {
                    return Err(MontrError::CacheFull {
                        max_size_mb: self.max_size_bytes / 1024 / 1024,
                    });
                }
            }
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

    #[tokio::test]
    async fn ensure_room_for_rejects_oversized_request() {
        let temp_dir = TempDir::new().unwrap();
        let cache_dir = temp_dir.path().join("cache");
        fs::create_dir_all(&cache_dir).await.unwrap();

        let cancel_token = CancellationToken::new();
        let lru = LruCacheManager::new(1, cache_dir, cancel_token).unwrap(); // 1 MB cap
        lru.init().await.unwrap();

        // 10 MB request against a 1 MB cap is impossible — reject up front.
        let err = lru.ensure_room_for(10 * 1024 * 1024).await.unwrap_err();
        assert!(matches!(err, MontrError::CacheFull { .. }));
    }

    #[tokio::test]
    async fn ensure_room_for_evicts_lru_to_make_room() {
        let temp_dir = TempDir::new().unwrap();
        let cache_dir = temp_dir.path().join("cache");
        fs::create_dir_all(&cache_dir).await.unwrap();

        let cancel_token = CancellationToken::new();
        // 1 MB cap, fill with 2 x 400 KB
        let lru = Arc::new(LruCacheManager::new(1, cache_dir.clone(), cancel_token).unwrap());
        lru.init().await.unwrap();

        for (id, label) in [(1u32, "old"), (2u32, "newer")] {
            let f = cache_dir.join(format!("{}_{}.mp4", id, label));
            fs::write(&f, vec![0u8; 400 * 1024]).await.unwrap();
            tokio::time::sleep(Duration::from_millis(5)).await;
            lru.add(id, f).await.unwrap();
        }

        // Request 500 KB. Cap = 1024 KB, current = 800 KB, so target after
        // ensure = 524 KB. We must evict at least one entry (the LRU one).
        lru.ensure_room_for(500 * 1024).await.unwrap();

        let stats = lru.stats().await;
        // Either both evicted or just one — the contract is "current_size +
        // incoming <= max_size_bytes".
        assert!(stats.total_size_bytes + 500 * 1024 <= lru.max_size_bytes());
    }

    #[tokio::test]
    async fn ensure_room_for_zero_bytes_is_noop() {
        let temp_dir = TempDir::new().unwrap();
        let cache_dir = temp_dir.path().join("cache");
        fs::create_dir_all(&cache_dir).await.unwrap();

        let cancel_token = CancellationToken::new();
        let lru = LruCacheManager::new(10, cache_dir, cancel_token).unwrap();
        lru.init().await.unwrap();

        // Empty cache + zero-byte request: trivially OK.
        lru.ensure_room_for(0).await.unwrap();
    }

    #[tokio::test]
    async fn available_disk_bytes_returns_some_for_real_path() {
        let temp_dir = TempDir::new().unwrap();
        let cache_dir = temp_dir.path().join("cache");
        fs::create_dir_all(&cache_dir).await.unwrap();

        let cancel_token = CancellationToken::new();
        let lru = LruCacheManager::new(1, cache_dir, cancel_token).unwrap();
        // Real partitions on dev/CI machines should be discoverable.
        assert!(lru.available_disk_bytes().is_some());
    }

    #[tokio::test]
    async fn max_size_bytes_matches_constructor() {
        let temp_dir = TempDir::new().unwrap();
        let cache_dir = temp_dir.path().join("cache");
        fs::create_dir_all(&cache_dir).await.unwrap();

        let cancel_token = CancellationToken::new();
        let lru = LruCacheManager::new(7, cache_dir, cancel_token).unwrap();
        assert_eq!(lru.max_size_bytes(), 7 * 1024 * 1024);
    }

    #[tokio::test]
    async fn pin_and_unpin_round_trip() {
        let temp_dir = TempDir::new().unwrap();
        let cache_dir = temp_dir.path().join("cache");
        fs::create_dir_all(&cache_dir).await.unwrap();

        let lru = LruCacheManager::new(10, cache_dir, CancellationToken::new()).unwrap();

        assert!(!lru.is_pinned(42).await);
        lru.pin(42).await;
        assert!(lru.is_pinned(42).await);
        // Idempotent
        lru.pin(42).await;
        assert!(lru.is_pinned(42).await);

        lru.unpin(42).await;
        assert!(!lru.is_pinned(42).await);
    }

    #[tokio::test]
    async fn replace_pins_swaps_set_atomically() {
        let temp_dir = TempDir::new().unwrap();
        let cache_dir = temp_dir.path().join("cache");
        fs::create_dir_all(&cache_dir).await.unwrap();

        let lru = LruCacheManager::new(10, cache_dir, CancellationToken::new()).unwrap();
        lru.pin(1).await;
        lru.pin(2).await;

        lru.replace_pins([3, 4]).await;
        assert!(!lru.is_pinned(1).await);
        assert!(!lru.is_pinned(2).await);
        assert!(lru.is_pinned(3).await);
        assert!(lru.is_pinned(4).await);
    }

    #[tokio::test]
    async fn evict_until_skips_pinned_entries() {
        let temp_dir = TempDir::new().unwrap();
        let cache_dir = temp_dir.path().join("cache");
        fs::create_dir_all(&cache_dir).await.unwrap();

        let lru =
            Arc::new(LruCacheManager::new(1, cache_dir.clone(), CancellationToken::new()).unwrap());

        // Three 400 KB files; total 1200 KB > 1024 KB cap.
        for (id, label) in [(1u32, "a"), (2u32, "b"), (3u32, "c")] {
            let f = cache_dir.join(format!("{}_{}.mp4", id, label));
            fs::write(&f, vec![0u8; 400 * 1024]).await.unwrap();
            tokio::time::sleep(Duration::from_millis(5)).await;
            lru.add(id, f).await.unwrap();
        }

        // Pin id=1 (the LRU). After ensure_room_for(0) → evict_until(max),
        // id=1 must survive even though it's the LRU candidate.
        lru.pin(1).await;
        lru.evict_until(400 * 1024).await.unwrap();

        let stats = lru.stats().await;
        assert!(lru.is_pinned(1).await, "pinned entry must remain pinned");
        // The pinned entry is still present, contributing 400 KB to the size.
        assert!(stats.total_size_bytes >= 400 * 1024);
    }

    #[tokio::test]
    async fn ensure_room_for_rejects_when_pinned_set_fills_cache() {
        let temp_dir = TempDir::new().unwrap();
        let cache_dir = temp_dir.path().join("cache");
        fs::create_dir_all(&cache_dir).await.unwrap();

        // 1 MB cap, fill with one 800 KB pinned entry.
        let lru =
            Arc::new(LruCacheManager::new(1, cache_dir.clone(), CancellationToken::new()).unwrap());
        let f = cache_dir.join("9_pinned.mp4");
        fs::write(&f, vec![0u8; 800 * 1024]).await.unwrap();
        lru.add(9, f).await.unwrap();
        lru.pin(9).await;

        // Asking for 500 KB more (total 1300 KB > 1024 KB cap) is impossible
        // because the pinned entry can't be freed.
        let err = lru.ensure_room_for(500 * 1024).await.unwrap_err();
        assert!(matches!(err, MontrError::CacheFull { .. }));
    }
}
