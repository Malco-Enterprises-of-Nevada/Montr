//! Connection state machine for managing WebSocket connection lifecycle
//!
//! This module implements a state machine pattern to manage the various states
//! of the WebSocket connection, from initial connection through registration
//! and operation.

use crate::error::{MontrError, Result};
use std::fmt;
use std::time::{Duration, Instant};

/// Connection state machine
///
/// Manages the lifecycle of the WebSocket connection through well-defined states.
/// State transitions are validated to ensure the connection progresses correctly.
#[derive(Debug, Clone)]
pub struct ConnectionState {
    /// Current state
    current: State,

    /// Previous state (for rollback/debugging)
    previous: Option<State>,

    /// Timestamp of last state change
    last_transition: Instant,

    /// Number of reconnection attempts in current cycle
    reconnect_attempts: u32,
}

/// Connection states
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// Not connected to server
    Disconnected,

    /// Attempting to establish WebSocket connection
    Connecting,

    /// WebSocket connection established, but not yet registered
    Connected,

    /// Sent registration message, waiting for response
    Registering,

    /// Successfully registered with server
    Registered,

    /// Waiting for initial playlist assignment
    WaitingPlaylist,

    /// Fully operational with assigned playlist
    Operational,

    /// Error state (will attempt reconnection)
    Error { reason: ErrorReason },
}

/// Reason for error state
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorReason {
    /// Connection failed during establishment
    ConnectionFailed,

    /// Connection was lost after being established
    ConnectionLost,

    /// Registration was rejected by server
    RegistrationFailed,

    /// Timeout waiting for server response
    Timeout,

    /// Protocol error (invalid message)
    ProtocolError,

    /// Server explicitly closed connection
    ServerClosed,
}

impl ConnectionState {
    /// Create a new connection state (starts in Disconnected)
    pub fn new() -> Self {
        Self {
            current: State::Disconnected,
            previous: None,
            last_transition: Instant::now(),
            reconnect_attempts: 0,
        }
    }

    /// Get current state
    pub fn current(&self) -> State {
        self.current
    }

    /// Get previous state
    pub fn previous(&self) -> Option<State> {
        self.previous
    }

    /// Get time since last state transition
    pub fn time_in_state(&self) -> Duration {
        self.last_transition.elapsed()
    }

    /// Get reconnection attempt count
    pub fn reconnect_attempts(&self) -> u32 {
        self.reconnect_attempts
    }

    /// Check if currently connected (any state after Connecting)
    pub fn is_connected(&self) -> bool {
        matches!(
            self.current,
            State::Connected
                | State::Registering
                | State::Registered
                | State::WaitingPlaylist
                | State::Operational
        )
    }

    /// Check if operational (ready to use)
    pub fn is_operational(&self) -> bool {
        matches!(self.current, State::Operational)
    }

    /// Check if in error state
    pub fn is_error(&self) -> bool {
        matches!(self.current, State::Error { .. })
    }

    /// Transition to a new state
    ///
    /// Validates that the transition is allowed and updates internal tracking.
    pub fn transition(&mut self, new_state: State) -> Result<()> {
        // Validate transition
        if !self.is_valid_transition(&new_state) {
            return Err(MontrError::ProtocolError(format!(
                "Invalid state transition: {:?} -> {:?}",
                self.current, new_state
            )));
        }

        // Log transition
        tracing::info!(
            "Connection state: {:?} -> {:?} (after {:?})",
            self.current,
            new_state,
            self.time_in_state()
        );

        // Update state
        self.previous = Some(self.current);
        self.current = new_state;
        self.last_transition = Instant::now();

        // Reset reconnect counter on successful registration
        if matches!(new_state, State::Registered) {
            self.reconnect_attempts = 0;
        }

        Ok(())
    }

    /// Transition to error state
    pub fn transition_to_error(&mut self, reason: ErrorReason) {
        tracing::error!(
            "Connection error: {:?} (from state {:?})",
            reason,
            self.current
        );

        self.previous = Some(self.current);
        self.current = State::Error { reason };
        self.last_transition = Instant::now();
        self.reconnect_attempts += 1;
    }

    /// Reset to disconnected state (for reconnection)
    pub fn reset(&mut self) {
        self.previous = Some(self.current);
        self.current = State::Disconnected;
        self.last_transition = Instant::now();
    }

    /// Check if transition to new state is valid
    fn is_valid_transition(&self, new_state: &State) -> bool {
        use State::*;

        match (&self.current, new_state) {
            // From Disconnected
            (Disconnected, Connecting) => true,

            // From Connecting
            (Connecting, Connected) => true,
            (Connecting, Error { .. }) => true,

            // From Connected
            (Connected, Registering) => true,
            (Connected, Error { .. }) => true,

            // From Registering
            (Registering, Registered) => true,
            (Registering, Error { .. }) => true,

            // From Registered
            (Registered, WaitingPlaylist) => true,
            (Registered, Operational) => true, // Direct to operational if playlist already assigned
            (Registered, Error { .. }) => true,

            // From WaitingPlaylist
            (WaitingPlaylist, Operational) => true,
            (WaitingPlaylist, Error { .. }) => true,

            // From Operational
            (Operational, WaitingPlaylist) => true, // Playlist cleared
            (Operational, Operational) => true,     // Playlist updated
            (Operational, Error { .. }) => true,

            // From Error
            (Error { .. }, Disconnected) => true, // Preparing to reconnect
            (Error { .. }, Connecting) => true,   // Reconnecting

            // Same state is always valid (idempotent)
            (current, new) if current == new => true,

            // All other transitions are invalid
            _ => false,
        }
    }
}

impl Default for ConnectionState {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Display for State {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            State::Disconnected => write!(f, "Disconnected"),
            State::Connecting => write!(f, "Connecting"),
            State::Connected => write!(f, "Connected"),
            State::Registering => write!(f, "Registering"),
            State::Registered => write!(f, "Registered"),
            State::WaitingPlaylist => write!(f, "Waiting for Playlist"),
            State::Operational => write!(f, "Operational"),
            State::Error { reason } => write!(f, "Error: {:?}", reason),
        }
    }
}

impl fmt::Display for ErrorReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ErrorReason::ConnectionFailed => write!(f, "Connection Failed"),
            ErrorReason::ConnectionLost => write!(f, "Connection Lost"),
            ErrorReason::RegistrationFailed => write!(f, "Registration Failed"),
            ErrorReason::Timeout => write!(f, "Timeout"),
            ErrorReason::ProtocolError => write!(f, "Protocol Error"),
            ErrorReason::ServerClosed => write!(f, "Server Closed"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;

    #[test]
    fn test_initial_state() {
        let state = ConnectionState::new();
        assert_eq!(state.current(), State::Disconnected);
        assert_eq!(state.previous(), None);
        assert_eq!(state.reconnect_attempts(), 0);
        assert!(!state.is_connected());
        assert!(!state.is_operational());
        assert!(!state.is_error());
    }

    #[test]
    fn test_valid_transition_disconnected_to_connecting() {
        let mut state = ConnectionState::new();
        let result = state.transition(State::Connecting);
        assert!(result.is_ok());
        assert_eq!(state.current(), State::Connecting);
        assert_eq!(state.previous(), Some(State::Disconnected));
    }

    #[test]
    fn test_valid_transition_connecting_to_connected() {
        let mut state = ConnectionState::new();
        state.transition(State::Connecting).unwrap();
        let result = state.transition(State::Connected);
        assert!(result.is_ok());
        assert_eq!(state.current(), State::Connected);
        assert!(state.is_connected());
    }

    #[test]
    fn test_valid_full_lifecycle() {
        let mut state = ConnectionState::new();

        // Full happy path
        state.transition(State::Connecting).unwrap();
        state.transition(State::Connected).unwrap();
        state.transition(State::Registering).unwrap();
        state.transition(State::Registered).unwrap();
        state.transition(State::WaitingPlaylist).unwrap();
        state.transition(State::Operational).unwrap();

        assert_eq!(state.current(), State::Operational);
        assert!(state.is_operational());
        assert!(state.is_connected());
    }

    #[test]
    fn test_invalid_transition() {
        let mut state = ConnectionState::new();

        // Can't go directly from Disconnected to Operational
        let result = state.transition(State::Operational);
        assert!(result.is_err());
        assert_eq!(state.current(), State::Disconnected); // State unchanged
    }

    #[test]
    fn test_transition_to_error() {
        let mut state = ConnectionState::new();
        state.transition(State::Connecting).unwrap();

        state.transition_to_error(ErrorReason::ConnectionFailed);

        assert!(state.is_error());
        assert_eq!(
            state.current(),
            State::Error {
                reason: ErrorReason::ConnectionFailed
            }
        );
        assert_eq!(state.previous(), Some(State::Connecting));
        assert_eq!(state.reconnect_attempts(), 1);
    }

    #[test]
    fn test_reconnect_attempts_increment() {
        let mut state = ConnectionState::new();

        state.transition_to_error(ErrorReason::ConnectionFailed);
        assert_eq!(state.reconnect_attempts(), 1);

        state.reset();
        state.transition(State::Connecting).unwrap();
        state.transition_to_error(ErrorReason::ConnectionLost);
        assert_eq!(state.reconnect_attempts(), 2);
    }

    #[test]
    fn test_reconnect_attempts_reset_on_registration() {
        let mut state = ConnectionState::new();

        // Build up some failed attempts
        state.transition_to_error(ErrorReason::ConnectionFailed);
        state.transition_to_error(ErrorReason::ConnectionFailed);
        assert_eq!(state.reconnect_attempts(), 2);

        // Successful connection and registration should reset
        state.reset();
        state.transition(State::Connecting).unwrap();
        state.transition(State::Connected).unwrap();
        state.transition(State::Registering).unwrap();
        state.transition(State::Registered).unwrap();

        assert_eq!(state.reconnect_attempts(), 0);
    }

    #[test]
    fn test_time_in_state() {
        let mut state = ConnectionState::new();

        sleep(Duration::from_millis(100));

        let elapsed = state.time_in_state();
        assert!(elapsed >= Duration::from_millis(100));
        assert!(elapsed < Duration::from_millis(200));

        state.transition(State::Connecting).unwrap();

        // After transition, time should be reset
        let new_elapsed = state.time_in_state();
        assert!(new_elapsed < Duration::from_millis(50));
    }

    #[test]
    fn test_reset() {
        let mut state = ConnectionState::new();
        state.transition(State::Connecting).unwrap();
        state.transition(State::Connected).unwrap();

        state.reset();

        assert_eq!(state.current(), State::Disconnected);
        assert_eq!(state.previous(), Some(State::Connected));
    }

    #[test]
    fn test_is_connected_states() {
        let mut state = ConnectionState::new();

        assert!(!state.is_connected());

        state.transition(State::Connecting).unwrap();
        assert!(!state.is_connected()); // Not yet connected

        state.transition(State::Connected).unwrap();
        assert!(state.is_connected());

        state.transition(State::Registering).unwrap();
        assert!(state.is_connected());

        state.transition(State::Registered).unwrap();
        assert!(state.is_connected());

        state.transition(State::WaitingPlaylist).unwrap();
        assert!(state.is_connected());

        state.transition(State::Operational).unwrap();
        assert!(state.is_connected());
    }

    #[test]
    fn test_operational_only_when_operational() {
        let mut state = ConnectionState::new();

        state.transition(State::Connecting).unwrap();
        assert!(!state.is_operational());

        state.transition(State::Connected).unwrap();
        assert!(!state.is_operational());

        state.transition(State::Registering).unwrap();
        state.transition(State::Registered).unwrap();
        state.transition(State::WaitingPlaylist).unwrap();
        assert!(!state.is_operational());

        state.transition(State::Operational).unwrap();
        assert!(state.is_operational());
    }

    #[test]
    fn test_state_display() {
        assert_eq!(format!("{}", State::Disconnected), "Disconnected");
        assert_eq!(format!("{}", State::Connecting), "Connecting");
        assert_eq!(format!("{}", State::Operational), "Operational");

        let error_state = State::Error {
            reason: ErrorReason::ConnectionLost,
        };
        assert!(format!("{}", error_state).contains("Error"));
    }

    #[test]
    fn test_error_reason_display() {
        assert_eq!(
            format!("{}", ErrorReason::ConnectionFailed),
            "Connection Failed"
        );
        assert_eq!(
            format!("{}", ErrorReason::RegistrationFailed),
            "Registration Failed"
        );
    }

    #[test]
    fn test_idempotent_transitions() {
        let mut state = ConnectionState::new();
        state.transition(State::Connecting).unwrap();

        // Transitioning to same state should be valid
        let result = state.transition(State::Connecting);
        assert!(result.is_ok());
        assert_eq!(state.current(), State::Connecting);
    }

    #[test]
    fn test_error_state_recovery() {
        let mut state = ConnectionState::new();
        state.transition(State::Connecting).unwrap();
        state.transition_to_error(ErrorReason::Timeout);

        assert!(state.is_error());

        // Should be able to reset and reconnect
        state.transition(State::Disconnected).unwrap();
        state.transition(State::Connecting).unwrap();

        assert!(!state.is_error());
    }
}
