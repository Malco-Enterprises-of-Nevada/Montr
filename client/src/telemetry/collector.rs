//! Telemetry sample collection
//!
//! Builds a `TelemetrySample` from sysinfo + AppState + mpv health snapshot.
//! Pure data-only — no I/O or network. The reporter is responsible for sending.

use crate::network::protocol::{
    TelemetryDiskSample, TelemetryMpvSample, TelemetryNetSample, TelemetryProcessSample,
    TelemetryTempSample,
};
use crate::playback::engine::MpvHealthStats;
use crate::state::AppState;
use sysinfo::{Components, Disks, System};

/// In-memory snapshot built per tick. Mirrors the wire-format `TelemetryMessage`
/// fields one-to-one so the reporter can hand it straight to the constructor.
#[derive(Debug, Clone)]
pub struct TelemetrySample {
    pub cpu_pct: f32,
    pub mem_used_mb: u64,
    pub mem_total_mb: u64,
    pub disks: Vec<TelemetryDiskSample>,
    pub temps: Vec<TelemetryTempSample>,
    pub net: TelemetryNetSample,
    pub mpv: TelemetryMpvSample,
    pub process: TelemetryProcessSample,
}

/// Build a single telemetry sample.
///
/// `sys` is held by the reporter across ticks so the CPU% calculation has a
/// previous-tick baseline. We refresh CPU and memory but rely on a fresh
/// `Disks` / `Components` instance per tick because the lists are typically
/// stable and the cost of re-listing is negligible.
pub fn collect_sample(
    sys: &mut System,
    state: &TelemetryStateSnapshot,
    mpv: MpvHealthStats,
) -> TelemetrySample {
    sys.refresh_cpu();
    sys.refresh_memory();

    let cpu_pct = sys.global_cpu_info().cpu_usage();
    let mem_total_bytes = sys.total_memory();
    let mem_used_bytes = sys.used_memory();

    // Disks: a fresh list each tick keeps stale mounts out of the report.
    let disks_inst = Disks::new_with_refreshed_list();
    let disks = disks_inst
        .list()
        .iter()
        .map(|d| TelemetryDiskSample {
            mount: d.mount_point().display().to_string(),
            used_bytes: d.total_space().saturating_sub(d.available_space()),
            total_bytes: d.total_space(),
        })
        .collect();

    // Temperatures: best-effort. Empty on platforms without sensors exposed.
    let comps = Components::new_with_refreshed_list();
    let temps = comps
        .iter()
        .map(|c| TelemetryTempSample {
            label: c.label().to_string(),
            celsius: c.temperature(),
        })
        .collect();

    let net = TelemetryNetSample {
        ws_reconnects: state.ws_reconnects,
        last_rtt_ms: state.last_rtt_ms,
        bytes_dl_total: state.bytes_dl_total,
    };

    let process = TelemetryProcessSample {
        client_uptime_s: state.client_uptime_s,
        // Real mpv uptime when the engine was wired in; falls back to client
        // uptime as a conservative upper bound when the snapshot didn't carry
        // one (e.g. early in startup or in tests).
        mpv_uptime_s: state.mpv_uptime_s.unwrap_or(state.client_uptime_s),
        restart_count: state.mpv_restart_count,
    };

    TelemetrySample {
        cpu_pct,
        mem_used_mb: mem_used_bytes / 1_048_576,
        mem_total_mb: mem_total_bytes / 1_048_576,
        disks,
        temps,
        net,
        mpv: TelemetryMpvSample {
            alive: mpv.alive,
            dropped_frames: mpv.dropped_frames,
            last_decoder_error: mpv.last_decoder_error,
        },
        process,
    }
}

/// Async-friendly bundle of values plucked from AppState and the WS client
/// before entering `collect_sample`. Keeps `collect_sample` synchronous and
/// trivially testable without an Arc<AppState>.
#[derive(Debug, Clone, Default)]
pub struct TelemetryStateSnapshot {
    pub ws_reconnects: u32,
    pub last_rtt_ms: Option<u32>,
    pub bytes_dl_total: u64,
    pub client_uptime_s: u64,
    /// Real mpv uptime in seconds, sampled from the engine. `None` means
    /// the caller didn't have an engine handle (test fixtures, very early
    /// startup); collector falls back to `client_uptime_s` in that case.
    pub mpv_uptime_s: Option<u64>,
    pub mpv_restart_count: u32,
}

impl TelemetryStateSnapshot {
    /// Read all required values from `AppState` in one place.
    pub async fn from_app_state(state: &AppState, ws_reconnects: u32) -> Self {
        Self {
            ws_reconnects,
            last_rtt_ms: state.last_ws_rtt_ms().await,
            bytes_dl_total: state.bytes_downloaded_total().await,
            client_uptime_s: state.client_uptime_s().await,
            mpv_uptime_s: None,
            mpv_restart_count: state.mpv_restart_count().await,
        }
    }

    /// Same as `from_app_state` but additionally records `mpv_uptime_s` from
    /// the engine. Use this in production wiring; the no-engine variant
    /// stays for tests that don't construct a real engine.
    pub async fn from_app_state_with_engine(
        state: &AppState,
        ws_reconnects: u32,
        engine: &crate::playback::engine::PlaybackEngine,
    ) -> Self {
        Self {
            ws_reconnects,
            last_rtt_ms: state.last_ws_rtt_ms().await,
            bytes_dl_total: state.bytes_downloaded_total().await,
            client_uptime_s: state.client_uptime_s().await,
            mpv_uptime_s: Some(engine.mpv_uptime().as_secs()),
            mpv_restart_count: state.mpv_restart_count().await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_sample_returns_nonzero_memory() {
        let mut sys = System::new();
        let snap = TelemetryStateSnapshot::default();
        let mpv = MpvHealthStats::default();
        let sample = collect_sample(&mut sys, &snap, mpv);
        // Memory totals are always populated by sysinfo on supported platforms.
        assert!(sample.mem_total_mb > 0);
        assert!(sample.cpu_pct >= 0.0);
        // The default snapshot leaves net counters at zero.
        assert_eq!(sample.net.ws_reconnects, 0);
    }
}
