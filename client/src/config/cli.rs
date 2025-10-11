use clap::Parser;
use std::path::PathBuf;

/// Montr media playlist client
#[derive(Parser, Debug)]
#[command(
    name = "montr-client",
    version = env!("CARGO_PKG_VERSION"),
    about = "Montr media playlist client for automated playback",
    long_about = "A distributed media playlist client that connects to a Montr server \
                  and plays assigned video/image playlists using libmpv.\n\n\
                  Examples:\n  \
                  montr-client --config /etc/montr-client/config.toml\n  \
                  montr-client --server-url http://192.168.1.100:3000 --client-name Display-Main\n  \
                  montr-client --verbose"
)]
pub struct CliArgs {
    /// Path to configuration file
    ///
    /// If not specified, searches standard locations:
    /// - Linux: ~/.config/montr-client/config.toml, /etc/montr-client/config.toml
    /// - Windows: %APPDATA%\Montr\config.toml, C:\ProgramData\Montr\config.toml
    /// - Current directory: ./config.toml
    #[arg(
        short,
        long,
        value_name = "FILE",
        help = "Path to configuration file"
    )]
    pub config: Option<PathBuf>,

    /// Server URL (overrides config file)
    ///
    /// Example: http://192.168.1.100:3000
    #[arg(
        short,
        long,
        value_name = "URL",
        help = "Server URL (overrides config file)",
        long_help = "Server URL (overrides config file)\n\
                     Example: http://192.168.1.100:3000 or https://montr.example.com"
    )]
    pub server_url: Option<String>,

    /// Client name (overrides config file)
    ///
    /// Used for identification in the server dashboard
    #[arg(
        short = 'n',
        long,
        value_name = "NAME",
        help = "Client display name (overrides config file)"
    )]
    pub client_name: Option<String>,

    /// Log level (overrides config file)
    ///
    /// Valid values: error, warn, info, debug, trace
    #[arg(
        short = 'l',
        long,
        value_name = "LEVEL",
        help = "Log level (overrides config file)",
        value_parser = ["error", "warn", "info", "debug", "trace"]
    )]
    pub log_level: Option<String>,

    /// Enable fullscreen mode (overrides config file)
    #[arg(
        short = 'f',
        long,
        help = "Enable fullscreen mode",
        conflicts_with = "no_fullscreen"
    )]
    pub fullscreen: bool,

    /// Disable fullscreen mode (overrides config file)
    #[arg(long, help = "Disable fullscreen mode", conflicts_with = "fullscreen")]
    pub no_fullscreen: bool,

    /// Enable verbose output (sets log level to debug)
    ///
    /// Equivalent to --log-level debug
    #[arg(
        short,
        long,
        help = "Enable verbose output (debug level)",
        conflicts_with = "log_level"
    )]
    pub verbose: bool,

    /// Enable trace output (sets log level to trace)
    ///
    /// Equivalent to --log-level trace. Most detailed logging.
    #[arg(
        short = 't',
        long,
        help = "Enable trace output (most detailed)",
        conflicts_with_all = ["log_level", "verbose"]
    )]
    pub trace: bool,
}

impl CliArgs {
    /// Parse command-line arguments
    pub fn parse_args() -> Self {
        let mut args = Self::parse();

        // Handle fullscreen resolution
        if args.no_fullscreen {
            args.fullscreen = false;
        }

        // Handle verbose/trace flags
        if args.trace {
            args.log_level = Some("trace".to_string());
        } else if args.verbose {
            args.log_level = Some("debug".to_string());
        }

        args
    }

    /// Get the fullscreen setting as Option<bool> for override logic
    pub fn get_fullscreen_override(&self) -> Option<bool> {
        if self.fullscreen {
            Some(true)
        } else if self.no_fullscreen {
            Some(false)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cli_parse_minimal() {
        // Test with no arguments (defaults)
        let args = CliArgs::parse_from(&["montr-client"]);

        assert!(args.config.is_none());
        assert!(args.server_url.is_none());
        assert!(args.client_name.is_none());
        assert!(args.log_level.is_none());
        assert!(!args.fullscreen);
        assert!(!args.no_fullscreen);
        assert!(!args.verbose);
    }

    #[test]
    fn test_cli_parse_config_path() {
        let args = CliArgs::parse_from(&["montr-client", "--config", "/etc/montr/config.toml"]);

        assert_eq!(args.config, Some(PathBuf::from("/etc/montr/config.toml")));
    }

    #[test]
    fn test_cli_parse_server_url() {
        let args = CliArgs::parse_from(&[
            "montr-client",
            "--server-url",
            "http://192.168.1.100:3000",
        ]);

        assert_eq!(
            args.server_url,
            Some("http://192.168.1.100:3000".to_string())
        );
    }

    #[test]
    fn test_cli_parse_client_name() {
        let args = CliArgs::parse_from(&["montr-client", "--client-name", "Display-Main"]);

        assert_eq!(args.client_name, Some("Display-Main".to_string()));
    }

    #[test]
    fn test_cli_parse_log_level() {
        let args = CliArgs::parse_from(&["montr-client", "--log-level", "debug"]);

        assert_eq!(args.log_level, Some("debug".to_string()));
    }

    #[test]
    fn test_cli_parse_fullscreen() {
        let args = CliArgs::parse_from(&["montr-client", "--fullscreen"]);

        assert!(args.fullscreen);
        assert!(!args.no_fullscreen);
        assert_eq!(args.get_fullscreen_override(), Some(true));
    }

    #[test]
    fn test_cli_parse_no_fullscreen() {
        let mut args = CliArgs::parse_from(&["montr-client", "--no-fullscreen"]);
        args = CliArgs {
            fullscreen: false,
            no_fullscreen: true,
            ..args
        };

        // Simulate parse_args() logic
        if args.no_fullscreen {
            args.fullscreen = false;
        }

        assert!(!args.fullscreen);
        assert_eq!(args.get_fullscreen_override(), Some(false));
    }

    #[test]
    fn test_cli_parse_verbose() {
        let mut args = CliArgs::parse_from(&["montr-client", "--verbose"]);

        // Simulate parse_args() logic
        if args.verbose {
            args.log_level = Some("debug".to_string());
        }

        assert_eq!(args.log_level, Some("debug".to_string()));
    }

    #[test]
    fn test_cli_parse_trace() {
        let mut args = CliArgs::parse_from(&["montr-client", "--trace"]);

        // Simulate parse_args() logic
        if args.trace {
            args.log_level = Some("trace".to_string());
        }

        assert_eq!(args.log_level, Some("trace".to_string()));
    }

    #[test]
    fn test_cli_parse_all_options() {
        let args = CliArgs::parse_from(&[
            "montr-client",
            "--config",
            "/etc/montr/config.toml",
            "--server-url",
            "http://localhost:3000",
            "--client-name",
            "Test-Client",
            "--log-level",
            "info",
            "--fullscreen",
        ]);

        assert_eq!(args.config, Some(PathBuf::from("/etc/montr/config.toml")));
        assert_eq!(args.server_url, Some("http://localhost:3000".to_string()));
        assert_eq!(args.client_name, Some("Test-Client".to_string()));
        assert_eq!(args.log_level, Some("info".to_string()));
        assert!(args.fullscreen);
    }

    #[test]
    fn test_cli_short_options() {
        let args = CliArgs::parse_from(&[
            "montr-client",
            "-c",
            "/etc/montr/config.toml",
            "-s",
            "http://localhost:3000",
            "-n",
            "Test",
            "-l",
            "debug",
            "-f",
        ]);

        assert_eq!(args.config, Some(PathBuf::from("/etc/montr/config.toml")));
        assert_eq!(args.server_url, Some("http://localhost:3000".to_string()));
        assert_eq!(args.client_name, Some("Test".to_string()));
        assert_eq!(args.log_level, Some("debug".to_string()));
        assert!(args.fullscreen);
    }

    #[test]
    fn test_get_fullscreen_override_none() {
        let args = CliArgs::parse_from(&["montr-client"]);
        assert_eq!(args.get_fullscreen_override(), None);
    }

    #[test]
    fn test_get_fullscreen_override_true() {
        let args = CliArgs::parse_from(&["montr-client", "--fullscreen"]);
        assert_eq!(args.get_fullscreen_override(), Some(true));
    }
}
