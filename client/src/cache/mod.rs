//! Media cache module
//!
//! Provides caching functionality for downloaded media files including:
//! - Download management with concurrency limits
//! - Checksum verification
//! - LRU eviction policy
//! - Disk space monitoring

pub mod checksum;
pub mod lru;
pub mod manager;

pub use checksum::{calculate_checksum, verify_checksum};
pub use lru::{CacheStats, LruCacheManager};
pub use manager::{CacheManager, DownloadProgress};
