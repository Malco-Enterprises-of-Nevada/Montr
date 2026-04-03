use crate::error::{MontrError, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Complete client configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub server: ServerConfig,
    pub client: ClientConfig,
    pub playback: PlaybackConfig,
    pub system: SystemConfig,
    pub display: DisplayConfig,

    /// Path to the config file (not serialized)
    #[serde(skip)]
    pub config_path: Option<PathBuf>,
}

/// Server connection configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    /// Server URL (e.g., "http://192.168.1.100:3000")
    pub url: String,

    /// Optional API key for authentication
    #[serde(default)]
    pub api_key: Option<String>,

    /// Reconnection interval in seconds
    #[serde(default = "default_reconnect_interval")]
    pub reconnect_interval: u64,

    /// Heartbeat interval in seconds
    #[serde(default = "default_heartbeat_interval")]
    pub heartbeat_interval: u64,
}

/// Client identification configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientConfig {
    /// Client UUID (auto-generated if empty)
    #[serde(default)]
    pub id: String,

    /// Human-readable client name (defaults to hostname if empty)
    #[serde(default)]
    pub name: String,
}

/// Media playback configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybackConfig {
    /// Default duration for images in seconds
    #[serde(default = "default_image_duration")]
    pub default_image_duration: u64,

    /// Whether to loop the playlist
    #[serde(default = "default_loop_playlist")]
    pub loop_playlist: bool,

    /// Media cache directory
    pub media_cache_dir: PathBuf,

    /// Maximum cache size in MB
    #[serde(default = "default_max_cache_size")]
    pub max_cache_size_mb: u64,

    /// Number of upcoming items to pre-fetch
    #[serde(default = "default_preload_next_items")]
    pub preload_next_items: usize,
}

/// System-level configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemConfig {
    /// Enable auto-start on system boot
    #[serde(default)]
    pub auto_start: bool,

    /// Enable automatic updates from GitHub releases
    #[serde(default = "default_auto_update")]
    pub auto_update: bool,

    /// Log level (error, warn, info, debug, trace)
    #[serde(default = "default_log_level")]
    pub log_level: String,

    /// Log file path
    pub log_file: PathBuf,

    /// Maximum log file size in MB
    #[serde(default = "default_log_max_size")]
    pub log_max_size_mb: u64,

    /// Maximum number of log files to keep
    #[serde(default = "default_log_max_files")]
    pub log_max_files: u32,
}

/// Display configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayConfig {
    /// Run in fullscreen mode
    #[serde(default = "default_fullscreen")]
    pub fullscreen: bool,

    /// Screen index for multi-monitor setups (0-indexed)
    #[serde(default)]
    pub screen_index: u32,

    /// Window width (if not fullscreen)
    #[serde(default)]
    pub window_width: Option<u32>,

    /// Window height (if not fullscreen)
    #[serde(default)]
    pub window_height: Option<u32>,
}

// Default value functions
fn default_reconnect_interval() -> u64 {
    5
}

fn default_heartbeat_interval() -> u64 {
    30
}

fn default_image_duration() -> u64 {
    5
}

fn default_loop_playlist() -> bool {
    true
}

fn default_max_cache_size() -> u64 {
    5000
}

fn default_preload_next_items() -> usize {
    2
}

fn default_auto_update() -> bool {
    true
}

fn default_log_level() -> String {
    "info".to_string()
}

fn default_log_max_size() -> u64 {
    100
}

fn default_log_max_files() -> u32 {
    5
}

fn default_fullscreen() -> bool {
    true
}

impl Config {
    /// Validate the configuration
    pub fn validate(&self) -> Result<()> {
        // Validate server URL
        if self.server.url.is_empty() {
            return Err(MontrError::ConfigMissing("server.url".to_string()));
        }

        if !self.server.url.starts_with("http://") && !self.server.url.starts_with("https://") {
            return Err(MontrError::ConfigValidation {
                field: "server.url".to_string(),
                reason: "Must start with http:// or https://".to_string(),
            });
        }

        // Validate client name
        if self.client.name.is_empty() {
            return Err(MontrError::ConfigMissing("client.name".to_string()));
        }

        // Validate intervals
        if self.server.reconnect_interval == 0 {
            return Err(MontrError::ConfigValidation {
                field: "server.reconnect_interval".to_string(),
                reason: "Must be greater than 0".to_string(),
            });
        }

        if self.server.heartbeat_interval == 0 {
            return Err(MontrError::ConfigValidation {
                field: "server.heartbeat_interval".to_string(),
                reason: "Must be greater than 0".to_string(),
            });
        }

        // Validate log level
        let valid_levels = ["error", "warn", "info", "debug", "trace"];
        if !valid_levels.contains(&self.system.log_level.as_str()) {
            return Err(MontrError::ConfigValidation {
                field: "system.log_level".to_string(),
                reason: format!("Must be one of: {}", valid_levels.join(", ")),
            });
        }

        // Validate cache size
        if self.playback.max_cache_size_mb < 100 {
            return Err(MontrError::ConfigValidation {
                field: "playback.max_cache_size_mb".to_string(),
                reason: "Must be at least 100 MB".to_string(),
            });
        }

        // Validate image duration
        if self.playback.default_image_duration == 0 {
            return Err(MontrError::ConfigValidation {
                field: "playback.default_image_duration".to_string(),
                reason: "Must be greater than 0".to_string(),
            });
        }

        // Validate log file size
        if self.system.log_max_size_mb == 0 {
            return Err(MontrError::ConfigValidation {
                field: "system.log_max_size_mb".to_string(),
                reason: "Must be greater than 0".to_string(),
            });
        }

        // Validate log file count
        if self.system.log_max_files == 0 {
            return Err(MontrError::ConfigValidation {
                field: "system.log_max_files".to_string(),
                reason: "Must be greater than 0".to_string(),
            });
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_valid_config() -> Config {
        Config {
            server: ServerConfig {
                url: "http://localhost:3000".to_string(),
                api_key: None,
                reconnect_interval: 5,
                heartbeat_interval: 30,
            },
            client: ClientConfig {
                id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
                name: "Test Client".to_string(),
            },
            playback: PlaybackConfig {
                default_image_duration: 5,
                loop_playlist: true,
                media_cache_dir: PathBuf::from("./cache"),
                max_cache_size_mb: 5000,
                preload_next_items: 2,
            },
            system: SystemConfig {
                auto_start: false,
                auto_update: true,
                log_level: "info".to_string(),
                log_file: PathBuf::from("./client.log"),
                log_max_size_mb: 100,
                log_max_files: 5,
            },
            display: DisplayConfig {
                fullscreen: true,
                screen_index: 0,
                window_width: None,
                window_height: None,
            },
            config_path: None,
        }
    }

    #[test]
    fn test_config_validation_valid() {
        let config = create_valid_config();
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_config_validation_missing_url() {
        let mut config = create_valid_config();
        config.server.url = String::new();

        let result = config.validate();
        assert!(result.is_err());

        if let Err(MontrError::ConfigMissing(field)) = result {
            assert_eq!(field, "server.url");
        } else {
            panic!("Expected ConfigMissing error");
        }
    }

    #[test]
    fn test_config_validation_invalid_url_scheme() {
        let mut config = create_valid_config();
        config.server.url = "ftp://localhost:3000".to_string();

        let result = config.validate();
        assert!(result.is_err());

        if let Err(MontrError::ConfigValidation { field, reason }) = result {
            assert_eq!(field, "server.url");
            assert!(reason.contains("http://"));
        } else {
            panic!("Expected ConfigValidation error");
        }
    }

    #[test]
    fn test_config_validation_missing_client_name() {
        let mut config = create_valid_config();
        config.client.name = String::new();

        let result = config.validate();
        assert!(result.is_err());

        if let Err(MontrError::ConfigMissing(field)) = result {
            assert_eq!(field, "client.name");
        } else {
            panic!("Expected ConfigMissing error");
        }
    }

    #[test]
    fn test_config_validation_invalid_reconnect_interval() {
        let mut config = create_valid_config();
        config.server.reconnect_interval = 0;

        let result = config.validate();
        assert!(result.is_err());

        if let Err(MontrError::ConfigValidation { field, .. }) = result {
            assert_eq!(field, "server.reconnect_interval");
        } else {
            panic!("Expected ConfigValidation error");
        }
    }

    #[test]
    fn test_config_validation_invalid_log_level() {
        let mut config = create_valid_config();
        config.system.log_level = "invalid".to_string();

        let result = config.validate();
        assert!(result.is_err());

        if let Err(MontrError::ConfigValidation { field, reason }) = result {
            assert_eq!(field, "system.log_level");
            assert!(reason.contains("error, warn, info, debug, trace"));
        } else {
            panic!("Expected ConfigValidation error");
        }
    }

    #[test]
    fn test_config_validation_cache_size_too_small() {
        let mut config = create_valid_config();
        config.playback.max_cache_size_mb = 50;

        let result = config.validate();
        assert!(result.is_err());

        if let Err(MontrError::ConfigValidation { field, .. }) = result {
            assert_eq!(field, "playback.max_cache_size_mb");
        } else {
            panic!("Expected ConfigValidation error");
        }
    }

    #[test]
    fn test_default_values() {
        assert_eq!(default_reconnect_interval(), 5);
        assert_eq!(default_heartbeat_interval(), 30);
        assert_eq!(default_image_duration(), 5);
        assert_eq!(default_loop_playlist(), true);
        assert_eq!(default_max_cache_size(), 5000);
        assert_eq!(default_preload_next_items(), 2);
        assert_eq!(default_log_level(), "info");
        assert_eq!(default_log_max_size(), 100);
        assert_eq!(default_log_max_files(), 5);
        assert_eq!(default_fullscreen(), true);
    }
}
