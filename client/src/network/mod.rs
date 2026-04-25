//! Network communication module
//!
//! This module handles all network communication with the Montr server,
//! including WebSocket connections, HTTP downloads, and protocol messages.

pub mod connection;
pub mod http;
pub mod protocol;
pub mod reconnect;
pub mod websocket;

// Re-export common types
pub use connection::{ConnectionState, ErrorReason, State};
pub use http::{DownloadOptions, HttpClient};
pub use protocol::{
    ClientCapabilities, ClientMessage, CommandMessage, ErrorMessage, ErrorSeverity,
    HeartbeatMessage, MediaInfo, PlaylistAssignedMessage, PlaylistInterruptMessage, PlaylistItem,
    PlaylistResumeMessage, PlaylistUpdatedMessage, RegisterMessage, Schedule,
    ScheduleDefinitionsMessage, ServerMessage, StatusUpdateMessage,
};
pub use reconnect::ReconnectStrategy;
pub use websocket::WebSocketClient;
