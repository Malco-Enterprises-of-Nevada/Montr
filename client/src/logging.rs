use crate::config::Config;
use crate::error::{MontrError, Result};
use std::fs;
use std::path::Path;
use std::sync::OnceLock;
use tokio::sync::mpsc;
use tracing::field::{Field, Visit};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Layer};

/// One-time channel created during logging init. The sender is held by
/// `LogCapturingLayer`; the receiver is taken once by main.rs at startup so
/// it can spawn the forwarder task that pushes events into the WS sender.
static LOG_EVENT_RX: OnceLock<std::sync::Mutex<Option<mpsc::UnboundedReceiver<CapturedLogEvent>>>> =
    OnceLock::new();

/// A captured WARN/ERROR log line. Plain data so it can cross the channel
/// without holding any tracing references.
#[derive(Debug, Clone)]
pub struct CapturedLogEvent {
    pub level: &'static str,
    pub target: String,
    pub message: String,
}

/// Take ownership of the receiver side of the captured-log channel.
///
/// Returns `None` if the channel was never installed (e.g. logging didn't
/// initialise the capturing layer) or if a previous caller already took it.
pub fn take_log_event_receiver() -> Option<mpsc::UnboundedReceiver<CapturedLogEvent>> {
    LOG_EVENT_RX
        .get()
        .and_then(|cell| cell.lock().ok().and_then(|mut g| g.take()))
}

/// tracing-subscriber layer that pushes WARN/ERROR events into an mpsc channel
/// for shipping to the server.
struct LogCapturingLayer {
    tx: mpsc::UnboundedSender<CapturedLogEvent>,
}

#[derive(Default)]
struct MessageVisitor {
    message: String,
}

impl Visit for MessageVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{:?}", value);
            // Strip the surrounding quotes that Debug adds for &str values.
            if self.message.starts_with('"') && self.message.ends_with('"') {
                self.message = self.message[1..self.message.len() - 1].to_string();
            }
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.to_string();
        }
    }
}

impl<S> Layer<S> for LogCapturingLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let metadata = event.metadata();
        let level = *metadata.level();
        if level > Level::WARN {
            return;
        }
        let mut visitor = MessageVisitor::default();
        event.record(&mut visitor);
        let _ = self.tx.send(CapturedLogEvent {
            level: if level == Level::ERROR {
                "error"
            } else {
                "warn"
            },
            target: metadata.target().to_string(),
            message: visitor.message,
        });
    }
}

/// Initialize the logging system with dual output (console + file)
///
/// Returns a WorkerGuard that MUST be kept alive for the program's lifetime.
/// If the guard is dropped, buffered logs may be lost.
pub fn init_logging(config: &Config) -> Result<()> {
    // Parse log level
    let _level = parse_log_level(&config.system.log_level)?;

    // Create log directory if needed
    if let Some(parent) = config.system.log_file.parent() {
        fs::create_dir_all(parent).map_err(|e| MontrError::DirectoryCreation {
            path: parent.to_path_buf(),
            source: e,
        })?;
    }

    // Check and perform log rotation if needed (before opening file)
    check_log_rotation(config)?;

    // Create env filter (RUST_LOG env var can override config)
    let env_filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new(&config.system.log_level))
        .map_err(|e| MontrError::LoggingInit(format!("Invalid log level: {}", e)))?;

    // Console layer
    let console_layer = fmt::layer()
        .with_target(true)
        .with_line_number(true)
        .with_ansi(true);

    // File layer
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&config.system.log_file)
        .map_err(|e| MontrError::FileAccess {
            path: config.system.log_file.clone(),
            source: e,
        })?;

    let file_layer = fmt::layer()
        .with_writer(std::sync::Mutex::new(log_file))
        .with_ansi(false)
        .with_target(true)
        .with_line_number(true);

    // Install the WARN/ERROR capturing layer. The receiver lives in a static
    // OnceLock so main.rs can take ownership later, after the WS sender exists.
    let (capture_tx, capture_rx) = mpsc::unbounded_channel::<CapturedLogEvent>();
    let _ = LOG_EVENT_RX.set(std::sync::Mutex::new(Some(capture_rx)));
    let capture_layer = LogCapturingLayer { tx: capture_tx };

    tracing_subscriber::registry()
        .with(env_filter)
        .with(console_layer)
        .with(file_layer)
        .with(capture_layer)
        .init();

    tracing::info!(
        "Logging initialized: level={}, file={}",
        config.system.log_level,
        config.system.log_file.display()
    );

    Ok(())
}

/// Parse log level string to tracing Level
fn parse_log_level(level_str: &str) -> Result<Level> {
    match level_str.to_lowercase().as_str() {
        "error" => Ok(Level::ERROR),
        "warn" => Ok(Level::WARN),
        "info" => Ok(Level::INFO),
        "debug" => Ok(Level::DEBUG),
        "trace" => Ok(Level::TRACE),
        _ => Err(MontrError::ConfigValidation {
            field: "system.log_level".to_string(),
            reason: format!("Invalid log level: {}", level_str),
        }),
    }
}

/// Check and perform log rotation if needed
fn check_log_rotation(config: &Config) -> Result<()> {
    let log_path = &config.system.log_file;

    if !log_path.exists() {
        return Ok(());
    }

    // Check file size
    let metadata = fs::metadata(log_path).map_err(|e| MontrError::FileAccess {
        path: log_path.clone(),
        source: e,
    })?;

    let size_mb = metadata.len() / (1024 * 1024);
    let max_size_mb = config.system.log_max_size_mb;

    if size_mb >= max_size_mb {
        rotate_logs(log_path, config.system.log_max_files)?;
    }

    Ok(())
}

/// Rotate log files
fn rotate_logs(log_path: &Path, max_files: u32) -> Result<()> {
    // Note: Using println! here because logging isn't initialized yet
    println!("Rotating log files...");

    // Remove oldest log if at max
    let oldest = log_path.with_extension(format!("log.{}", max_files));
    if oldest.exists() {
        fs::remove_file(&oldest).map_err(|e| MontrError::FileAccess {
            path: oldest.clone(),
            source: e,
        })?;
    }

    // Shift existing logs (move .log.N to .log.N+1)
    for i in (1..max_files).rev() {
        let current = log_path.with_extension(format!("log.{}", i));
        let next = log_path.with_extension(format!("log.{}", i + 1));

        if current.exists() {
            fs::rename(&current, &next).map_err(|e| MontrError::FileAccess {
                path: current.clone(),
                source: e,
            })?;
        }
    }

    // Rotate current log to .log.1
    let rotated = log_path.with_extension("log.1");
    fs::rename(log_path, &rotated).map_err(|e| MontrError::FileAccess {
        path: log_path.to_path_buf(),
        source: e,
    })?;

    println!("Log rotation complete");

    Ok(())
}

/// Log system information on startup
pub fn log_startup_info(config: &Config) {
    tracing::info!("=== Montr Client Starting ===");
    tracing::info!("Version: {}", env!("CARGO_PKG_VERSION"));
    tracing::info!("Client ID: {}", config.client.id);
    tracing::info!("Client Name: {}", config.client.name);
    tracing::info!("Server URL: {}", config.server.url);
    tracing::info!(
        "Cache Directory: {}",
        config.playback.media_cache_dir.display()
    );
    tracing::info!("Log Level: {}", config.system.log_level);

    #[cfg(target_os = "linux")]
    tracing::info!("Platform: Linux");

    #[cfg(target_os = "windows")]
    tracing::info!("Platform: Windows");

    #[cfg(target_os = "macos")]
    tracing::info!("Platform: macOS");

    tracing::info!("=============================");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn create_test_config(temp_dir: &TempDir) -> Config {
        let log_file = temp_dir.path().join("test.log");

        crate::config::Config {
            server: crate::config::ServerConfig {
                url: "http://localhost:3000".to_string(),
                api_key: None,
                reconnect_interval: 5,
                heartbeat_interval: 30,
                ca_cert_path: None,
                tls_skip_verify: false,
            },
            client: crate::config::ClientConfig {
                id: "550e8400-e29b-41d4-a716-446655440000".to_string(),
                name: "Test Client".to_string(),
                preview_interval_secs: 10,
            },
            playback: crate::config::PlaybackConfig {
                default_image_duration: 5,
                loop_playlist: true,
                media_cache_dir: temp_dir.path().join("cache"),
                max_cache_size_mb: 5000,
                preload_next_items: 2,
                offline_fallback_grace_secs: 5,
            },
            system: crate::config::SystemConfig {
                auto_start: false,
                auto_update: true,
                log_level: "info".to_string(),
                log_file,
                log_max_size_mb: 100,
                log_max_files: 5,
            },
            display: crate::config::DisplayConfig {
                fullscreen: true,
                screen_index: 0,
                window_width: None,
                window_height: None,
                enable_subtitles: false,
                preferred_subtitle_language: None,
                subtitle_font_size: None,
            },
            config_path: None,
        }
    }

    #[test]
    fn test_parse_log_level_valid() {
        assert!(matches!(parse_log_level("error"), Ok(Level::ERROR)));
        assert!(matches!(parse_log_level("warn"), Ok(Level::WARN)));
        assert!(matches!(parse_log_level("info"), Ok(Level::INFO)));
        assert!(matches!(parse_log_level("debug"), Ok(Level::DEBUG)));
        assert!(matches!(parse_log_level("trace"), Ok(Level::TRACE)));
    }

    #[test]
    fn test_parse_log_level_case_insensitive() {
        assert!(matches!(parse_log_level("ERROR"), Ok(Level::ERROR)));
        assert!(matches!(parse_log_level("Info"), Ok(Level::INFO)));
        assert!(matches!(parse_log_level("DeBuG"), Ok(Level::DEBUG)));
    }

    #[test]
    fn test_parse_log_level_invalid() {
        let result = parse_log_level("invalid");
        assert!(result.is_err());

        match result {
            Err(MontrError::ConfigValidation { field, .. }) => {
                assert_eq!(field, "system.log_level");
            }
            _ => panic!("Expected ConfigValidation error"),
        }
    }

    #[test]
    fn test_log_rotation_small_file() {
        let temp_dir = TempDir::new().unwrap();
        let log_path = temp_dir.path().join("test.log");

        // Create a small log file
        fs::write(&log_path, "small log content").unwrap();

        let config = create_test_config(&temp_dir);

        // Should not rotate (file is small)
        let result = check_log_rotation(&config);
        assert!(result.is_ok());

        // Original file should still exist
        assert!(log_path.exists());
    }

    #[test]
    fn test_log_rotation_large_file() {
        let temp_dir = TempDir::new().unwrap();
        let log_path = temp_dir.path().join("test.log");

        // Create a large log file (>100 MB worth of data)
        let large_content = vec![0u8; 101 * 1024 * 1024]; // 101 MB
        fs::write(&log_path, &large_content).unwrap();

        let config = create_test_config(&temp_dir);

        // Should rotate (file is large)
        let result = check_log_rotation(&config);
        assert!(result.is_ok());

        // Original file should not exist (rotated)
        assert!(!log_path.exists());

        // Rotated file should exist
        let rotated = log_path.with_extension("log.1");
        assert!(rotated.exists());
    }

    #[test]
    fn test_log_rotation_multiple() {
        let temp_dir = TempDir::new().unwrap();
        let log_path = temp_dir.path().join("test.log");

        // Create initial log files
        fs::write(&log_path, "current").unwrap();
        fs::write(log_path.with_extension("log.1"), "old1").unwrap();
        fs::write(log_path.with_extension("log.2"), "old2").unwrap();

        // Perform rotation
        let result = rotate_logs(&log_path, 5);
        assert!(result.is_ok());

        // Check rotation happened correctly
        assert!(!log_path.exists()); // Current was rotated away
        assert!(log_path.with_extension("log.1").exists()); // Current -> .1
        assert!(log_path.with_extension("log.2").exists()); // .1 -> .2
        assert!(log_path.with_extension("log.3").exists()); // .2 -> .3

        // Verify content
        let content1 = fs::read_to_string(log_path.with_extension("log.1")).unwrap();
        assert_eq!(content1, "current");

        let content2 = fs::read_to_string(log_path.with_extension("log.2")).unwrap();
        assert_eq!(content2, "old1");
    }

    #[test]
    fn test_log_rotation_max_files() {
        let temp_dir = TempDir::new().unwrap();
        let log_path = temp_dir.path().join("test.log");

        // Create max number of log files
        fs::write(&log_path, "current").unwrap();
        for i in 1..=5 {
            fs::write(
                log_path.with_extension(format!("log.{}", i)),
                format!("old{}", i),
            )
            .unwrap();
        }

        // Perform rotation (max_files = 5)
        let result = rotate_logs(&log_path, 5);
        assert!(result.is_ok());

        // Oldest file (log.5) should have been removed
        // log.6 should not exist (would exceed max)
        assert!(!log_path.with_extension("log.6").exists());

        // Should have exactly 5 rotated files (log.1 through log.5)
        for i in 1..=5 {
            assert!(log_path.with_extension(format!("log.{}", i)).exists());
        }
    }

    #[test]
    fn test_log_file_creation() {
        let temp_dir = TempDir::new().unwrap();
        let config = create_test_config(&temp_dir);

        // Log file should not exist yet
        assert!(!config.system.log_file.exists());

        // Initialize logging (we can't test the full init due to global state,
        // but we can test that directories are created)
        if let Some(parent) = config.system.log_file.parent() {
            fs::create_dir_all(parent).unwrap();
            assert!(parent.exists());
        }
    }
}
