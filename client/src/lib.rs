// Re-export common types and modules for easier access
pub mod cache;
pub mod config;
pub mod error;
pub mod logging;
pub mod network;
pub mod playback;
pub mod state;
pub mod status;

// Re-export commonly used types at crate root for convenience
pub use error::{MontrError, Result};
pub use config::Config;

/// Application version from Cargo.toml
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Application name from Cargo.toml
pub const APP_NAME: &str = env!("CARGO_PKG_NAME");

/// Application description from Cargo.toml
pub const APP_DESCRIPTION: &str = env!("CARGO_PKG_DESCRIPTION");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version_is_set() {
        assert!(!VERSION.is_empty());
        assert!(VERSION.contains('.'));
    }

    #[test]
    fn test_app_name_is_set() {
        assert_eq!(APP_NAME, "montr-client");
    }

    #[test]
    fn test_app_description_is_set() {
        assert!(!APP_DESCRIPTION.is_empty());
    }
}
