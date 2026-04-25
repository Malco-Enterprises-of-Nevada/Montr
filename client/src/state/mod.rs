//! Application state management module
//!
//! Provides shared state and coordination between subsystems.

pub mod app_state;
pub mod coordinator;
pub mod persistence;
pub mod schedule_eval;

pub use app_state::{AppState, StateSnapshot};
pub use coordinator::{CoordinatorMessage, PlaybackEventMessage, StateCoordinator};
pub use schedule_eval::{is_active, select_active_schedule};
