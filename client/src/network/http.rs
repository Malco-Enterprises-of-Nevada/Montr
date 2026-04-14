//! HTTP client for downloading media files from the server
//!
//! This module provides a wrapper around reqwest for downloading media files
//! with progress tracking, resume support, and error handling.

use crate::error::{MontrError, Result};
use indicatif::{ProgressBar, ProgressStyle};
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_LENGTH, RANGE};
use reqwest::Client;
use std::ffi::OsStr;
use std::path::Path;
use std::time::Duration;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;

/// HTTP client for media downloads
pub struct HttpClient {
    client: Client,
    server_url: String,
}

/// Download options
#[derive(Debug, Clone)]
pub struct DownloadOptions {
    /// Whether to show progress bar
    pub show_progress: bool,

    /// Whether to resume partial downloads
    pub resume: bool,

    /// Request timeout in seconds
    pub timeout_secs: u64,

    /// Maximum retries on failure
    pub max_retries: u32,

    /// Optional API key for authentication
    pub api_key: Option<String>,
}

impl Default for DownloadOptions {
    fn default() -> Self {
        Self {
            show_progress: true,
            resume: true,
            timeout_secs: 300, // 5 minutes
            max_retries: 3,
            api_key: None,
        }
    }
}

impl HttpClient {
    /// Create a new HTTP client
    pub fn new(
        server_url: String,
        ca_cert_path: Option<&Path>,
        tls_skip_verify: bool,
    ) -> Result<Self> {
        let mut builder = Client::builder().timeout(Duration::from_secs(300));

        if tls_skip_verify {
            tracing::warn!("TLS certificate verification is DISABLED — do not use in production");
            builder = builder.danger_accept_invalid_certs(true);
        } else if let Some(ca_path) = ca_cert_path {
            let cert_pem = std::fs::read(ca_path).map_err(|e| MontrError::FileAccess {
                path: ca_path.to_path_buf(),
                source: e,
            })?;
            let cert = reqwest::Certificate::from_pem(&cert_pem)
                .map_err(|e| MontrError::HttpRequest(format!("Invalid CA certificate: {}", e)))?;
            builder = builder.add_root_certificate(cert);
        }

        let client = builder.build()?;

        Ok(Self { client, server_url })
    }

    /// Download a media file by ID
    ///
    /// Downloads from `/api/media/:id/download` endpoint and saves to the
    /// specified destination path.
    pub async fn download_media(
        &self,
        media_id: u32,
        dest_path: &Path,
        options: DownloadOptions,
    ) -> Result<()> {
        let url = format!("{}/api/media/{}/download", self.server_url, media_id);

        let mut attempt = 0;
        loop {
            match self.try_download(&url, dest_path, &options).await {
                Ok(()) => return Ok(()),
                Err(e) => {
                    attempt += 1;
                    if attempt >= options.max_retries {
                        return Err(MontrError::DownloadFailed {
                            url: url.clone(),
                            reason: format!("Failed after {} attempts: {}", attempt, e),
                        });
                    }

                    tracing::warn!(
                        "Download attempt {}/{} failed: {}. Retrying...",
                        attempt,
                        options.max_retries,
                        e
                    );

                    // Exponential backoff: 1s, 2s, 4s...
                    let delay = Duration::from_secs(2u64.pow(attempt - 1));
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }

    /// Attempt a single download
    async fn try_download(
        &self,
        url: &str,
        dest_path: &Path,
        options: &DownloadOptions,
    ) -> Result<()> {
        // Check if partial file exists for resume
        let start_byte = if options.resume && dest_path.exists() {
            dest_path
                .metadata()
                .map_err(|e| MontrError::FileAccess {
                    path: dest_path.to_path_buf(),
                    source: e,
                })?
                .len()
        } else {
            0
        };

        // Build request with headers
        let mut headers = HeaderMap::new();
        if let Some(ref api_key) = options.api_key {
            headers.insert(
                "X-API-Key",
                HeaderValue::from_str(api_key).map_err(|e| {
                    MontrError::HttpRequest(format!("Invalid API key header value: {}", e))
                })?,
            );
        }

        // Add Range header for resume
        if start_byte > 0 {
            let range_value = format!("bytes={}-", start_byte);
            headers.insert(
                RANGE,
                HeaderValue::from_str(&range_value).map_err(|e| {
                    MontrError::HttpRequest(format!("Invalid Range header value: {}", e))
                })?,
            );
        }

        // Send request
        let response = self
            .client
            .get(url)
            .headers(headers)
            .timeout(Duration::from_secs(options.timeout_secs))
            .send()
            .await?;

        // Handle Range Not Satisfiable — partial file is larger than source, delete and retry
        if response.status().as_u16() == 416 && start_byte > 0 {
            tracing::warn!(
                "Range not satisfiable (partial file invalid), restarting download from scratch"
            );
            let _ = tokio::fs::remove_file(dest_path).await;
            return Err(MontrError::HttpRequest(
                "Server returned status: 416 Range Not Satisfiable".to_string(),
            ));
        }

        // Check status
        if !response.status().is_success() {
            return Err(MontrError::HttpRequest(format!(
                "Server returned status: {}",
                response.status()
            )));
        }

        // Get content length
        let total_size = if start_byte > 0 {
            // For resume, add start_byte to content-length (which is remaining bytes)
            start_byte
                + response
                    .headers()
                    .get(CONTENT_LENGTH)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(0)
        } else {
            response
                .headers()
                .get(CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0)
        };

        // Setup progress bar
        let progress = if options.show_progress && total_size > 0 {
            let pb = ProgressBar::new(total_size);
            pb.set_style(
                ProgressStyle::default_bar()
                    .template(
                        "{msg}\n[{elapsed_precise}] [{bar:40.cyan/blue}] {bytes}/{total_bytes} ({eta})"
                    )
                    .unwrap_or_else(|_| ProgressStyle::default_bar())
                    .progress_chars("#>-")
            );
            pb.set_message(format!(
                "Downloading {}",
                dest_path
                    .file_name()
                    .unwrap_or(OsStr::new("unknown"))
                    .to_string_lossy()
            ));
            if start_byte > 0 {
                pb.set_position(start_byte);
            }
            Some(pb)
        } else {
            None
        };

        // Open file for writing (append mode for resume)
        let mut file = if start_byte > 0 {
            tokio::fs::OpenOptions::new()
                .append(true)
                .open(dest_path)
                .await
                .map_err(|e| MontrError::CacheWrite {
                    path: dest_path.to_path_buf(),
                    source: e,
                })?
        } else {
            // Create parent directories if needed
            if let Some(parent) = dest_path.parent() {
                tokio::fs::create_dir_all(parent).await.map_err(|e| {
                    MontrError::DirectoryCreation {
                        path: parent.to_path_buf(),
                        source: e,
                    }
                })?;
            }

            File::create(dest_path)
                .await
                .map_err(|e| MontrError::CacheWrite {
                    path: dest_path.to_path_buf(),
                    source: e,
                })?
        };

        // Stream download with progress
        let mut stream = response.bytes_stream();
        let mut downloaded: u64 = start_byte;

        use futures_util::StreamExt;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| {
                MontrError::HttpRequest(format!("Error reading response chunk: {}", e))
            })?;

            file.write_all(&chunk)
                .await
                .map_err(|e| MontrError::CacheWrite {
                    path: dest_path.to_path_buf(),
                    source: e,
                })?;

            downloaded += chunk.len() as u64;

            if let Some(ref pb) = progress {
                pb.set_position(downloaded);
            }
        }

        // Finish progress bar
        if let Some(pb) = progress {
            pb.finish_with_message(format!(
                "Downloaded {}",
                dest_path
                    .file_name()
                    .unwrap_or(OsStr::new("unknown"))
                    .to_string_lossy()
            ));
        }

        // Flush file
        file.flush().await.map_err(|e| MontrError::CacheWrite {
            path: dest_path.to_path_buf(),
            source: e,
        })?;

        Ok(())
    }

    /// Get file size without downloading
    pub async fn get_file_size(&self, media_id: u32, api_key: Option<&str>) -> Result<u64> {
        let url = format!("{}/api/media/{}/download", self.server_url, media_id);

        let mut headers = HeaderMap::new();
        if let Some(key) = api_key {
            headers.insert(
                "X-API-Key",
                HeaderValue::from_str(key).map_err(|e| {
                    MontrError::HttpRequest(format!("Invalid API key header value: {}", e))
                })?,
            );
        }

        let response = self.client.head(&url).headers(headers).send().await?;

        if !response.status().is_success() {
            return Err(MontrError::HttpRequest(format!(
                "Server returned status: {}",
                response.status()
            )));
        }

        let size = response
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .ok_or_else(|| MontrError::HttpRequest("Missing Content-Length header".to_string()))?;

        Ok(size)
    }

    /// Get the server URL
    pub fn server_url(&self) -> &str {
        &self.server_url
    }

    /// Report playback start to analytics API
    pub async fn report_playback_start(
        &self,
        client_id: &str,
        media_id: u32,
        api_key: Option<&str>,
    ) -> Result<Option<u64>> {
        let url = format!("{}/api/analytics/playback/start", self.server_url);
        let body = serde_json::json!({
            "clientId": client_id,
            "mediaId": media_id,
        });

        let mut req = self.client.post(&url).json(&body);
        if let Some(key) = api_key {
            req = req.header("X-API-Key", key);
        }

        match req.timeout(Duration::from_secs(5)).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    let id = json
                        .get("data")
                        .and_then(|d| d.get("id"))
                        .and_then(|v| v.as_u64());
                    Ok(id)
                } else {
                    Ok(None)
                }
            }
            Ok(resp) => {
                tracing::debug!("Analytics start returned {}", resp.status());
                Ok(None)
            }
            Err(e) => {
                tracing::debug!("Analytics start failed: {}", e);
                Ok(None)
            }
        }
    }

    /// Upload a tail of the local log file to the server in response to a
    /// `fetch_logs` command. The body is raw text/plain (no JSON wrapper) and
    /// the request is correlated with the originating dashboard request via
    /// the `X-Request-Id` header.
    pub async fn upload_logs(
        &self,
        client_id: &str,
        request_id: &str,
        log_bytes: Vec<u8>,
        api_key: Option<&str>,
    ) -> Result<()> {
        let url = format!("{}/api/clients/{}/logs/upload", self.server_url, client_id);

        let mut req = self
            .client
            .post(&url)
            .header("Content-Type", "text/plain; charset=utf-8")
            .header("X-Request-Id", request_id)
            .body(log_bytes);

        if let Some(key) = api_key {
            req = req.header("X-API-Key", key);
        }

        match req.timeout(Duration::from_secs(15)).send().await {
            Ok(resp) if resp.status().is_success() => Ok(()),
            Ok(resp) => Err(MontrError::HttpRequest(format!(
                "Log upload returned {}",
                resp.status()
            ))),
            Err(e) => Err(MontrError::HttpRequest(format!("Log upload failed: {}", e))),
        }
    }

    /// Report playback end to analytics API
    pub async fn report_playback_end(
        &self,
        log_id: u64,
        duration_watched: f64,
        completed: bool,
        api_key: Option<&str>,
    ) -> Result<()> {
        let url = format!("{}/api/analytics/playback/{}/end", self.server_url, log_id);
        let body = serde_json::json!({
            "durationWatched": duration_watched,
            "completed": completed,
        });

        let mut req = self.client.post(&url).json(&body);
        if let Some(key) = api_key {
            req = req.header("X-API-Key", key);
        }

        match req.timeout(Duration::from_secs(5)).send().await {
            Ok(_) => {}
            Err(e) => tracing::debug!("Analytics end failed: {}", e),
        }
        Ok(())
    }

    /// Check server health
    pub async fn check_health(&self) -> Result<bool> {
        let url = format!("{}/api/health", self.server_url);

        match self
            .client
            .get(&url)
            .timeout(Duration::from_secs(5))
            .send()
            .await
        {
            Ok(response) => Ok(response.status().is_success()),
            Err(_) => Ok(false),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_http_client_creation() {
        let client = HttpClient::new("http://localhost:3000".to_string(), None, false);
        assert!(client.is_ok());
    }

    #[test]
    fn test_download_options_default() {
        let options = DownloadOptions::default();
        assert_eq!(options.show_progress, true);
        assert_eq!(options.resume, true);
        assert_eq!(options.timeout_secs, 300);
        assert_eq!(options.max_retries, 3);
        assert!(options.api_key.is_none());
    }

    #[test]
    fn test_download_options_custom() {
        let options = DownloadOptions {
            show_progress: false,
            resume: false,
            timeout_secs: 60,
            max_retries: 5,
            api_key: Some("test-key".to_string()),
        };

        assert_eq!(options.show_progress, false);
        assert_eq!(options.resume, false);
        assert_eq!(options.timeout_secs, 60);
        assert_eq!(options.max_retries, 5);
        assert_eq!(options.api_key, Some("test-key".to_string()));
    }

    #[tokio::test]
    async fn test_download_media_invalid_url() {
        let client = HttpClient::new(
            "http://invalid-nonexistent-server.test".to_string(),
            None,
            false,
        )
        .unwrap();
        let temp_dir = TempDir::new().unwrap();
        let dest = temp_dir.path().join("test.mp4");

        let options = DownloadOptions {
            show_progress: false,
            resume: false,
            timeout_secs: 2,
            max_retries: 1,
            api_key: None,
        };

        let result = client.download_media(1, &dest, options).await;
        assert!(result.is_err());
    }

    #[test]
    fn test_http_client_server_url() {
        let server_url = "http://192.168.1.100:3000".to_string();
        let client = HttpClient::new(server_url.clone(), None, false).unwrap();
        assert_eq!(client.server_url, server_url);
    }

    #[tokio::test]
    async fn test_report_playback_start_returns_log_id() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/api/analytics/playback/start")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"success":true,"data":{"id":7}}"#)
            .create_async()
            .await;

        let client = HttpClient::new(server.url(), None, false).unwrap();
        let result = client.report_playback_start("client-abc", 42, None).await;

        assert_eq!(result.unwrap(), Some(7));
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn test_report_playback_start_handles_error_response() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/api/analytics/playback/start")
            .with_status(500)
            .with_body("boom")
            .create_async()
            .await;

        let client = HttpClient::new(server.url(), None, false).unwrap();
        let result = client.report_playback_start("client-abc", 42, None).await;

        // Errors are swallowed — returns Ok(None) so analytics never fails playback
        assert_eq!(result.unwrap(), None);
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn test_report_playback_end_posts_duration_and_completed() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/api/analytics/playback/7/end")
            .match_body(mockito::Matcher::PartialJsonString(
                r#"{"durationWatched":12.5,"completed":true}"#.to_string(),
            ))
            .with_status(200)
            .with_body(r#"{"success":true}"#)
            .create_async()
            .await;

        let client = HttpClient::new(server.url(), None, false).unwrap();
        client
            .report_playback_end(7, 12.5, true, None)
            .await
            .unwrap();

        mock.assert_async().await;
    }

    #[tokio::test]
    async fn test_report_playback_start_attaches_api_key() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/api/analytics/playback/start")
            .match_header("x-api-key", "secret-key")
            .with_status(200)
            .with_body(r#"{"success":true,"data":{"id":1}}"#)
            .create_async()
            .await;

        let client = HttpClient::new(server.url(), None, false).unwrap();
        let _ = client
            .report_playback_start("c", 1, Some("secret-key"))
            .await;

        mock.assert_async().await;
    }
}
