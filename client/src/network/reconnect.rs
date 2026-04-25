//! Reconnection strategy with exponential backoff
//!
//! Implements an exponential backoff algorithm with jitter for WebSocket reconnection.
//! This prevents thundering herd problems when multiple clients try to reconnect
//! to a server simultaneously.

use crate::config::Config;
use arc_swap::ArcSwap;
use rand::Rng;
use std::sync::Arc;
use std::time::Duration;

/// Reconnection strategy using exponential backoff with jitter
///
/// The backoff delay increases exponentially with each failed attempt:
/// - Attempt 1: base_delay
/// - Attempt 2: base_delay * multiplier
/// - Attempt 3: base_delay * multiplier^2
/// - ...
/// - Max: max_backoff
///
/// Jitter (±20%) is added to prevent synchronized retries across multiple clients.
///
/// When a `cfg_snap` is wired, `base_delay` is re-read from
/// `server.reconnect_interval` on every call to `next_delay()` so SIGHUP-driven
/// hot reload takes effect on the next retry.
#[derive(Debug, Clone)]
pub struct ReconnectStrategy {
    /// Base delay for first reconnection attempt (fallback when cfg_snap is None)
    base_delay: Duration,

    /// Current delay (increases exponentially)
    current_delay: Duration,

    /// Multiplier for exponential backoff (e.g., 1.5 or 2.0)
    multiplier: f64,

    /// Maximum backoff delay cap
    max_backoff: Duration,

    /// Current attempt number (0-indexed)
    attempt: u32,

    /// Whether to add random jitter (±20%)
    jitter_enabled: bool,

    /// Optional shared config snapshot — when present, `base_delay` is read
    /// fresh from `server.reconnect_interval` on every `next_delay()` call.
    cfg_snap: Option<Arc<ArcSwap<Config>>>,
}

impl ReconnectStrategy {
    /// Create a new reconnection strategy
    ///
    /// # Arguments
    /// * `base_delay` - Initial delay between reconnection attempts
    /// * `multiplier` - Factor to multiply delay by after each failure (typically 1.5 or 2.0)
    /// * `max_backoff` - Maximum delay between attempts (cap)
    pub fn new(base_delay: Duration, multiplier: f64, max_backoff: Duration) -> Self {
        Self {
            base_delay,
            current_delay: base_delay,
            multiplier,
            max_backoff,
            attempt: 0,
            jitter_enabled: true,
            cfg_snap: None,
        }
    }

    /// Wire in the shared config snapshot. Subsequent `next_delay()` calls
    /// will read `server.reconnect_interval` from the snapshot instead of
    /// using the value passed at construction.
    pub fn with_cfg_snap(mut self, cfg_snap: Arc<ArcSwap<Config>>) -> Self {
        self.cfg_snap = Some(cfg_snap);
        self
    }

    fn current_base_delay(&self) -> Duration {
        match self.cfg_snap.as_ref() {
            Some(snap) => Duration::from_secs(snap.load().server.reconnect_interval.max(1)),
            None => self.base_delay,
        }
    }

    /// Create default reconnection strategy
    ///
    /// - Base delay: 5 seconds
    /// - Multiplier: 1.5x
    /// - Max backoff: 300 seconds (5 minutes)
    pub fn default_strategy() -> Self {
        Self::new(Duration::from_secs(5), 1.5, Duration::from_secs(300))
    }

    /// Get the next delay duration for reconnection
    ///
    /// This method calculates the delay with exponential backoff and jitter,
    /// then increments the attempt counter. When a `cfg_snap` is wired, the
    /// base delay is taken from the live snapshot so SIGHUP changes apply
    /// to the very next retry.
    pub fn next_delay(&mut self) -> Duration {
        let base = self.current_base_delay();
        let base_duration = if self.attempt == 0 {
            // First attempt uses base delay
            base
        } else {
            // Calculate exponential backoff
            let backoff_secs = base.as_secs_f64() * self.multiplier.powi(self.attempt as i32);
            Duration::from_secs_f64(backoff_secs.min(self.max_backoff.as_secs_f64()))
        };

        // Apply jitter if enabled
        let delay = if self.jitter_enabled {
            self.apply_jitter(base_duration)
        } else {
            base_duration
        };

        self.current_delay = delay;
        self.attempt += 1;

        delay
    }

    /// Reset the strategy (on successful connection)
    pub fn reset(&mut self) {
        self.attempt = 0;
        self.current_delay = self.current_base_delay();
    }

    /// Get current attempt number
    pub fn attempt_number(&self) -> u32 {
        self.attempt
    }

    /// Get current delay without incrementing
    pub fn current_delay(&self) -> Duration {
        self.current_delay
    }

    /// Enable or disable jitter
    pub fn set_jitter(&mut self, enabled: bool) {
        self.jitter_enabled = enabled;
    }

    /// Apply random jitter of ±20% to the duration
    fn apply_jitter(&self, duration: Duration) -> Duration {
        let mut rng = rand::thread_rng();

        // Jitter range: 0.8 to 1.2 (±20%)
        let jitter_factor = rng.gen_range(0.8..1.2);

        let jittered_secs = duration.as_secs_f64() * jitter_factor;
        Duration::from_secs_f64(jittered_secs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_strategy_creation() {
        let strategy = ReconnectStrategy::default_strategy();

        assert_eq!(strategy.base_delay, Duration::from_secs(5));
        assert_eq!(strategy.multiplier, 1.5);
        assert_eq!(strategy.max_backoff, Duration::from_secs(300));
        assert_eq!(strategy.attempt, 0);
        assert_eq!(strategy.jitter_enabled, true);
    }

    #[test]
    fn test_custom_strategy_creation() {
        let strategy =
            ReconnectStrategy::new(Duration::from_secs(10), 2.0, Duration::from_secs(120));

        assert_eq!(strategy.base_delay, Duration::from_secs(10));
        assert_eq!(strategy.multiplier, 2.0);
        assert_eq!(strategy.max_backoff, Duration::from_secs(120));
    }

    #[test]
    fn test_exponential_backoff_no_jitter() {
        let mut strategy =
            ReconnectStrategy::new(Duration::from_secs(2), 2.0, Duration::from_secs(100));
        strategy.set_jitter(false);

        // Attempt 0: base delay (2s)
        let delay1 = strategy.next_delay();
        assert_eq!(delay1, Duration::from_secs(2));
        assert_eq!(strategy.attempt_number(), 1);

        // Attempt 1: 2 * 2^1 = 4s
        let delay2 = strategy.next_delay();
        assert_eq!(delay2, Duration::from_secs(4));
        assert_eq!(strategy.attempt_number(), 2);

        // Attempt 2: 2 * 2^2 = 8s
        let delay3 = strategy.next_delay();
        assert_eq!(delay3, Duration::from_secs(8));
        assert_eq!(strategy.attempt_number(), 3);

        // Attempt 3: 2 * 2^3 = 16s
        let delay4 = strategy.next_delay();
        assert_eq!(delay4, Duration::from_secs(16));
        assert_eq!(strategy.attempt_number(), 4);
    }

    #[test]
    fn test_backoff_respects_max_cap() {
        let mut strategy =
            ReconnectStrategy::new(Duration::from_secs(10), 2.0, Duration::from_secs(50));
        strategy.set_jitter(false);

        // Keep calling next_delay until we exceed the cap
        let _d1 = strategy.next_delay(); // 10s
        let _d2 = strategy.next_delay(); // 20s
        let _d3 = strategy.next_delay(); // 40s
        let d4 = strategy.next_delay(); // Would be 80s, but capped at 50s

        assert_eq!(d4, Duration::from_secs(50));

        // Further attempts should stay at max
        let d5 = strategy.next_delay();
        assert_eq!(d5, Duration::from_secs(50));
    }

    #[test]
    fn test_reset() {
        let mut strategy = ReconnectStrategy::default_strategy();
        strategy.set_jitter(false);

        // Advance a few attempts
        let _ = strategy.next_delay();
        let _ = strategy.next_delay();
        let _ = strategy.next_delay();

        assert_eq!(strategy.attempt_number(), 3);
        assert!(strategy.current_delay() > Duration::from_secs(5));

        // Reset should bring us back to initial state
        strategy.reset();

        assert_eq!(strategy.attempt_number(), 0);
        assert_eq!(strategy.current_delay(), Duration::from_secs(5));
    }

    #[test]
    fn test_jitter_adds_randomness() {
        let mut strategy =
            ReconnectStrategy::new(Duration::from_secs(10), 2.0, Duration::from_secs(100));
        strategy.set_jitter(true);

        // Get multiple delays and check they're different (due to jitter)
        let delay1 = strategy.next_delay();

        strategy.reset();
        let delay2 = strategy.next_delay();

        strategy.reset();
        let delay3 = strategy.next_delay();

        // All should be within ±20% of base delay (8s to 12s)
        assert!(delay1.as_secs() >= 8 && delay1.as_secs() <= 12);
        assert!(delay2.as_secs() >= 8 && delay2.as_secs() <= 12);
        assert!(delay3.as_secs() >= 8 && delay3.as_secs() <= 12);

        // At least one pair should be different (very high probability with jitter)
        assert!(delay1 != delay2 || delay2 != delay3 || delay1 != delay3);
    }

    #[test]
    fn test_jitter_can_be_disabled() {
        let mut strategy =
            ReconnectStrategy::new(Duration::from_secs(5), 2.0, Duration::from_secs(100));

        // Disable jitter
        strategy.set_jitter(false);

        // Multiple calls should return exact same value
        let delay1 = strategy.next_delay();
        strategy.reset();
        let delay2 = strategy.next_delay();
        strategy.reset();
        let delay3 = strategy.next_delay();

        assert_eq!(delay1, delay2);
        assert_eq!(delay2, delay3);
        assert_eq!(delay1, Duration::from_secs(5));
    }

    #[test]
    fn test_multiplier_of_1_5() {
        let mut strategy =
            ReconnectStrategy::new(Duration::from_secs(4), 1.5, Duration::from_secs(100));
        strategy.set_jitter(false);

        let d1 = strategy.next_delay();
        assert_eq!(d1, Duration::from_secs(4)); // 4

        let d2 = strategy.next_delay();
        assert_eq!(d2, Duration::from_secs(6)); // 4 * 1.5 = 6

        let d3 = strategy.next_delay();
        assert_eq!(d3, Duration::from_secs(9)); // 4 * 1.5^2 = 9
    }

    #[test]
    fn test_current_delay_getter() {
        let mut strategy = ReconnectStrategy::default_strategy();
        strategy.set_jitter(false);

        // Before any delays
        assert_eq!(strategy.current_delay(), Duration::from_secs(5));

        // After first delay
        let _ = strategy.next_delay();
        assert_eq!(strategy.current_delay(), Duration::from_secs(5));

        // After second delay
        let _ = strategy.next_delay();
        assert!(strategy.current_delay() > Duration::from_secs(5));
    }

    #[test]
    fn test_attempt_number_increments() {
        let mut strategy = ReconnectStrategy::default_strategy();

        assert_eq!(strategy.attempt_number(), 0);

        let _ = strategy.next_delay();
        assert_eq!(strategy.attempt_number(), 1);

        let _ = strategy.next_delay();
        assert_eq!(strategy.attempt_number(), 2);

        let _ = strategy.next_delay();
        assert_eq!(strategy.attempt_number(), 3);
    }

    /// Build a minimal Config for snapshot tests without dragging in fixtures.
    fn cfg_with_reconnect(secs: u64) -> Config {
        use crate::config::{
            ClientConfig, DisplayConfig, PlaybackConfig, ServerConfig, SystemConfig,
        };
        use std::path::PathBuf;
        Config {
            server: ServerConfig {
                url: "http://localhost:3000".to_string(),
                api_key: None,
                reconnect_interval: secs,
                heartbeat_interval: 30,
                ca_cert_path: None,
                tls_skip_verify: false,
            },
            client: ClientConfig {
                id: "00000000-0000-0000-0000-000000000000".to_string(),
                name: "test".to_string(),
                preview_interval_secs: 10,
                status_interval_secs: 10,
                telemetry_interval_secs: 60,
            },
            playback: PlaybackConfig {
                default_image_duration: 5,
                loop_playlist: true,
                media_cache_dir: PathBuf::from("./cache"),
                max_cache_size_mb: 5000,
                preload_next_items: 2,
                preload_bytes_budget: None,
                offline_fallback_grace_secs: 5,
            },
            system: SystemConfig {
                auto_start: false,
                auto_update: false,
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
                enable_subtitles: false,
                preferred_subtitle_language: None,
                subtitle_font_size: None,
            },
            config_path: None,
        }
    }

    #[test]
    fn snapshot_swap_changes_base_delay_on_next_call() {
        let snap = Arc::new(ArcSwap::from_pointee(cfg_with_reconnect(2)));
        let mut strategy =
            ReconnectStrategy::new(Duration::from_secs(99), 2.0, Duration::from_secs(300))
                .with_cfg_snap(snap.clone());
        strategy.set_jitter(false);

        // First call: snapshot says 2 → 2s base. The constructor's 99 is ignored.
        assert_eq!(strategy.next_delay(), Duration::from_secs(2));

        // Hot-swap to 10s. Reset attempt count so the next call reads fresh
        // base directly without the exponential multiplier kicking in.
        snap.store(Arc::new(cfg_with_reconnect(10)));
        strategy.reset();

        // Next call uses the new base from the snapshot.
        assert_eq!(strategy.next_delay(), Duration::from_secs(10));
    }

    #[test]
    fn snapshot_absent_uses_constructor_base_delay() {
        // No snapshot wired → falls back to the value passed to new().
        let mut strategy =
            ReconnectStrategy::new(Duration::from_secs(7), 2.0, Duration::from_secs(300));
        strategy.set_jitter(false);

        assert_eq!(strategy.next_delay(), Duration::from_secs(7));
    }
}
