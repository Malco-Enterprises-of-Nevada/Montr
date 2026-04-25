//! State coordinator - routes messages between subsystems
//!
//! Acts as the central message hub that:
//! - Receives server messages from WebSocket
//! - Updates application state
//! - Triggers downloads via CacheManager
//! - Sends commands to PlaybackEngine
//! - Emits status updates for reporter

use crate::cache::CacheManager;
use crate::config::Config;
use crate::error::{MontrError, Result};
use crate::network::protocol::ClientMessage;
use crate::network::{ErrorSeverity, HttpClient, PlaylistItem, Schedule, ServerMessage};
use crate::playback::engine::{PlaybackCommand, PlaybackEngineOps};
use crate::state::app_state::AppState;
use crate::state::persistence;
use arc_swap::ArcSwap;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, Notify, RwLock};
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
    /// Grace period elapsed without a playlist from the server — try to
    /// restore the last-known playlist from disk and start playback.
    TryOfflineRestore,
    /// Offline schedule evaluator picked a different playlist than the one
    /// we're currently playing. Coordinator looks up the cached snapshot
    /// for `playlist_id` and starts it; logs a warning if uncached.
    OfflineScheduleSwitch { playlist_id: u32 },
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
    /// Optional shared config snapshot — when present, `preload_upcoming`
    /// reads `preload_next_items` and `preload_bytes_budget` from this on
    /// every pass so SIGHUP-driven hot reload takes effect immediately.
    /// Tests use the legacy fixed-value fields below instead.
    cfg_snap: Option<Arc<ArcSwap<Config>>>,
    /// Fallback when `cfg_snap` is None (test fixtures). Number of upcoming
    /// items to pre-fetch.
    preload_next_items: usize,
    /// Fallback when `cfg_snap` is None (test fixtures). Optional cumulative-
    /// bytes cap on each preload pass.
    preload_bytes_budget: Option<u64>,
    /// HTTP client for analytics reporting
    http_client: Arc<HttpClient>,
    /// API key for authenticated requests
    api_key: Option<String>,
    /// Current playback log ID (for analytics end reporting)
    current_playback_log_id: Option<u64>,
    /// Time when current media started playing
    playback_start_time: Option<tokio::time::Instant>,
    /// Path to the local log file — used by the `fetch_logs` command handler
    /// to read a tail and upload it to the server.
    log_file: Option<std::path::PathBuf>,
    /// Directory used for persisting playlist snapshots for offline fallback.
    /// When `None`, no persistence or offline restore is attempted.
    cache_dir: Option<PathBuf>,
    /// Whether the operator has opted into subtitle rendering. Defaults to
    /// off — matches historical behavior for existing deployments.
    subtitles_enabled: bool,
    /// Preferred subtitle language as an ISO 639-2 code ("eng", "spa", …).
    preferred_subtitle_language: Option<String>,
    /// Optional `sub-font-size` override passed to mpv on each play.
    subtitle_font_size: Option<u32>,
    /// Optional WebSocket sender — when configured, `report_error()` enqueues
    /// `ClientMessage::Error` here so the server learns about client-side
    /// faults instead of them being logged and dropped.
    ws_tx: Option<mpsc::UnboundedSender<ClientMessage>>,
    /// Optional channel for on-demand screenshot requests carrying a
    /// `request_id`. Drained by the screenshot task in `main.rs` which holds
    /// the playback engine and HTTP client needed for capture+upload.
    screenshot_tx: Option<mpsc::UnboundedSender<String>>,
    /// Optional playback engine handle — when present, end_analytics_session
    /// queries `take_quality_snapshot()` and forwards per-media metrics to
    /// the analytics API. Tests using mock engines leave this as `None`.
    playback_engine: Option<Arc<crate::playback::engine::PlaybackEngine>>,
    /// Latest schedule definitions pushed by the server. Shared so the
    /// offline-eval task in main.rs can read without touching coordinator
    /// internals; written here in response to `ScheduleDefinitions`.
    schedules: Arc<RwLock<Vec<Schedule>>>,
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
            cfg_snap: None,
            preload_next_items,
            preload_bytes_budget: None,
            http_client,
            api_key,
            current_playback_log_id: None,
            playback_start_time: None,
            log_file: None,
            cache_dir: None,
            subtitles_enabled: false,
            preferred_subtitle_language: None,
            subtitle_font_size: None,
            ws_tx: None,
            screenshot_tx: None,
            playback_engine: None,
            schedules: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Shared read handle on the latest known schedule set. The offline
    /// schedule-eval task clones this and reads on every tick. Updated
    /// in-place when a `ServerMessage::ScheduleDefinitions` arrives.
    pub fn schedules_handle(&self) -> Arc<RwLock<Vec<Schedule>>> {
        self.schedules.clone()
    }

    /// Return the message-sender clone so other subsystems can also push
    /// `OfflineScheduleSwitch` events. Equivalent to `message_sender()`
    /// but named explicitly for the offline-eval task in main.rs.
    pub fn message_tx(&self) -> mpsc::UnboundedSender<CoordinatorMessage> {
        self.message_tx.clone()
    }

    /// Wire in the concrete playback engine so the coordinator can read
    /// per-media quality metrics on `end_analytics_session`. Optional —
    /// tests that pass a mock engine for command_sender can omit this.
    pub fn with_playback_engine(
        mut self,
        engine: Arc<crate::playback::engine::PlaybackEngine>,
    ) -> Self {
        self.playback_engine = Some(engine);
        self
    }

    /// Cap cumulative preload bytes per pass. `None` (default) uses the
    /// item-count cap only. Used only when `cfg_snap` is unset (tests).
    pub fn with_preload_bytes_budget(mut self, budget: Option<u64>) -> Self {
        self.preload_bytes_budget = budget;
        self
    }

    /// Wire in the shared config snapshot. When set, `preload_upcoming` reads
    /// `preload_next_items` and `preload_bytes_budget` from the live snapshot
    /// each pass instead of using the values captured at construction. SIGHUP
    /// reload then takes effect on the next preload tick.
    pub fn with_cfg_snap(mut self, cfg_snap: Arc<ArcSwap<Config>>) -> Self {
        self.cfg_snap = Some(cfg_snap);
        self
    }

    /// Wire in the WebSocket sender so the coordinator can push
    /// `ClientMessage::Error` reports for client-side faults.
    pub fn with_ws_sender(mut self, ws_tx: mpsc::UnboundedSender<ClientMessage>) -> Self {
        self.ws_tx = Some(ws_tx);
        self
    }

    /// Wire in the on-demand screenshot trigger channel. The receiving task
    /// (in `main.rs`) holds the engine + HTTP client needed to actually take
    /// the snapshot and upload it.
    pub fn with_screenshot_sender(mut self, tx: mpsc::UnboundedSender<String>) -> Self {
        self.screenshot_tx = Some(tx);
        self
    }

    /// Opt into subtitle rendering and set the preferred language + font size.
    /// Off by default so existing deployments keep their prior behavior after upgrade.
    pub fn with_subtitle_preferences(
        mut self,
        enabled: bool,
        preferred_language: Option<String>,
        font_size: Option<u32>,
    ) -> Self {
        self.subtitles_enabled = enabled;
        self.preferred_subtitle_language = preferred_language;
        self.subtitle_font_size = font_size;
        self
    }

    /// Set the path of the local log file. When configured, the coordinator
    /// can answer `fetch_logs` commands by reading a tail and uploading it.
    pub fn with_log_file(mut self, path: std::path::PathBuf) -> Self {
        self.log_file = Some(path);
        self
    }

    /// Enable playlist persistence for offline fallback. When set, the
    /// coordinator writes a `playlist.json` snapshot to this directory on each
    /// server-sent playlist update, and will restore from it in response to
    /// `CoordinatorMessage::TryOfflineRestore`.
    pub fn with_cache_dir(mut self, path: PathBuf) -> Self {
        self.cache_dir = Some(path);
        self
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
            CoordinatorMessage::TryOfflineRestore => self.handle_try_offline_restore().await,
            CoordinatorMessage::OfflineScheduleSwitch { playlist_id } => {
                self.handle_offline_schedule_switch(playlist_id).await
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

                self.persist_playlist(msg.playlist_id, &msg.items, msg.loop_playlist)
                    .await;

                // Pin the assigned items in the cache so they survive eviction
                // during long offline windows. Replaces the prior pin set.
                self.cache_manager.pin_playlist_items(&msg.items).await;

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

                self.persist_playlist(msg.playlist_id, &msg.items, msg.loop_playlist)
                    .await;

                self.cache_manager.pin_playlist_items(&msg.items).await;

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

                // Pin the interrupt playlist for the duration it's active.
                // PlaylistResume re-pins the restored playlist below.
                self.cache_manager.pin_playlist_items(&msg.items).await;

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
                    self.persist_playlist(playlist_id, &msg.items, msg.loop_playlist)
                        .await;
                    self.cache_manager.pin_playlist_items(&msg.items).await;
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
                    "fetch_logs" => {
                        let max_bytes = cmd
                            .args
                            .as_ref()
                            .and_then(|a| a.get("max_bytes"))
                            .and_then(|v| v.as_u64())
                            .unwrap_or(102_400) as usize;
                        let request_id = cmd
                            .args
                            .as_ref()
                            .and_then(|a| a.get("request_id"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let Some(request_id) = request_id else {
                            tracing::warn!("fetch_logs command missing request_id");
                            return Ok(());
                        };
                        if let Err(e) = self.handle_fetch_logs(&request_id, max_bytes).await {
                            tracing::error!("fetch_logs handler failed: {}", e);
                        }
                    }
                    "screenshot" => {
                        let request_id = cmd
                            .args
                            .as_ref()
                            .and_then(|a| a.get("request_id"))
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                        let Some(request_id) = request_id else {
                            tracing::warn!("screenshot command missing request_id");
                            return Ok(());
                        };
                        let Some(tx) = self.screenshot_tx.as_ref() else {
                            tracing::warn!(
                                "screenshot command received but no screenshot task wired"
                            );
                            return Ok(());
                        };
                        if let Err(e) = tx.send(request_id) {
                            tracing::warn!("Failed to enqueue screenshot request: {}", e);
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
                self.report_error("server", ErrorSeverity::Warn, msg.error.clone(), None)
                    .await;
                Ok(())
            }
            ServerMessage::ScheduleDefinitions(msg) => {
                tracing::info!(
                    "Received {} schedule definition(s) from server",
                    msg.schedules.len()
                );
                {
                    let mut s = self.schedules.write().await;
                    *s = msg.schedules.clone();
                }
                // Persist so offline boot still has the latest schedule set.
                if let Some(ref dir) = self.cache_dir {
                    if let Err(e) = persistence::save_schedules(dir, &msg.schedules).await {
                        tracing::warn!("Failed to persist schedules: {}", e);
                    }
                }
                Ok(())
            }
        }
    }

    /// Apply a switch chosen by the offline schedule evaluator. The target
    /// playlist must already be cached (we can't download offline) — if
    /// not, log and return without changing playback.
    async fn handle_offline_schedule_switch(&mut self, playlist_id: u32) -> Result<()> {
        let Some(ref cache_dir) = self.cache_dir else {
            tracing::debug!("Offline schedule switch ignored: no cache_dir wired (test fixture)");
            return Ok(());
        };

        // Skip when the chosen playlist is already the one playing.
        if let Some(current) = self.state.playlist_id().await {
            if current == playlist_id {
                tracing::debug!(
                    "Offline schedule switch: playlist {} already active, no-op",
                    playlist_id
                );
                return Ok(());
            }
        }

        let snapshot = match persistence::load_playlist_versioned(cache_dir, playlist_id).await? {
            Some(s) => s,
            None => {
                tracing::warn!(
                    "Offline schedule wants to switch to playlist {} but it's not cached; ignoring",
                    playlist_id
                );
                return Ok(());
            }
        };

        tracing::info!(
            "Offline schedule switch: -> playlist {} ({} items)",
            snapshot.playlist_id,
            snapshot.items.len()
        );

        // End any in-flight analytics session before swapping playlists.
        self.end_analytics_session(false).await;

        self.state
            .update_playlist(
                snapshot.playlist_id,
                snapshot.items.clone(),
                snapshot.loop_enabled,
            )
            .await?;

        // Pin the items in the cache so cache pressure doesn't evict them
        // while this offline-selected playlist plays.
        self.cache_manager.pin_playlist_items(&snapshot.items).await;

        // download_and_start no-ops the actual transfers when items are
        // already cached, but still kicks off playback for the first item.
        self.download_and_start(snapshot.items).await?;
        Ok(())
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

                let mut ctx = HashMap::new();
                ctx.insert("media_id".to_string(), serde_json::Value::from(media_id));
                self.report_error("playback", ErrorSeverity::Error, error.clone(), Some(ctx))
                    .await;

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

        if failure_count > 0 {
            let mut ctx = HashMap::new();
            ctx.insert("total".to_string(), serde_json::Value::from(total as u64));
            ctx.insert(
                "succeeded".to_string(),
                serde_json::Value::from(success_count as u64),
            );
            ctx.insert(
                "failed".to_string(),
                serde_json::Value::from(failure_count as u64),
            );
            // Severity warn: the playlist still plays whatever did succeed.
            // Operator visibility matters; client status flap does not.
            self.report_error(
                "cache",
                ErrorSeverity::Warn,
                format!("{} of {} downloads failed", failure_count, total),
                Some(ctx),
            )
            .await;
        }

        self.download_notify.notify_waiters();
        let _ = relay_handle.await;

        Ok(success_count)
    }

    // (helper `select_preload_items` lives at the module level below.)

    /// Pre-download upcoming items in the background.
    ///
    /// Two caps apply on every pass:
    ///   * `preload_next_items` — hard cap on the number of items considered.
    ///   * `preload_bytes_budget` (optional) — cumulative-bytes cap, computed
    ///     from each item's `file_size`. Stops the pass at the first item
    ///     that would push the running total over the budget. Items whose
    ///     server didn't emit `file_size` contribute 0 — they're preloaded
    ///     without affecting the budget.
    fn preload_upcoming(&self) {
        // Read live values from the snapshot when wired (production path);
        // fall back to construction-time captures for tests.
        let (count, bytes_budget) = match self.cfg_snap.as_ref() {
            Some(snap) => {
                let cfg = snap.load();
                (
                    cfg.playback.preload_next_items,
                    cfg.playback.preload_bytes_budget,
                )
            }
            None => (self.preload_next_items, self.preload_bytes_budget),
        };
        if count == 0 {
            return;
        }
        let state = self.state.clone();
        let cache_manager = self.cache_manager.clone();
        let ws_tx = self.ws_tx.clone();

        tokio::spawn(async move {
            let upcoming = state.get_upcoming_items(count).await;
            let to_preload = select_preload_items(&upcoming, count, bytes_budget);
            for item in to_preload {
                if !cache_manager.is_cached(item.media_id, &item.filename).await {
                    tracing::debug!("Preloading media {}: {}", item.media_id, item.filename);
                    let checksum = item.checksum.clone().unwrap_or_default();
                    let cm = cache_manager.clone();
                    let ws_tx_inner = ws_tx.clone();
                    let state_inner = state.clone();
                    tokio::spawn(async move {
                        if let Err(e) = cm
                            .download_media(item.media_id, &item.filename, &checksum)
                            .await
                        {
                            tracing::warn!("Preload failed for media {}: {}", item.media_id, e);
                            // Best-effort uplink — preload failure is transient,
                            // so severity is `warn` and we don't flap status.
                            if let Some(tx) = ws_tx_inner {
                                let mut ctx = HashMap::new();
                                ctx.insert(
                                    "media_id".to_string(),
                                    serde_json::Value::from(item.media_id),
                                );
                                let client_id = state_inner.client_id().await;
                                let msg = ClientMessage::error_detailed(
                                    client_id,
                                    Some("preload".to_string()),
                                    Some(ErrorSeverity::Warn),
                                    format!("preload failed for media {}: {}", item.media_id, e),
                                    Some(ctx),
                                );
                                let _ = tx.send(msg);
                            }
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

    /// Persist the current playlist for offline fallback. Best-effort —
    /// errors are logged and swallowed so a disk failure never breaks live
    /// playback.
    ///
    /// Two slots are written: the legacy `playlist.json` (single-snapshot,
    /// used by the boot-time grace-period restore) and the versioned
    /// `playlists/<id>.json` (used by offline schedule re-eval to switch
    /// between known playlists).
    async fn persist_playlist(&self, playlist_id: u32, items: &[PlaylistItem], loop_enabled: bool) {
        let Some(ref cache_dir) = self.cache_dir else {
            return;
        };
        if let Err(e) = persistence::save(cache_dir, playlist_id, items, loop_enabled).await {
            tracing::warn!(
                "Failed to persist playlist {} for offline fallback: {}",
                playlist_id,
                e
            );
        } else {
            tracing::debug!(
                "Persisted playlist {} ({} items) for offline fallback",
                playlist_id,
                items.len()
            );
        }

        // Also write the per-id versioned slot so offline schedule eval can
        // reach this playlist later, alongside any others previously seen.
        if let Err(e) =
            persistence::save_playlist_versioned(cache_dir, playlist_id, items, loop_enabled).await
        {
            tracing::warn!(
                "Failed to persist versioned playlist {}: {}",
                playlist_id,
                e
            );
        }
    }

    /// Attempt to restore the last-known playlist from disk when the server
    /// has not responded within the startup grace period. No-op if the queue
    /// is already populated, if persistence is not configured, or if there is
    /// no cached playlist on disk.
    async fn handle_try_offline_restore(&mut self) -> Result<()> {
        let Some(cache_dir) = self.cache_dir.clone() else {
            return Ok(());
        };

        if !self.state.is_queue_empty().await {
            tracing::debug!("Offline restore skipped: queue already populated");
            return Ok(());
        }

        let snapshot = match persistence::load(&cache_dir).await? {
            Some(s) => s,
            None => {
                tracing::info!(
                    "Server unreachable after grace period, no cached playlist to restore"
                );
                return Ok(());
            }
        };

        tracing::info!(
            "Server unreachable after grace period; restoring playlist {} from disk ({} items)",
            snapshot.playlist_id,
            snapshot.items.len()
        );

        self.state
            .update_playlist(
                snapshot.playlist_id,
                snapshot.items.clone(),
                snapshot.loop_enabled,
            )
            .await?;

        // Pin restored items so they survive eviction while we're offline —
        // this is the whole point of an offline mode.
        self.cache_manager.pin_playlist_items(&snapshot.items).await;

        self.download_and_start(snapshot.items).await?;

        Ok(())
    }

    /// Best-effort: enqueue a client-error report on the WebSocket sender.
    ///
    /// Non-blocking — if the channel is closed (server disconnected) or the
    /// coordinator was constructed without `with_ws_sender`, the error is only
    /// logged locally. Never returns an error to avoid recursion: callers
    /// already log via `tracing` first, this is purely an uplink.
    async fn report_error(
        &self,
        source: &str,
        severity: ErrorSeverity,
        message: impl Into<String>,
        context: Option<HashMap<String, serde_json::Value>>,
    ) {
        let Some(ws_tx) = self.ws_tx.as_ref() else {
            return;
        };
        let client_id = self.state.client_id().await;
        let msg = ClientMessage::error_detailed(
            client_id,
            Some(source.to_string()),
            Some(severity),
            message.into(),
            context,
        );
        if let Err(e) = ws_tx.send(msg) {
            tracing::debug!("Could not enqueue client error to server: {}", e);
        }
    }

    /// Read the tail of the local log file and upload it to the server in
    /// response to a `fetch_logs` command.
    ///
    /// Bounded by `max_bytes`. Returns Err on file/network failure but the
    /// caller logs and swallows it — fetch_logs is best-effort.
    async fn handle_fetch_logs(&self, request_id: &str, max_bytes: usize) -> Result<()> {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};

        let log_path = self
            .log_file
            .as_ref()
            .ok_or_else(|| MontrError::Playback("fetch_logs: log_file not configured".into()))?;

        let mut file =
            tokio::fs::File::open(log_path)
                .await
                .map_err(|e| MontrError::FileAccess {
                    path: log_path.clone(),
                    source: e,
                })?;

        let len = file
            .metadata()
            .await
            .map_err(|e| MontrError::FileAccess {
                path: log_path.clone(),
                source: e,
            })?
            .len() as usize;

        let to_read = len.min(max_bytes);
        let start = len.saturating_sub(to_read);

        file.seek(std::io::SeekFrom::Start(start as u64))
            .await
            .map_err(|e| MontrError::FileAccess {
                path: log_path.clone(),
                source: e,
            })?;

        let mut buf = Vec::with_capacity(to_read);
        file.read_to_end(&mut buf)
            .await
            .map_err(|e| MontrError::FileAccess {
                path: log_path.clone(),
                source: e,
            })?;

        let client_id = self.state.client_id().await;
        let api_key = self.api_key.as_deref();
        self.http_client
            .upload_logs(&client_id, request_id, buf, api_key)
            .await?;

        tracing::info!(
            "Uploaded {} bytes of logs (request_id={})",
            to_read,
            request_id
        );
        Ok(())
    }

    /// Report playback start to analytics
    async fn start_analytics_session(&mut self, media_id: u32) {
        // Close any in-flight session first to avoid orphaning a server-side row
        // if MediaFinished never arrived for the previous media.
        if self.current_playback_log_id.is_some() {
            tracing::trace!(
                "Analytics: previous session still open, ending it before starting a new one"
            );
            self.end_analytics_session(false).await;
        }

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
            let quality = if let Some(ref engine) = self.playback_engine {
                Some(engine.take_quality_snapshot().await)
            } else {
                None
            };
            let _ = self
                .http_client
                .report_playback_end(log_id, duration, completed, quality, api_key)
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

        // Build a subtitle plan: externals on disk + active selection. We
        // only bother for video items — images never carry subs.
        let is_video = item.media_type == "video";
        let subtitles = if is_video {
            Some(self.resolve_subtitles_for_item(&item).await)
        } else {
            None
        };

        // Send play command to engine
        self.playback_tx
            .send(PlaybackCommand::Play {
                path: cache_path,
                is_video,
                image_duration: Some(item.image_duration),
                subtitles,
            })
            .map_err(|e| MontrError::Playback(format!("Failed to send play command: {}", e)))?;

        // Report analytics
        self.start_analytics_session(media_id).await;

        Ok(())
    }

    /// Build a `ResolvedSubtitles` from the item's advertised tracks: checks
    /// which externals have cached sidecar files, then applies the selector
    /// policy using the operator's configured preferences. Always returns
    /// something — an empty plan collapses to `sub-visibility no`.
    async fn resolve_subtitles_for_item(
        &self,
        item: &PlaylistItem,
    ) -> crate::playback::subtitle_selector::ResolvedSubtitles {
        use crate::network::protocol::SubtitleKind;
        use crate::playback::subtitle_selector::{self, SubtitleCandidate};

        let mut candidates: Vec<SubtitleCandidate> = Vec::new();
        for track in &item.subtitles {
            match track.kind {
                SubtitleKind::External => {
                    let filename =
                        track
                            .filename
                            .clone()
                            .unwrap_or_else(|| match track.format.as_deref() {
                                Some("vtt") => format!("{}.vtt", track.id),
                                _ => format!("{}.srt", track.id),
                            });
                    let local_path = self
                        .cache_manager
                        .get_subtitle_cache_path(track.id, &filename);
                    if local_path.exists() {
                        candidates.push(SubtitleCandidate::external(track.clone(), local_path));
                    } else {
                        tracing::warn!("External subtitle {} not on disk; skipping", track.id);
                    }
                }
                SubtitleKind::Embedded => {
                    candidates.push(SubtitleCandidate::embedded(track.clone()));
                }
            }
        }

        subtitle_selector::resolve(
            candidates,
            self.preferred_subtitle_language.as_deref(),
            self.subtitles_enabled,
            self.subtitle_font_size,
        )
    }
}

/// Pick the prefix of `upcoming` to actually preload, honoring both the
/// item-count cap and the optional cumulative-byte budget.
///
/// Behavior:
///   * Always returns at most `count` items.
///   * If `bytes_budget` is `None`, returns the first `min(count, len)` items.
///   * If `bytes_budget` is `Some(budget)`, walks the list and stops at the
///     first item whose `file_size` would push the running total over
///     `budget`. Items with `file_size = None` contribute 0 (they preload
///     without consuming budget — server didn't tell us their size).
///   * Always preloads at least the first item that fits, even if it equals
///     the budget exactly. Important so we never starve playback when an
///     operator picks a tight budget by mistake.
fn select_preload_items(
    upcoming: &[PlaylistItem],
    count: usize,
    bytes_budget: Option<u64>,
) -> Vec<PlaylistItem> {
    let cap = upcoming.len().min(count);
    let Some(budget) = bytes_budget else {
        return upcoming[..cap].to_vec();
    };

    let mut picked = Vec::with_capacity(cap);
    let mut running: u64 = 0;
    for item in upcoming.iter().take(cap) {
        let size = item.file_size.unwrap_or(0);
        // Saturate to avoid wraparound on absurd inputs.
        let next = running.saturating_add(size);
        if next > budget {
            break;
        }
        running = next;
        picked.push(item.clone());
    }
    picked
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
            subtitles: Vec::new(),
            file_size: None,
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

    /// Test helper that returns a mock engine + the receiver end of the command
    /// channel, so tests can assert which PlaybackCommand the coordinator sent.
    fn create_observable_playback_engine() -> (
        MockPlaybackEngineOps,
        mpsc::UnboundedReceiver<PlaybackCommand>,
    ) {
        let mut mock = MockPlaybackEngineOps::new();
        let (tx, rx) = mpsc::unbounded_channel::<PlaybackCommand>();
        mock.expect_command_sender().returning(move || tx.clone());
        (mock, rx)
    }

    #[tokio::test]
    async fn test_coordinator_creation() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client =
            Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
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
        let http_client =
            Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
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
        let http_client =
            Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
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
        let http_client =
            Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
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
        let http_client =
            Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
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
        let http_client =
            Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
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
        let http_client =
            Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
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
        let http_client =
            Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
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
        let http_client =
            Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
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
        let http_client =
            Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
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
        let http_client =
            Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
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
        let http_client =
            Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
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
        let http_client =
            Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
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
        let http_client =
            Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
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

    #[tokio::test]
    async fn test_command_volume_dispatches_playback_command() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client =
            Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client.clone(),
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let (playback_engine, mut playback_rx) = create_observable_playback_engine();
        let mut coordinator = StateCoordinator::new(
            state,
            cache_manager,
            http_client,
            &playback_engine,
            cancel_token,
            2,
            None,
        );

        let mut args = std::collections::HashMap::new();
        args.insert("level".to_string(), serde_json::json!(42.0));
        let cmd = ServerMessage::Command(crate::network::CommandMessage {
            command: "volume".to_string(),
            args: Some(args),
        });
        coordinator.handle_server_message(cmd).await.unwrap();

        match playback_rx.try_recv() {
            Ok(PlaybackCommand::Volume { level }) => assert_eq!(level, 42.0),
            other => panic!("expected Volume command, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_command_volume_missing_args_is_noop() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client =
            Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client.clone(),
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let (playback_engine, mut playback_rx) = create_observable_playback_engine();
        let mut coordinator = StateCoordinator::new(
            state,
            cache_manager,
            http_client,
            &playback_engine,
            cancel_token,
            2,
            None,
        );

        let cmd = ServerMessage::Command(crate::network::CommandMessage {
            command: "volume".to_string(),
            args: None,
        });
        coordinator.handle_server_message(cmd).await.unwrap();

        assert!(
            matches!(
                playback_rx.try_recv(),
                Err(mpsc::error::TryRecvError::Empty)
            ),
            "volume without args should not dispatch a playback command"
        );
    }

    #[tokio::test]
    async fn test_command_seek_dispatches_playback_command() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client =
            Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
        let cancel_token = CancellationToken::new();
        let cache_manager = Arc::new(
            CacheManager::new(
                http_client.clone(),
                temp_dir.path().to_path_buf(),
                cancel_token.clone(),
            )
            .unwrap(),
        );

        let (playback_engine, mut playback_rx) = create_observable_playback_engine();
        let mut coordinator = StateCoordinator::new(
            state,
            cache_manager,
            http_client,
            &playback_engine,
            cancel_token,
            2,
            None,
        );

        let mut args = std::collections::HashMap::new();
        args.insert("position".to_string(), serde_json::json!(30.0));
        let cmd = ServerMessage::Command(crate::network::CommandMessage {
            command: "seek".to_string(),
            args: Some(args),
        });
        coordinator.handle_server_message(cmd).await.unwrap();

        match playback_rx.try_recv() {
            Ok(PlaybackCommand::Seek { position }) => assert_eq!(position, 30.0),
            other => panic!("expected Seek command, got {:?}", other),
        }
    }

    /// Helper: build a coordinator with a cache_dir configured (offline-fallback
    /// enabled) sharing the same cache directory as its media cache manager.
    fn make_coordinator_with_cache(
        temp_dir: &TempDir,
        state: AppState,
    ) -> (StateCoordinator, Arc<CacheManager>) {
        let http_client =
            Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
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
            cache_manager.clone(),
            http_client,
            &playback_engine,
            cancel_token,
            2,
            None,
        )
        .with_cache_dir(temp_dir.path().to_path_buf());
        (coordinator, cache_manager)
    }

    #[tokio::test]
    async fn playlist_assigned_writes_persistence_snapshot() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let (mut coordinator, cache_manager) =
            make_coordinator_with_cache(&temp_dir, state.clone());

        let items = vec![create_test_item(1, 1), create_test_item(2, 2)];

        // Pre-populate cache so download_and_start's fast path is taken
        for item in &items {
            let cache_path = cache_manager.get_cache_path(item.media_id, &item.filename);
            std::fs::create_dir_all(cache_path.parent().unwrap()).unwrap();
            std::fs::write(&cache_path, b"dummy video data").unwrap();
        }

        coordinator
            .handle_server_message(ServerMessage::PlaylistAssigned(PlaylistAssignedMessage {
                playlist_id: 77,
                playlist_name: "Persisted".to_string(),
                items: items.clone(),
                loop_playlist: true,
            }))
            .await
            .unwrap();

        let loaded = persistence::load(temp_dir.path()).await.unwrap().unwrap();
        assert_eq!(loaded.playlist_id, 77);
        assert_eq!(loaded.items, items);
        assert!(loaded.loop_enabled);
    }

    #[tokio::test]
    async fn try_offline_restore_populates_empty_queue() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let (mut coordinator, cache_manager) =
            make_coordinator_with_cache(&temp_dir, state.clone());

        let items = vec![create_test_item(1, 1), create_test_item(2, 2)];
        for item in &items {
            let cache_path = cache_manager.get_cache_path(item.media_id, &item.filename);
            std::fs::create_dir_all(cache_path.parent().unwrap()).unwrap();
            std::fs::write(&cache_path, b"dummy video data").unwrap();
        }

        persistence::save(temp_dir.path(), 99, &items, true)
            .await
            .unwrap();

        assert!(state.is_queue_empty().await);

        coordinator.handle_try_offline_restore().await.unwrap();

        assert_eq!(state.playlist_id().await, Some(99));
        assert_eq!(state.queue_length().await, 2);
        assert!(state.is_looping().await);
    }

    #[tokio::test]
    async fn try_offline_restore_is_noop_when_queue_populated() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let (mut coordinator, _cache_manager) =
            make_coordinator_with_cache(&temp_dir, state.clone());

        let live_items = vec![create_test_item(1, 100)];
        state
            .update_playlist(1, live_items.clone(), false)
            .await
            .unwrap();

        // Persist a *different* playlist on disk
        let disk_items = vec![create_test_item(5, 500)];
        persistence::save(temp_dir.path(), 55, &disk_items, true)
            .await
            .unwrap();

        coordinator.handle_try_offline_restore().await.unwrap();

        // Live playlist unchanged
        assert_eq!(state.playlist_id().await, Some(1));
        assert_eq!(state.queue_length().await, 1);
    }

    #[tokio::test]
    async fn try_offline_restore_is_noop_when_no_snapshot_exists() {
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let (mut coordinator, _cache_manager) =
            make_coordinator_with_cache(&temp_dir, state.clone());

        coordinator.handle_try_offline_restore().await.unwrap();

        assert!(state.is_queue_empty().await);
        assert_eq!(state.playlist_id().await, None);
    }

    #[tokio::test]
    async fn try_offline_restore_is_noop_when_cache_dir_unset() {
        // Coordinator built *without* with_cache_dir() — persistence disabled
        let temp_dir = TempDir::new().unwrap();
        let state = AppState::new("test-id".to_string(), "Test Client".to_string());
        let http_client =
            Arc::new(HttpClient::new("http://localhost:3000".to_string(), None, false).unwrap());
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

        coordinator.handle_try_offline_restore().await.unwrap();
        assert!(state.is_queue_empty().await);
    }

    fn item_with_size(id: u32, size: Option<u64>) -> PlaylistItem {
        PlaylistItem {
            id,
            media_id: id,
            filename: format!("m{}.mp4", id),
            download_url: format!("http://test/api/media/{}/download", id),
            media_type: "video".to_string(),
            duration: Some(10.0),
            checksum: None,
            order_index: id - 1,
            image_duration: 5,
            subtitles: Vec::new(),
            file_size: size,
        }
    }

    #[test]
    fn select_preload_items_no_budget_uses_count_only() {
        let items = vec![
            item_with_size(1, Some(500)),
            item_with_size(2, Some(500)),
            item_with_size(3, Some(500)),
        ];
        // Count cap of 2, no byte budget — should pick the first two regardless of size.
        let picked = select_preload_items(&items, 2, None);
        assert_eq!(picked.iter().map(|i| i.id).collect::<Vec<_>>(), vec![1, 2]);
    }

    #[test]
    fn select_preload_items_byte_budget_stops_early() {
        let items = vec![
            item_with_size(1, Some(400)),
            item_with_size(2, Some(400)),
            item_with_size(3, Some(400)),
        ];
        // Count cap 5, budget 1000: 400 + 400 = 800 fits; +400 would be 1200 > 1000 so stop.
        let picked = select_preload_items(&items, 5, Some(1000));
        assert_eq!(picked.iter().map(|i| i.id).collect::<Vec<_>>(), vec![1, 2]);
    }

    #[test]
    fn select_preload_items_unknown_size_does_not_consume_budget() {
        let items = vec![
            item_with_size(1, None),
            item_with_size(2, None),
            item_with_size(3, Some(500)),
        ];
        // Two unknown items contribute 0; the third (500) fits in budget 1000.
        let picked = select_preload_items(&items, 5, Some(1000));
        assert_eq!(
            picked.iter().map(|i| i.id).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
    }

    #[test]
    fn select_preload_items_empty_input() {
        assert!(select_preload_items(&[], 5, Some(1000)).is_empty());
        assert!(select_preload_items(&[], 0, None).is_empty());
    }

    #[test]
    fn select_preload_items_count_zero_returns_empty() {
        let items = vec![item_with_size(1, Some(100))];
        assert!(select_preload_items(&items, 0, None).is_empty());
    }

    #[test]
    fn select_preload_items_first_item_too_large_returns_empty() {
        // First item alone (1000 bytes) exceeds the 500-byte budget — preload skips it.
        // Trade-off: we'd rather preload nothing than block the playback queue waiting
        // on a single oversized item; the synchronous download path handles it later.
        let items = vec![item_with_size(1, Some(1000))];
        assert!(select_preload_items(&items, 5, Some(500)).is_empty());
    }
}
