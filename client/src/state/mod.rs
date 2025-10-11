//! Application state management module
//!
//! Provides shared state and coordination between subsystems.

pub mod app_state;
pub mod coordinator;

pub use app_state::{AppState, StateSnapshot};
pub use coordinator::{CoordinatorMessage, PlaybackEventMessage, StateCoordinator};
