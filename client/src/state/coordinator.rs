//! State coordinator - routes messages between subsystems
//!
//! Acts as the central message hub that:
//! - Receives server messages from WebSocket
//! - Updates application state
//! - Triggers downloads via CacheManager
//! - Sends commands to PlaybackEngine
//! - Emits status updates for reporter

use crate::cache::CacheManager;
use crate::error::{MontrError, Result};
use crate::network::{PlaylistItem, ServerMessage};
use crate::playback::engine::{PlaybackCommand, PlaybackEngine};
use crate::state::app_state::AppState;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Message types for internal communication
#[derive(Debug, Clone)]
pub enum CoordinatorMessage {
    /// Server message received via WebSocket
    ServerMessage(ServerMessage),
    /// Playback event from engine
    PlaybackEvent(PlaybackEventMessage),
    /// Download complete
    DownloadComplete { media_id: u32, success: bool },
}

/// Playback events from the engine
#[derive(Debug, Clone)]
pub enum PlaybackEventMessage {
    /// Media finished playing
    MediaFinished { media_id: u32 },
    /// Media started playing
    MediaStarted { media_id: u32 },
    /// Playback error occurred
    Error { media_id: u32, error: String },
    /// Position update
    PositionUpdate { position: f64 },
}

/// State coordinator
///
/// Manages message routing and coordinates between different subsystems.
pub struct StateCoordinator {
    /// Application state
    state: AppState,
    /// Cache manager
    cache_manager: Arc<CacheManager>,
    /// Playback engine command sender
    playback_tx: mpsc::UnboundedSender<PlaybackCommand>,
    /// Message receiver
    message_rx: mpsc::UnboundedReceiver<CoordinatorMessage>,
    /// Message sender (for cloning)
    message_tx: mpsc::UnboundedSender<CoordinatorMessage>,
    /// Cancellation token
    cancel_token: CancellationToken,
}

impl StateCoordinator {
    /// Create a new state coordinator
    pub fn new(
        state: AppState,
        cache_manager: Arc<CacheManager>,
        playback_engine: &PlaybackEngine,
        cancel_token: CancellationToken,
    ) -> Self {
        let (message_tx, message_rx) = mpsc::unbounded_channel();
        let playback_tx = playback_engine.command_sender();

        Self {
            state,
            cache_manager,
            playback_tx,
            message_rx,
            message_tx,
            cancel_token,
        }
    }

    /// Get a message sender for other subsystems to send messages
    pub fn message_sender(&self) -> mpsc::UnboundedSender<CoordinatorMessage> {
        self.message_tx.clone()
    }

    /// Run the coordinator loop
    pub async fn run(mut self) -> Result<()> {
        tracing::info!("State coordinator started");

        loop {
            tokio::select! {
                _ = self.cancel_token.cancelled() => {
                    tracing::info!("State coordinator shutting down");
                    break;
                }
                Some(message) = self.message_rx.recv() => {
                    if let Err(e) = self.handle_message(message).await {
                        tracing::error!("Failed to handle coordinator message: {}", e);
                        self.state.set_error(Some(e.to_string())).await;
                    }
                }
                else => {
                    tracing::debug!("Coordinator message channel closed");
                    break;
                }
            }
        }

        Ok(())
    }

    /// Handle a coordinator message
    async fn handle_message(&mut self, message: CoordinatorMessage) -> Result<()> {
        match message {
            CoordinatorMessage::ServerMessage(server_msg) => {
                self.handle_server_message(server_msg).await
            }
            CoordinatorMessage::PlaybackEvent(event) => {
                self.handle_playback_event(event).await
            }
            CoordinatorMessage::DownloadComplete { media_id, success } => {
                self.handle_download_complete(media_id, success).await
            }
        }
    }

    /// Handle server messages
    async fn handle_server_message(&mut self, message: ServerMessage) -> Result<()> {
        match message {
            ServerMessage::PlaylistAssigned(msg) => {
                tracing::info!(
                    "Playlist assigned: {} ({} items)",
                    msg.playlist_name,
                    msg.items.len()
                );

                // Update state with new playlist
                self.state
                    .update_playlist(msg.playlist_id, msg.items.clone(), msg.loop_playlist)
                    .await?;

                // Trigger downloads for all media
                self.download_playlist_media(msg.items).await?;

                // Start playback once downloads are ready
                self.start_playback().await?;

                Ok(())
            }
            ServerMessage::PlaylistUpdated(msg) => {
                tracing::info!("Playlist updated: {} items", msg.items.len());

                // Check if we need to stop current playback
                let current_media_id = self.state.current_media_id().await;
                let new_items_have_current = current_media_id
                    .map(|id| msg.items.iter().any(|item| item.media.id == id))
                    .unwrap_or(false);

                // Update playlist
                self.state
                    .update_playlist(msg.playlist_id, msg.items.clone(), msg.loop_playlist)
                    .await?;

                // Download new media
                self.download_playlist_media(msg.items).await?;

                // If current media is no longer in playlist, restart from beginning
                if !new_items_have_current {
                    tracing::info!("Current media not in updated playlist, restarting");
                    self.start_playback().await?;
                }

                Ok(())
            }
            ServerMessage::Command(cmd) => {
                tracing::info!("Received command: {}", cmd.command);

                match cmd.command.as_str() {
                    "reload_playlist" => {
                        self.state.reset_queue().await;
                        self.start_playback().await?;
                    }
                    "pause" => {
                        self.playback_tx
                            .send(PlaybackCommand::Pause)
                            .map_err(|e| MontrError::Playback(format!("Failed to send pause command: {}", e)))?;
                        self.state.set_playing(false).await;
                    }
                    "resume" => {
                        self.playback_tx
                            .send(PlaybackCommand::Resume)
                            .map_err(|e| MontrError::Playback(format!("Failed to send resume command: {}", e)))?;
                        self.state.set_playing(true).await;
                    }
                    "skip" => {
                        if let Some(next_item) = self.state.next_item().await {
                            self.play_media(next_item).await?;
                        }
                    }
                    "previous" => {
                        if let Some(prev_item) = self.state.previous_item().await {
                            self.play_media(prev_item).await?;
                        }
                    }
                    _ => {
                        tracing::warn!("Unknown command: {}", cmd.command);
                    }
                }

                Ok(())
            }
        }
    }

    /// Handle playback events
    async fn handle_playback_event(&mut self, event: PlaybackEventMessage) -> Result<()> {
        match event {
            PlaybackEventMessage::MediaFinished { media_id } => {
                tracing::info!("Media {} finished, advancing to next", media_id);

                self.state.set_playing(false).await;

                // Advance to next item
                if let Some(next_item) = self.state.next_item().await {
                    self.play_media(next_item).await?;
                } else {
                    tracing::info!("Playlist finished (not looping)");
                }

                Ok(())
            }
            PlaybackEventMessage::MediaStarted { media_id } => {
                tracing::info!("Media {} started", media_id);

                self.state.set_current_media(Some(media_id)).await;
                self.state.set_playing(true).await;
                self.state.update_position(0.0).await;

                Ok(())
            }
            PlaybackEventMessage::Error { media_id, error } => {
                tracing::error!("Playback error for media {}: {}", media_id, error);

                self.state.set_error(Some(error)).await;
                self.state.set_playing(false).await;

                // Try to skip to next item
                if let Some(next_item) = self.state.next_item().await {
                    tracing::info!("Skipping to next item after error");
                    self.play_media(next_item).await?;
                }

                Ok(())
            }
            PlaybackEventMessage::PositionUpdate { position } => {
                self.state.update_position(position).await;
                Ok(())
            }
        }
    }

    /// Handle download completion
    async fn handle_download_complete(&mut self, media_id: u32, success: bool) -> Result<()> {
        if success {
            tracing::info!("Download complete for media {}", media_id);
        } else {
            tracing::warn!("Download failed for media {}", media_id);
        }

        Ok(())
    }

    /// Download media for playlist items
    async fn download_playlist_media(&self, items: Vec<PlaylistItem>) -> Result<()> {
        tracing::info!("Starting download of {} media files", items.len());

        let cache_manager = self.cache_manager.clone();

        // Spawn background task for downloads
        tokio::spawn(async move {
            let results = cache_manager.download_batch(items, None).await;

            let success_count = results.iter().filter(|(_, r)| r.is_ok()).count();
            let failure_count = results.len() - success_count;

            tracing::info!(
                "Batch download complete: {} succeeded, {} failed",
                success_count,
                failure_count
            );
        });

        Ok(())
    }

    /// Start playback from current queue position
    async fn start_playback(&mut self) -> Result<()> {
        if self.state.is_queue_empty().await {
            tracing::warn!("Cannot start playback: queue is empty");
            return Ok(());
        }

        // Get current or first item
        let item = if let Some(current) = self.state.current_queue_item().await {
            current
        } else if let Some(first) = self.state.next_item().await {
            first
        } else {
            tracing::warn!("No items available for playback");
            return Ok(());
        };

        self.play_media(item).await
    }

    /// Play a specific media item
    async fn play_media(&self, item: PlaylistItem) -> Result<()> {
        let media_id = item.media.id;
        let filename = &item.media.filename;

        tracing::info!("Playing media {}: {}", media_id, filename);

        // Get cache path
        let cache_path = self.cache_manager.get_cache_path(media_id, filename);

        // Wait for download if not cached
        if !cache_path.exists() {
            tracing::info!("Media {} not cached, waiting for download", media_id);

            // TODO: Implement proper wait mechanism
            // For now, just check periodically
            for _ in 0..30 {
                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                if cache_path.exists() {
                    break;
                }
            }

            if !cache_path.exists() {
                return Err(MontrError::MediaNotFound(cache_path.clone()));
            }
        }

        // Send play command to engine
        self.playback_tx
            .send(PlaybackCommand::Play {
                path: cache_path,
                is_video: item.media.media_type == "video",
                image_duration: item.image_duration,
            })
            .map_err(|e| MontrError::Playback(format!("Failed to send play command: {}", e)))?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::HttpClient;
    use crate::network::{MediaInfo, PlaylistAssignedMessage};
    use tempfile::TempDir;

    fn create_test_item(id: u32, media_id: u32) -> PlaylistItem {
        PlaylistItem {
            id,
            media_id,
            order_index: id - 1,
            media: MediaInfo {
                id: media_id,
                filename: format!("test_{}.mp4", media_id),
                filepath: format!("/storage/test_{}.mp4", media_id),
                media_type: "video".to_string(),
                duration: Some(120.0),
                resolution: Some("1920x1080".to_string()),
                file_size: 1024000,
                checksum: format!("checksum_{}", media_id),
            },
            image_duration: None,
        }
    }

    #[tokio::test]
    async fn test_coordinator_creation() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client = Arc::new(HttpClient::new("http://localhost:3000".to_string()).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client,
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let playback_engine = PlaybackEngine::new(cancel_token.clone()).unwrap();
        let coordinator = StateCoordinator::new(
            state,
            cache_manager,
            &playback_engine,
            cancel_token,
        );

        // Should be able to get message sender
        let _sender = coordinator.message_sender();
    }

    #[tokio::test]
    async fn test_playlist_assigned_message() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client = Arc::new(HttpClient::new("http://localhost:3000".to_string()).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client,
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let playback_engine = PlaybackEngine::new(cancel_token.clone()).unwrap();
        let mut coordinator = StateCoordinator::new(
            state.clone(),
            cache_manager,
            &playback_engine,
            cancel_token,
        );

        let items = vec![create_test_item(1, 1), create_test_item(2, 2)];

        let message = ServerMessage::PlaylistAssigned(PlaylistAssignedMessage {
            playlist_id: 42,
            playlist_name: "Test Playlist".to_string(),
            items: items.clone(),
            loop_playlist: true,
        });

        // Handle message
        coordinator
            .handle_server_message(message)
            .await
            .unwrap();

        // Verify state was updated
        assert_eq!(state.playlist_id().await, Some(42));
        assert_eq!(state.queue_length().await, 2);
    }

    #[tokio::test]
    async fn test_playback_event_media_finished() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client = Arc::new(HttpClient::new("http://localhost:3000".to_string()).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client,
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let playback_engine = PlaybackEngine::new(cancel_token.clone()).unwrap();
        let mut coordinator = StateCoordinator::new(
            state.clone(),
            cache_manager,
            &playback_engine,
            cancel_token,
        );

        // Set up playlist
        let items = vec![create_test_item(1, 1), create_test_item(2, 2)];
        state.update_playlist(1, items, false).await.unwrap();
        state.set_playing(true).await;

        // Handle media finished event
        let event = PlaybackEventMessage::MediaFinished { media_id: 1 };
        coordinator.handle_playback_event(event).await.unwrap();

        // State should advance to next
        assert_eq!(state.current_media_id().await, Some(2));
    }

    #[tokio::test]
    async fn test_coordinator_message_sender() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client = Arc::new(HttpClient::new("http://localhost:3000".to_string()).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client,
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let playback_engine = PlaybackEngine::new(cancel_token.clone()).unwrap();
        let coordinator = StateCoordinator::new(
            state,
            cache_manager,
            &playback_engine,
            cancel_token,
        );

        let sender = coordinator.message_sender();

        // Should be able to send messages
        let msg = CoordinatorMessage::DownloadComplete {
            media_id: 1,
            success: true,
        };

        assert!(sender.send(msg).is_ok());
    }
}
