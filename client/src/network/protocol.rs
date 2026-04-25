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
    /// Periodic system telemetry (60s cadence)
    Telemetry(TelemetryMessage),
    /// Auto-pushed log event (warn/error only)
    LogEvent(LogEventMessage),
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

    /// Optional human-readable client name from config
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
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

    /// Timestamp (Unix epoch milliseconds)
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

    /// Timestamp (Unix epoch milliseconds)
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
    pub context: Option<HashMap<String, serde_json::Value>>,

    /// Subsystem that originated the error (e.g., "playback", "cache", "network").
    /// Server uses this to route admin alerts and group repeated faults.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,

    /// Severity tier — controls server-side handling: `warn` is logged and
    /// broadcast only, `error` also persists to client status, `fatal` fires a
    /// notification rule. Defaults to `error` if absent (legacy behavior).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<ErrorSeverity>,

    /// Timestamp (Unix epoch milliseconds)
    pub timestamp: u64,
}

/// Severity classification for client-reported errors.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ErrorSeverity {
    /// Transient or informational — playback continues, no status flap.
    Warn,
    /// Recoverable error — the client may have retried, but operator should see it.
    Error,
    /// Unrecoverable — the client is in a degraded state; fire notifications.
    Fatal,
}

/// Per-disk sample within a TelemetryMessage
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TelemetryDiskSample {
    pub mount: String,
    pub used_bytes: u64,
    pub total_bytes: u64,
}

/// Per-temperature-sensor sample within a TelemetryMessage
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TelemetryTempSample {
    pub label: String,
    pub celsius: f32,
}

/// Network sub-sample within a TelemetryMessage
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TelemetryNetSample {
    pub ws_reconnects: u32,
    pub last_rtt_ms: Option<u32>,
    pub bytes_dl_total: u64,
}

/// mpv health sub-sample within a TelemetryMessage
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TelemetryMpvSample {
    pub alive: bool,
    pub dropped_frames: u64,
    pub last_decoder_error: Option<String>,
}

/// Process-level sub-sample within a TelemetryMessage
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TelemetryProcessSample {
    pub client_uptime_s: u64,
    pub mpv_uptime_s: u64,
    pub restart_count: u32,
}

/// Periodic system telemetry message
///
/// Sent every 60 seconds with sysinfo + mpv health snapshots. Field names use
/// snake_case so they line up with the server-side ClientTelemetryRow shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryMessage {
    #[serde(rename = "clientId")]
    pub client_id: String,
    pub cpu_pct: f32,
    pub mem_used_mb: u64,
    pub mem_total_mb: u64,
    pub disks: Vec<TelemetryDiskSample>,
    pub temps: Vec<TelemetryTempSample>,
    pub net: TelemetryNetSample,
    pub mpv: TelemetryMpvSample,
    pub process: TelemetryProcessSample,
    pub timestamp: u64,
}

/// Auto-pushed log event message (WARN or ERROR only)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEventMessage {
    #[serde(rename = "clientId")]
    pub client_id: String,
    pub level: String,
    pub target: String,
    pub message: String,
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

    /// Playlist interrupt — high-priority playlist overrides current
    PlaylistInterrupt(PlaylistInterruptMessage),

    /// Playlist resume — revert to previous playlist after interruption
    PlaylistResume(PlaylistResumeMessage),

    /// Success acknowledgement (e.g., registration confirmed)
    Success(SuccessMessage),

    /// Error response from server
    ErrorResponse(ErrorResponseMessage),

    /// Schedules that apply to this client. Sent on register and after
    /// CRUD/group changes. Persisted by the client and used for offline
    /// re-evaluation when the WebSocket is disconnected.
    ScheduleDefinitions(ScheduleDefinitionsMessage),
}

/// One schedule pushed by the server. Fields mirror server `ScheduleDef` —
/// `serde(default)` on optional ones so old servers (which don't emit this
/// message at all) and forward-compatible new fields don't break parsing.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Schedule {
    pub id: u32,
    pub name: String,
    #[serde(rename = "playlistId")]
    pub playlist_id: u32,
    /// Single-client target UUID, or None for group/global scope.
    #[serde(default, rename = "clientId")]
    pub client_id: Option<String>,
    /// Group target id, or None for client/global scope.
    #[serde(default, rename = "groupId")]
    pub group_id: Option<u32>,
    /// "HH:MM" or None when cron-only.
    #[serde(default, rename = "startTime")]
    pub start_time: Option<String>,
    /// "HH:MM" or None.
    #[serde(default, rename = "endTime")]
    pub end_time: Option<String>,
    /// Comma-separated day numbers, e.g. "0,1,2,3,4,5,6". Sunday = 0.
    #[serde(default = "default_days_of_week", rename = "daysOfWeek")]
    pub days_of_week: String,
    #[serde(default)]
    pub priority: i32,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 5-field cron expression, or None.
    #[serde(default, rename = "cronExpression")]
    pub cron_expression: Option<String>,
    /// IANA timezone (e.g. "America/Los_Angeles"); None = client local.
    #[serde(default)]
    pub timezone: Option<String>,
    /// Pass-through for `holidays`/`special_dates`/`event_trigger`. Treated
    /// as opaque by the offline evaluator (the server is authoritative for
    /// holiday + event evaluation; client sticks to cron + window only).
    #[serde(default)]
    pub conditions: Option<serde_json::Value>,
    #[serde(default = "default_interrupt_mode", rename = "interruptMode")]
    pub interrupt_mode: String,
    #[serde(default, rename = "durationSeconds")]
    pub duration_seconds: Option<u32>,
}

fn default_days_of_week() -> String {
    "0,1,2,3,4,5,6".to_string()
}

fn default_true() -> bool {
    true
}

fn default_interrupt_mode() -> String {
    "assign".to_string()
}

/// Server→client message carrying the full set of schedules that apply to
/// this client. Replaces (does not merge with) any previously-known set.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ScheduleDefinitionsMessage {
    #[serde(default)]
    pub schedules: Vec<Schedule>,
}

/// Success acknowledgement from server
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SuccessMessage {
    pub message: String,
}

/// Error response from server
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ErrorResponseMessage {
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
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

/// Playlist interrupt message — overrides current playlist temporarily
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PlaylistInterruptMessage {
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

    /// Previous playlist ID (to resume after interrupt)
    #[serde(rename = "previousPlaylistId")]
    pub previous_playlist_id: Option<u32>,
}

/// Playlist resume message — revert to previous playlist
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PlaylistResumeMessage {
    /// Playlist ID to resume (null = stop playback)
    #[serde(rename = "playlistId")]
    pub playlist_id: Option<u32>,

    /// Playlist name
    #[serde(rename = "playlistName")]
    pub playlist_name: Option<String>,

    /// Playlist items
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

    /// Subtitle tracks attached to this item. Always an array; empty when
    /// none are attached. `serde(default)` keeps us compatible with servers
    /// on protocol 1.0.0 that don't emit this field.
    #[serde(default)]
    pub subtitles: Vec<SubtitleTrack>,

    /// File size in bytes from the server's `media_files.file_size`. Added in
    /// protocol 1.2.0 so clients can budget preload bandwidth/disk by total
    /// bytes rather than just item count. `None` means the server didn't
    /// emit it (older protocol or row mid-upload) — preload still runs but
    /// can't enforce a byte budget for that item.
    #[serde(default, rename = "fileSize", skip_serializing_if = "Option::is_none")]
    pub file_size: Option<u64>,
}

/// Source of a subtitle track — either a sidecar file we fetch over HTTP,
/// or a stream already embedded inside the parent video container.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SubtitleKind {
    External,
    Embedded,
}

/// One subtitle track as advertised by the server on a playlist item.
/// Added in protocol 1.1.0.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct SubtitleTrack {
    /// Subtitle row ID (unique across all videos)
    pub id: u32,

    /// External sidecar file vs embedded stream
    pub kind: SubtitleKind,

    /// ISO 639-2 language code ("eng", "spa", …) when known
    pub language: Option<String>,

    /// Display name shown in UI ("English SDH")
    pub label: Option<String>,

    /// Server-marked default track for this media
    #[serde(rename = "isDefault")]
    pub is_default: bool,

    /// Forced-display track (plays without user toggle)
    #[serde(rename = "isForced")]
    pub is_forced: bool,

    // ── External-only fields ────────────────────────────────────────────
    /// HTTP path to download the sidecar file
    #[serde(rename = "downloadUrl", skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,

    /// Suggested cache-local filename hint
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filename: Option<String>,

    /// Sidecar format (srt/vtt)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,

    /// SHA-256 checksum of the sidecar file
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checksum: Option<String>,

    // ── Embedded-only fields ────────────────────────────────────────────
    /// ffprobe global stream index inside the container
    #[serde(rename = "streamIndex", skip_serializing_if = "Option::is_none")]
    pub stream_index: Option<u32>,

    /// Codec name (e.g. "subrip", "mov_text")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codec: Option<String>,
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
        name: Option<String>,
    ) -> Self {
        Self::Register(RegisterMessage {
            client_id,
            version,
            capabilities,
            name,
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
                .unwrap_or_default()
                .as_millis() as u64,
        })
    }

    /// Create a heartbeat message
    pub fn heartbeat(client_id: String) -> Self {
        Self::Heartbeat(HeartbeatMessage {
            client_id,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        })
    }

    /// Create an error report message (legacy — defaults severity to `error`).
    pub fn error(
        client_id: String,
        error: String,
        context: Option<HashMap<String, serde_json::Value>>,
    ) -> Self {
        Self::error_detailed(client_id, None, None, error, context)
    }

    /// Create an error report message with explicit source and severity.
    pub fn error_detailed(
        client_id: String,
        source: Option<String>,
        severity: Option<ErrorSeverity>,
        error: String,
        context: Option<HashMap<String, serde_json::Value>>,
    ) -> Self {
        Self::Error(ErrorMessage {
            client_id,
            error,
            context,
            source,
            severity,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        })
    }

    /// Create a telemetry message
    #[allow(clippy::too_many_arguments)]
    pub fn telemetry(
        client_id: String,
        cpu_pct: f32,
        mem_used_mb: u64,
        mem_total_mb: u64,
        disks: Vec<TelemetryDiskSample>,
        temps: Vec<TelemetryTempSample>,
        net: TelemetryNetSample,
        mpv: TelemetryMpvSample,
        process: TelemetryProcessSample,
    ) -> Self {
        Self::Telemetry(TelemetryMessage {
            client_id,
            cpu_pct,
            mem_used_mb,
            mem_total_mb,
            disks,
            temps,
            net,
            mpv,
            process,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        })
    }

    /// Create a log event message
    pub fn log_event(client_id: String, level: String, target: String, message: String) -> Self {
        Self::LogEvent(LogEventMessage {
            client_id,
            level,
            target,
            message,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
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
            Some("Mac-Display-1".to_string()),
        );

        let json = msg.to_json().unwrap();
        assert!(json.contains(r#""type":"register"#));
        assert!(json.contains(r#""clientId":"550e8400-e29b-41d4-a716-446655440000"#));
        assert!(json.contains(r#""version":"1.0.0"#));
        assert!(json.contains(r#""name":"Mac-Display-1"#));
    }

    #[test]
    fn test_register_message_without_name() {
        let msg = ClientMessage::register(
            "550e8400-e29b-41d4-a716-446655440000".to_string(),
            "1.0.0".to_string(),
            ClientCapabilities::default(),
            None,
        );

        let json = msg.to_json().unwrap();
        assert!(json.contains(r#""type":"register"#));
        assert!(!json.contains(r#""name""#));
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
        let mut ctx = HashMap::new();
        ctx.insert("media_id".to_string(), serde_json::json!(42));
        let msg = ClientMessage::error(
            "test-id".to_string(),
            "Playback failed".to_string(),
            Some(ctx),
        );

        let json = msg.to_json().unwrap();
        assert!(json.contains(r#""type":"error"#));
        assert!(json.contains(r#""error":"Playback failed"#));
        assert!(json.contains(r#""context":{"#));
    }

    #[test]
    fn test_telemetry_message_round_trip() {
        let msg = ClientMessage::telemetry(
            "test-id".to_string(),
            42.5,
            512,
            8192,
            vec![TelemetryDiskSample {
                mount: "/".to_string(),
                used_bytes: 1_000_000,
                total_bytes: 5_000_000,
            }],
            vec![TelemetryTempSample {
                label: "cpu".to_string(),
                celsius: 65.3,
            }],
            TelemetryNetSample {
                ws_reconnects: 3,
                last_rtt_ms: Some(42),
                bytes_dl_total: 100_000,
            },
            TelemetryMpvSample {
                alive: true,
                dropped_frames: 7,
                last_decoder_error: None,
            },
            TelemetryProcessSample {
                client_uptime_s: 1234,
                mpv_uptime_s: 1100,
                restart_count: 2,
            },
        );

        let json = msg.to_json().unwrap();
        assert!(json.contains(r#""type":"telemetry"#));
        assert!(json.contains(r#""cpu_pct":42.5"#));

        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ClientMessage::Telemetry(t) => {
                assert_eq!(t.client_id, "test-id");
                assert_eq!(t.disks.len(), 1);
                assert_eq!(t.disks[0].mount, "/");
                assert_eq!(t.temps[0].celsius, 65.3);
                assert_eq!(t.net.ws_reconnects, 3);
                assert_eq!(t.mpv.dropped_frames, 7);
                assert_eq!(t.process.restart_count, 2);
            }
            _ => panic!("Expected Telemetry variant"),
        }
    }

    #[test]
    fn test_log_event_message_round_trip() {
        let msg = ClientMessage::log_event(
            "test-id".to_string(),
            "error".to_string(),
            "montr_client::cache".to_string(),
            "checksum mismatch".to_string(),
        );
        let json = msg.to_json().unwrap();
        assert!(json.contains(r#""type":"log_event"#));
        assert!(json.contains(r#""level":"error"#));

        let parsed: ClientMessage = serde_json::from_str(&json).unwrap();
        match parsed {
            ClientMessage::LogEvent(ev) => {
                assert_eq!(ev.target, "montr_client::cache");
                assert_eq!(ev.message, "checksum mismatch");
            }
            _ => panic!("Expected LogEvent variant"),
        }
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
            subtitles: Vec::new(),
            file_size: None,
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
            subtitles: Vec::new(),
            file_size: None,
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
