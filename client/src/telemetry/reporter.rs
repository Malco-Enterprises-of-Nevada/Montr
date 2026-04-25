//! Periodic telemetry reporter
//!
//! Spawns a tokio task that fires every `interval_secs`, builds a telemetry
//! sample (CPU/mem/disk/temps/net/mpv), and pushes it through the existing
//! WebSocket sender as a `ClientMessage::Telemetry` variant.
//!
//! Mirrors `crate::status::reporter::StatusReporter` so the patterns line up.

use crate::config::Config;
use crate::error::Result;
use crate::network::protocol::ClientMessage;
use crate::network::websocket::WebSocketClient;
use crate::playback::engine::PlaybackEngine;
use crate::state::AppState;
use crate::telemetry::collector::{collect_sample, TelemetryStateSnapshot};
use arc_swap::ArcSwap;
use std::sync::Arc;
use sysinfo::System;
use tokio::sync::{mpsc, Mutex, Notify};
use tokio::time::{sleep, Duration};
use tokio_util::sync::CancellationToken;

/// Default cadence for telemetry samples (once per minute).
pub const DEFAULT_TELEMETRY_INTERVAL_SECS: u64 = 60;

/// Periodic system telemetry reporter.
pub struct TelemetryReporter {
    state: Arc<AppState>,
    ws_tx: mpsc::UnboundedSender<ClientMessage>,
    ws_client: Arc<WebSocketClient>,
    playback_engine: Arc<PlaybackEngine>,
    cancel_token: CancellationToken,
    /// Fallback interval when no `cfg_snap` is wired (tests).
    interval_secs: u64,
    /// Shared config snapshot — when present, the loop reads
    /// `client.telemetry_interval_secs` from this on every tick.
    cfg_snap: Option<Arc<ArcSwap<Config>>>,
    /// Wake source so SIGHUP reload interrupts the current sleep.
    config_changed: Option<Arc<Notify>>,
    /// Long-lived sysinfo handle. Held across ticks so CPU% has a baseline.
    sys: Arc<Mutex<System>>,
}

impl TelemetryReporter {
    pub fn new(
        state: Arc<AppState>,
        ws_tx: mpsc::UnboundedSender<ClientMessage>,
        ws_client: Arc<WebSocketClient>,
        playback_engine: Arc<PlaybackEngine>,
        interval_secs: u64,
        cancel_token: CancellationToken,
    ) -> Self {
        Self {
            state,
            ws_tx,
            ws_client,
            playback_engine,
            cancel_token,
            interval_secs,
            cfg_snap: None,
            config_changed: None,
            sys: Arc::new(Mutex::new(System::new())),
        }
    }

    /// Wire the shared config snapshot + reload notifier. After this, the
    /// task ignores the construction-time `interval_secs` and reads
    /// `client.telemetry_interval_secs` from the snapshot every tick.
    pub fn with_cfg_snap(
        mut self,
        cfg_snap: Arc<ArcSwap<Config>>,
        config_changed: Arc<Notify>,
    ) -> Self {
        self.cfg_snap = Some(cfg_snap);
        self.config_changed = Some(config_changed);
        self
    }

    fn current_interval(&self) -> u64 {
        match self.cfg_snap.as_ref() {
            Some(snap) => snap.load().client.telemetry_interval_secs,
            None => self.interval_secs,
        }
    }

    /// Spawn the telemetry sampling loop. Returns the JoinHandle so the
    /// caller can include it in the shutdown set.
    pub fn start(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        let cancel_token = self.cancel_token.clone();
        let config_changed = self.config_changed.clone();

        tokio::spawn(async move {
            tracing::info!(
                "Telemetry task started (initial interval: {}s)",
                self.current_interval()
            );

            loop {
                let next = Duration::from_secs(self.current_interval().max(1));
                let notify_fut = async {
                    match config_changed.as_ref() {
                        Some(n) => n.notified().await,
                        None => std::future::pending().await,
                    }
                };
                tokio::select! {
                    _ = cancel_token.cancelled() => {
                        tracing::info!("Telemetry task shutting down");
                        break;
                    }
                    _ = notify_fut => continue,
                    _ = sleep(next) => {
                        if let Err(e) = self.send_one().await {
                            tracing::warn!("Failed to send telemetry: {}", e);
                        }
                    }
                }
            }
        })
    }

    /// Build one sample and push it through the WS sender. Public so unit
    /// tests can drive a single tick without spinning a real timer.
    pub async fn send_one(&self) -> Result<()> {
        let client_id = self.state.client_id().await;
        let ws_reconnects = self.ws_client.reconnect_attempts().await;
        let snap = TelemetryStateSnapshot::from_app_state_with_engine(
            &self.state,
            ws_reconnects,
            &self.playback_engine,
        )
        .await;
        let mpv_health = self.playback_engine.query_health_stats().await;

        let sample = {
            let mut sys = self.sys.lock().await;
            collect_sample(&mut sys, &snap, mpv_health)
        };

        let message = ClientMessage::telemetry(
            client_id,
            sample.cpu_pct,
            sample.mem_used_mb,
            sample.mem_total_mb,
            sample.disks,
            sample.temps,
            sample.net,
            sample.mpv,
            sample.process,
        );

        self.ws_tx.send(message).map_err(|e| {
            crate::error::MontrError::WebSocketSend(format!("Telemetry send failed: {}", e))
        })?;

        tracing::trace!("Telemetry sent");
        Ok(())
    }
}
