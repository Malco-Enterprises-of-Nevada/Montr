//! MPV-based playback engine using JSON IPC subprocess
//!
//! Controls mpv via its JSON IPC protocol over a Unix socket, avoiding
//! libmpv C API version incompatibilities.

use crate::error::{MontrError, Result};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, RwLock};
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

#[cfg(test)]
use mockall::automock;

/// Clamp a volume level to mpv's 0-100 range. NaN maps to 0.
pub(crate) fn clamp_volume(level: f64) -> f64 {
    if level.is_nan() {
        0.0
    } else {
        level.clamp(0.0, 100.0)
    }
}

/// Clamp a seek position to a non-negative value. NaN maps to 0.
pub(crate) fn clamp_seek(position: f64) -> f64 {
    if position.is_nan() {
        0.0
    } else {
        position.max(0.0)
    }
}

/// Commands that can be sent to the playback engine
#[derive(Debug, Clone)]
pub enum PlaybackCommand {
    /// Play a media file
    Play {
        path: PathBuf,
        is_video: bool,
        image_duration: Option<u32>,
        /// Optional subtitle plan resolved upstream (in the coordinator)
        /// from the playlist item's advertised tracks + cached sidecars +
        /// operator config. `None` = legacy behavior (no subtitles).
        subtitles: Option<crate::playback::subtitle_selector::ResolvedSubtitles>,
    },
    /// Pause playback
    Pause,
    /// Resume playback
    Resume,
    /// Stop playback
    Stop,
    /// Set volume (0-100)
    Volume { level: f64 },
    /// Seek to absolute position (seconds)
    Seek { position: f64 },
}

/// Trait for playback engine operations
/// This allows for mocking in tests without requiring actual mpv initialization
#[cfg_attr(test, automock)]
pub trait PlaybackEngineOps: Send + Sync {
    /// Get a sender for sending commands to the playback engine
    fn command_sender(&self) -> mpsc::UnboundedSender<PlaybackCommand>;
}

/// MPV playback engine using JSON IPC subprocess
pub struct PlaybackEngine {
    /// mpv child process
    #[allow(dead_code)]
    process: Arc<RwLock<Option<Child>>>,

    /// Path to the IPC socket
    ipc_path: String,

    /// Current playback state
    state: Arc<RwLock<PlaybackState>>,

    /// Event channel sender
    event_tx: mpsc::Sender<PlaybackEvent>,

    /// Event channel receiver (taken by subscriber)
    event_rx: Arc<RwLock<Option<mpsc::Receiver<PlaybackEvent>>>>,

    /// Command channel sender (for external control)
    command_tx: mpsc::UnboundedSender<PlaybackCommand>,

    /// Command channel receiver
    command_rx: Arc<RwLock<Option<mpsc::UnboundedReceiver<PlaybackCommand>>>>,

    /// Cancellation token
    cancel_token: CancellationToken,

    /// Default image duration (seconds). Used as fallback when the playlist
    /// item didn't carry an explicit duration. When `cfg_snap` is wired,
    /// the value is read live from the snapshot in the command handler so
    /// SIGHUP changes apply to the very next image.
    default_image_duration: u64,

    /// Optional shared config snapshot. When set, the command handler reads
    /// `playback.default_image_duration` from this on every Play instead of
    /// using the captured fallback above.
    cfg_snap: Option<Arc<arc_swap::ArcSwap<crate::config::Config>>>,

    /// Wall-clock instant when this engine spawned mpv. Used by telemetry to
    /// report a real `mpv_uptime_s` rather than mirroring client uptime.
    mpv_started_at: Instant,

    /// Per-media playback quality accumulator. Reset on each `loadfile`.
    quality: Arc<RwLock<PlaybackQuality>>,
}

/// Current playback state
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PlaybackState {
    /// Currently loaded file path
    pub current_file: Option<String>,

    /// Whether playback is active
    pub is_playing: bool,

    /// Current position in seconds (for videos)
    pub position: Option<f64>,

    /// Duration in seconds (for videos)
    pub duration: Option<f64>,

    /// Whether this is an image (uses timer)
    pub is_image: bool,
}

/// Snapshot of mpv health metrics, queried by the telemetry subsystem.
#[derive(Debug, Clone, Default)]
pub struct MpvHealthStats {
    /// Whether the mpv IPC socket accepted a connection just now.
    pub alive: bool,
    /// Cumulative dropped frame count reported by `decoder-frame-drop-count`.
    pub dropped_frames: u64,
    /// Best-effort string for the most recent decoder error (None if not exposed).
    pub last_decoder_error: Option<String>,
}

/// Per-media playback quality counters maintained by the engine across the
/// lifetime of a single `play()` invocation. Reset on every `loadfile`.
#[derive(Debug, Clone, Default)]
pub struct PlaybackQuality {
    /// Wall-clock instant when the most recent `loadfile` was issued.
    /// Used as the stopwatch base for `time_to_first_frame_ms`.
    pub loadfile_at: Option<Instant>,
    /// Snapshot of `decoder-frame-drop-count` taken at `loadfile`. The end-
    /// of-session diff (current - this) yields per-media dropped frames.
    pub dropped_at_start: u64,
    /// Number of times `paused-for-cache` transitioned false→true since
    /// `loadfile` — a proxy for rebuffering events.
    pub rebuffer_count: u32,
    /// Time-to-first-frame in milliseconds: time between `loadfile` and the
    /// first non-zero `playback-time` reading. `None` if playback never
    /// produced a frame (image, error, etc.).
    pub time_to_first_frame_ms: Option<u32>,
    /// Internal edge-detection state for `paused-for-cache` polling.
    pub was_paused_for_cache: bool,
}

/// End-of-session quality snapshot, returned by
/// `PlaybackEngine::take_quality_snapshot()` and forwarded to the analytics
/// API in the `/playback/:id/end` body.
#[derive(Debug, Clone, Copy, Default)]
pub struct PlaybackQualitySnapshot {
    pub rebuffer_count: u32,
    pub dropped_frames: u32,
    pub time_to_first_frame_ms: Option<u32>,
    /// Decoder error count is currently always 0 — wiring up mpv log-message
    /// subscription is deferred. Field is reported for forward-compat.
    pub decoder_errors: u32,
}

/// Playback events emitted by the engine
#[derive(Debug, Clone)]
pub enum PlaybackEvent {
    /// File finished playing
    EndFile,

    /// Playback started
    Started { file: String },

    /// Playback paused
    Paused,

    /// Playback resumed
    Resumed,

    /// Playback stopped
    Stopped,

    /// Error occurred
    Error { message: String },

    /// Position update (for videos)
    PositionChanged { position: f64 },
}

impl PlaybackEngineOps for PlaybackEngine {
    fn command_sender(&self) -> mpsc::UnboundedSender<PlaybackCommand> {
        self.command_tx.clone()
    }
}

impl PlaybackEngine {
    /// Create a new playback engine by spawning an mpv subprocess
    pub fn new(
        cancel_token: CancellationToken,
        fullscreen: bool,
        screen_index: u32,
    ) -> Result<Self> {
        let ipc_path = format!("/tmp/montr-mpv-{}.sock", std::process::id());

        // Clean up stale socket
        let _ = std::fs::remove_file(&ipc_path);

        let mut args = vec![
            "--idle=yes".to_string(),
            format!("--input-ipc-server={}", ipc_path),
            "--no-terminal".to_string(),
            "--force-window=yes".to_string(),
            "--keep-open=yes".to_string(),
            "--hwdec=auto".to_string(),
            // Suppress all OSD, controls, and branding
            "--osd-level=0".to_string(),
            "--no-osc".to_string(),
            "--no-input-default-bindings".to_string(),
            "--no-input-cursor".to_string(),
            "--cursor-autohide=always".to_string(),
            "--background-color=#000000".to_string(),
            "--border=no".to_string(),
            "--autofit=1280x720".to_string(),
            "--geometry=50%:50%".to_string(),
            "--fullscreen=yes".to_string(),
            format!("--fs-screen={}", screen_index),
        ];

        // On Linux, pull in the system mpv config shipped with the .deb. It
        // pins vo=gpu and gpu-api=opengl to dodge the broken auto-default
        // (dmabuf-wayland silently rendering nothing) and the broken Vulkan
        // path on Pi 5 + labwc. mpv silently ignores --include if the file
        // doesn't exist (e.g. dev runs from `cargo run`), so this is safe to
        // leave on unconditionally on Linux. Other platforms keep their own
        // defaults.
        #[cfg(target_os = "linux")]
        args.push("--include=/etc/montr-client/mpv.conf".to_string());

        if !fullscreen {
            args.retain(|a| a != "--fullscreen=yes");
        }

        tracing::info!("Starting mpv subprocess with IPC at {}", ipc_path);

        let child = Command::new("mpv")
            .args(&args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| MontrError::MpvInit(format!("Failed to spawn mpv: {}", e)))?;

        tracing::info!("mpv subprocess started (PID: {:?})", child.id());

        let (event_tx, event_rx) = mpsc::channel(100);
        let (command_tx, command_rx) = mpsc::unbounded_channel();

        Ok(Self {
            process: Arc::new(RwLock::new(Some(child))),
            ipc_path,
            state: Arc::new(RwLock::new(PlaybackState::default())),
            event_tx,
            event_rx: Arc::new(RwLock::new(Some(event_rx))),
            command_tx,
            command_rx: Arc::new(RwLock::new(Some(command_rx))),
            cancel_token,
            default_image_duration: 5,
            cfg_snap: None,
            mpv_started_at: Instant::now(),
            quality: Arc::new(RwLock::new(PlaybackQuality::default())),
        })
    }

    /// Wire in the shared config snapshot so the command handler reads
    /// `playback.default_image_duration` live on every Play. When unset,
    /// the construction-time fallback (5s) is used instead.
    pub fn with_cfg_snap(
        mut self,
        cfg_snap: Arc<arc_swap::ArcSwap<crate::config::Config>>,
    ) -> Self {
        self.cfg_snap = Some(cfg_snap);
        self
    }

    /// Resolve the active default image duration from the snapshot when
    /// wired, else fall back to the value captured at construction.
    fn current_default_image_duration(&self) -> u64 {
        match self.cfg_snap.as_ref() {
            Some(snap) => snap.load().playback.default_image_duration,
            None => self.default_image_duration,
        }
    }

    /// How long the underlying mpv subprocess has been running, as observed
    /// by this engine. Re-spawn would currently produce a new engine; once
    /// in-place mpv restart is implemented, this value should reset there.
    pub fn mpv_uptime(&self) -> Duration {
        self.mpv_started_at.elapsed()
    }

    /// Take an end-of-session snapshot of per-media playback quality. Queries
    /// the current `decoder-frame-drop-count` and diffs against the value
    /// captured at `loadfile`. Best-effort: any IPC error returns zeroed
    /// counters so a missing snapshot never blocks analytics.
    pub async fn take_quality_snapshot(&self) -> PlaybackQualitySnapshot {
        let q = self.quality.read().await.clone();
        let dropped_now = self
            .send_command(&[
                serde_json::json!("get_property"),
                serde_json::json!("decoder-frame-drop-count"),
            ])
            .await
            .ok()
            .and_then(|r| r.get("data").and_then(|d| d.as_u64()))
            .unwrap_or(q.dropped_at_start);
        let dropped_frames = dropped_now.saturating_sub(q.dropped_at_start) as u32;

        PlaybackQualitySnapshot {
            rebuffer_count: q.rebuffer_count,
            dropped_frames,
            time_to_first_frame_ms: q.time_to_first_frame_ms,
            decoder_errors: 0,
        }
    }

    /// Send a JSON command to mpv via IPC
    async fn send_command(&self, command: &[serde_json::Value]) -> Result<serde_json::Value> {
        let msg = serde_json::json!({ "command": command });
        self.send_raw(&msg).await
    }

    /// Query the current mpv health stats for telemetry reporting.
    ///
    /// This is best-effort: if mpv is unreachable we report `alive: false` with
    /// zero counters. If it's alive but a property query fails (e.g. mpv doesn't
    /// expose `decoder-frame-drop-count` for the current file), the affected
    /// field stays at its default. Never returns an error.
    pub async fn query_health_stats(&self) -> MpvHealthStats {
        let alive = tokio::net::UnixStream::connect(&self.ipc_path)
            .await
            .is_ok();
        if !alive {
            return MpvHealthStats::default();
        }

        let dropped_frames = self
            .send_command(&[
                serde_json::json!("get_property"),
                serde_json::json!("decoder-frame-drop-count"),
            ])
            .await
            .ok()
            .and_then(|r| r.get("data").and_then(|d| d.as_u64()))
            .unwrap_or(0);

        MpvHealthStats {
            alive: true,
            dropped_frames,
            last_decoder_error: None,
        }
    }

    /// Send a raw JSON message to mpv IPC socket
    async fn send_raw(&self, msg: &serde_json::Value) -> Result<serde_json::Value> {
        // Connect to the IPC socket
        let stream = tokio::net::UnixStream::connect(&self.ipc_path)
            .await
            .map_err(|e| MontrError::MpvCommand(format!("IPC connect failed: {}", e)))?;

        let (reader, mut writer) = tokio::io::split(stream);

        // Send command (must be newline-terminated)
        let mut data = serde_json::to_vec(msg)
            .map_err(|e| MontrError::MpvCommand(format!("JSON serialize failed: {}", e)))?;
        data.push(b'\n');

        writer
            .write_all(&data)
            .await
            .map_err(|e| MontrError::MpvCommand(format!("IPC write failed: {}", e)))?;

        // Read response
        let mut buf_reader = BufReader::new(reader);
        let mut line = String::new();
        buf_reader
            .read_line(&mut line)
            .await
            .map_err(|e| MontrError::MpvCommand(format!("IPC read failed: {}", e)))?;

        serde_json::from_str(&line)
            .map_err(|e| MontrError::MpvCommand(format!("IPC parse failed: {}", e)))
    }

    /// Wait for the IPC socket to become available
    async fn wait_for_ipc(&self) -> Result<()> {
        for i in 0..50 {
            if tokio::net::UnixStream::connect(&self.ipc_path)
                .await
                .is_ok()
            {
                tracing::info!("mpv IPC connected after {}ms", i * 100);
                return Ok(());
            }
            sleep(Duration::from_millis(100)).await;
        }
        Err(MontrError::MpvInit(
            "Timed out waiting for mpv IPC socket".to_string(),
        ))
    }

    /// Run the playback engine command loop
    pub async fn run(self: Arc<Self>) -> Result<()> {
        // Wait for mpv IPC to be ready
        self.wait_for_ipc().await?;

        // Take the command receiver
        let mut command_rx = {
            let mut rx_lock = self.command_rx.write().await;
            rx_lock
                .take()
                .ok_or_else(|| MontrError::Playback("Command receiver already taken".to_string()))?
        };

        tracing::info!("Playback engine started (IPC mode)");

        // Spawn event listener
        let event_self = self.clone();
        tokio::spawn(async move {
            event_self.event_loop().await;
        });

        loop {
            tokio::select! {
                _ = self.cancel_token.cancelled() => {
                    tracing::info!("Playback engine shutting down");
                    // Kill mpv process
                    let _ = self.send_command(&[serde_json::json!("quit")]).await;
                    let _ = std::fs::remove_file(&self.ipc_path);
                    break;
                }
                Some(command) = command_rx.recv() => {
                    if let Err(e) = self.handle_command(command).await {
                        tracing::error!("Failed to handle playback command: {}", e);
                    }
                }
            }
        }

        Ok(())
    }

    /// Poll mpv for events and position updates
    async fn event_loop(&self) {
        let mut eof_sent_for_file: Option<String> = None;
        let mut ipc_fail_count: u32 = 0;

        loop {
            if self.cancel_token.is_cancelled() {
                break;
            }

            // Watchdog: check mpv is still responsive
            if tokio::net::UnixStream::connect(&self.ipc_path)
                .await
                .is_err()
            {
                ipc_fail_count += 1;
                if ipc_fail_count >= 5 {
                    tracing::error!(
                        "mpv IPC unresponsive for {} checks, process may have crashed",
                        ipc_fail_count
                    );
                    let _ = self
                        .event_tx
                        .send(PlaybackEvent::Error {
                            message: "mpv process unresponsive".to_string(),
                        })
                        .await;
                    break;
                }
                sleep(Duration::from_secs(1)).await;
                continue;
            }
            ipc_fail_count = 0;

            let state = self.state.read().await.clone();

            // Reset EOF tracking when a new file starts playing
            if let Some(ref current) = state.current_file {
                if eof_sent_for_file.as_ref() != Some(current) && state.is_playing {
                    eof_sent_for_file = None;
                }
            }

            // Poll position if playing a video
            if state.is_playing && !state.is_image {
                if let Ok(response) = self
                    .send_command(&[
                        serde_json::json!("get_property"),
                        serde_json::json!("playback-time"),
                    ])
                    .await
                {
                    if let Some(pos) = response.get("data").and_then(|d| d.as_f64()) {
                        let mut s = self.state.write().await;
                        s.position = Some(pos);
                        let _ = self
                            .event_tx
                            .send(PlaybackEvent::PositionChanged { position: pos })
                            .await;

                        // Time-to-first-frame: first non-zero playback-time
                        // after a loadfile is the moment mpv started actually
                        // rendering. Record once per session.
                        if pos > 0.0 {
                            let mut q = self.quality.write().await;
                            if q.time_to_first_frame_ms.is_none() {
                                if let Some(start) = q.loadfile_at {
                                    let ms =
                                        start.elapsed().as_millis().min(u32::MAX as u128) as u32;
                                    q.time_to_first_frame_ms = Some(ms);
                                }
                            }
                        }
                    }
                }

                // Rebuffer count: rising edges of `paused-for-cache`. mpv
                // sets this when it had to stop playback waiting for I/O.
                if let Ok(response) = self
                    .send_command(&[
                        serde_json::json!("get_property"),
                        serde_json::json!("paused-for-cache"),
                    ])
                    .await
                {
                    if let Some(now_paused) = response.get("data").and_then(|d| d.as_bool()) {
                        let mut q = self.quality.write().await;
                        if now_paused && !q.was_paused_for_cache {
                            q.rebuffer_count = q.rebuffer_count.saturating_add(1);
                        }
                        q.was_paused_for_cache = now_paused;
                    }
                }

                // Check for end of file (only once per file)
                if eof_sent_for_file.is_none() {
                    if let Ok(response) = self
                        .send_command(&[
                            serde_json::json!("get_property"),
                            serde_json::json!("eof-reached"),
                        ])
                        .await
                    {
                        if response.get("data").and_then(|d| d.as_bool()) == Some(true) {
                            tracing::info!("End of file reached");
                            eof_sent_for_file = state.current_file.clone();
                            let mut s = self.state.write().await;
                            s.is_playing = false;
                            let _ = self.event_tx.send(PlaybackEvent::EndFile).await;
                        }
                    }
                }
            }

            sleep(Duration::from_secs(1)).await;
        }
    }

    /// Handle a playback command
    async fn handle_command(&self, command: PlaybackCommand) -> Result<()> {
        match command {
            PlaybackCommand::Play {
                path,
                is_video,
                image_duration,
                subtitles,
            } => {
                let duration = image_duration
                    .map(|d| d as u64)
                    .unwrap_or_else(|| self.current_default_image_duration());
                self.play(&path, !is_video, duration, subtitles.as_ref())
                    .await
            }
            PlaybackCommand::Pause => self.pause().await,
            PlaybackCommand::Resume => self.resume().await,
            PlaybackCommand::Stop => self.stop().await,
            PlaybackCommand::Volume { level } => self.volume(level).await,
            PlaybackCommand::Seek { position } => self.seek(position).await,
        }
    }

    /// Subscribe to playback events (can only be called once)
    pub async fn subscribe_events(&self) -> mpsc::Receiver<PlaybackEvent> {
        self.event_rx
            .write()
            .await
            .take()
            .expect("subscribe_events can only be called once")
    }

    /// Play a media file
    pub async fn play(
        &self,
        file_path: &Path,
        is_image: bool,
        image_duration_secs: u64,
        subtitles: Option<&crate::playback::subtitle_selector::ResolvedSubtitles>,
    ) -> Result<()> {
        let path_str = file_path
            .to_str()
            .ok_or_else(|| MontrError::Playback("Invalid file path".to_string()))?;

        tracing::info!("Playing: {} (image: {})", path_str, is_image);

        // Reset per-media quality counters to anchor the new session. Capture
        // the current dropped-frame count BEFORE the loadfile so the diff at
        // end-of-session attributes only this media's drops.
        {
            let dropped_at_start = self
                .send_command(&[
                    serde_json::json!("get_property"),
                    serde_json::json!("decoder-frame-drop-count"),
                ])
                .await
                .ok()
                .and_then(|r| r.get("data").and_then(|d| d.as_u64()))
                .unwrap_or(0);
            let mut q = self.quality.write().await;
            *q = PlaybackQuality {
                loadfile_at: Some(Instant::now()),
                dropped_at_start,
                rebuffer_count: 0,
                time_to_first_frame_ms: None,
                was_paused_for_cache: false,
            };
        }

        // Load file via IPC and ensure playback starts
        self.send_command(&[
            serde_json::json!("loadfile"),
            serde_json::json!(path_str),
            serde_json::json!("replace"),
        ])
        .await?;

        // Unpause in case mpv was paused at end of previous file
        let _ = self
            .send_command(&[
                serde_json::json!("set_property"),
                serde_json::json!("pause"),
                serde_json::json!(false),
            ])
            .await;

        // Apply subtitle plan (videos only — images never carry subs).
        if !is_image {
            if let Some(plan) = subtitles {
                if let Err(e) = self.apply_subtitle_plan(plan).await {
                    // Subtitles are best-effort. A failure here must not keep
                    // the video from playing — log and move on.
                    tracing::warn!("Failed to apply subtitle plan: {}", e);
                }
            } else {
                // No plan provided at all — hide whatever mpv picked by default.
                let _ = self
                    .send_command(&[
                        serde_json::json!("set_property"),
                        serde_json::json!("sub-visibility"),
                        serde_json::json!(false),
                    ])
                    .await;
            }
        }

        // Update state
        {
            let mut state = self.state.write().await;
            state.current_file = Some(path_str.to_string());
            state.is_playing = true;
            state.is_image = is_image;
            state.position = None;
            state.duration = None;
        }

        // For images, set up timer to signal end
        if is_image {
            let state = self.state.clone();
            let event_tx = self.event_tx.clone();

            tokio::spawn(async move {
                sleep(Duration::from_secs(image_duration_secs)).await;
                let mut s = state.write().await;
                s.is_playing = false;
                let _ = event_tx.send(PlaybackEvent::EndFile).await;
            });
        }

        let _ = self
            .event_tx
            .send(PlaybackEvent::Started {
                file: path_str.to_string(),
            })
            .await;

        Ok(())
    }

    /// Register all external subtitle sidecars with mpv and then set the
    /// active track (or `sid=no` if nothing is selected). Called only on
    /// video playback — images never carry subtitles.
    async fn apply_subtitle_plan(
        &self,
        plan: &crate::playback::subtitle_selector::ResolvedSubtitles,
    ) -> Result<()> {
        use crate::playback::subtitle_selector::SubtitleSelection;

        // `sub-add <path> auto` makes mpv aware of each sidecar without
        // immediately switching to it. We'll pick the active one explicitly
        // via `sid` below.
        for sidecar in &plan.external_paths {
            let path_str = match sidecar.to_str() {
                Some(s) => s,
                None => {
                    tracing::warn!("Skipping subtitle with non-UTF-8 path: {:?}", sidecar);
                    continue;
                }
            };
            if let Err(e) = self
                .send_command(&[
                    serde_json::json!("sub-add"),
                    serde_json::json!(path_str),
                    serde_json::json!("auto"),
                ])
                .await
            {
                tracing::warn!("sub-add failed for {}: {}", path_str, e);
            }
        }

        // Apply optional font-size override before selecting the track,
        // so the first frame rendered already uses the right size.
        if let Some(size) = plan.font_size {
            let _ = self
                .send_command(&[
                    serde_json::json!("set_property"),
                    serde_json::json!("sub-font-size"),
                    serde_json::json!(size),
                ])
                .await;
        }

        match &plan.selected {
            SubtitleSelection::None => {
                self.send_command(&[
                    serde_json::json!("set_property"),
                    serde_json::json!("sub-visibility"),
                    serde_json::json!(false),
                ])
                .await?;
            }
            SubtitleSelection::Embedded { sid } => {
                self.send_command(&[
                    serde_json::json!("set_property"),
                    serde_json::json!("sid"),
                    serde_json::json!(*sid),
                ])
                .await?;
                self.send_command(&[
                    serde_json::json!("set_property"),
                    serde_json::json!("sub-visibility"),
                    serde_json::json!(true),
                ])
                .await?;
            }
            SubtitleSelection::External { path } => {
                // mpv assigns sids to `sub-add` entries after any embedded
                // streams. Rather than track the exact sid returned by
                // `sub-add`, we re-add the selected one with `select` which
                // switches to it atomically.
                let path_str = path
                    .to_str()
                    .ok_or_else(|| MontrError::Playback("Invalid subtitle path".to_string()))?;
                self.send_command(&[
                    serde_json::json!("sub-add"),
                    serde_json::json!(path_str),
                    serde_json::json!("select"),
                ])
                .await?;
                self.send_command(&[
                    serde_json::json!("set_property"),
                    serde_json::json!("sub-visibility"),
                    serde_json::json!(true),
                ])
                .await?;
            }
        }

        Ok(())
    }

    /// Pause playback
    pub async fn pause(&self) -> Result<()> {
        self.send_command(&[
            serde_json::json!("set_property"),
            serde_json::json!("pause"),
            serde_json::json!(true),
        ])
        .await?;

        let mut state = self.state.write().await;
        state.is_playing = false;
        let _ = self.event_tx.send(PlaybackEvent::Paused).await;
        Ok(())
    }

    /// Resume playback
    pub async fn resume(&self) -> Result<()> {
        self.send_command(&[
            serde_json::json!("set_property"),
            serde_json::json!("pause"),
            serde_json::json!(false),
        ])
        .await?;

        let mut state = self.state.write().await;
        state.is_playing = true;
        let _ = self.event_tx.send(PlaybackEvent::Resumed).await;
        Ok(())
    }

    /// Stop playback
    pub async fn stop(&self) -> Result<()> {
        self.send_command(&[serde_json::json!("stop")]).await?;

        let mut state = self.state.write().await;
        state.current_file = None;
        state.is_playing = false;
        state.position = None;
        state.duration = None;
        let _ = self.event_tx.send(PlaybackEvent::Stopped).await;
        Ok(())
    }

    /// Seek to position
    pub async fn seek(&self, position: f64) -> Result<()> {
        let clamped = clamp_seek(position);
        if clamped != position {
            tracing::trace!("Seek position clamped from {} to {}", position, clamped);
        }
        self.send_command(&[
            serde_json::json!("seek"),
            serde_json::json!(clamped),
            serde_json::json!("absolute"),
        ])
        .await?;

        let mut state = self.state.write().await;
        state.position = Some(clamped);
        Ok(())
    }

    /// Set volume level (0-100)
    pub async fn volume(&self, level: f64) -> Result<()> {
        let clamped = clamp_volume(level);
        if clamped != level {
            tracing::warn!("Volume level {} clamped to {}", level, clamped);
        }
        tracing::info!("Setting volume to {}", clamped);
        self.send_command(&[
            serde_json::json!("set_property"),
            serde_json::json!("volume"),
            serde_json::json!(clamped),
        ])
        .await?;
        Ok(())
    }

    /// Get current playback state
    pub async fn get_state(&self) -> PlaybackState {
        self.state.read().await.clone()
    }

    /// Get current position
    pub async fn get_position(&self) -> Option<f64> {
        if let Ok(response) = self
            .send_command(&[
                serde_json::json!("get_property"),
                serde_json::json!("time-pos"),
            ])
            .await
        {
            if let Some(pos) = response.get("data").and_then(|d| d.as_f64()) {
                let mut state = self.state.write().await;
                state.position = Some(pos);
                return Some(pos);
            }
        }
        None
    }

    /// Get duration
    pub async fn get_duration(&self) -> Option<f64> {
        if let Ok(response) = self
            .send_command(&[
                serde_json::json!("get_property"),
                serde_json::json!("duration"),
            ])
            .await
        {
            if let Some(dur) = response.get("data").and_then(|d| d.as_f64()) {
                let mut state = self.state.write().await;
                state.duration = Some(dur);
                return Some(dur);
            }
        }
        None
    }

    /// Check if currently playing
    pub async fn is_playing(&self) -> bool {
        self.state.read().await.is_playing
    }

    /// Capture a screenshot to the given file path
    pub async fn screenshot(&self, output_path: &str) -> Result<()> {
        self.send_command(&[
            serde_json::json!("screenshot-to-file"),
            serde_json::json!(output_path),
            serde_json::json!("video"),
        ])
        .await?;
        Ok(())
    }
}

impl Drop for PlaybackEngine {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.ipc_path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_playback_state_default() {
        let state = PlaybackState::default();
        assert_eq!(state.current_file, None);
        assert_eq!(state.is_playing, false);
        assert_eq!(state.position, None);
        assert_eq!(state.duration, None);
        assert_eq!(state.is_image, false);
    }

    #[test]
    fn test_playback_state_equality() {
        let state1 = PlaybackState {
            current_file: Some("/path/to/file.mp4".to_string()),
            is_playing: true,
            position: Some(10.5),
            duration: Some(120.0),
            is_image: false,
        };

        let state2 = PlaybackState {
            current_file: Some("/path/to/file.mp4".to_string()),
            is_playing: true,
            position: Some(10.5),
            duration: Some(120.0),
            is_image: false,
        };

        assert_eq!(state1, state2);
    }

    #[test]
    fn clamp_volume_in_range_is_unchanged() {
        assert_eq!(clamp_volume(0.0), 0.0);
        assert_eq!(clamp_volume(50.0), 50.0);
        assert_eq!(clamp_volume(100.0), 100.0);
    }

    #[test]
    fn clamp_volume_above_100_is_capped() {
        assert_eq!(clamp_volume(150.0), 100.0);
        assert_eq!(clamp_volume(f64::INFINITY), 100.0);
    }

    #[test]
    fn clamp_volume_below_0_is_floored() {
        assert_eq!(clamp_volume(-5.0), 0.0);
        assert_eq!(clamp_volume(f64::NEG_INFINITY), 0.0);
    }

    #[test]
    fn clamp_volume_nan_becomes_zero() {
        assert_eq!(clamp_volume(f64::NAN), 0.0);
    }

    #[test]
    fn clamp_seek_non_negative_is_unchanged() {
        assert_eq!(clamp_seek(0.0), 0.0);
        assert_eq!(clamp_seek(42.5), 42.5);
        assert_eq!(clamp_seek(10_000.0), 10_000.0);
    }

    #[test]
    fn clamp_seek_negative_is_floored_to_zero() {
        assert_eq!(clamp_seek(-1.0), 0.0);
        assert_eq!(clamp_seek(f64::NEG_INFINITY), 0.0);
    }

    #[test]
    fn clamp_seek_nan_becomes_zero() {
        assert_eq!(clamp_seek(f64::NAN), 0.0);
    }
}
