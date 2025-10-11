use std::io;
use std::path::PathBuf;
use thiserror::Error;

/// Main error type for the Montr client
#[derive(Error, Debug)]
pub enum MontrError {
    // Configuration errors
    /// Failed to read config file
    #[error("Failed to read config file at {path}: {source}")]
    ConfigFileRead {
        path: PathBuf,
        source: io::Error,
    },

    /// Failed to parse TOML config file
    #[error("Failed to parse config file: {0}")]
    ConfigParse(#[from] toml::de::Error),

    /// Configuration validation failed
    #[error("Invalid configuration: {field} - {reason}")]
    ConfigValidation { field: String, reason: String },

    /// Missing required configuration field
    #[error("Missing required configuration field: {0}")]
    ConfigMissing(String),

    /// No config file found in any search location
    #[error("No config file found. Searched locations:\n{}\n\nSuggestion: Create config file using 'cp config.example.toml config.toml'", locations.join("\n"))]
    ConfigNotFound { locations: Vec<String> },

    // UUID errors
    /// Invalid client ID format
    #[error("Invalid client ID format: {0}")]
    InvalidClientId(String),

    /// Failed to generate UUID
    #[error("Failed to generate UUID: {0}")]
    UuidGeneration(String),

    // File system errors
    /// Failed to create directory
    #[error("Failed to create directory {path}: {source}")]
    DirectoryCreation {
        path: PathBuf,
        source: io::Error,
    },

    /// Failed to access file or directory
    #[error("Failed to access path {path}: {source}")]
    FileAccess {
        path: PathBuf,
        source: io::Error,
    },

    /// Failed to save config file
    #[error("Failed to save config file to {path}: {source}")]
    ConfigSave {
        path: PathBuf,
        source: io::Error,
    },

    // Logging errors
    /// Failed to initialize logging system
    #[error("Failed to initialize logging: {0}")]
    LoggingInit(String),

    /// Failed to set up log file
    #[error("Failed to set up log file at {path}: {source}")]
    LogFileSetup {
        path: PathBuf,
        source: io::Error,
    },

    // Network errors
    /// WebSocket connection failed
    #[error("WebSocket connection failed: {0}")]
    WebSocketConnection(String),

    /// WebSocket send error
    #[error("Failed to send WebSocket message: {0}")]
    WebSocketSend(String),

    /// WebSocket receive error
    #[error("Failed to receive WebSocket message: {0}")]
    WebSocketReceive(String),

    /// HTTP request failed
    #[error("HTTP request failed: {0}")]
    HttpRequest(String),

    /// HTTP request from reqwest
    #[error("HTTP request error: {0}")]
    Reqwest(#[from] reqwest::Error),

    /// Network timeout
    #[error("Network operation timed out: {0}")]
    NetworkTimeout(String),

    /// Message serialization error
    #[error("Failed to serialize message: {0}")]
    MessageSerialization(#[from] serde_json::Error),

    /// Message deserialization error
    #[error("Failed to deserialize message: {0}")]
    MessageDeserialization(String),

    /// Registration with server failed
    #[error("Client registration failed: {0}")]
    RegistrationFailed(String),

    /// Protocol error - unexpected message type
    #[error("Protocol error: {0}")]
    ProtocolError(String),

    /// Connection closed unexpectedly
    #[error("Connection closed: {0}")]
    ConnectionClosed(String),

    // Playback errors
    /// Media playback error
    #[error("Media playback error: {0}")]
    Playback(String),

    /// MPV initialization failed
    #[error("MPV initialization failed: {0}")]
    MpvInit(String),

    /// MPV command error
    #[error("MPV command failed: {0}")]
    MpvCommand(String),

    /// MPV property error
    #[error("MPV property error: {0}")]
    MpvProperty(String),

    /// MPV event error
    #[error("MPV event error: {0}")]
    MpvEvent(String),

    /// Media file not found
    #[error("Media file not found: {0}")]
    MediaNotFound(PathBuf),

    /// Unsupported media format
    #[error("Unsupported media format: {0}")]
    UnsupportedFormat(String),

    /// Playlist error
    #[error("Playlist error: {0}")]
    PlaylistError(String),

    /// Playlist is empty
    #[error("Playlist is empty")]
    PlaylistEmpty,

    /// Invalid playlist item
    #[error("Invalid playlist item: {0}")]
    InvalidPlaylistItem(String),

    // Cache and download errors
    /// Download failed
    #[error("Failed to download media from {url}: {reason}")]
    DownloadFailed { url: String, reason: String },

    /// Checksum verification failed
    #[error("Checksum verification failed for {path}: expected {expected}, got {actual}")]
    ChecksumMismatch {
        path: PathBuf,
        expected: String,
        actual: String,
    },

    /// Cache is full
    #[error("Media cache is full (max size: {max_size_mb} MB)")]
    CacheFull { max_size_mb: u64 },

    /// Failed to write to cache
    #[error("Failed to write to cache at {path}: {source}")]
    CacheWrite {
        path: PathBuf,
        source: io::Error,
    },

    /// Failed to read from cache
    #[error("Failed to read from cache at {path}: {source}")]
    CacheRead {
        path: PathBuf,
        source: io::Error,
    },

    /// File corruption detected
    #[error("File corruption detected at {0}")]
    FileCorruption(PathBuf),

    /// Insufficient disk space
    #[error("Insufficient disk space: required {required_mb} MB, available {available_mb} MB")]
    InsufficientDiskSpace {
        required_mb: u64,
        available_mb: u64,
    },

    // Generic errors
    /// Generic IO error wrapper
    #[error("IO error: {0}")]
    Io(#[from] io::Error),

    /// Catch-all for unexpected errors with context
    #[error("Unexpected error: {0}")]
    Other(#[from] anyhow::Error),
}

/// Result type alias for convenience throughout the application
pub type Result<T> = std::result::Result<T, MontrError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display_config_file_read() {
        let error = MontrError::ConfigFileRead {
            path: PathBuf::from("/etc/montr/config.toml"),
            source: io::Error::new(io::ErrorKind::NotFound, "file not found"),
        };
        let message = error.to_string();
        assert!(message.contains("Failed to read config file"));
        assert!(message.contains("/etc/montr/config.toml"));
    }

    #[test]
    fn test_error_display_config_validation() {
        let error = MontrError::ConfigValidation {
            field: "server.url".to_string(),
            reason: "Must start with http:// or https://".to_string(),
        };
        let message = error.to_string();
        assert!(message.contains("Invalid configuration"));
        assert!(message.contains("server.url"));
        assert!(message.contains("Must start with http://"));
    }

    #[test]
    fn test_error_display_config_not_found() {
        let error = MontrError::ConfigNotFound {
            locations: vec![
                "/etc/montr-client/config.toml".to_string(),
                "~/.config/montr-client/config.toml".to_string(),
                "./config.toml".to_string(),
            ],
        };
        let message = error.to_string();
        assert!(message.contains("No config file found"));
        assert!(message.contains("config.example.toml"));
    }

    #[test]
    fn test_error_conversion_io() {
        let io_error = io::Error::new(io::ErrorKind::PermissionDenied, "access denied");
        let montr_error: MontrError = io_error.into();
        match montr_error {
            MontrError::Io(_) => (),
            _ => panic!("Expected MontrError::Io variant"),
        }
    }

    #[test]
    fn test_result_type_alias() {
        fn returns_result() -> Result<String> {
            Ok("success".to_string())
        }

        assert!(returns_result().is_ok());
    }
}
