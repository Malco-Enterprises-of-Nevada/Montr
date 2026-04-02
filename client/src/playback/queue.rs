//! Playlist queue management with loop support
//!
//! Manages a queue of playlist items with support for sequential playback,
//! looping, and random access.

use crate::error::{MontrError, Result};
use crate::network::PlaylistItem;

/// Playlist queue
///
/// Maintains an ordered list of playlist items with playback position tracking.
#[derive(Debug, Clone)]
pub struct PlaylistQueue {
    /// Playlist items in order
    items: Vec<PlaylistItem>,

    /// Current index in playlist (None if empty or not started)
    current_index: Option<usize>,

    /// Whether to loop when reaching end
    loop_enabled: bool,

    /// Playlist ID
    playlist_id: Option<u32>,
}

impl PlaylistQueue {
    /// Create an empty playlist queue
    pub fn new() -> Self {
        Self {
            items: Vec::new(),
            current_index: None,
            loop_enabled: false,
            playlist_id: None,
        }
    }

    /// Create a playlist queue from items
    pub fn from_items(items: Vec<PlaylistItem>, loop_enabled: bool, playlist_id: u32) -> Self {
        let current_index = if items.is_empty() { None } else { Some(0) };

        Self {
            items,
            current_index,
            loop_enabled,
            playlist_id: Some(playlist_id),
        }
    }

    /// Get playlist ID
    pub fn playlist_id(&self) -> Option<u32> {
        self.playlist_id
    }

    /// Check if queue is empty
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Get number of items
    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// Get current index
    pub fn current_index(&self) -> Option<usize> {
        self.current_index
    }

    /// Get current item
    pub fn current(&self) -> Option<&PlaylistItem> {
        self.current_index.and_then(|idx| self.items.get(idx))
    }

    /// Get item at specific index
    pub fn get(&self, index: usize) -> Option<&PlaylistItem> {
        self.items.get(index)
    }

    /// Get all items
    pub fn items(&self) -> &[PlaylistItem] {
        &self.items
    }

    /// Move to next item
    ///
    /// Returns the next item, or None if at end (and not looping).
    /// If looping is enabled, wraps around to the beginning.
    #[allow(clippy::should_implement_trait)]
    pub fn next(&mut self) -> Option<&PlaylistItem> {
        if self.items.is_empty() {
            return None;
        }

        let next_index = match self.current_index {
            None => Some(0),
            Some(idx) => {
                let next = idx + 1;
                if next >= self.items.len() {
                    // At end of playlist
                    if self.loop_enabled {
                        Some(0) // Loop to beginning
                    } else {
                        None // Stay at end
                    }
                } else {
                    Some(next)
                }
            }
        };

        self.current_index = next_index;
        next_index.and_then(|idx| self.items.get(idx))
    }

    /// Move to previous item
    ///
    /// Returns the previous item, or None if at beginning (and not looping).
    /// If looping is enabled, wraps around to the end.
    pub fn previous(&mut self) -> Option<&PlaylistItem> {
        if self.items.is_empty() {
            return None;
        }

        let prev_index = match self.current_index {
            None => Some(0),
            Some(0) => {
                // At beginning of playlist
                if self.loop_enabled {
                    Some(self.items.len() - 1) // Loop to end
                } else {
                    Some(0) // Stay at beginning
                }
            }
            Some(idx) => Some(idx - 1),
        };

        self.current_index = prev_index;
        prev_index.and_then(|idx| self.items.get(idx))
    }

    /// Jump to specific index
    pub fn jump_to(&mut self, index: usize) -> Result<&PlaylistItem> {
        if index >= self.items.len() {
            return Err(MontrError::PlaylistError(format!(
                "Index {} out of bounds (len: {})",
                index,
                self.items.len()
            )));
        }

        self.current_index = Some(index);
        Ok(&self.items[index])
    }

    /// Reset to beginning (at first item)
    ///
    /// Sets current_index to 0 so current() returns the first item.
    pub fn reset(&mut self) {
        if !self.items.is_empty() {
            self.current_index = Some(0);
        } else {
            self.current_index = None;
        }
    }

    /// Enable or disable looping
    pub fn set_loop(&mut self, enabled: bool) {
        self.loop_enabled = enabled;
    }

    /// Check if looping is enabled
    pub fn is_looping(&self) -> bool {
        self.loop_enabled
    }

    /// Update playlist items
    ///
    /// Replaces all items and positions before first item (so next() will return the first item).
    pub fn update_items(&mut self, items: Vec<PlaylistItem>, playlist_id: u32) {
        self.items = items;
        self.playlist_id = Some(playlist_id);
        self.current_index = None; // Position before first item
    }

    /// Clear all items
    pub fn clear(&mut self) {
        self.items.clear();
        self.current_index = None;
        self.playlist_id = None;
    }

    /// Check if at end of playlist (and not looping)
    pub fn is_at_end(&self) -> bool {
        if self.loop_enabled {
            false // Never at end if looping
        } else {
            match self.current_index {
                None => true,
                Some(idx) => idx >= self.items.len().saturating_sub(1),
            }
        }
    }

    /// Get remaining item count from current position
    pub fn remaining_count(&self) -> usize {
        match self.current_index {
            None if !self.items.is_empty() => self.items.len(),
            Some(idx) => self.items.len().saturating_sub(idx + 1),
            _ => 0,
        }
    }
}

impl Default for PlaylistQueue {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_item(id: u32, media_id: u32, order_index: u32) -> PlaylistItem {
        PlaylistItem {
            id,
            media_id,
            filename: format!("test_{}.mp4", media_id),
            download_url: format!("http://localhost:3000/api/media/{}/download", media_id),
            media_type: "video".to_string(),
            duration: Some(120.0),
            checksum: Some(format!("checksum_{}", media_id)),
            order_index,
            image_duration: 5,
        }
    }

    #[test]
    fn test_empty_queue() {
        let queue = PlaylistQueue::new();
        assert!(queue.is_empty());
        assert_eq!(queue.len(), 0);
        assert_eq!(queue.current(), None);
        assert_eq!(queue.current_index(), None);
    }

    #[test]
    fn test_queue_creation_with_items() {
        let items = vec![
            create_test_item(1, 1, 0),
            create_test_item(2, 2, 1),
            create_test_item(3, 3, 2),
        ];

        let queue = PlaylistQueue::from_items(items.clone(), true, 42);

        assert!(!queue.is_empty());
        assert_eq!(queue.len(), 3);
        assert_eq!(queue.current_index(), Some(0));
        assert_eq!(queue.is_looping(), true);
        assert_eq!(queue.playlist_id(), Some(42));
    }

    #[test]
    fn test_next_without_loop() {
        let items = vec![
            create_test_item(1, 1, 0),
            create_test_item(2, 2, 1),
            create_test_item(3, 3, 2),
        ];

        let mut queue = PlaylistQueue::from_items(items, false, 1);

        // Start at index 0
        assert_eq!(queue.current_index(), Some(0));

        // Move to index 1
        let next = queue.next();
        assert!(next.is_some());
        assert_eq!(queue.current_index(), Some(1));

        // Move to index 2
        let next = queue.next();
        assert!(next.is_some());
        assert_eq!(queue.current_index(), Some(2));

        // Try to move past end (no loop)
        let next = queue.next();
        assert_eq!(next, None);
        assert_eq!(queue.current_index(), None);
    }

    #[test]
    fn test_next_with_loop() {
        let items = vec![
            create_test_item(1, 1, 0),
            create_test_item(2, 2, 1),
            create_test_item(3, 3, 2),
        ];

        let mut queue = PlaylistQueue::from_items(items, true, 1);

        // Move through all items
        queue.next();
        queue.next();

        // At index 2 (last item)
        assert_eq!(queue.current_index(), Some(2));

        // Should loop back to index 0
        let next = queue.next();
        assert!(next.is_some());
        let next_id = next.unwrap().id;
        assert_eq!(queue.current_index(), Some(0));
        assert_eq!(next_id, 1);
    }

    #[test]
    fn test_previous_without_loop() {
        let items = vec![
            create_test_item(1, 1, 0),
            create_test_item(2, 2, 1),
            create_test_item(3, 3, 2),
        ];

        let mut queue = PlaylistQueue::from_items(items, false, 1);

        // Start at index 0
        assert_eq!(queue.current_index(), Some(0));

        // Try to go previous (should stay at 0)
        let prev = queue.previous();
        assert!(prev.is_some());
        assert_eq!(queue.current_index(), Some(0));
    }

    #[test]
    fn test_previous_with_loop() {
        let items = vec![
            create_test_item(1, 1, 0),
            create_test_item(2, 2, 1),
            create_test_item(3, 3, 2),
        ];

        let mut queue = PlaylistQueue::from_items(items, true, 1);

        // Start at index 0
        assert_eq!(queue.current_index(), Some(0));

        // Go previous (should loop to end)
        let prev = queue.previous();
        assert!(prev.is_some());
        let prev_id = prev.unwrap().id;
        assert_eq!(queue.current_index(), Some(2));
        assert_eq!(prev_id, 3);
    }

    #[test]
    fn test_jump_to() {
        let items = vec![
            create_test_item(1, 1, 0),
            create_test_item(2, 2, 1),
            create_test_item(3, 3, 2),
        ];

        let mut queue = PlaylistQueue::from_items(items, false, 1);

        // Jump to index 2
        let result = queue.jump_to(2);
        assert!(result.is_ok());
        assert_eq!(queue.current_index(), Some(2));

        // Jump to invalid index
        let result = queue.jump_to(10);
        assert!(result.is_err());
    }

    #[test]
    fn test_reset() {
        let items = vec![create_test_item(1, 1, 0), create_test_item(2, 2, 1)];

        let mut queue = PlaylistQueue::from_items(items, false, 1);

        queue.next(); // Move to index 1
        assert_eq!(queue.current_index(), Some(1));

        queue.reset();
        assert_eq!(queue.current_index(), Some(0));
    }

    #[test]
    fn test_clear() {
        let items = vec![create_test_item(1, 1, 0)];
        let mut queue = PlaylistQueue::from_items(items, false, 1);

        queue.clear();
        assert!(queue.is_empty());
        assert_eq!(queue.current_index(), None);
        assert_eq!(queue.playlist_id(), None);
    }

    #[test]
    fn test_is_at_end() {
        let items = vec![create_test_item(1, 1, 0), create_test_item(2, 2, 1)];

        let mut queue = PlaylistQueue::from_items(items.clone(), false, 1);
        assert!(!queue.is_at_end());

        queue.next(); // Move to last item
        assert!(queue.is_at_end());

        // With looping, never at end
        let mut queue_loop = PlaylistQueue::from_items(items, true, 1);
        queue_loop.next();
        assert!(!queue_loop.is_at_end());
    }

    #[test]
    fn test_remaining_count() {
        let items = vec![
            create_test_item(1, 1, 0),
            create_test_item(2, 2, 1),
            create_test_item(3, 3, 2),
        ];

        let mut queue = PlaylistQueue::from_items(items, false, 1);

        // At index 0, 2 items remaining
        assert_eq!(queue.remaining_count(), 2);

        queue.next();
        // At index 1, 1 item remaining
        assert_eq!(queue.remaining_count(), 1);

        queue.next();
        // At index 2, 0 items remaining
        assert_eq!(queue.remaining_count(), 0);
    }

    #[test]
    fn test_update_items() {
        let initial_items = vec![create_test_item(1, 1, 0)];
        let mut queue = PlaylistQueue::from_items(initial_items, false, 1);

        let new_items = vec![create_test_item(2, 2, 0), create_test_item(3, 3, 1)];

        queue.update_items(new_items, 2);

        assert_eq!(queue.len(), 2);
        assert_eq!(queue.current_index(), None); // After update, positioned before first item (next() will return first)
        assert_eq!(queue.playlist_id(), Some(2));
    }

    #[test]
    fn test_set_loop() {
        let mut queue = PlaylistQueue::new();
        assert!(!queue.is_looping());

        queue.set_loop(true);
        assert!(queue.is_looping());

        queue.set_loop(false);
        assert!(!queue.is_looping());
    }
}
