//! Periodic telemetry reporter
//!
//! Spawns a tokio task that fires every `interval_secs`, builds a telemetry
//! sample (CPU/mem/disk/temps/net/mpv), and pushes it through the existing
//! WebSocket sender as a `ClientMessage::Telemetry` variant.
//!
//! Mirrors `crate::status::reporter::StatusReporter` so the patterns line up.

use crate::error::Result;
use crate::network::protocol::ClientMessage;
use crate::network::websocket::WebSocketClient;
use crate::playback::engine::PlaybackEngine;
use crate::state::AppState;
use crate::telemetry::collector::{collect_sample, TelemetryStateSnapshot};
use std::sync::Arc;
use sysinfo::System;
use tokio::sync::{mpsc, Mutex};
use tokio::time::{interval, Duration};
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
    interval_secs: u64,
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
            sys: Arc::new(Mutex::new(System::new())),
        }
    }

    /// Spawn the telemetry sampling loop. Returns the JoinHandle so the
    /// caller can include it in the shutdown set.
    pub fn start(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        let cancel_token = self.cancel_token.clone();

        tokio::spawn(async move {
            let mut interval = interval(Duration::from_secs(self.interval_secs));
            // Skip the initial tick — interval fires immediately on first poll.
            interval.tick().await;

            tracing::info!("Telemetry task started (interval: {}s)", self.interval_secs);

            loop {
                tokio::select! {
                    _ = cancel_token.cancelled() => {
                        tracing::info!("Telemetry task shutting down");
                        break;
                    }
                    _ = interval.tick() => {
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
        let snap = TelemetryStateSnapshot::from_app_state(&self.state, ws_reconnects).await;
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
