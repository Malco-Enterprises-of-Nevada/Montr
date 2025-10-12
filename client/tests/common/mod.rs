/// Common test helpers for integration tests
use std::fs;
use std::path::PathBuf;
use tempfile::TempDir;

/// Create a minimal test configuration suitable for E2E testing
pub fn create_test_config(server_url: &str, client_id: &str, temp_dir: &TempDir) -> String {
    let cache_dir = temp_dir.path().join("cache");
    let log_file = temp_dir.path().join("client.log");

    format!(
        r#"[server]
url = "{}"
reconnect_interval = 1
heartbeat_interval = 5

[client]
id = "{}"
name = "Test Client"

[playback]
default_image_duration = 5
loop_playlist = true
media_cache_dir = "{}"
max_cache_size_mb = 100

[system]
auto_start = false
log_level = "debug"
log_file = "{}"

[display]
fullscreen = false
"#,
        server_url,
        client_id,
        cache_dir.display(),
        log_file.display()
    )
}

/// Create a configuration file in a temporary directory
pub fn write_test_config(
    server_url: &str,
    client_id: &str,
    temp_dir: &TempDir,
) -> PathBuf {
    let config_content = create_test_config(server_url, client_id, temp_dir);
    let config_path = temp_dir.path().join("config.toml");

    fs::write(&config_path, config_content)
        .expect("Failed to write test config");

    config_path
}

/// Spawn the client process for testing
///
/// Returns the child process that can be controlled by the test
#[allow(dead_code)]
pub fn spawn_client(config_path: &PathBuf) -> std::process::Child {
    let binary_path = if cfg!(debug_assertions) {
        "target/debug/montr-client"
    } else {
        "target/release/montr-client"
    };

    std::process::Command::new(binary_path)
        .arg("--config")
        .arg(config_path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("Failed to spawn client process")
}

/// Helper to create a test config with custom parameters
pub struct TestConfigBuilder {
    server_url: String,
    client_id: String,
    client_name: String,
    reconnect_interval: u64,
    heartbeat_interval: u64,
    log_level: String,
}

impl TestConfigBuilder {
    pub fn new(server_url: &str, client_id: &str) -> Self {
        Self {
            server_url: server_url.to_string(),
            client_id: client_id.to_string(),
            client_name: "Test Client".to_string(),
            reconnect_interval: 1,
            heartbeat_interval: 5,
            log_level: "debug".to_string(),
        }
    }

    pub fn client_name(mut self, name: &str) -> Self {
        self.client_name = name.to_string();
        self
    }

    pub fn reconnect_interval(mut self, interval: u64) -> Self {
        self.reconnect_interval = interval;
        self
    }

    pub fn heartbeat_interval(mut self, interval: u64) -> Self {
        self.heartbeat_interval = interval;
        self
    }

    pub fn log_level(mut self, level: &str) -> Self {
        self.log_level = level.to_string();
        self
    }

    pub fn build(self, temp_dir: &TempDir) -> String {
        let cache_dir = temp_dir.path().join("cache");
        let log_file = temp_dir.path().join("client.log");

        format!(
            r#"[server]
url = "{}"
reconnect_interval = {}
heartbeat_interval = {}

[client]
id = "{}"
name = "{}"

[playback]
default_image_duration = 5
loop_playlist = true
media_cache_dir = "{}"
max_cache_size_mb = 100

[system]
auto_start = false
log_level = "{}"
log_file = "{}"

[display]
fullscreen = false
"#,
            self.server_url,
            self.reconnect_interval,
            self.heartbeat_interval,
            self.client_id,
            self.client_name,
            cache_dir.display(),
            self.log_level,
            log_file.display()
        )
    }

    pub fn write(self, temp_dir: &TempDir) -> PathBuf {
        let config_content = self.build(temp_dir);
        let config_path = temp_dir.path().join("config.toml");

        fs::write(&config_path, config_content)
            .expect("Failed to write test config");

        config_path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_test_config() {
        let temp_dir = TempDir::new().unwrap();
        let config = create_test_config(
            "http://localhost:3000",
            "550e8400-e29b-41d4-a716-446655440000",
            &temp_dir,
        );

        assert!(config.contains("http://localhost:3000"));
        assert!(config.contains("550e8400-e29b-41d4-a716-446655440000"));
        assert!(config.contains("Test Client"));
    }

    #[test]
    fn test_write_test_config() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = write_test_config(
            "http://localhost:3000",
            "550e8400-e29b-41d4-a716-446655440000",
            &temp_dir,
        );

        assert!(config_path.exists());
        let content = fs::read_to_string(&config_path).unwrap();
        assert!(content.contains("http://localhost:3000"));
    }

    #[test]
    fn test_config_builder() {
        let temp_dir = TempDir::new().unwrap();
        let config = TestConfigBuilder::new(
            "http://localhost:3000",
            "550e8400-e29b-41d4-a716-446655440000",
        )
        .client_name("Custom Client")
        .reconnect_interval(3)
        .heartbeat_interval(10)
        .log_level("trace")
        .build(&temp_dir);

        assert!(config.contains("Custom Client"));
        assert!(config.contains("reconnect_interval = 3"));
        assert!(config.contains("heartbeat_interval = 10"));
        assert!(config.contains("log_level = \"trace\""));
    }
}
