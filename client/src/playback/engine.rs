//! MPV-based playback engine for video and image rendering
//!
//! This module wraps libmpv to provide media playback functionality with support
//! for both videos and images (with configurable display duration).

use crate::error::{MontrError, Result};
use libmpv::Mpv;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, RwLock};
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;

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

/// MPV playback engine
///
/// Manages media playback using libmpv with support for videos and images.
pub struct PlaybackEngine {
    /// MPV instance
    mpv: Arc<Mpv>,

    /// Current playback state
    state: Arc<RwLock<PlaybackState>>,

    /// Event channel sender
    event_tx: mpsc::Sender<PlaybackEvent>,

    /// Command channel sender (for external control)
    command_tx: mpsc::UnboundedSender<PlaybackCommand>,

    /// Command channel receiver
    command_rx: Arc<RwLock<Option<mpsc::UnboundedReceiver<PlaybackCommand>>>>,

    /// Cancellation token
    cancel_token: CancellationToken,

    /// Default image duration (seconds)
    default_image_duration: u64,

    /// Fullscreen mode (for future display configuration)
    #[allow(dead_code)]
    fullscreen: bool,
}

/// Current playback state
#[derive(Debug, Clone, PartialEq)]
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

impl Default for PlaybackState {
    fn default() -> Self {
        Self {
            current_file: None,
            is_playing: false,
            position: None,
            duration: None,
            is_image: false,
        }
    }
}

impl PlaybackEngine {
    /// Create a new playback engine
    pub fn new(cancel_token: CancellationToken) -> Result<Self> {
        let mpv = Mpv::new().map_err(|e| MontrError::MpvInit(e.to_string()))?;

        // Configure MPV with basic settings
        Self::configure_mpv(&mpv, true)?;

        let (event_tx, _rx) = mpsc::channel(100);
        let (command_tx, command_rx) = mpsc::unbounded_channel();

        Ok(Self {
            mpv: Arc::new(mpv),
            state: Arc::new(RwLock::new(PlaybackState::default())),
            event_tx,
            command_tx,
            command_rx: Arc::new(RwLock::new(Some(command_rx))),
            cancel_token,
            default_image_duration: 5,
            fullscreen: true,
        })
    }

    /// Configure MPV with optimal settings
    fn configure_mpv(mpv: &Mpv, fullscreen: bool) -> Result<()> {
        // Video output
        mpv.set_property("vo", "gpu")
            .map_err(|e| MontrError::MpvProperty(e.to_string()))?;

        // Hardware decoding
        mpv.set_property("hwdec", "auto")
            .map_err(|e| MontrError::MpvProperty(e.to_string()))?;

        // Disable on-screen display
        mpv.set_property("osd-level", 0i64)
            .map_err(|e| MontrError::MpvProperty(e.to_string()))?;

        // Disable window decorations
        mpv.set_property("border", false)
            .map_err(|e| MontrError::MpvProperty(e.to_string()))?;

        // Fullscreen
        mpv.set_property("fullscreen", fullscreen)
            .map_err(|e| MontrError::MpvProperty(e.to_string()))?;

        // Keep open after playback
        mpv.set_property("keep-open", "yes")
            .map_err(|e| MontrError::MpvProperty(e.to_string()))?;

        // Disable audio (for images)
        mpv.set_property("audio", "no")
            .map_err(|e| MontrError::MpvProperty(e.to_string()))?;

        tracing::info!("MPV configured successfully");
        Ok(())
    }

    /// Get a sender for sending commands to the playback engine
    pub fn command_sender(&self) -> mpsc::UnboundedSender<PlaybackCommand> {
        self.command_tx.clone()
    }

    /// Run the playback engine command loop
    pub async fn run(self: Arc<Self>) -> Result<()> {
        // Take the command receiver
        let mut command_rx = {
            let mut rx_lock = self.command_rx.write().await;
            rx_lock.take().ok_or_else(|| MontrError::Playback("Command receiver already taken".to_string()))?
        };

        tracing::info!("Playback engine started");

        loop {
            tokio::select! {
                _ = self.cancel_token.cancelled() => {
                    tracing::info!("Playback engine shutting down");
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

    /// Handle a playback command
    async fn handle_command(&self, command: PlaybackCommand) -> Result<()> {
        match command {
            PlaybackCommand::Play { path, is_video, image_duration } => {
                let duration = image_duration.map(|d| d as u64).unwrap_or(self.default_image_duration);
                self.play(&path, !is_video, duration).await
            }
            PlaybackCommand::Pause => self.pause().await,
            PlaybackCommand::Resume => self.resume().await,
            PlaybackCommand::Stop => self.stop().await,
        }
    }

    /// Subscribe to playback events
    ///
    /// Returns a receiver for playback events. The events are polled from libmpv
    /// in a background blocking task and converted to our PlaybackEvent enum.
    pub fn subscribe_events(&self) -> mpsc::Receiver<PlaybackEvent> {
        let (tx, rx) = mpsc::channel(100);
        let mpv_handle = self.mpv.clone();
        let cancel = self.cancel_token.clone();

        // Spawn blocking task for MPV event polling
        // MPV's event API is blocking, so we need to use spawn_blocking
        tokio::task::spawn_blocking(move || {
            tracing::info!("MPV event polling loop started");

            // Create event context from MPV handle
            // This creates a context for receiving events from libmpv
            let mut event_ctx = mpv_handle.create_event_context();

            // Main event polling loop
            loop {
                // Check if we should shutdown
                if cancel.is_cancelled() {
                    tracing::info!("MPV event polling loop shutting down");
                    break;
                }

                // Wait for next event with timeout
                // Using 1.0 second timeout to allow checking cancellation token periodically
                match event_ctx.wait_event(1.0) {
                    Some(Ok(event)) => {
                        // Convert libmpv event to our PlaybackEvent
                        let playback_event = match event {
                            libmpv::events::Event::EndFile(_) => {
                                tracing::debug!("MPV EndFile event");
                                Some(PlaybackEvent::EndFile)
                            }

                            libmpv::events::Event::FileLoaded => {
                                tracing::debug!("MPV FileLoaded event");
                                // We don't have a direct FileLoaded event in PlaybackEvent
                                // This is already handled by the play() method sending Started event
                                None
                            }

                            libmpv::events::Event::PropertyChange { name, change, .. } => {
                                // We're interested in time-pos changes for position updates
                                if name == "time-pos" {
                                    if let libmpv::events::PropertyData::Double(position) = change {
                                        tracing::trace!("MPV time-pos changed: {:.2}s", position);
                                        Some(PlaybackEvent::PositionChanged { position })
                                    } else {
                                        None
                                    }
                                } else {
                                    None
                                }
                            }

                            libmpv::events::Event::PlaybackRestart => {
                                tracing::debug!("MPV PlaybackRestart event");
                                None
                            }

                            libmpv::events::Event::Shutdown => {
                                tracing::info!("MPV Shutdown event received");
                                break;
                            }

                            _ => {
                                // Ignore other events we don't care about
                                None
                            }
                        };

                        // Send event to channel if we have one
                        if let Some(event) = playback_event {
                            // Try to send, but don't block if channel is full
                            // Use try_send to avoid blocking the event loop
                            match tx.try_send(event.clone()) {
                                Ok(_) => {
                                    tracing::trace!("Sent event: {:?}", event);
                                }
                                Err(mpsc::error::TrySendError::Full(_)) => {
                                    tracing::warn!("Event channel full, dropping event: {:?}", event);
                                }
                                Err(mpsc::error::TrySendError::Closed(_)) => {
                                    tracing::info!("Event channel closed, stopping event loop");
                                    break;
                                }
                            }
                        }
                    }

                    Some(Err(e)) => {
                        tracing::error!("MPV event error: {}", e);
                        // Don't break on errors, just log and continue
                        // The error might be transient
                    }

                    None => {
                        // Timeout reached, no event available
                        // This is expected - just continue the loop
                        tracing::trace!("MPV event poll timeout (normal)");
                    }
                }
            }

            tracing::info!("MPV event polling loop exited");
        });

        rx
    }

    /// Play a media file
    ///
    /// For images, this will display for the configured duration.
    /// For videos, this will play until completion.
    pub async fn play(&self, file_path: &Path, is_image: bool, image_duration_secs: u64) -> Result<()> {
        let path_str = file_path
            .to_str()
            .ok_or_else(|| MontrError::Playback("Invalid file path".to_string()))?;

        tracing::info!("Playing: {} (image: {})", path_str, is_image);

        // Load file
        self.mpv
            .command("loadfile", &[path_str])
            .map_err(|e| MontrError::MpvCommand(e.to_string()))?;

        // Update state
        {
            let mut state = self.state.write().await;
            state.current_file = Some(path_str.to_string());
            state.is_playing = true;
            state.is_image = is_image;
            state.position = None;
            state.duration = None;
        }

        // For images, set up timer
        if is_image {
            let state = self.state.clone();
            let event_tx = self.event_tx.clone();

            tokio::spawn(async move {
                sleep(Duration::from_secs(image_duration_secs)).await;

                // Mark as finished
                let mut s = state.write().await;
                s.is_playing = false;

                // Send end event
                let _ = event_tx.send(PlaybackEvent::EndFile).await;
            });
        }

        // Send started event
        let _ = self
            .event_tx
            .send(PlaybackEvent::Started {
                file: path_str.to_string(),
            })
            .await;

        Ok(())
    }

    /// Pause playback (videos only)
    pub async fn pause(&self) -> Result<()> {
        self.mpv
            .set_property("pause", true)
            .map_err(|e| MontrError::MpvProperty(e.to_string()))?;

        let mut state = self.state.write().await;
        state.is_playing = false;

        let _ = self.event_tx.send(PlaybackEvent::Paused).await;

        Ok(())
    }

    /// Resume playback (videos only)
    pub async fn resume(&self) -> Result<()> {
        self.mpv
            .set_property("pause", false)
            .map_err(|e| MontrError::MpvProperty(e.to_string()))?;

        let mut state = self.state.write().await;
        state.is_playing = true;

        let _ = self.event_tx.send(PlaybackEvent::Resumed).await;

        Ok(())
    }

    /// Stop playback
    pub async fn stop(&self) -> Result<()> {
        self.mpv
            .command("stop", &[])
            .map_err(|e| MontrError::MpvCommand(e.to_string()))?;

        let mut state = self.state.write().await;
        state.current_file = None;
        state.is_playing = false;
        state.position = None;
        state.duration = None;

        let _ = self.event_tx.send(PlaybackEvent::Stopped).await;

        Ok(())
    }

    /// Seek to position (videos only)
    pub async fn seek(&self, position: f64) -> Result<()> {
        self.mpv
            .command("seek", &[&position.to_string(), "absolute"])
            .map_err(|e| MontrError::MpvCommand(e.to_string()))?;

        let mut state = self.state.write().await;
        state.position = Some(position);

        Ok(())
    }

    /// Get current playback state
    pub async fn get_state(&self) -> PlaybackState {
        self.state.read().await.clone()
    }

    /// Get current position (videos only)
    pub async fn get_position(&self) -> Option<f64> {
        if let Ok(pos) = self.mpv.get_property::<f64>("time-pos") {
            let mut state = self.state.write().await;
            state.position = Some(pos);
            Some(pos)
        } else {
            None
        }
    }

    /// Get duration (videos only)
    pub async fn get_duration(&self) -> Option<f64> {
        if let Ok(dur) = self.mpv.get_property::<f64>("duration") {
            let mut state = self.state.write().await;
            state.duration = Some(dur);
            Some(dur)
        } else {
            None
        }
    }

    /// Check if currently playing
    pub async fn is_playing(&self) -> bool {
        self.state.read().await.is_playing
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

    // Note: MPV tests require a display/X11 server, so they're commented out for CI
    // Uncomment these for local testing with a display available

    // #[tokio::test]
    // async fn test_engine_creation() {
    //     let config = Arc::new(create_test_config());
    //     let engine = PlaybackEngine::new(config);
    //     assert!(engine.is_ok());
    // }

    // #[tokio::test]
    // async fn test_initial_state() {
    //     let config = Arc::new(create_test_config());
    //     let engine = PlaybackEngine::new(config).unwrap();
    //     let state = engine.get_state().await;
    //     assert!(!state.is_playing);
    //     assert_eq!(state.current_file, None);
    // }
}
