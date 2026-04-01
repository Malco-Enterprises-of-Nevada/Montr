//! Reconnection strategy with exponential backoff
//!
//! Implements an exponential backoff algorithm with jitter for WebSocket reconnection.
//! This prevents thundering herd problems when multiple clients try to reconnect
//! to a server simultaneously.

use rand::Rng;
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
#[derive(Debug, Clone)]
pub struct ReconnectStrategy {
    /// Base delay for first reconnection attempt
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
    /// then increments the attempt counter.
    pub fn next_delay(&mut self) -> Duration {
        let base_duration = if self.attempt == 0 {
            // First attempt uses base delay
            self.base_delay
        } else {
            // Calculate exponential backoff
            let backoff_secs =
                self.base_delay.as_secs_f64() * self.multiplier.powi(self.attempt as i32);
            let backoff = Duration::from_secs_f64(backoff_secs.min(self.max_backoff.as_secs_f64()));
            backoff
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
        self.current_delay = self.base_delay;
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
}
