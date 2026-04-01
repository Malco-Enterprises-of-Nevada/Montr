//! Status reporter for heartbeat and status updates
//!
//! Sends periodic heartbeat (30s) and status (10s) messages to the server
//! via WebSocket connection.

use crate::error::Result;
use crate::network::protocol::ClientMessage;
use crate::state::app_state::AppState;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::time::{interval, Duration};
use tokio_util::sync::CancellationToken;

/// Status reporter
///
/// Spawns background tasks to send periodic heartbeat and status updates.
pub struct StatusReporter {
    /// Application state
    state: Arc<AppState>,
    /// WebSocket message sender
    ws_tx: mpsc::UnboundedSender<ClientMessage>,
    /// Cancellation token
    cancel_token: CancellationToken,
    /// Heartbeat interval in seconds
    heartbeat_interval_secs: u64,
    /// Status update interval in seconds
    status_interval_secs: u64,
}

impl StatusReporter {
    /// Create a new status reporter
    ///
    /// # Arguments
    /// * `state` - Application state to read from
    /// * `ws_tx` - WebSocket sender for messages
    /// * `heartbeat_interval_secs` - Heartbeat interval (default: 30s)
    /// * `status_interval_secs` - Status update interval (default: 10s)
    /// * `cancel_token` - Cancellation token for shutdown
    pub fn new(
        state: Arc<AppState>,
        ws_tx: mpsc::UnboundedSender<ClientMessage>,
        heartbeat_interval_secs: u64,
        status_interval_secs: u64,
        cancel_token: CancellationToken,
    ) -> Self {
        Self {
            state,
            ws_tx,
            cancel_token,
            heartbeat_interval_secs,
            status_interval_secs,
        }
    }

    /// Start heartbeat and status reporter tasks
    ///
    /// Returns handles to both tasks for monitoring.
    pub fn start(self: Arc<Self>) -> (tokio::task::JoinHandle<()>, tokio::task::JoinHandle<()>) {
        let heartbeat_handle = self.clone().start_heartbeat_task();
        let status_handle = self.start_status_task();

        (heartbeat_handle, status_handle)
    }

    /// Start heartbeat task
    ///
    /// Sends heartbeat messages at configured interval to keep connection alive.
    fn start_heartbeat_task(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        let cancel_token = self.cancel_token.clone();

        tokio::spawn(async move {
            let mut interval = interval(Duration::from_secs(self.heartbeat_interval_secs));

            tracing::info!(
                "Heartbeat task started (interval: {}s)",
                self.heartbeat_interval_secs
            );

            loop {
                tokio::select! {
                    _ = cancel_token.cancelled() => {
                        tracing::info!("Heartbeat task shutting down");
                        break;
                    }
                    _ = interval.tick() => {
                        if let Err(e) = self.send_heartbeat().await {
                            tracing::warn!("Failed to send heartbeat: {}", e);
                        }
                    }
                }
            }
        })
    }

    /// Start status update task
    ///
    /// Sends status updates at configured interval to report playback state.
    fn start_status_task(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        let cancel_token = self.cancel_token.clone();

        tokio::spawn(async move {
            let mut interval = interval(Duration::from_secs(self.status_interval_secs));

            tracing::info!(
                "Status update task started (interval: {}s)",
                self.status_interval_secs
            );

            loop {
                tokio::select! {
                    _ = cancel_token.cancelled() => {
                        tracing::info!("Status update task shutting down");
                        break;
                    }
                    _ = interval.tick() => {
                        if let Err(e) = self.send_status_update().await {
                            tracing::warn!("Failed to send status update: {}", e);
                        }
                    }
                }
            }
        })
    }

    /// Send a heartbeat message
    async fn send_heartbeat(&self) -> Result<()> {
        let client_id = self.state.client_id().await;

        let message = ClientMessage::heartbeat(client_id);

        self.ws_tx.send(message).map_err(|e| {
            crate::error::MontrError::WebSocketSend(format!("Heartbeat send failed: {}", e))
        })?;

        tracing::trace!("Heartbeat sent");

        Ok(())
    }

    /// Send a status update message
    async fn send_status_update(&self) -> Result<()> {
        let snapshot = self.state.snapshot().await;

        // Build CurrentMediaInfo from current queue item if available
        let current_media = if let Some(media_id) = snapshot.current_media_id {
            // Get current queue item to extract filename
            if let Some(item) = self.state.current_queue_item().await {
                Some(crate::network::protocol::CurrentMediaInfo {
                    id: media_id,
                    filename: item.filename.clone(),
                })
            } else {
                // Fallback: we have media_id but no queue item
                // This shouldn't happen in normal operation, but handle gracefully
                None
            }
        } else {
            None
        };

        tracing::trace!(
            "Status update sent: media={:?}, playing={}",
            current_media,
            snapshot.is_playing
        );

        let message = ClientMessage::status_update(
            snapshot.client_id,
            current_media,
            snapshot.current_position,
            snapshot.is_playing,
        );

        self.ws_tx.send(message).map_err(|e| {
            crate::error::MontrError::WebSocketSend(format!("Status send failed: {}", e))
        })?;

        Ok(())
    }

    /// Send an error report
    pub async fn send_error(
        &self,
        error: String,
        context: Option<std::collections::HashMap<String, serde_json::Value>>,
    ) -> Result<()> {
        let client_id = self.state.client_id().await;

        let message = ClientMessage::error(client_id, error, context);

        self.ws_tx.send(message).map_err(|e| {
            crate::error::MontrError::WebSocketSend(format!("Error report send failed: {}", e))
        })?;

        tracing::debug!("Error report sent");

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::app_state::AppState;

    #[tokio::test]
    async fn test_reporter_creation() {
        let state = Arc::new(AppState::new(
            "test-id".to_string(),
            "Test Client".to_string(),
        ));
        let (ws_tx, _ws_rx) = mpsc::unbounded_channel();
        let cancel_token = CancellationToken::new();

        let reporter = StatusReporter::new(state, ws_tx, 30, 10, cancel_token);

        assert_eq!(reporter.heartbeat_interval_secs, 30);
        assert_eq!(reporter.status_interval_secs, 10);
    }

    #[tokio::test]
    async fn test_send_heartbeat() {
        let state = Arc::new(AppState::new(
            "test-id".to_string(),
            "Test Client".to_string(),
        ));
        let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
        let cancel_token = CancellationToken::new();

        let reporter = StatusReporter::new(state, ws_tx, 30, 10, cancel_token);

        reporter.send_heartbeat().await.unwrap();

        // Should receive heartbeat message
        let message = ws_rx.recv().await.unwrap();
        match message {
            ClientMessage::Heartbeat(_) => (),
            _ => panic!("Expected Heartbeat message"),
        }
    }

    #[tokio::test]
    async fn test_send_status_update() {
        use crate::network::protocol::PlaylistItem;

        let state = Arc::new(AppState::new(
            "test-id".to_string(),
            "Test Client".to_string(),
        ));
        let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
        let cancel_token = CancellationToken::new();

        // Set up a playlist with an item so we have a filename
        let items = vec![PlaylistItem {
            id: 1,
            media_id: 42,
            filename: "test.mp4".to_string(),
            download_url: "http://localhost:3000/api/media/42/download".to_string(),
            media_type: "video".to_string(),
            duration: Some(120.0),
            checksum: Some("abc123".to_string()),
            order_index: 0,
            image_duration: 5,
        }];

        state.update_playlist(1, items, false).await.unwrap();
        state.next_item().await; // Advance to first item
        state.set_playing(true).await;

        let reporter = StatusReporter::new(state, ws_tx, 30, 10, cancel_token);

        reporter.send_status_update().await.unwrap();

        // Should receive status update message
        let message = ws_rx.recv().await.unwrap();
        match message {
            ClientMessage::StatusUpdate(status) => {
                assert_eq!(status.client_id, "test-id");
                assert!(status.current_media.is_some());
                if let Some(media) = status.current_media {
                    assert_eq!(media.id, 42);
                    assert_eq!(media.filename, "test.mp4");
                }
                assert_eq!(status.is_playing, true);
            }
            _ => panic!("Expected StatusUpdate message"),
        }
    }

    #[tokio::test]
    async fn test_send_error() {
        let state = Arc::new(AppState::new(
            "test-id".to_string(),
            "Test Client".to_string(),
        ));
        let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
        let cancel_token = CancellationToken::new();

        let reporter = StatusReporter::new(state, ws_tx, 30, 10, cancel_token);

        let mut ctx = std::collections::HashMap::new();
        ctx.insert("detail".to_string(), serde_json::json!("Test context"));
        reporter
            .send_error("Test error".to_string(), Some(ctx.clone()))
            .await
            .unwrap();

        // Should receive error message
        let message = ws_rx.recv().await.unwrap();
        match message {
            ClientMessage::Error(err) => {
                assert_eq!(err.client_id, "test-id");
                assert_eq!(err.error, "Test error");
                assert_eq!(err.context, Some(ctx));
            }
            _ => panic!("Expected Error message"),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_heartbeat_task() {
        let state = Arc::new(AppState::new(
            "test-id".to_string(),
            "Test Client".to_string(),
        ));
        let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
        let cancel_token = CancellationToken::new();

        let reporter = Arc::new(StatusReporter::new(
            state,
            ws_tx,
            1, // 1 second for faster testing
            10,
            cancel_token.clone(),
        ));

        let (heartbeat_handle, _) = reporter.start();

        // Wait for at least one heartbeat
        tokio::time::sleep(Duration::from_millis(1100)).await;

        // Cancel and wait for shutdown
        cancel_token.cancel();
        heartbeat_handle.await.unwrap();

        // Should have received at least one heartbeat
        let mut count = 0;
        while ws_rx.try_recv().is_ok() {
            count += 1;
        }
        assert!(count >= 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn test_status_task() {
        let state = Arc::new(AppState::new(
            "test-id".to_string(),
            "Test Client".to_string(),
        ));
        let (ws_tx, mut ws_rx) = mpsc::unbounded_channel();
        let cancel_token = CancellationToken::new();

        let reporter = Arc::new(StatusReporter::new(
            state,
            ws_tx,
            10,
            1, // 1 second for faster testing
            cancel_token.clone(),
        ));

        let (_, status_handle) = reporter.start();

        // Wait for at least one status update
        tokio::time::sleep(Duration::from_millis(1100)).await;

        // Cancel and wait for shutdown
        cancel_token.cancel();
        status_handle.await.unwrap();

        // Should have received at least one status update
        let mut count = 0;
        while ws_rx.try_recv().is_ok() {
            count += 1;
        }
        assert!(count >= 1);
    }

    #[tokio::test]
    async fn test_reporter_shutdown() {
        let state = Arc::new(AppState::new(
            "test-id".to_string(),
            "Test Client".to_string(),
        ));
        let (ws_tx, _ws_rx) = mpsc::unbounded_channel();
        let cancel_token = CancellationToken::new();

        let reporter = Arc::new(StatusReporter::new(
            state,
            ws_tx,
            1,
            1,
            cancel_token.clone(),
        ));

        let (heartbeat_handle, status_handle) = reporter.start();

        // Immediately cancel
        cancel_token.cancel();

        // Both tasks should complete
        heartbeat_handle.await.unwrap();
        status_handle.await.unwrap();
    }
}
