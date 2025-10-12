/// Shutdown integration tests
///
/// These tests verify that the client handles shutdown signals correctly,
/// which is essential for E2E testing where the test framework needs to
/// cleanly stop the client process.

use std::process::{Command, Stdio};
use std::time::Duration;
use tempfile::TempDir;

mod common;
use common::write_test_config;

/// Test that client responds to SIGTERM signal (Unix only)
#[test]
#[cfg(unix)]
fn test_client_responds_to_sigterm() {
    use nix::sys::signal::{self, Signal};
    use nix::unistd::Pid;

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

    // Start the client
    let mut child = Command::new(binary_path)
        .arg("--config")
        .arg(&config_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Failed to spawn client");

    let pid = child.id() as i32;

    // Give it a moment to start
    std::thread::sleep(Duration::from_millis(500));

    // Send SIGTERM
    signal::kill(Pid::from_raw(pid), Signal::SIGTERM)
        .expect("Failed to send SIGTERM");

    // Wait for graceful shutdown (with timeout)
    let timeout = Duration::from_secs(5);
    let start = std::time::Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                // Process has exited
                break;
            }
            Ok(None) => {
                // Still running
                if start.elapsed() > timeout {
                    // Force kill if timeout
                    let _ = signal::kill(Pid::from_raw(pid), Signal::SIGKILL);
                    panic!("Client did not shutdown within timeout");
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                panic!("Error waiting for client: {}", e);
            }
        }
    }

    // Verify it exited (don't care about exit code in this test,
    // as mpv might fail to initialize)
    assert!(child.try_wait().unwrap().is_some());
}

/// Test that client responds to Ctrl+C (SIGINT) - Unix only
#[test]
#[cfg(unix)]
fn test_client_responds_to_sigint() {
    use nix::sys::signal::{self, Signal};
    use nix::unistd::Pid;

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

    // Start the client
    let mut child = Command::new(binary_path)
        .arg("--config")
        .arg(&config_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Failed to spawn client");

    let pid = child.id() as i32;

    // Give it a moment to start
    std::thread::sleep(Duration::from_millis(500));

    // Send SIGINT (Ctrl+C)
    signal::kill(Pid::from_raw(pid), Signal::SIGINT)
        .expect("Failed to send SIGINT");

    // Wait for graceful shutdown (with timeout)
    let timeout = Duration::from_secs(5);
    let start = std::time::Instant::now();

    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                // Process has exited
                break;
            }
            Ok(None) => {
                // Still running
                if start.elapsed() > timeout {
                    // Force kill if timeout
                    let _ = signal::kill(Pid::from_raw(pid), Signal::SIGKILL);
                    panic!("Client did not shutdown within timeout after SIGINT");
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                panic!("Error waiting for client: {}", e);
            }
        }
    }

    // Verify it exited
    assert!(child.try_wait().unwrap().is_some());
}

/// Test that client cleans up properly on shutdown
#[test]
#[cfg(unix)]
fn test_client_cleanup_on_shutdown() {
    use nix::sys::signal::{self, Signal};
    use nix::unistd::Pid;

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

    // Start the client
    let child = Command::new(binary_path)
        .arg("--config")
        .arg(&config_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Failed to spawn client");

    let pid = child.id() as i32;

    // Give it a moment to start and create directories
    std::thread::sleep(Duration::from_millis(1000));

    // Verify cache directory was created
    let cache_dir = temp_dir.path().join("cache");
    assert!(cache_dir.exists(), "Cache directory should be created");

    // Send SIGTERM
    signal::kill(Pid::from_raw(pid), Signal::SIGTERM)
        .expect("Failed to send SIGTERM");

    // Wait for shutdown
    let _ = child.wait_with_output();

    // Verify directories still exist (client shouldn't delete them)
    assert!(cache_dir.exists(), "Cache directory should persist after shutdown");
}
