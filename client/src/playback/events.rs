//! MPV event handling
//!
//! Processes events from the MPV player and translates them into application events.

use crate::error::Result;
use tokio::sync::mpsc;

/// MPV event types that we care about
#[derive(Debug, Clone, PartialEq)]
pub enum MpvEvent {
    /// File has been loaded and playback started
    FileLoaded,

    /// Playback has ended
    EndFile,

    /// Playback was paused
    Pause,

    /// Playback was resumed
    Unpause,

    /// Seek operation completed
    SeekComplete,

    /// Property changed (e.g., time-pos, duration)
    PropertyChange {
        property: String,
        value: String,
    },

    /// MPV shutdown
    Shutdown,

    /// Error occurred
    Error {
        message: String,
    },
}

/// MPV event handler
///
/// Listens for events from MPV and translates them into high-level application events.
pub struct MpvEventHandler {
    /// Channel for sending events to application
    event_tx: mpsc::Sender<MpvEvent>,
}

impl MpvEventHandler {
    /// Create a new event handler
    pub fn new() -> (Self, mpsc::Receiver<MpvEvent>) {
        let (tx, rx) = mpsc::channel(100);

        (Self { event_tx: tx }, rx)
    }

    /// Start event processing loop
    ///
    /// NOTE: The actual MPV event polling is now implemented in the
    /// PlaybackEngine's `subscribe_events()` method in engine.rs.
    /// This handler is kept for manual event injection in tests.
    pub async fn start(self) -> Result<()> {
        // This is intentionally minimal - the real event polling happens
        // in PlaybackEngine::subscribe_events() which uses libmpv's event
        // context in a spawn_blocking task.
        //
        // This handler is primarily used for test event injection via emit().

        Ok(())
    }

    /// Emit an event (for manual event injection in tests)
    pub async fn emit(&self, event: MpvEvent) -> Result<()> {
        self.event_tx
            .send(event)
            .await
            .map_err(|_| crate::error::MontrError::MpvEvent("Channel closed".to_string()))?;
        Ok(())
    }
}

impl Default for MpvEventHandler {
    fn default() -> Self {
        let (handler, _) = Self::new();
        handler
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_event_equality() {
        let event1 = MpvEvent::FileLoaded;
        let event2 = MpvEvent::FileLoaded;
        assert_eq!(event1, event2);

        let event3 = MpvEvent::EndFile;
        assert_ne!(event1, event3);
    }

    #[test]
    fn test_property_change_event() {
        let event = MpvEvent::PropertyChange {
            property: "time-pos".to_string(),
            value: "45.5".to_string(),
        };

        match event {
            MpvEvent::PropertyChange { property, value } => {
                assert_eq!(property, "time-pos");
                assert_eq!(value, "45.5");
            }
            _ => panic!("Expected PropertyChange event"),
        }
    }

    #[test]
    fn test_error_event() {
        let event = MpvEvent::Error {
            message: "Failed to load file".to_string(),
        };

        match event {
            MpvEvent::Error { message } => {
                assert_eq!(message, "Failed to load file");
            }
            _ => panic!("Expected Error event"),
        }
    }

    #[tokio::test]
    async fn test_event_handler_creation() {
        let (handler, mut rx) = MpvEventHandler::new();

        // Emit an event
        handler.emit(MpvEvent::FileLoaded).await.unwrap();

        // Receive the event
        let received = rx.recv().await;
        assert_eq!(received, Some(MpvEvent::FileLoaded));
    }

    #[tokio::test]
    async fn test_multiple_events() {
        let (handler, mut rx) = MpvEventHandler::new();

        // Emit multiple events
        handler.emit(MpvEvent::FileLoaded).await.unwrap();
        handler.emit(MpvEvent::Unpause).await.unwrap();
        handler.emit(MpvEvent::EndFile).await.unwrap();

        // Receive all events
        assert_eq!(rx.recv().await, Some(MpvEvent::FileLoaded));
        assert_eq!(rx.recv().await, Some(MpvEvent::Unpause));
        assert_eq!(rx.recv().await, Some(MpvEvent::EndFile));
    }
}
