//! Media playback module
//!
//! Handles video and image playback using MPV, with playlist queue management
//! and event handling.

pub mod engine;
pub mod events;
pub mod queue;
pub mod subtitle_selector;

// Re-export common types
pub use engine::{PlaybackCommand, PlaybackEngine, PlaybackEvent, PlaybackState};
pub use events::{MpvEvent, MpvEventHandler};
pub use queue::PlaylistQueue;
pub use subtitle_selector::{ResolvedSubtitles, SubtitleCandidate, SubtitleSelection};
