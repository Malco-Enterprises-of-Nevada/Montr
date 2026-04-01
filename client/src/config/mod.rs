mod cli;
mod types;

pub use cli::CliArgs;
pub use types::*;

use crate::error::{MontrError, Result};
use directories::ProjectDirs;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// Configuration loader with platform-specific path resolution
pub struct ConfigLoader {
    config_path: Option<PathBuf>,
}

impl ConfigLoader {
    /// Create a new config loader with optional config path
    pub fn new(config_path: Option<PathBuf>) -> Self {
        Self { config_path }
    }

    /// Load configuration from file or defaults
    pub fn load(&self) -> Result<Config> {
        let config_path = self.resolve_config_path()?;

        // Read and parse TOML
        let config_str =
            fs::read_to_string(&config_path).map_err(|e| MontrError::ConfigFileRead {
                path: config_path.clone(),
                source: e,
            })?;

        let mut config: Config = toml::from_str(&config_str)?;

        // Store the config path for later (UUID persistence)
        config.config_path = Some(config_path.clone());

        // Apply platform-specific defaults
        self.apply_platform_defaults(&mut config)?;

        // Generate UUID if needed
        self.ensure_client_id(&mut config)?;

        // Validate
        config.validate()?;

        Ok(config)
    }

    /// Apply CLI argument overrides to config
    pub fn apply_overrides(&self, config: &mut Config, args: &CliArgs) -> Result<()> {
        if let Some(ref server_url) = args.server_url {
            config.server.url = server_url.clone();
        }

        if let Some(ref client_name) = args.client_name {
            config.client.name = client_name.clone();
        }

        if let Some(ref log_level) = args.log_level {
            config.system.log_level = log_level.clone();
        }

        if let Some(fullscreen) = args.get_fullscreen_override() {
            config.display.fullscreen = fullscreen;
        }

        // Re-validate after overrides
        config.validate()?;

        Ok(())
    }

    /// Resolve the config file path
    fn resolve_config_path(&self) -> Result<PathBuf> {
        if let Some(ref path) = self.config_path {
            if path.exists() {
                return Ok(path.clone());
            } else {
                return Err(MontrError::ConfigFileRead {
                    path: path.clone(),
                    source: std::io::Error::new(
                        std::io::ErrorKind::NotFound,
                        "Specified config file not found",
                    ),
                });
            }
        }

        // Try platform-specific locations
        let candidates = self.get_config_search_paths();
        let searched_locations: Vec<String> =
            candidates.iter().map(|p| p.display().to_string()).collect();

        for path in candidates {
            if path.exists() {
                return Ok(path);
            }
        }

        // No config file found
        Err(MontrError::ConfigNotFound {
            locations: searched_locations,
        })
    }

    /// Get platform-specific config search paths
    fn get_config_search_paths(&self) -> Vec<PathBuf> {
        let mut paths = Vec::new();

        // Current directory (highest priority for development)
        paths.push(PathBuf::from("config.toml"));

        // User config directory
        if let Some(proj_dirs) = ProjectDirs::from("com", "Montr", "montr-client") {
            paths.push(proj_dirs.config_dir().join("config.toml"));
        }

        // System config directory (platform-specific)
        #[cfg(unix)]
        paths.push(PathBuf::from("/etc/montr-client/config.toml"));

        #[cfg(windows)]
        paths.push(PathBuf::from("C:\\ProgramData\\Montr\\config.toml"));

        paths
    }

    /// Apply platform-specific path defaults
    fn apply_platform_defaults(&self, config: &mut Config) -> Result<()> {
        let proj_dirs = ProjectDirs::from("com", "Montr", "montr-client");

        // Cache directory - replace relative path with platform-specific absolute path
        let cache_str = config.playback.media_cache_dir.to_string_lossy();
        if cache_str == "./cache" || cache_str == "cache" {
            config.playback.media_cache_dir = if let Some(ref proj) = proj_dirs {
                proj.cache_dir().to_path_buf()
            } else {
                // Fallback if ProjectDirs fails
                #[cfg(unix)]
                {
                    PathBuf::from("/var/lib/montr-client/cache")
                }

                #[cfg(windows)]
                {
                    PathBuf::from("C:\\ProgramData\\Montr\\cache")
                }
            };
        }

        // Log file - replace relative path with platform-specific absolute path
        let log_str = config.system.log_file.to_string_lossy();
        if log_str == "./client.log" || log_str == "client.log" {
            config.system.log_file = if let Some(ref proj) = proj_dirs {
                proj.data_dir().join("logs").join("client.log")
            } else {
                // Fallback if ProjectDirs fails
                #[cfg(unix)]
                {
                    PathBuf::from("/var/log/montr-client/client.log")
                }

                #[cfg(windows)]
                {
                    PathBuf::from("C:\\ProgramData\\Montr\\logs\\client.log")
                }
            };
        }

        // Ensure directories exist
        self.ensure_directory_exists(&config.playback.media_cache_dir)?;

        if let Some(parent) = config.system.log_file.parent() {
            self.ensure_directory_exists(parent)?;
        }

        Ok(())
    }

    /// Ensure client ID is set (generate if needed)
    fn ensure_client_id(&self, config: &mut Config) -> Result<()> {
        if config.client.id.is_empty() {
            // Generate new UUID
            let uuid = Uuid::new_v4();
            config.client.id = uuid.to_string();

            // Save back to config file to persist UUID
            self.save_config(config)?;

            tracing::info!("Generated new client ID: {}", config.client.id);
        } else {
            // Validate existing UUID
            Uuid::parse_str(&config.client.id)
                .map_err(|_| MontrError::InvalidClientId(config.client.id.clone()))?;
        }

        Ok(())
    }

    /// Save config back to file (for UUID persistence)
    fn save_config(&self, config: &Config) -> Result<()> {
        if let Some(ref config_path) = config.config_path {
            let toml_str =
                toml::to_string_pretty(config).map_err(|e| MontrError::Other(e.into()))?;

            fs::write(config_path, toml_str).map_err(|e| MontrError::ConfigSave {
                path: config_path.clone(),
                source: e,
            })?;

            Ok(())
        } else {
            // If no config path (shouldn't happen), just skip saving
            Ok(())
        }
    }

    /// Ensure a directory exists, creating it if necessary
    fn ensure_directory_exists(&self, path: &Path) -> Result<()> {
        if !path.exists() {
            fs::create_dir_all(path).map_err(|e| MontrError::DirectoryCreation {
                path: path.to_path_buf(),
                source: e,
            })?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;
    use tempfile::TempDir;

    fn create_test_config_content() -> String {
        r#"
[server]
url = "http://localhost:3000"
reconnect_interval = 5
heartbeat_interval = 30

[client]
id = ""
name = "Test Client"

[playback]
default_image_duration = 5
loop_playlist = true
media_cache_dir = "./cache"
max_cache_size_mb = 5000
preload_next_items = 2

[system]
auto_start = false
log_level = "info"
log_file = "./client.log"
log_max_size_mb = 100
log_max_files = 5

[display]
fullscreen = true
screen_index = 0
"#
        .to_string()
    }

    fn create_test_config_with_uuid() -> String {
        r#"
[server]
url = "http://localhost:3000"

[client]
id = "550e8400-e29b-41d4-a716-446655440000"
name = "Test Client"

[playback]
media_cache_dir = "./cache"

[system]
log_file = "./client.log"

[display]
"#
        .to_string()
    }

    #[test]
    fn test_load_config_with_uuid_generation() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("config.toml");

        // Create config with empty UUID
        fs::write(&config_path, create_test_config_content()).unwrap();

        let loader = ConfigLoader::new(Some(config_path.clone()));
        let config = loader.load().unwrap();

        // UUID should be generated
        assert!(!config.client.id.is_empty());
        assert!(Uuid::parse_str(&config.client.id).is_ok());

        // Should be persisted to file
        let file_content = fs::read_to_string(&config_path).unwrap();
        assert!(file_content.contains(&config.client.id));

        // Loading again should preserve the same UUID
        let loader2 = ConfigLoader::new(Some(config_path.clone()));
        let config2 = loader2.load().unwrap();
        assert_eq!(config.client.id, config2.client.id);
    }

    #[test]
    fn test_load_config_with_existing_uuid() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("config.toml");

        // Create config with existing UUID
        fs::write(&config_path, create_test_config_with_uuid()).unwrap();

        let loader = ConfigLoader::new(Some(config_path));
        let config = loader.load().unwrap();

        // Should preserve existing UUID
        assert_eq!(config.client.id, "550e8400-e29b-41d4-a716-446655440000");
    }

    #[test]
    fn test_load_config_missing_file() {
        let loader = ConfigLoader::new(Some(PathBuf::from("/nonexistent/config.toml")));
        let result = loader.load();

        assert!(result.is_err());
        match result {
            Err(MontrError::ConfigFileRead { .. }) => (),
            _ => panic!("Expected ConfigFileRead error"),
        }
    }

    #[test]
    fn test_apply_cli_overrides() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("config.toml");

        fs::write(&config_path, create_test_config_with_uuid()).unwrap();

        let loader = ConfigLoader::new(Some(config_path));
        let mut config = loader.load().unwrap();

        // Create CLI args with overrides
        let cli_args = CliArgs::parse_from(&[
            "montr-client",
            "--server-url",
            "http://192.168.1.200:4000",
            "--client-name",
            "Overridden Name",
            "--log-level",
            "debug",
            "--fullscreen",
        ]);

        loader.apply_overrides(&mut config, &cli_args).unwrap();

        // Check overrides were applied
        assert_eq!(config.server.url, "http://192.168.1.200:4000");
        assert_eq!(config.client.name, "Overridden Name");
        assert_eq!(config.system.log_level, "debug");
        assert_eq!(config.display.fullscreen, true);
    }

    #[test]
    fn test_cli_overrides_validation_failure() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("config.toml");

        fs::write(&config_path, create_test_config_with_uuid()).unwrap();

        let loader = ConfigLoader::new(Some(config_path));
        let mut config = loader.load().unwrap();

        // Create CLI args with invalid override
        let cli_args = CliArgs::parse_from(&[
            "montr-client",
            "--server-url",
            "ftp://invalid", // Invalid protocol
        ]);

        let result = loader.apply_overrides(&mut config, &cli_args);

        // Should fail validation
        assert!(result.is_err());
    }

    #[test]
    fn test_get_config_search_paths() {
        let loader = ConfigLoader::new(None);
        let paths = loader.get_config_search_paths();

        // Should include current directory
        assert!(paths.iter().any(|p| p.ends_with("config.toml")));

        // Should have multiple paths
        assert!(paths.len() >= 2);
    }

    #[test]
    fn test_platform_defaults_cache_dir() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("config.toml");

        fs::write(&config_path, create_test_config_content()).unwrap();

        let loader = ConfigLoader::new(Some(config_path));
        let config = loader.load().unwrap();

        // Cache dir should be replaced with platform-specific path
        let cache_str = config.playback.media_cache_dir.to_string_lossy();
        assert!(!cache_str.contains("./cache"));

        // Should be an absolute path
        assert!(config.playback.media_cache_dir.is_absolute());
    }

    #[test]
    fn test_platform_defaults_log_file() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("config.toml");

        fs::write(&config_path, create_test_config_content()).unwrap();

        let loader = ConfigLoader::new(Some(config_path));
        let config = loader.load().unwrap();

        // Log file should be replaced with platform-specific path
        let log_str = config.system.log_file.to_string_lossy();
        assert!(!log_str.contains("./client.log"));

        // Should be an absolute path
        assert!(config.system.log_file.is_absolute());
    }

    #[test]
    fn test_invalid_uuid_format() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("config.toml");

        let invalid_config = r#"
[server]
url = "http://localhost:3000"

[client]
id = "not-a-valid-uuid"
name = "Test"

[playback]
media_cache_dir = "./cache"

[system]
log_file = "./client.log"

[display]
"#;

        fs::write(&config_path, invalid_config).unwrap();

        let loader = ConfigLoader::new(Some(config_path));
        let result = loader.load();

        assert!(result.is_err());
        match result {
            Err(MontrError::InvalidClientId(_)) => (),
            _ => panic!("Expected InvalidClientId error"),
        }
    }
}
