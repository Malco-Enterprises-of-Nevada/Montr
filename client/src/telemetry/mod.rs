//! Periodic system telemetry collection and reporting.
//!
//! Samples sysinfo (CPU, memory, disks, temperatures), reads mpv health from
//! the playback engine, and pushes a `TelemetryMessage` to the server every
//! 60 seconds. Mirrors the structure of `crate::status::reporter`.

pub mod collector;
pub mod reporter;

pub use collector::{collect_sample, TelemetrySample};
pub use reporter::TelemetryReporter;
