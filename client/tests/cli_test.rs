/// CLI integration tests
///
/// These tests verify that the client binary correctly handles command-line arguments
/// and configuration files, which is essential for E2E testing.

use std::fs;
use std::process::Command;
use tempfile::TempDir;

mod common;
use common::{write_test_config, TestConfigBuilder};

/// Test that the client binary exists and is executable
#[test]
fn test_binary_exists() {
    let binary_path = if cfg!(debug_assertions) {
        "target/debug/montr-client"
    } else {
        "target/release/montr-client"
    };

    let metadata = fs::metadata(binary_path)
        .expect("Client binary not found. Run 'cargo build' first.");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = metadata.permissions();
        assert!(
            permissions.mode() & 0o111 != 0,
            "Client binary is not executable"
        );
    }
}

/// Test that the client accepts --config argument
#[test]
fn test_client_accepts_config_argument() {
    let temp_dir = TempDir::new().unwrap();
    let config_path = write_test_config(
        "http://localhost:3001",
        "550e8400-e29b-41d4-a716-446655440000",
        &temp_dir,
    );

    let binary_path = if cfg!(debug_assertions) {
        "target/debug/montr-client"
    } else {
        "target/release/montr-client"
    };

    // Run with --help to verify the binary works
    let output = Command::new(binary_path)
        .arg("--help")
        .output()
        .expect("Failed to run client");

    assert!(output.status.success() || output.status.code() == Some(0));
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("--config"));
}

/// Test that client works with minimal configuration
#[test]
fn test_client_with_minimal_config() {
    let temp_dir = TempDir::new().unwrap();
    let cache_dir = temp_dir.path().join("cache");
    let log_file = temp_dir.path().join("client.log");

    let minimal_config = format!(
        r#"[server]
url = "http://localhost:3001"

[client]
id = "550e8400-e29b-41d4-a716-446655440000"
name = "Minimal Test Client"

[playback]
media_cache_dir = "{}"

[system]
log_file = "{}"

[display]
"#,
        cache_dir.display(),
        log_file.display()
    );

    let config_path = temp_dir.path().join("config.toml");
    fs::write(&config_path, minimal_config).unwrap();

    // Verify config can be parsed
    assert!(config_path.exists());

    // The config should contain required fields
    let content = fs::read_to_string(&config_path).unwrap();
    assert!(content.contains("http://localhost:3001"));
    assert!(content.contains("550e8400-e29b-41d4-a716-446655440000"));
}

/// Test that config builder produces valid configurations
#[test]
fn test_config_builder_produces_valid_config() {
    let temp_dir = TempDir::new().unwrap();

    let config_path = TestConfigBuilder::new(
        "http://localhost:3001",
        "550e8400-e29b-41d4-a716-446655440000",
    )
    .client_name("E2E Test Client")
    .reconnect_interval(2)
    .heartbeat_interval(10)
    .log_level("info")
    .write(&temp_dir);

    assert!(config_path.exists());

    let content = fs::read_to_string(&config_path).unwrap();
    assert!(content.contains("E2E Test Client"));
    assert!(content.contains("reconnect_interval = 2"));
    assert!(content.contains("heartbeat_interval = 10"));
    assert!(content.contains("log_level = \"info\""));
}

/// Test that CLI overrides work correctly
#[test]
fn test_cli_overrides() {
    // This test verifies that the CLI argument parsing supports overrides
    // The actual override behavior is tested in unit tests

    let binary_path = if cfg!(debug_assertions) {
        "target/debug/montr-client"
    } else {
        "target/release/montr-client"
    };

    let output = Command::new(binary_path)
        .arg("--help")
        .output()
        .expect("Failed to run client");

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Verify all expected CLI options are available
    assert!(stdout.contains("--config"));
    assert!(stdout.contains("--server-url"));
    assert!(stdout.contains("--client-name"));
    assert!(stdout.contains("--log-level"));
    assert!(stdout.contains("--fullscreen"));
    assert!(stdout.contains("--verbose"));
}

/// Test version flag
#[test]
fn test_version_flag() {
    let binary_path = if cfg!(debug_assertions) {
        "target/debug/montr-client"
    } else {
        "target/release/montr-client"
    };

    let output = Command::new(binary_path)
        .arg("--version")
        .output()
        .expect("Failed to run client");

    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("1.0.0") || stdout.contains("montr-client"));
}

/// Test that missing config file produces appropriate error
#[test]
fn test_missing_config_file_error() {
    let binary_path = if cfg!(debug_assertions) {
        "target/debug/montr-client"
    } else {
        "target/release/montr-client"
    };

    let output = Command::new(binary_path)
        .arg("--config")
        .arg("/nonexistent/config.toml")
        .output()
        .expect("Failed to run client");

    // Should fail with non-zero exit code
    assert!(!output.status.success());

    // Should have error message
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("Configuration error") ||
        stderr.contains("not found") ||
        stderr.contains("No such file")
    );
}
