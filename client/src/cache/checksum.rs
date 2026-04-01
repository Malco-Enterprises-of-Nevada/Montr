//! File checksum verification using SHA-256
//!
//! Provides functions to calculate and verify SHA-256 checksums for downloaded files.

use crate::error::{MontrError, Result};
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::fs::File;
use tokio::io::AsyncReadExt;

/// Calculate SHA-256 checksum for a file
///
/// Reads the file in 8KB chunks to avoid loading large files into memory.
pub async fn calculate_checksum(file_path: &Path) -> Result<String> {
    let mut file = File::open(file_path)
        .await
        .map_err(|e| MontrError::CacheRead {
            path: file_path.to_path_buf(),
            source: e,
        })?;

    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 8192]; // 8KB chunks

    loop {
        let bytes_read = file
            .read(&mut buffer)
            .await
            .map_err(|e| MontrError::CacheRead {
                path: file_path.to_path_buf(),
                source: e,
            })?;

        if bytes_read == 0 {
            break;
        }

        hasher.update(&buffer[..bytes_read]);
    }

    let result = hasher.finalize();
    Ok(format!("{:x}", result))
}

/// Verify file checksum matches expected value
///
/// Returns Ok(()) if checksums match, or ChecksumMismatch error if they don't.
pub async fn verify_checksum(file_path: &Path, expected_checksum: &str) -> Result<()> {
    // Skip verification if server didn't provide a checksum
    if expected_checksum.is_empty() {
        tracing::debug!("Skipping checksum verification (no checksum provided by server)");
        return Ok(());
    }

    let actual_checksum = calculate_checksum(file_path).await?;

    if actual_checksum.to_lowercase() == expected_checksum.to_lowercase() {
        Ok(())
    } else {
        Err(MontrError::ChecksumMismatch {
            path: file_path.to_path_buf(),
            expected: expected_checksum.to_string(),
            actual: actual_checksum,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;
    use tokio::fs;

    #[tokio::test]
    async fn test_calculate_checksum_empty_file() {
        let mut temp_file = NamedTempFile::new().unwrap();
        temp_file.write_all(b"").unwrap();
        temp_file.flush().unwrap();

        let checksum = calculate_checksum(temp_file.path()).await.unwrap();

        // SHA-256 of empty string
        assert_eq!(
            checksum,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[tokio::test]
    async fn test_calculate_checksum_hello_world() {
        let mut temp_file = NamedTempFile::new().unwrap();
        temp_file.write_all(b"Hello, World!").unwrap();
        temp_file.flush().unwrap();

        let checksum = calculate_checksum(temp_file.path()).await.unwrap();

        // SHA-256 of "Hello, World!"
        assert_eq!(
            checksum,
            "dffd6021bb2bd5b0af676290809ec3a53191dd81c7f70a4b28688a362182986f"
        );
    }

    #[tokio::test]
    async fn test_calculate_checksum_large_file() {
        let temp_file = NamedTempFile::new().unwrap();

        // Create a 20KB file (larger than 8KB buffer)
        let content = vec![0x42u8; 20 * 1024];
        fs::write(temp_file.path(), &content).await.unwrap();

        let checksum = calculate_checksum(temp_file.path()).await.unwrap();

        // Should successfully hash the entire file
        assert_eq!(checksum.len(), 64); // SHA-256 produces 64 hex characters
    }

    #[tokio::test]
    async fn test_verify_checksum_success() {
        let mut temp_file = NamedTempFile::new().unwrap();
        temp_file.write_all(b"test data").unwrap();
        temp_file.flush().unwrap();

        let checksum = calculate_checksum(temp_file.path()).await.unwrap();

        // Verification should succeed
        let result = verify_checksum(temp_file.path(), &checksum).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_verify_checksum_case_insensitive() {
        let mut temp_file = NamedTempFile::new().unwrap();
        temp_file.write_all(b"test").unwrap();
        temp_file.flush().unwrap();

        let checksum = calculate_checksum(temp_file.path()).await.unwrap();
        let uppercase_checksum = checksum.to_uppercase();

        // Should work with different cases
        let result = verify_checksum(temp_file.path(), &uppercase_checksum).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_verify_checksum_mismatch() {
        let mut temp_file = NamedTempFile::new().unwrap();
        temp_file.write_all(b"actual content").unwrap();
        temp_file.flush().unwrap();

        let wrong_checksum = "0000000000000000000000000000000000000000000000000000000000000000";

        // Verification should fail
        let result = verify_checksum(temp_file.path(), wrong_checksum).await;
        assert!(result.is_err());

        match result {
            Err(MontrError::ChecksumMismatch { expected, actual, .. }) => {
                assert_eq!(expected, wrong_checksum);
                assert_ne!(actual, wrong_checksum);
            }
            _ => panic!("Expected ChecksumMismatch error"),
        }
    }

    #[tokio::test]
    async fn test_calculate_checksum_nonexistent_file() {
        let result = calculate_checksum(Path::new("/nonexistent/file.txt")).await;
        assert!(result.is_err());

        match result {
            Err(MontrError::CacheRead { .. }) => (),
            _ => panic!("Expected CacheRead error"),
        }
    }

    #[tokio::test]
    async fn test_checksum_deterministic() {
        let mut temp_file = NamedTempFile::new().unwrap();
        temp_file.write_all(b"deterministic test").unwrap();
        temp_file.flush().unwrap();

        // Calculate checksum multiple times
        let checksum1 = calculate_checksum(temp_file.path()).await.unwrap();
        let checksum2 = calculate_checksum(temp_file.path()).await.unwrap();
        let checksum3 = calculate_checksum(temp_file.path()).await.unwrap();

        // All should be identical
        assert_eq!(checksum1, checksum2);
        assert_eq!(checksum2, checksum3);
    }
}
