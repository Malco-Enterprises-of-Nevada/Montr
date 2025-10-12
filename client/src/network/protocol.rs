//! WebSocket protocol message types for client-server communication
//!
//! This module defines all message types used in the WebSocket protocol between
//! the Montr client and server. Messages are JSON-encoded with a discriminated
//! union based on the `type` field.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============================================================================
// Client → Server Messages
// ============================================================================

/// Messages sent from client to server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    /// Register client with server
    Register(RegisterMessage),
    /// Send status update
    StatusUpdate(StatusUpdateMessage),
    /// Send heartbeat (keep-alive)
    Heartbeat(HeartbeatMessage),
    /// Report an error
    Error(ErrorMessage),
}

/// Client registration message
///
/// Sent when client first connects to server to register its identity
/// and capabilities.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterMessage {
    /// Unique client ID (UUID v4)
    #[serde(rename = "clientId")]
    pub client_id: String,

    /// Client version (e.g., "1.0.0")
    pub version: String,

    /// Client capabilities
    pub capabilities: ClientCapabilities,
}

/// Client capabilities advertised during registration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientCapabilities {
    /// Whether client can play video files
    pub video: bool,

    /// Whether client can display image files
    pub image: bool,
}

/// Current media information in status update
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurrentMediaInfo {
    /// Media file ID
    pub id: u32,

    /// Media filename
    pub filename: String,
}

/// Status update message
///
/// Sent periodically (every 10 seconds) to report current playback status.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusUpdateMessage {
    /// Client ID
    #[serde(rename = "clientId")]
    pub client_id: String,

    /// Currently playing media (if any)
    #[serde(rename = "currentMedia")]
    pub current_media: Option<CurrentMediaInfo>,

    /// Current playback position in seconds (for videos, null for images or when idle)
    pub position: Option<f64>,

    /// Whether media is currently playing
    #[serde(rename = "isPlaying")]
    pub is_playing: bool,

    /// Timestamp (Unix epoch seconds)
    pub timestamp: u64,
}

/// Heartbeat message
///
/// Sent every 30 seconds to keep connection alive and prove client is responsive.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatMessage {
    /// Client ID
    #[serde(rename = "clientId")]
    pub client_id: String,

    /// Timestamp (Unix epoch seconds)
    pub timestamp: u64,
}

/// Error report message
///
/// Sent when client encounters an error that server should know about.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorMessage {
    /// Client ID
    #[serde(rename = "clientId")]
    pub client_id: String,

    /// Error message
    pub error: String,

    /// Additional context (e.g., media ID, file path)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,

    /// Timestamp (Unix epoch seconds)
    pub timestamp: u64,
}

// ============================================================================
// Server → Client Messages
// ============================================================================

/// Messages sent from server to client
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    /// Playlist has been assigned to client
    PlaylistAssigned(PlaylistAssignedMessage),

    /// Playlist has been updated
    PlaylistUpdated(PlaylistUpdatedMessage),

    /// Command from server (e.g., reload, pause)
    Command(CommandMessage),
}

/// Playlist assignment message
///
/// Sent when server assigns a playlist to this client.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PlaylistAssignedMessage {
    /// Playlist ID
    #[serde(rename = "playlistId")]
    pub playlist_id: u32,

    /// Playlist name
    #[serde(rename = "playlistName")]
    pub playlist_name: String,

    /// Playlist items in order
    pub items: Vec<PlaylistItem>,

    /// Whether to loop the playlist
    #[serde(rename = "loopPlaylist")]
    pub loop_playlist: bool,
}

/// Playlist update message
///
/// Sent when the assigned playlist is modified (items added/removed/reordered).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PlaylistUpdatedMessage {
    /// Playlist ID
    #[serde(rename = "playlistId")]
    pub playlist_id: u32,

    /// Updated playlist items
    pub items: Vec<PlaylistItem>,

    /// Whether to loop the playlist
    #[serde(rename = "loopPlaylist")]
    pub loop_playlist: bool,
}

/// Single item in a playlist
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct PlaylistItem {
    /// Unique item ID
    pub id: u32,

    /// Media file ID
    #[serde(rename = "mediaId")]
    pub media_id: u32,

    /// Filename
    pub filename: String,

    /// Download URL
    #[serde(rename = "downloadUrl")]
    pub download_url: String,

    /// Media type ("video" or "image")
    #[serde(rename = "type")]
    pub media_type: String,

    /// Duration in seconds (for videos) or image duration
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,

    /// SHA-256 checksum for verification
    pub checksum: Option<String>,

    /// Order index in playlist (0-based)
    #[serde(rename = "orderIndex")]
    pub order_index: u32,

    /// Duration override for images (seconds)
    #[serde(rename = "imageDuration")]
    pub image_duration: u32,
}

/// Media file information
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct MediaInfo {
    /// Media file ID
    pub id: u32,

    /// Original filename
    pub filename: String,

    /// File path on server (for download URL construction)
    pub filepath: String,

    /// Media type ("video" or "image")
    #[serde(rename = "type")]
    pub media_type: String,

    /// Duration in seconds (for videos, null for images)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,

    /// Resolution (e.g., "1920x1080")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,

    /// File size in bytes
    #[serde(rename = "fileSize")]
    pub file_size: u64,

    /// SHA-256 checksum for verification
    pub checksum: String,
}

/// Command message from server
///
/// Used for remote control operations.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CommandMessage {
    /// Command name (e.g., "reload_playlist", "pause", "resume", "skip")
    pub command: String,

    /// Optional command arguments
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<HashMap<String, serde_json::Value>>,
}

// ============================================================================
// Helper Functions
// ============================================================================

impl ClientMessage {
    /// Create a registration message
    pub fn register(
        client_id: String,
        version: String,
        capabilities: ClientCapabilities,
    ) -> Self {
        Self::Register(RegisterMessage {
            client_id,
            version,
            capabilities,
        })
    }

    /// Create a status update message
    pub fn status_update(
        client_id: String,
        current_media: Option<CurrentMediaInfo>,
        position: Option<f64>,
        is_playing: bool,
    ) -> Self {
        Self::StatusUpdate(StatusUpdateMessage {
            client_id,
            current_media,
            position,
            is_playing,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        })
    }

    /// Create a heartbeat message
    pub fn heartbeat(client_id: String) -> Self {
        Self::Heartbeat(HeartbeatMessage {
            client_id,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        })
    }

    /// Create an error report message
    pub fn error(client_id: String, error: String, context: Option<String>) -> Self {
        Self::Error(ErrorMessage {
            client_id,
            error,
            context,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs(),
        })
    }

    /// Serialize message to JSON
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(self)
    }
}

impl ServerMessage {
    /// Deserialize message from JSON
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }
}

impl Default for ClientCapabilities {
    fn default() -> Self {
        Self {
            video: true,
            image: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_register_message_serialization() {
        let msg = ClientMessage::register(
            "550e8400-e29b-41d4-a716-446655440000".to_string(),
            "1.0.0".to_string(),
            ClientCapabilities::default(),
        );

        let json = msg.to_json().unwrap();
        assert!(json.contains(r#""type":"register"#));
        assert!(json.contains(r#""clientId":"550e8400-e29b-41d4-a716-446655440000"#));
        assert!(json.contains(r#""version":"1.0.0"#));
    }

    #[test]
    fn test_heartbeat_message_serialization() {
        let msg = ClientMessage::heartbeat("test-id".to_string());
        let json = msg.to_json().unwrap();
        assert!(json.contains(r#""type":"heartbeat"#));
        assert!(json.contains(r#""clientId":"test-id"#));
        assert!(json.contains(r#""timestamp":"#));
    }

    #[test]
    fn test_status_update_message_serialization() {
        let msg = ClientMessage::status_update(
            "test-id".to_string(),
            Some(CurrentMediaInfo {
                id: 42,
                filename: "test.mp4".to_string(),
            }),
            Some(10.5),
            true,
        );

        let json = msg.to_json().unwrap();
        assert!(json.contains(r#""type":"status_update"#));
        assert!(json.contains(r#""currentMedia":"#));
        assert!(json.contains(r#""id":42"#));
        assert!(json.contains(r#""position":10.5"#));
        assert!(json.contains(r#""isPlaying":true"#));
    }

    #[test]
    fn test_error_message_serialization() {
        let msg = ClientMessage::error(
            "test-id".to_string(),
            "Playback failed".to_string(),
            Some("media_id:42".to_string()),
        );

        let json = msg.to_json().unwrap();
        assert!(json.contains(r#""type":"error"#));
        assert!(json.contains(r#""error":"Playback failed"#));
        assert!(json.contains(r#""context":"media_id:42"#));
    }

    #[test]
    fn test_playlist_assigned_deserialization() {
        let json = r#"{
            "type": "playlist_assigned",
            "playlistId": 10,
            "playlistName": "Test Playlist",
            "items": [],
            "loopPlaylist": true
        }"#;

        let msg = ServerMessage::from_json(json).unwrap();
        match msg {
            ServerMessage::PlaylistAssigned(assigned) => {
                assert_eq!(assigned.playlist_id, 10);
                assert_eq!(assigned.playlist_name, "Test Playlist");
                assert_eq!(assigned.loop_playlist, true);
            }
            _ => panic!("Expected PlaylistAssigned message"),
        }
    }

    #[test]
    fn test_command_deserialization() {
        let json = r#"{
            "type": "command",
            "command": "reload_playlist"
        }"#;

        let msg = ServerMessage::from_json(json).unwrap();
        match msg {
            ServerMessage::Command(cmd) => {
                assert_eq!(cmd.command, "reload_playlist");
                assert!(cmd.args.is_none());
            }
            _ => panic!("Expected Command message"),
        }
    }

    #[test]
    fn test_playlist_item_equality() {
        let item1 = PlaylistItem {
            id: 1,
            media_id: 1,
            filename: "test.mp4".to_string(),
            download_url: "http://localhost:3000/api/media/1/download".to_string(),
            media_type: "video".to_string(),
            duration: Some(120.0),
            checksum: Some("abc123".to_string()),
            order_index: 0,
            image_duration: 5,
        };

        let item2 = PlaylistItem {
            id: 1,
            media_id: 1,
            filename: "test.mp4".to_string(),
            download_url: "http://localhost:3000/api/media/1/download".to_string(),
            media_type: "video".to_string(),
            duration: Some(120.0),
            checksum: Some("abc123".to_string()),
            order_index: 0,
            image_duration: 5,
        };

        assert_eq!(item1, item2);
    }

    #[test]
    fn test_default_capabilities() {
        let caps = ClientCapabilities::default();
        assert!(caps.video);
        assert!(caps.image);
    }
}
