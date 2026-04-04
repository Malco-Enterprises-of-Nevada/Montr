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
use crate::network::{HttpClient, PlaylistItem, ServerMessage};
use crate::playback::engine::{PlaybackCommand, PlaybackEngineOps};
use crate::state::app_state::AppState;
use std::sync::Arc;
use tokio::sync::{mpsc, Notify};
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
    /// Notify signal for download completion events
    download_notify: Arc<Notify>,
    /// Number of upcoming items to pre-fetch
    preload_next_items: usize,
    /// HTTP client for analytics reporting
    http_client: Arc<HttpClient>,
    /// API key for authenticated requests
    api_key: Option<String>,
    /// Current playback log ID (for analytics end reporting)
    current_playback_log_id: Option<u64>,
    /// Time when current media started playing
    playback_start_time: Option<tokio::time::Instant>,
}

impl StateCoordinator {
    /// Create a new state coordinator
    pub fn new(
        state: AppState,
        cache_manager: Arc<CacheManager>,
        http_client: Arc<HttpClient>,
        playback_engine: &impl PlaybackEngineOps,
        cancel_token: CancellationToken,
        preload_next_items: usize,
        api_key: Option<String>,
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
            download_notify: Arc::new(Notify::new()),
            preload_next_items,
            http_client,
            api_key,
            current_playback_log_id: None,
            playback_start_time: None,
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
            CoordinatorMessage::PlaybackEvent(event) => self.handle_playback_event(event).await,
            CoordinatorMessage::DownloadComplete { media_id, success } => {
                self.handle_download_complete(media_id, success).await
            }
        }
    }

    /// Handle server messages
    async fn handle_server_message(&mut self, message: ServerMessage) -> Result<()> {
        match message {
            ServerMessage::PlaylistAssigned(msg) => {
                // Deduplicate: skip if same playlist with same items
                if self
                    .is_playlist_unchanged(msg.playlist_id, &msg.items)
                    .await
                {
                    tracing::debug!(
                        "Playlist {} unchanged, skipping duplicate assignment",
                        msg.playlist_id
                    );
                    return Ok(());
                }

                tracing::info!(
                    "Playlist assigned: {} ({} items)",
                    msg.playlist_name,
                    msg.items.len()
                );

                // Normal assignment clears any interrupt context
                self.state.clear_interrupt_stack().await;

                // End current analytics session
                self.end_analytics_session(false).await;

                // Update state with new playlist
                self.state
                    .update_playlist(msg.playlist_id, msg.items.clone(), msg.loop_playlist)
                    .await?;

                // Download media and start playback as soon as first item is ready
                self.download_and_start(msg.items).await?;

                Ok(())
            }
            ServerMessage::PlaylistUpdated(msg) => {
                if self
                    .is_playlist_unchanged(msg.playlist_id, &msg.items)
                    .await
                {
                    tracing::debug!("Playlist update unchanged, skipping");
                    return Ok(());
                }

                tracing::info!("Playlist updated: {} items", msg.items.len());

                let current_media_id = self.state.current_media_id().await;
                let new_items_have_current = current_media_id
                    .map(|id| msg.items.iter().any(|item| item.media_id == id))
                    .unwrap_or(false);

                self.state
                    .update_playlist(msg.playlist_id, msg.items.clone(), msg.loop_playlist)
                    .await?;

                let ready = self.download_playlist_media(msg.items).await?;

                if !new_items_have_current && ready > 0 {
                    tracing::info!("Current media not in updated playlist, restarting");
                    self.end_analytics_session(false).await;
                    self.start_playback().await?;
                }

                Ok(())
            }
            ServerMessage::PlaylistInterrupt(msg) => {
                tracing::info!(
                    "Playlist interrupt: {} ({} items)",
                    msg.playlist_name,
                    msg.items.len()
                );

                // Save current playlist onto interrupt stack for resume
                self.state.push_interrupt().await;

                self.end_analytics_session(false).await;

                self.state
                    .update_playlist(msg.playlist_id, msg.items.clone(), msg.loop_playlist)
                    .await?;

                self.download_and_start(msg.items).await?;
                Ok(())
            }
            ServerMessage::PlaylistResume(msg) => {
                tracing::info!(
                    "Playlist resume: {}",
                    msg.playlist_name.as_deref().unwrap_or("(stop)")
                );

                let _restored = self.state.pop_interrupt().await;
                self.end_analytics_session(false).await;

                if let Some(playlist_id) = msg.playlist_id {
                    self.state
                        .update_playlist(playlist_id, msg.items.clone(), msg.loop_playlist)
                        .await?;
                    self.download_and_start(msg.items).await?;
                } else {
                    self.state.clear_playlist().await;
                    self.playback_tx
                        .send(PlaybackCommand::Stop)
                        .map_err(|e| MontrError::Playback(format!("Failed to send stop: {}", e)))?;
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
                        self.playback_tx.send(PlaybackCommand::Pause).map_err(|e| {
                            MontrError::Playback(format!("Failed to send pause command: {}", e))
                        })?;
                        self.state.set_playing(false).await;
                    }
                    "resume" => {
                        self.playback_tx
                            .send(PlaybackCommand::Resume)
                            .map_err(|e| {
                                MontrError::Playback(format!(
                                    "Failed to send resume command: {}",
                                    e
                                ))
                            })?;
                        self.state.set_playing(true).await;
                    }
                    "skip" => {
                        self.end_analytics_session(false).await;
                        if let Some(next_item) = self.state.next_item().await {
                            self.play_media(next_item).await?;
                            self.preload_upcoming();
                        }
                    }
                    "previous" => {
                        self.end_analytics_session(false).await;
                        if let Some(prev_item) = self.state.previous_item().await {
                            self.play_media(prev_item).await?;
                        }
                    }
                    "volume" => {
                        if let Some(level) = cmd
                            .args
                            .as_ref()
                            .and_then(|a| a.get("level"))
                            .and_then(|v| v.as_f64())
                        {
                            self.playback_tx
                                .send(PlaybackCommand::Volume { level })
                                .map_err(|e| {
                                    MontrError::Playback(format!("Failed to send volume: {}", e))
                                })?;
                        }
                    }
                    "seek" => {
                        if let Some(position) = cmd
                            .args
                            .as_ref()
                            .and_then(|a| a.get("position"))
                            .and_then(|v| v.as_f64())
                        {
                            self.playback_tx
                                .send(PlaybackCommand::Seek { position })
                                .map_err(|e| {
                                    MontrError::Playback(format!("Failed to send seek: {}", e))
                                })?;
                        }
                    }
                    _ => {
                        tracing::warn!("Unknown command: {}", cmd.command);
                    }
                }

                Ok(())
            }
            ServerMessage::Success(msg) => {
                tracing::info!("Server: {}", msg.message);
                Ok(())
            }
            ServerMessage::ErrorResponse(msg) => {
                tracing::error!("Server error: {}", msg.error);
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
                self.end_analytics_session(true).await;

                // Advance to next item
                if let Some(next_item) = self.state.next_item().await {
                    self.play_media(next_item).await?;
                    self.preload_upcoming();
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

    /// Download all media for playlist items and wait for completion
    async fn download_playlist_media(&self, items: Vec<PlaylistItem>) -> Result<usize> {
        let total = items.len();
        tracing::info!("Downloading {} media files before playback...", total);

        let (progress_tx, mut progress_rx) = mpsc::unbounded_channel();

        // Relay task: notify waiters after each individual download completes
        let notify = self.download_notify.clone();
        let relay_handle = tokio::spawn(async move {
            while (progress_rx.recv().await).is_some() {
                notify.notify_waiters();
            }
        });

        let results = self
            .cache_manager
            .download_batch(items, Some(progress_tx))
            .await;

        let success_count = results.iter().filter(|(_, r)| r.is_ok()).count();
        let failure_count = total - success_count;

        tracing::info!(
            "All downloads complete: {}/{} ready, {} failed",
            success_count,
            total,
            failure_count
        );

        self.download_notify.notify_waiters();
        let _ = relay_handle.await;

        Ok(success_count)
    }

    /// Pre-download upcoming items in the background
    fn preload_upcoming(&self) {
        if self.preload_next_items == 0 {
            return;
        }
        let state = self.state.clone();
        let cache_manager = self.cache_manager.clone();
        let count = self.preload_next_items;

        tokio::spawn(async move {
            let upcoming = state.get_upcoming_items(count).await;
            for item in upcoming {
                if !cache_manager.is_cached(item.media_id, &item.filename).await {
                    tracing::debug!("Preloading media {}: {}", item.media_id, item.filename);
                    let checksum = item.checksum.clone().unwrap_or_default();
                    let cm = cache_manager.clone();
                    tokio::spawn(async move {
                        if let Err(e) = cm
                            .download_media(item.media_id, &item.filename, &checksum)
                            .await
                        {
                            tracing::warn!("Preload failed for media {}: {}", item.media_id, e);
                        }
                    });
                }
            }
        });
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

    /// Check if incoming playlist matches current (deduplication)
    async fn is_playlist_unchanged(&self, playlist_id: u32, items: &[PlaylistItem]) -> bool {
        if self.state.playlist_id().await != Some(playlist_id) {
            return false;
        }
        let current = self.state.queue_items().await;
        if current.len() != items.len() {
            return false;
        }
        current
            .iter()
            .zip(items.iter())
            .all(|(a, b)| a.media_id == b.media_id && a.order_index == b.order_index)
    }

    /// Download media and start playback as soon as first item is cached
    async fn download_and_start(&mut self, items: Vec<PlaylistItem>) -> Result<()> {
        if items.is_empty() {
            tracing::warn!("No media files to download");
            return Ok(());
        }

        let first_item = items[0].clone();
        let first_cached = self
            .cache_manager
            .is_cached(first_item.media_id, &first_item.filename)
            .await;

        if first_cached {
            // First item already cached — start immediately, download rest in background
            tracing::info!("First item cached, starting playback immediately");
            self.start_playback().await?;
            let cm = self.cache_manager.clone();
            let remaining = items.into_iter().skip(1).collect::<Vec<_>>();
            if !remaining.is_empty() {
                tokio::spawn(async move {
                    cm.download_batch(remaining, None).await;
                });
            }
        } else {
            // Need to download — start playback as soon as first completes
            let ready = self.download_playlist_media(items).await?;
            if ready > 0 {
                tracing::info!("{} media files cached, starting playback", ready);
                self.start_playback().await?;
            } else {
                tracing::warn!("No media files available, playback not started");
            }
        }
        Ok(())
    }

    /// Report playback start to analytics
    async fn start_analytics_session(&mut self, media_id: u32) {
        let client_id = self.state.client_id().await;
        let api_key = self.api_key.as_deref();
        match self
            .http_client
            .report_playback_start(&client_id, media_id, api_key)
            .await
        {
            Ok(Some(log_id)) => {
                self.current_playback_log_id = Some(log_id);
                self.playback_start_time = Some(tokio::time::Instant::now());
                tracing::debug!("Analytics: started session {}", log_id);
            }
            Ok(None) => {
                self.current_playback_log_id = None;
                self.playback_start_time = None;
            }
            Err(e) => {
                tracing::debug!("Analytics start error: {}", e);
                self.current_playback_log_id = None;
                self.playback_start_time = None;
            }
        }
    }

    /// Report playback end to analytics
    async fn end_analytics_session(&mut self, completed: bool) {
        if let (Some(log_id), Some(start_time)) =
            (self.current_playback_log_id, self.playback_start_time)
        {
            let duration = start_time.elapsed().as_secs_f64();
            let api_key = self.api_key.as_deref();
            let _ = self
                .http_client
                .report_playback_end(log_id, duration, completed, api_key)
                .await;
            tracing::debug!(
                "Analytics: ended session {} ({}s, completed={})",
                log_id,
                duration as u32,
                completed
            );
        }
        self.current_playback_log_id = None;
        self.playback_start_time = None;
    }

    /// Play a specific media item
    async fn play_media(&mut self, item: PlaylistItem) -> Result<()> {
        let media_id = item.media_id;
        let filename = &item.filename;

        tracing::info!("Playing media {}: {}", media_id, filename);

        // Get cache path
        let cache_path = self.cache_manager.get_cache_path(media_id, filename);

        // Wait for download if not cached
        if !cache_path.exists() {
            tracing::info!("Media {} not cached, waiting for download", media_id);

            let deadline = tokio::time::Instant::now() + tokio::time::Duration::from_secs(30);
            loop {
                if cache_path.exists() {
                    break;
                }
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                if remaining.is_zero() {
                    tracing::warn!(
                        "Media {} not available after timeout, skipping to next",
                        media_id
                    );
                    // Signal end-of-file so the coordinator loop advances
                    let _ = self.playback_tx.send(PlaybackCommand::Stop);
                    return Ok(());
                }
                tokio::select! {
                    _ = self.download_notify.notified() => {}
                    _ = tokio::time::sleep(remaining) => {}
                }
            }
        }

        // Send play command to engine
        self.playback_tx
            .send(PlaybackCommand::Play {
                path: cache_path,
                is_video: item.media_type == "video",
                image_duration: Some(item.image_duration),
            })
            .map_err(|e| MontrError::Playback(format!("Failed to send play command: {}", e)))?;

        // Report analytics
        self.start_analytics_session(media_id).await;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::HttpClient;
    use crate::network::PlaylistAssignedMessage;
    use crate::playback::engine::MockPlaybackEngineOps;
    use tempfile::TempDir;

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

    fn create_mock_playback_engine() -> MockPlaybackEngineOps {
        let mut mock = MockPlaybackEngineOps::new();

        // Create a channel that persists across calls
        let (tx, mut rx) = mpsc::unbounded_channel::<PlaybackCommand>();

        // Spawn a task to consume commands so the channel doesn't fill up
        tokio::spawn(async move {
            while let Some(_cmd) = rx.recv().await {
                // Just consume the commands in tests
            }
        });

        mock.expect_command_sender().returning(move || tx.clone());

        mock
    }

    #[tokio::test]
    async fn test_coordinator_creation() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client = Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client.clone(),
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let playback_engine = create_mock_playback_engine();
        let coordinator = StateCoordinator::new(
            state,
            cache_manager,
            http_client,
            &playback_engine,
            cancel_token,
            2,
            None,
        );

        // Should be able to get message sender
        let _sender = coordinator.message_sender();
    }

    #[tokio::test]
    async fn test_playlist_assigned_message() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client = Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client.clone(),
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let playback_engine = create_mock_playback_engine();
        let mut coordinator = StateCoordinator::new(
            state.clone(),
            cache_manager.clone(),
            http_client.clone(),
            &playback_engine,
            cancel_token,
            2,
            None,
        );

        let items = vec![create_test_item(1, 1), create_test_item(2, 2)];

        // Create dummy media files in cache
        for item in &items {
            let cache_path = cache_manager.get_cache_path(item.media_id, &item.filename);
            std::fs::create_dir_all(cache_path.parent().unwrap()).unwrap();
            std::fs::write(&cache_path, b"dummy video data").unwrap();
        }

        let message = ServerMessage::PlaylistAssigned(PlaylistAssignedMessage {
            playlist_id: 42,
            playlist_name: "Test Playlist".to_string(),
            items: items.clone(),
            loop_playlist: true,
        });

        // Handle message
        coordinator.handle_server_message(message).await.unwrap();

        // Verify state was updated
        assert_eq!(state.playlist_id().await, Some(42));
        assert_eq!(state.queue_length().await, 2);
    }

    #[tokio::test]
    async fn test_playback_event_media_finished() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client = Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client.clone(),
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let playback_engine = create_mock_playback_engine();
        let mut coordinator = StateCoordinator::new(
            state.clone(),
            cache_manager.clone(),
            http_client.clone(),
            &playback_engine,
            cancel_token,
            2,
            None,
        );

        // Set up playlist
        let items = vec![create_test_item(1, 1), create_test_item(2, 2)];

        // Create dummy media files in cache
        for item in &items {
            let cache_path = cache_manager.get_cache_path(item.media_id, &item.filename);
            std::fs::create_dir_all(cache_path.parent().unwrap()).unwrap();
            std::fs::write(&cache_path, b"dummy video data").unwrap();
        }

        state.update_playlist(1, items, false).await.unwrap();
        state.set_current_media(Some(1)).await;
        state.set_playing(true).await;

        // Verify initial state
        assert_eq!(state.current_media_id().await, Some(1));
        assert_eq!(state.is_playing().await, true);

        // Handle media finished event
        let event = PlaybackEventMessage::MediaFinished { media_id: 1 };
        coordinator.handle_playback_event(event).await.unwrap();

        // After handling MediaFinished:
        // - Playing should be set to false
        // - A PlaybackCommand should have been sent (we can't verify this directly in this test)
        // - The current_media_id won't change until MediaStarted event is received
        assert_eq!(state.is_playing().await, false);

        // Simulate the MediaStarted event that would come from the playback engine
        let started_event = PlaybackEventMessage::MediaStarted { media_id: 2 };
        coordinator
            .handle_playback_event(started_event)
            .await
            .unwrap();

        // Now state should reflect the next media
        assert_eq!(state.current_media_id().await, Some(2));
        assert_eq!(state.is_playing().await, true);
    }

    #[tokio::test]
    async fn test_coordinator_message_sender() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client = Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client.clone(),
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let playback_engine = create_mock_playback_engine();
        let coordinator = StateCoordinator::new(
            state,
            cache_manager,
            http_client,
            &playback_engine,
            cancel_token,
            2,
            None,
        );

        let sender = coordinator.message_sender();

        // Should be able to send messages
        let msg = CoordinatorMessage::DownloadComplete {
            media_id: 1,
            success: true,
        };

        assert!(sender.send(msg).is_ok());
    }

    #[tokio::test]
    async fn test_command_pause() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client = Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client.clone(),
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let playback_engine = create_mock_playback_engine();
        let mut coordinator = StateCoordinator::new(
            state.clone(),
            cache_manager,
            http_client,
            &playback_engine,
            cancel_token,
            2,
            None,
        );

        state.set_playing(true).await;

        let cmd = ServerMessage::Command(crate::network::CommandMessage {
            command: "pause".to_string(),
            args: None,
        });
        coordinator.handle_server_message(cmd).await.unwrap();

        assert_eq!(state.is_playing().await, false);
    }

    #[tokio::test]
    async fn test_command_resume() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client = Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client.clone(),
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let playback_engine = create_mock_playback_engine();
        let mut coordinator = StateCoordinator::new(
            state.clone(),
            cache_manager,
            http_client,
            &playback_engine,
            cancel_token,
            2,
            None,
        );

        state.set_playing(false).await;

        let cmd = ServerMessage::Command(crate::network::CommandMessage {
            command: "resume".to_string(),
            args: None,
        });
        coordinator.handle_server_message(cmd).await.unwrap();

        assert_eq!(state.is_playing().await, true);
    }

    #[tokio::test]
    async fn test_command_reload_playlist() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client = Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client.clone(),
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let playback_engine = create_mock_playback_engine();
        let mut coordinator = StateCoordinator::new(
            state.clone(),
            cache_manager.clone(),
            http_client.clone(),
            &playback_engine,
            cancel_token,
            2,
            None,
        );

        // Set up playlist with cached files
        let items = vec![create_test_item(1, 1), create_test_item(2, 2)];
        for item in &items {
            let cache_path = cache_manager.get_cache_path(item.media_id, &item.filename);
            std::fs::create_dir_all(cache_path.parent().unwrap()).unwrap();
            std::fs::write(&cache_path, b"dummy video data").unwrap();
        }
        state.update_playlist(1, items, true).await.unwrap();
        // Advance past the first item
        state.next_item().await;

        let cmd = ServerMessage::Command(crate::network::CommandMessage {
            command: "reload_playlist".to_string(),
            args: None,
        });
        coordinator.handle_server_message(cmd).await.unwrap();

        // After reload, queue should still have items and be reset to beginning
        assert_eq!(state.queue_length().await, 2);
        assert_eq!(state.playlist_index().await, Some(0));
    }

    #[tokio::test]
    async fn test_command_skip() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client = Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client.clone(),
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let playback_engine = create_mock_playback_engine();
        let mut coordinator = StateCoordinator::new(
            state.clone(),
            cache_manager.clone(),
            http_client.clone(),
            &playback_engine,
            cancel_token,
            2,
            None,
        );

        // Set up playlist with 2 items and create cached files
        let items = vec![create_test_item(1, 1), create_test_item(2, 2)];
        for item in &items {
            let cache_path = cache_manager.get_cache_path(item.media_id, &item.filename);
            std::fs::create_dir_all(cache_path.parent().unwrap()).unwrap();
            std::fs::write(&cache_path, b"dummy video data").unwrap();
        }
        state.update_playlist(1, items, false).await.unwrap();
        // Position at first item
        state.next_item().await;
        state.set_playing(true).await;

        let cmd = ServerMessage::Command(crate::network::CommandMessage {
            command: "skip".to_string(),
            args: None,
        });
        coordinator.handle_server_message(cmd).await.unwrap();

        // After skip, state should have advanced: current media updated to item 2
        assert_eq!(state.current_media_id().await, Some(2));
    }

    #[tokio::test]
    async fn test_command_unknown() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client = Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client.clone(),
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let playback_engine = create_mock_playback_engine();
        let mut coordinator = StateCoordinator::new(
            state.clone(),
            cache_manager,
            http_client,
            &playback_engine,
            cancel_token,
            2,
            None,
        );

        let cmd = ServerMessage::Command(crate::network::CommandMessage {
            command: "nonexistent_command".to_string(),
            args: None,
        });
        // Should return Ok without panicking
        let result = coordinator.handle_server_message(cmd).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_playback_error_sets_error_state() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client = Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client.clone(),
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let playback_engine = create_mock_playback_engine();
        let mut coordinator = StateCoordinator::new(
            state.clone(),
            cache_manager,
            http_client,
            &playback_engine,
            cancel_token,
            2,
            None,
        );

        state.set_playing(true).await;

        let event = PlaybackEventMessage::Error {
            media_id: 1,
            error: "codec not supported".to_string(),
        };
        coordinator.handle_playback_event(event).await.unwrap();

        assert_eq!(
            state.last_error().await,
            Some("codec not supported".to_string())
        );
        assert_eq!(state.is_playing().await, false);
    }

    #[tokio::test]
    async fn test_position_update() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client = Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client.clone(),
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let playback_engine = create_mock_playback_engine();
        let mut coordinator = StateCoordinator::new(
            state.clone(),
            cache_manager,
            http_client,
            &playback_engine,
            cancel_token,
            2,
            None,
        );

        let event = PlaybackEventMessage::PositionUpdate { position: 42.5 };
        coordinator.handle_playback_event(event).await.unwrap();

        assert_eq!(state.current_position().await, Some(42.5));
    }

    #[tokio::test]
    async fn test_media_started_updates_state() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client = Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client.clone(),
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let playback_engine = create_mock_playback_engine();
        let mut coordinator = StateCoordinator::new(
            state.clone(),
            cache_manager,
            http_client,
            &playback_engine,
            cancel_token,
            2,
            None,
        );

        // Initially not playing, no current media
        assert_eq!(state.current_media_id().await, None);
        assert_eq!(state.is_playing().await, false);

        let event = PlaybackEventMessage::MediaStarted { media_id: 1 };
        coordinator.handle_playback_event(event).await.unwrap();

        assert_eq!(state.current_media_id().await, Some(1));
        assert_eq!(state.is_playing().await, true);
        assert_eq!(state.current_position().await, Some(0.0));
    }

    #[tokio::test]
    async fn test_download_complete_success() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client = Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client.clone(),
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let playback_engine = create_mock_playback_engine();
        let mut coordinator = StateCoordinator::new(
            state.clone(),
            cache_manager,
            http_client,
            &playback_engine,
            cancel_token,
            2,
            None,
        );

        // Should succeed without error
        let result = coordinator.handle_download_complete(1, true).await;
        assert!(result.is_ok());

        // Also test the failure case - should still return Ok (just logs a warning)
        let result = coordinator.handle_download_complete(2, false).await;
        assert!(result.is_ok());

        // No error should be set in state
        assert_eq!(state.last_error().await, None);
    }

    #[tokio::test]
    async fn test_run_exits_on_cancel() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client = Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client.clone(),
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let playback_engine = create_mock_playback_engine();
        let coordinator = StateCoordinator::new(
            state,
            cache_manager,
            http_client,
            &playback_engine,
            cancel_token.clone(),
            2,
            None,
        );

        // Cancel immediately
        cancel_token.cancel();

        // run() should exit cleanly
        let result =
            tokio::time::timeout(std::time::Duration::from_secs(5), coordinator.run()).await;

        assert!(result.is_ok(), "run() should have completed before timeout");
        assert!(
            result.unwrap().is_ok(),
            "run() should return Ok on cancellation"
        );
    }
}
