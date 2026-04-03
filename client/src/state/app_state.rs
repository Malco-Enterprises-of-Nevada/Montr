//! Application state management
//!
//! Provides shared state accessible from all subsystems using Arc<RwLock> pattern.
//! State includes playlist queue, current playback position, and client info.

use crate::error::Result;
use crate::playback::queue::PlaylistQueue;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Inner state protected by RwLock
#[derive(Debug)]
struct AppStateInner {
    /// Client UUID
    client_id: String,
    /// Client name
    client_name: String,
    /// Currently assigned playlist ID
    playlist_id: Option<u32>,
    /// Playlist queue
    queue: PlaylistQueue,
    /// Current media ID being played
    current_media_id: Option<u32>,
    /// Current position in media (seconds, for videos)
    current_position: Option<f64>,
    /// Whether media is currently playing
    is_playing: bool,
    /// Error message (if any)
    last_error: Option<String>,
    /// Playlist ID saved during interrupt (for resume)
    interrupted_from_playlist_id: Option<u32>,
}

/// Shared application state
///
/// Thread-safe state container that can be cloned and shared across async tasks.
/// Uses RwLock to allow multiple concurrent readers but exclusive writers.
#[derive(Debug, Clone)]
pub struct AppState {
    inner: Arc<RwLock<AppStateInner>>,
}

impl AppState {
    /// Create new application state
    pub fn new(client_id: String, client_name: String) -> Self {
        let inner = AppStateInner {
            client_id,
            client_name,
            playlist_id: None,
            queue: PlaylistQueue::new(),
            current_media_id: None,
            current_position: None,
            is_playing: false,
            last_error: None,
            interrupted_from_playlist_id: None,
        };

        Self {
            inner: Arc::new(RwLock::new(inner)),
        }
    }

    // ========================================================================
    // Read Operations (shared access)
    // ========================================================================

    /// Get client ID
    pub async fn client_id(&self) -> String {
        let state = self.inner.read().await;
        state.client_id.clone()
    }

    /// Get client name
    pub async fn client_name(&self) -> String {
        let state = self.inner.read().await;
        state.client_name.clone()
    }

    /// Get current playlist ID
    pub async fn playlist_id(&self) -> Option<u32> {
        let state = self.inner.read().await;
        state.playlist_id
    }

    /// Get current media ID
    pub async fn current_media_id(&self) -> Option<u32> {
        let state = self.inner.read().await;
        state.current_media_id
    }

    /// Get current position
    pub async fn current_position(&self) -> Option<f64> {
        let state = self.inner.read().await;
        state.current_position
    }

    /// Check if playing
    pub async fn is_playing(&self) -> bool {
        let state = self.inner.read().await;
        state.is_playing
    }

    /// Get current playlist index
    pub async fn playlist_index(&self) -> Option<usize> {
        let state = self.inner.read().await;
        state.queue.current_index()
    }

    /// Get last error
    pub async fn last_error(&self) -> Option<String> {
        let state = self.inner.read().await;
        state.last_error.clone()
    }

    /// Get queue length
    pub async fn queue_length(&self) -> usize {
        let state = self.inner.read().await;
        state.queue.len()
    }

    /// Check if queue is empty
    pub async fn is_queue_empty(&self) -> bool {
        let state = self.inner.read().await;
        state.queue.is_empty()
    }

    /// Get current queue item
    pub async fn current_queue_item(&self) -> Option<crate::network::PlaylistItem> {
        let state = self.inner.read().await;
        state.queue.current().cloned()
    }

    /// Get all queue items
    pub async fn queue_items(&self) -> Vec<crate::network::PlaylistItem> {
        let state = self.inner.read().await;
        state.queue.items().to_vec()
    }

    /// Get upcoming items from the queue without advancing
    pub async fn get_upcoming_items(&self, count: usize) -> Vec<crate::network::PlaylistItem> {
        let state = self.inner.read().await;
        let current_idx = match state.queue.current_index() {
            Some(idx) => idx,
            None => return Vec::new(),
        };
        let mut items = Vec::new();
        for offset in 1..=count {
            if let Some(item) = state.queue.get(current_idx + offset) {
                items.push(item.clone());
            }
        }
        items
    }

    /// Get interrupted playlist ID (saved during interrupt)
    pub async fn interrupted_from_playlist_id(&self) -> Option<u32> {
        let state = self.inner.read().await;
        state.interrupted_from_playlist_id
    }

    /// Check if looping
    pub async fn is_looping(&self) -> bool {
        let state = self.inner.read().await;
        state.queue.is_looping()
    }

    // ========================================================================
    // Write Operations (exclusive access)
    // ========================================================================

    /// Update playlist and queue
    pub async fn update_playlist(
        &self,
        playlist_id: u32,
        items: Vec<crate::network::PlaylistItem>,
        loop_enabled: bool,
    ) -> Result<()> {
        let mut state = self.inner.write().await;

        state.playlist_id = Some(playlist_id);
        state.queue.update_items(items, playlist_id);
        state.queue.set_loop(loop_enabled);

        tracing::info!(
            "Updated playlist {}: {} items, loop={}",
            playlist_id,
            state.queue.len(),
            loop_enabled
        );

        Ok(())
    }

    /// Clear playlist
    pub async fn clear_playlist(&self) {
        let mut state = self.inner.write().await;

        state.playlist_id = None;
        state.queue.clear();
        state.current_media_id = None;
        state.current_position = None;
        state.is_playing = false;

        tracing::info!("Cleared playlist");
    }

    /// Move to next item in queue
    pub async fn next_item(&self) -> Option<crate::network::PlaylistItem> {
        let mut state = self.inner.write().await;

        let item = state.queue.next().cloned();

        if let Some(ref item) = item {
            state.current_media_id = Some(item.media_id);
            state.current_position = Some(0.0);
            tracing::debug!("Advanced to next item: media {}", item.media_id);
        } else {
            state.current_media_id = None;
            state.current_position = None;
            tracing::debug!("No next item available");
        }

        item
    }

    /// Move to previous item in queue
    pub async fn previous_item(&self) -> Option<crate::network::PlaylistItem> {
        let mut state = self.inner.write().await;

        let item = state.queue.previous().cloned();

        if let Some(ref item) = item {
            state.current_media_id = Some(item.media_id);
            state.current_position = Some(0.0);
            tracing::debug!("Moved to previous item: media {}", item.media_id);
        }

        item
    }

    /// Jump to specific index
    pub async fn jump_to(&self, index: usize) -> Result<crate::network::PlaylistItem> {
        let mut state = self.inner.write().await;

        let item = state.queue.jump_to(index)?.clone();
        state.current_media_id = Some(item.media_id);
        state.current_position = Some(0.0);

        tracing::info!("Jumped to index {}: media {}", index, item.media_id);

        Ok(item)
    }

    /// Reset queue to beginning
    pub async fn reset_queue(&self) {
        let mut state = self.inner.write().await;
        state.queue.reset();
        state.current_position = Some(0.0);

        if let Some(item) = state.queue.current() {
            state.current_media_id = Some(item.media_id);
        }

        tracing::info!("Reset queue to beginning");
    }

    /// Update playback position
    pub async fn update_position(&self, position: f64) {
        let mut state = self.inner.write().await;
        state.current_position = Some(position);
    }

    /// Set playing state
    pub async fn set_playing(&self, is_playing: bool) {
        let mut state = self.inner.write().await;
        state.is_playing = is_playing;

        tracing::debug!(
            "Playback state: {}",
            if is_playing { "playing" } else { "paused" }
        );
    }

    /// Set current media
    pub async fn set_current_media(&self, media_id: Option<u32>) {
        let mut state = self.inner.write().await;
        state.current_media_id = media_id;

        if let Some(id) = media_id {
            tracing::debug!("Current media set to: {}", id);
        } else {
            tracing::debug!("Current media cleared");
        }
    }

    /// Set error
    pub async fn set_error(&self, error: Option<String>) {
        let mut state = self.inner.write().await;
        state.last_error = error.clone();

        if let Some(ref err) = error {
            tracing::error!("State error: {}", err);
        }
    }

    /// Set interrupted playlist ID
    pub async fn set_interrupted_from(&self, playlist_id: Option<u32>) {
        let mut state = self.inner.write().await;
        state.interrupted_from_playlist_id = playlist_id;
    }

    /// Clear error
    pub async fn clear_error(&self) {
        let mut state = self.inner.write().await;
        state.last_error = None;
    }

    /// Get snapshot of current state for status reporting
    pub async fn snapshot(&self) -> StateSnapshot {
        let state = self.inner.read().await;

        StateSnapshot {
            client_id: state.client_id.clone(),
            playlist_id: state.playlist_id,
            current_media_id: state.current_media_id,
            current_position: state.current_position,
            is_playing: state.is_playing,
            playlist_index: state.queue.current_index(),
            queue_length: state.queue.len(),
            last_error: state.last_error.clone(),
        }
    }
}

/// Immutable snapshot of application state
///
/// Used for status reporting and logging without holding locks.
#[derive(Debug, Clone)]
pub struct StateSnapshot {
    pub client_id: String,
    pub playlist_id: Option<u32>,
    pub current_media_id: Option<u32>,
    pub current_position: Option<f64>,
    pub is_playing: bool,
    pub playlist_index: Option<usize>,
    pub queue_length: usize,
    pub last_error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::PlaylistItem;

    fn create_test_item(id: u32, media_id: u32) -> PlaylistItem {
        PlaylistItem {
            id,
            media_id,
            filename: format!("test_{}.mp4", media_id),
            download_url: format!("http://localhost:3000/api/media/{}/download", media_id),
            media_type: "video".to_string(),
            duration: Some(120.0),
            checksum: Some(format!("checksum_{}", media_id)),
            order_index: id - 1,
            image_duration: 5,
        }
    }

    #[tokio::test]
    async fn test_app_state_creation() {
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());

        assert_eq!(state.client_id().await, "test-id");
        assert_eq!(state.client_name().await, "Test Client");
        assert_eq!(state.playlist_id().await, None);
        assert!(!state.is_playing().await);
    }

    #[tokio::test]
    async fn test_update_playlist() {
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());

        let items = vec![
            create_test_item(1, 1),
            create_test_item(2, 2),
            create_test_item(3, 3),
        ];

        state.update_playlist(42, items, true).await.unwrap();

        assert_eq!(state.playlist_id().await, Some(42));
        assert_eq!(state.queue_length().await, 3);
        assert!(state.is_looping().await);
    }

    #[tokio::test]
    async fn test_next_item() {
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());

        let items = vec![create_test_item(1, 10), create_test_item(2, 20)];

        state.update_playlist(1, items, false).await.unwrap();

        // First call returns first item
        let item = state.next_item().await;
        assert!(item.is_some());
        assert_eq!(item.unwrap().media_id, 10);
        assert_eq!(state.current_media_id().await, Some(10));

        // Second call returns second item
        let item = state.next_item().await;
        assert!(item.is_some());
        assert_eq!(item.unwrap().media_id, 20);
    }

    #[tokio::test]
    async fn test_clear_playlist() {
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());

        let items = vec![create_test_item(1, 1)];
        state.update_playlist(1, items, false).await.unwrap();

        assert_eq!(state.playlist_id().await, Some(1));

        state.clear_playlist().await;

        assert_eq!(state.playlist_id().await, None);
        assert!(state.is_queue_empty().await);
    }

    #[tokio::test]
    async fn test_set_playing() {
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());

        assert!(!state.is_playing().await);

        state.set_playing(true).await;
        assert!(state.is_playing().await);

        state.set_playing(false).await;
        assert!(!state.is_playing().await);
    }

    #[tokio::test]
    async fn test_update_position() {
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());

        state.update_position(42.5).await;
        assert_eq!(state.current_position().await, Some(42.5));

        state.update_position(100.0).await;
        assert_eq!(state.current_position().await, Some(100.0));
    }

    #[tokio::test]
    async fn test_error_handling() {
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());

        assert_eq!(state.last_error().await, None);

        state.set_error(Some("Test error".to_string())).await;
        assert_eq!(state.last_error().await, Some("Test error".to_string()));

        state.clear_error().await;
        assert_eq!(state.last_error().await, None);
    }

    #[tokio::test]
    async fn test_snapshot() {
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());

        let items = vec![create_test_item(1, 100)];
        state.update_playlist(42, items, true).await.unwrap();
        state.set_playing(true).await;
        state.update_position(10.5).await;

        let snapshot = state.snapshot().await;

        assert_eq!(snapshot.client_id, "test-id");
        assert_eq!(snapshot.playlist_id, Some(42));
        assert_eq!(snapshot.is_playing, true);
        assert_eq!(snapshot.current_position, Some(10.5));
        assert_eq!(snapshot.queue_length, 1);
    }

    #[tokio::test]
    async fn test_jump_to() {
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());

        let items = vec![
            create_test_item(1, 10),
            create_test_item(2, 20),
            create_test_item(3, 30),
        ];

        state.update_playlist(1, items, false).await.unwrap();

        let item = state.jump_to(2).await.unwrap();
        assert_eq!(item.media_id, 30);
        assert_eq!(state.current_media_id().await, Some(30));
        assert_eq!(state.playlist_index().await, Some(2));
    }

    #[tokio::test]
    async fn test_reset_queue() {
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());

        let items = vec![create_test_item(1, 10), create_test_item(2, 20)];

        state.update_playlist(1, items, false).await.unwrap();
        state.next_item().await; // Move to index 0
        state.next_item().await; // Move to index 1

        assert_eq!(state.playlist_index().await, Some(1));

        state.reset_queue().await;
        assert_eq!(state.playlist_index().await, Some(0));
    }

    #[tokio::test]
    async fn test_state_clone() {
        let state1 = AppState::new("test-id".to_string(), "Test Client".to_string());
        let state2 = state1.clone();

        state1.set_playing(true).await;
        assert!(state2.is_playing().await); // Should see the same state
    }
}
