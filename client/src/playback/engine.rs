//! MPV-based playback engine using JSON IPC subprocess
//!
//! Controls mpv via its JSON IPC protocol over a Unix socket, avoiding
//! libmpv C API version incompatibilities.

use crate::error::{MontrError, Result};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, RwLock};
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

#[cfg(test)]
use mockall::automock;

/// Commands that can be sent to the playback engine
#[derive(Debug, Clone)]
pub enum PlaybackCommand {
    /// Play a media file
    Play {
        path: PathBuf,
        is_video: bool,
        image_duration: Option<u32>,
    },
    /// Pause playback
    Pause,
    /// Resume playback
    Resume,
    /// Stop playback
    Stop,
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

    /// Default image duration (seconds)
    default_image_duration: u64,
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
        })
    }

    /// Send a JSON command to mpv via IPC
    async fn send_command(&self, command: &[serde_json::Value]) -> Result<serde_json::Value> {
        let msg = serde_json::json!({ "command": command });
        self.send_raw(&msg).await
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

        loop {
            if self.cancel_token.is_cancelled() {
                break;
            }

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
            } => {
                let duration = image_duration
                    .map(|d| d as u64)
                    .unwrap_or(self.default_image_duration);
                self.play(&path, !is_video, duration).await
            }
            PlaybackCommand::Pause => self.pause().await,
            PlaybackCommand::Resume => self.resume().await,
            PlaybackCommand::Stop => self.stop().await,
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
    ) -> Result<()> {
        let path_str = file_path
            .to_str()
            .ok_or_else(|| MontrError::Playback("Invalid file path".to_string()))?;

        tracing::info!("Playing: {} (image: {})", path_str, is_image);

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
        self.send_command(&[
            serde_json::json!("seek"),
            serde_json::json!(position),
            serde_json::json!("absolute"),
        ])
        .await?;

        let mut state = self.state.write().await;
        state.position = Some(position);
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
}
