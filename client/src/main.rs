use montr_client::{config, error::Result, logging};

#[tokio::main]
async fn main() -> Result<()> {
    // Step 1: Parse CLI arguments (must be first, synchronous)
    let args = config::CliArgs::parse_args();

    // Step 1.5: Handle --setup interactive wizard
    if args.setup {
        if let Err(e) = run_setup(&args) {
            eprintln!("Setup failed: {}", e);
            std::process::exit(1);
        }
    }

    // Step 2: Load configuration from file (synchronous, before logging)
    let loader = config::ConfigLoader::new(args.config.clone());
    let mut cfg = match loader.load() {
        Ok(config) => config,
        Err(montr_client::error::MontrError::ConfigNotFound { locations }) => {
            let config_path = config::ConfigLoader::get_default_config_path();
            match config::ConfigLoader::generate_default_config(&config_path) {
                Ok(()) => {
                    eprintln!("No config file found (searched: {})", locations.join(", "));
                    eprintln!();
                    eprintln!("Created default config at: {}", config_path.display());
                    eprintln!("Edit the server URL and restart, or use --setup for guided setup.");
                    std::process::exit(0);
                }
                Err(e) => {
                    eprintln!("Configuration error: no config file found");
                    eprintln!("Searched: {}", locations.join(", "));
                    eprintln!("Failed to generate default config: {}", e);
                    std::process::exit(1);
                }
            }
        }
        Err(e) => {
            eprintln!("Configuration error: {}", e);
            std::process::exit(1);
        }
    };

    // Step 3: Apply CLI overrides to configuration
    if let Err(e) = loader.apply_overrides(&mut cfg, &args) {
        eprintln!("Configuration override error: {}", e);
        std::process::exit(1);
    }

    // Step 4: Initialize logging (synchronous, must happen before async operations)
    if let Err(e) = logging::init_logging(&cfg) {
        eprintln!("Failed to initialize logging: {}", e);
        std::process::exit(1);
    }

    // Step 5: Log startup information
    logging::log_startup_info(&cfg);

    // Step 5.5: Check for updates
    match montr_client::update::check_and_update(cfg.system.auto_update).await {
        Ok(true) => {
            tracing::info!("Update applied, restarting...");
            match std::env::current_exe() {
                Ok(exe) => {
                    let args: Vec<String> = std::env::args().collect();
                    let err = exec::execvp(&exe, &args);
                    tracing::error!("Failed to restart after update: {}", err);
                    std::process::exit(1);
                }
                Err(e) => {
                    tracing::error!(
                        "Update applied but cannot determine current executable path ({}); continuing on existing process — manual restart recommended",
                        e
                    );
                }
            }
        }
        Ok(false) => {}
        Err(e) => tracing::warn!("Update check failed (continuing): {}", e),
    }

    // Step 6: Run the async client application
    if let Err(e) = run_client(cfg).await {
        tracing::error!("Client error: {:?}", e);
        std::process::exit(1);
    }

    tracing::info!("Client terminated successfully");
    Ok(())
}

/// Main client loop
///
/// Initializes all subsystems and runs until shutdown signal.
async fn run_client(config: config::Config) -> Result<()> {
    use arc_swap::ArcSwap;
    use montr_client::{
        cache::{CacheManager, LruCacheManager},
        logging::take_log_event_receiver,
        network::{
            protocol::{ClientCapabilities, ClientMessage},
            websocket::WebSocketClient,
            HttpClient,
        },
        playback::engine::PlaybackEngine,
        state::{app_state::AppState, coordinator::StateCoordinator},
        status::StatusReporter,
        telemetry::TelemetryReporter,
    };
    use std::sync::Arc;
    use tokio::sync::{mpsc, Notify};
    use tokio_util::sync::CancellationToken;

    tracing::info!("Initializing Montr client...");

    // Atomic snapshot of the current config + a notifier woken by SIGHUP
    // after a successful reload. Subsystems clone both and read the snapshot
    // each work cycle so reload-safe field changes take effect without a
    // restart. Initial value is the config loaded at startup.
    let cfg_snap = Arc::new(ArcSwap::from_pointee(config.clone()));
    let config_changed = Arc::new(Notify::new());

    // Create cancellation token for graceful shutdown
    let cancel_token = CancellationToken::new();
    let cancel_token_signal = cancel_token.clone();

    // Spawn signal handler (SIGINT + SIGTERM on Unix, SIGINT only on other platforms)
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::SignalKind;
            match tokio::signal::unix::signal(SignalKind::terminate()) {
                Ok(mut sigterm) => {
                    tokio::select! {
                        result = tokio::signal::ctrl_c() => {
                            match result {
                                Ok(()) => tracing::info!("Received shutdown signal (SIGINT)"),
                                Err(e) => tracing::error!("Failed to listen for SIGINT: {}", e),
                            }
                        }
                        _ = sigterm.recv() => {
                            tracing::info!("Received shutdown signal (SIGTERM)");
                        }
                    }
                }
                Err(e) => {
                    tracing::error!(
                        "Failed to register SIGTERM handler ({}); falling back to SIGINT only",
                        e
                    );
                    match tokio::signal::ctrl_c().await {
                        Ok(()) => tracing::info!("Received shutdown signal (SIGINT)"),
                        Err(e) => tracing::error!("Failed to listen for SIGINT: {}", e),
                    }
                }
            }
        }
        #[cfg(not(unix))]
        {
            match tokio::signal::ctrl_c().await {
                Ok(()) => tracing::info!("Received shutdown signal (Ctrl+C)"),
                Err(e) => tracing::error!("Failed to listen for shutdown signal: {}", e),
            }
        }
        cancel_token_signal.cancel();
    });

    // SIGHUP handler — Unix only. Re-reads the config file, atomically swaps
    // the snapshot pointer subsystems read from, and wakes them via Notify.
    // Reload-safe fields take effect on the next iteration of each subsystem's
    // loop. Restart-required field changes are reported via a warning so the
    // operator sees what didn't take effect.
    #[cfg(unix)]
    {
        let cancel_token_hup = cancel_token.clone();
        let cfg_snap_hup = cfg_snap.clone();
        let config_changed_hup = config_changed.clone();
        let initial_cfg = config.clone();
        tokio::spawn(async move {
            use tokio::signal::unix::SignalKind;
            let mut sighup = match tokio::signal::unix::signal(SignalKind::hangup()) {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!("SIGHUP handler not registered ({}): hot-reload disabled", e);
                    return;
                }
            };

            let Some(config_path) = initial_cfg.config_path.clone() else {
                tracing::warn!(
                    "SIGHUP handler started but no config path is known; hot-reload no-ops"
                );
                // Still drain SIGHUPs to avoid default-action terminate.
                loop {
                    tokio::select! {
                        _ = cancel_token_hup.cancelled() => return,
                        _ = sighup.recv() => {
                            tracing::warn!("Received SIGHUP but no config path; nothing to reload");
                        }
                    }
                }
            };

            tracing::info!("SIGHUP handler ready (config: {})", config_path.display());

            loop {
                tokio::select! {
                    _ = cancel_token_hup.cancelled() => return,
                    _ = sighup.recv() => {
                        tracing::info!("SIGHUP received; reloading {}", config_path.display());
                        let loader =
                            montr_client::config::ConfigLoader::new(Some(config_path.clone()));
                        let new_cfg = match loader.load() {
                            Ok(c) => c,
                            Err(e) => {
                                tracing::error!(
                                    "SIGHUP reload failed: {}. Keeping previous config.",
                                    e
                                );
                                continue;
                            }
                        };

                        // Snapshot the previous value so apply_safe_reload can
                        // diff against it; then publish the new one and wake
                        // subsystems before logging anything else.
                        let prev_arc = cfg_snap_hup.load_full();
                        cfg_snap_hup.store(Arc::new(new_cfg.clone()));
                        config_changed_hup.notify_waiters();
                        apply_safe_reload(&prev_arc, &new_cfg);
                    }
                }
            }
        });
    }

    // ========================================================================
    // Initialize HTTP Client
    // ========================================================================
    tracing::info!("Initializing HTTP client");
    let http_client = Arc::new(HttpClient::new(
        config.server.url.clone(),
        config.server.ca_cert_path.as_deref(),
        config.server.tls_skip_verify,
    )?);

    // ========================================================================
    // Initialize LRU Cache Manager
    // ========================================================================
    // Built before the download cache so the cache can pre-flight space
    // (`ensure_room_for`) against the LRU's quota before each new download.
    tracing::info!("Initializing LRU cache manager");
    let lru_manager = Arc::new(LruCacheManager::new(
        config.playback.max_cache_size_mb,
        config.playback.media_cache_dir.clone(),
        cancel_token.clone(),
    )?);
    lru_manager.init().await?;

    // Start LRU cleanup task
    let _lru_cleanup_handle = lru_manager.clone().start_cleanup_task();

    // ========================================================================
    // Initialize Cache Manager
    // ========================================================================
    tracing::info!("Initializing cache manager");
    let cache_manager = Arc::new(
        CacheManager::new(
            http_client.clone(),
            config.playback.media_cache_dir.clone(),
            cancel_token.clone(),
        )?
        .with_api_key(config.server.api_key.clone())
        .with_lru_manager(lru_manager.clone()),
    );
    cache_manager.init().await?;

    // ========================================================================
    // Initialize Application State
    // ========================================================================
    tracing::info!("Initializing application state");
    let app_state = Arc::new(AppState::new(
        config.client.id.clone(),
        config.client.name.clone(),
    ));

    // Now that AppState exists, give the cache manager a handle so it can
    // bump the bytes-downloaded telemetry counter after each download. We
    // rebuild it via clone-and-replace because CacheManager is held in an Arc.
    let cache_manager =
        Arc::new(CacheManager::clone(&cache_manager).with_app_state((*app_state).clone()));

    // ========================================================================
    // Initialize Playback Engine
    // ========================================================================
    tracing::info!("Initializing playback engine");
    let playback_engine = Arc::new(
        PlaybackEngine::new(
            cancel_token.clone(),
            config.display.fullscreen,
            config.display.screen_index,
        )?
        .with_cfg_snap(cfg_snap.clone()),
    );

    // Start playback event loop
    let playback_event_handle = {
        let engine = playback_engine.clone();
        tokio::spawn(async move {
            if let Err(e) = engine.run().await {
                tracing::error!("Playback engine error: {}", e);
            }
        })
    };

    // ========================================================================
    // Initialize WebSocket Client
    // ========================================================================
    tracing::info!("Initializing WebSocket client");
    let ws_client =
        Arc::new(WebSocketClient::new_with_cfg_snap(&config, Some(cfg_snap.clone())).await?);

    // Send registration message (and set it to auto-resend on reconnect)
    let capabilities = ClientCapabilities {
        video: true,
        image: true,
    };

    let register_msg = ClientMessage::register(
        config.client.id.clone(),
        montr_client::VERSION.to_string(),
        capabilities,
        Some(config.client.name.clone()),
    );

    ws_client.set_on_connect(register_msg.clone()).await;
    ws_client.send(register_msg).await?;
    tracing::info!("Registered with server");

    // ========================================================================
    // Initialize State Coordinator
    // ========================================================================
    tracing::info!("Initializing state coordinator");

    // Channel for the coordinator (and other client-side tasks like the
    // storage-low watermark) to enqueue ClientMessage::Error reports. A
    // forwarder task (below) drains this into the WebSocket once the WS
    // client is constructed.
    let (coord_ws_tx, mut coord_ws_rx) = mpsc::unbounded_channel();
    let coord_ws_tx_for_storage = coord_ws_tx.clone();
    let coord_ws_tx_for_offline = coord_ws_tx.clone();

    // Channel for the coordinator to forward on-demand screenshot requests
    // to the screenshot task (below) which holds the engine + HTTP client.
    let (screenshot_tx, mut screenshot_rx) = mpsc::unbounded_channel::<String>();

    let coordinator = StateCoordinator::new(
        (*app_state).clone(),
        cache_manager.clone(),
        http_client.clone(),
        playback_engine.as_ref(),
        cancel_token.clone(),
        config.playback.preload_next_items,
        config.server.api_key.clone(),
    )
    .with_log_file(config.system.log_file.clone())
    .with_cache_dir(config.playback.media_cache_dir.clone())
    .with_subtitle_preferences(
        config.display.enable_subtitles,
        config.display.preferred_subtitle_language.clone(),
        config.display.subtitle_font_size,
    )
    .with_ws_sender(coord_ws_tx)
    .with_screenshot_sender(screenshot_tx)
    .with_playback_engine(playback_engine.clone())
    .with_preload_bytes_budget(config.playback.preload_bytes_budget)
    .with_cfg_snap(cfg_snap.clone());

    let coordinator_tx = coordinator.message_sender();
    let schedules_handle = coordinator.schedules_handle();

    // One-time migration: bring forward any legacy single-file playlist into
    // the per-id `playlists/{id}.json` layout used for offline schedule eval.
    if let Err(e) = montr_client::state::persistence::migrate_legacy_playlist_if_needed(
        &config.playback.media_cache_dir,
    )
    .await
    {
        tracing::warn!("Legacy playlist migration failed: {}", e);
    }

    // Hydrate the coordinator's schedules from disk so offline-eval can fire
    // on the very first tick after a restart, before the WS reconnects.
    {
        let stored =
            montr_client::state::persistence::load_schedules(&config.playback.media_cache_dir)
                .await
                .unwrap_or_default();
        if !stored.is_empty() {
            tracing::info!("Hydrated {} persisted schedule(s) at startup", stored.len());
            *schedules_handle.write().await = stored;
        }
    }

    // Start coordinator task
    let coordinator_handle = tokio::spawn(async move {
        if let Err(e) = coordinator.run().await {
            tracing::error!("Coordinator error: {}", e);
        }
    });

    // Spawn the offline-fallback grace-period task. After the configured
    // number of seconds, signal the coordinator to try restoring the
    // last-known playlist from disk; the coordinator no-ops if the server
    // already assigned a playlist in the meantime.
    if config.playback.offline_fallback_grace_secs > 0 {
        use montr_client::state::coordinator::CoordinatorMessage;
        let tx = coordinator_tx.clone();
        let cancel = cancel_token.clone();
        let grace = tokio::time::Duration::from_secs(config.playback.offline_fallback_grace_secs);
        tokio::spawn(async move {
            tokio::select! {
                _ = cancel.cancelled() => {}
                _ = tokio::time::sleep(grace) => {
                    if let Err(e) = tx.send(CoordinatorMessage::TryOfflineRestore) {
                        tracing::debug!("Grace-period restore signal failed: {}", e);
                    }
                }
            }
        });
    }

    // Bridge playback events to coordinator
    {
        let coordinator_tx = coordinator_tx.clone();
        let engine = playback_engine.clone();
        let cancel = cancel_token.clone();
        tokio::spawn(async move {
            use montr_client::state::coordinator::{CoordinatorMessage, PlaybackEventMessage};
            let mut event_rx = engine.subscribe_events().await;
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    Some(event) = event_rx.recv() => {
                        let msg = match event {
                            montr_client::playback::PlaybackEvent::EndFile => {
                                Some(PlaybackEventMessage::MediaFinished { media_id: 0 })
                            }
                            montr_client::playback::PlaybackEvent::PositionChanged { position } => {
                                Some(PlaybackEventMessage::PositionUpdate { position })
                            }
                            montr_client::playback::PlaybackEvent::Error { message } => {
                                Some(PlaybackEventMessage::Error { media_id: 0, error: message })
                            }
                            _ => None,
                        };
                        if let Some(m) = msg {
                            let _ = coordinator_tx.send(CoordinatorMessage::PlaybackEvent(m));
                        }
                    }
                }
            }
        });
    }

    // Start WebSocket message receiver task
    let ws_msg_handle = {
        let ws_client = ws_client.clone();
        let coordinator_tx = coordinator_tx.clone();
        let cancel_token = cancel_token.clone();

        tokio::spawn(async move {
            use montr_client::state::coordinator::CoordinatorMessage;

            loop {
                tokio::select! {
                    _ = cancel_token.cancelled() => {
                        tracing::info!("WebSocket receiver shutting down");
                        break;
                    }
                    Some(server_msg) = ws_client.recv() => {
                        tracing::debug!("Received server message: {:?}", server_msg);
                        if let Err(e) = coordinator_tx.send(CoordinatorMessage::ServerMessage(server_msg)) {
                            tracing::error!("Failed to send message to coordinator: {}", e);
                            break;
                        }
                    }
                }
            }
        })
    };

    // ========================================================================
    // Initialize Status Reporter
    // ========================================================================
    tracing::info!("Initializing Status reporter");

    // Create a channel for status reporter to send messages to WebSocket
    let (status_ws_tx, mut status_ws_rx) = mpsc::unbounded_channel();

    let status_reporter = Arc::new(
        StatusReporter::new(
            app_state.clone(),
            status_ws_tx,
            config.server.heartbeat_interval,
            config.client.status_interval_secs,
            cancel_token.clone(),
        )
        .with_cfg_snap(cfg_snap.clone(), config_changed.clone()),
    );

    // Forward status reporter messages to WebSocket
    let ws_client_for_status = ws_client.clone();
    let status_forward_handle = tokio::spawn(async move {
        while let Some(msg) = status_ws_rx.recv().await {
            if let Err(e) = ws_client_for_status.send(msg).await {
                tracing::error!("Failed to forward status message: {}", e);
            }
        }
    });

    // Forward coordinator client_error reports to WebSocket
    let ws_client_for_coord = ws_client.clone();
    let coord_forward_handle = tokio::spawn(async move {
        while let Some(msg) = coord_ws_rx.recv().await {
            if let Err(e) = ws_client_for_coord.send(msg).await {
                tracing::warn!("Failed to forward coordinator error report: {}", e);
            }
        }
    });

    // Start reporter tasks
    let (heartbeat_handle, status_handle) = status_reporter.start();

    // ========================================================================
    // Initialize Telemetry Reporter (60s system metrics)
    // ========================================================================
    tracing::info!("Initializing telemetry reporter");
    let (telemetry_ws_tx, mut telemetry_ws_rx) = mpsc::unbounded_channel();

    let telemetry_reporter = Arc::new(
        TelemetryReporter::new(
            app_state.clone(),
            telemetry_ws_tx,
            ws_client.clone(),
            playback_engine.clone(),
            config.client.telemetry_interval_secs,
            cancel_token.clone(),
        )
        .with_cfg_snap(cfg_snap.clone(), config_changed.clone()),
    );

    let ws_client_for_telemetry = ws_client.clone();
    let _telemetry_forward_handle = tokio::spawn(async move {
        while let Some(msg) = telemetry_ws_rx.recv().await {
            if let Err(e) = ws_client_for_telemetry.send(msg).await {
                tracing::error!("Failed to forward telemetry message: {}", e);
            }
        }
    });

    let _telemetry_handle = telemetry_reporter.start();

    // ========================================================================
    // Log Event Forwarder (auto-pushed WARN/ERROR lines)
    // ========================================================================
    if let Some(mut log_rx) = take_log_event_receiver() {
        let ws_client_for_logs = ws_client.clone();
        let client_id_for_logs = config.client.id.clone();
        let cancel_for_logs = cancel_token.clone();
        let _log_forward_handle = tokio::spawn(async move {
            tracing::info!("Log event forwarder started");
            loop {
                tokio::select! {
                    _ = cancel_for_logs.cancelled() => break,
                    Some(ev) = log_rx.recv() => {
                        let msg = ClientMessage::log_event(
                            client_id_for_logs.clone(),
                            ev.level.to_string(),
                            ev.target,
                            ev.message,
                        );
                        if let Err(e) = ws_client_for_logs.send(msg).await {
                            tracing::trace!("Failed to forward log event: {}", e);
                        }
                    }
                    else => break,
                }
            }
        });
    } else {
        tracing::warn!("Log event channel was not installed; logs will not be auto-pushed");
    }

    // ========================================================================
    // Preview Screenshot Task
    // ========================================================================
    // Interval is read live from `cfg_snap` on every tick so SIGHUP can adjust
    // the cadence (or disable capture entirely by setting it to 0) without a
    // restart. `server.url`, `client.id`, and `server.api_key` are still
    // captured at construction — those changes remain restart-required.
    const PREVIEW_MAX_BYTES: usize = 5 * 1024 * 1024; // matches server /api/clients/:id/preview limit
    let preview_engine = playback_engine.clone();
    let preview_cancel = cancel_token.clone();
    let preview_server_url = config.server.url.clone();
    let preview_client_id = config.client.id.clone();
    let preview_api_key = config.server.api_key.clone();
    let preview_cfg = cfg_snap.clone();
    let preview_notify = config_changed.clone();
    let preview_handle = tokio::spawn(async move {
        let screenshot_path = std::env::temp_dir()
            .join(format!("montr-preview-{}.jpg", std::process::id()))
            .to_string_lossy()
            .to_string();
        let client = reqwest::Client::new();

        tracing::info!(
            "Preview capture task started (initial interval: {}s)",
            preview_cfg.load().client.preview_interval_secs
        );

        loop {
            let secs = preview_cfg.load().client.preview_interval_secs;
            // Setting the field to 0 disables capture — sleep until SIGHUP
            // either changes it back or the cancel token fires.
            if secs == 0 {
                tokio::select! {
                    _ = preview_cancel.cancelled() => {
                        tracing::info!("Preview capture task shutting down");
                        let _ = std::fs::remove_file(&screenshot_path);
                        return;
                    }
                    _ = preview_notify.notified() => continue,
                }
            }

            tokio::select! {
                _ = preview_cancel.cancelled() => {
                    tracing::info!("Preview capture task shutting down");
                    let _ = std::fs::remove_file(&screenshot_path);
                    return;
                }
                _ = preview_notify.notified() => {
                    // SIGHUP: re-read interval on next loop iteration.
                    continue;
                }
                _ = tokio::time::sleep(tokio::time::Duration::from_secs(secs)) => {
                    // Remove any stale capture so we never upload a previous frame
                    // if the upcoming screenshot call silently fails.
                    let _ = std::fs::remove_file(&screenshot_path);

                    // Take screenshot via mpv IPC
                    if let Err(e) = preview_engine.screenshot(&screenshot_path).await {
                        tracing::trace!("Screenshot capture skipped: {}", e);
                        continue;
                    }

                    // Wait briefly for file to be written
                    tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

                    let data = match tokio::fs::read(&screenshot_path).await {
                        Ok(d) => d,
                        Err(_) => continue, // file not ready or missing
                    };

                    if data.len() > PREVIEW_MAX_BYTES {
                        tracing::warn!(
                            "Preview {} bytes exceeds server limit ({} bytes), skipping",
                            data.len(),
                            PREVIEW_MAX_BYTES
                        );
                        let _ = std::fs::remove_file(&screenshot_path);
                        continue;
                    }

                    let part = match reqwest::multipart::Part::bytes(data)
                        .file_name("preview.jpg")
                        .mime_str("image/jpeg")
                    {
                        Ok(p) => p,
                        Err(e) => {
                            tracing::error!("Failed to build preview mime part: {}", e);
                            continue;
                        }
                    };
                    let form = reqwest::multipart::Form::new().part("preview", part);

                    let url = format!(
                        "{}/api/clients/{}/preview",
                        preview_server_url, preview_client_id
                    );
                    let mut req = client.post(&url).multipart(form);
                    if let Some(ref key) = preview_api_key {
                        req = req.header("X-API-Key", key);
                    }
                    match req.send().await {
                        Ok(resp) if resp.status().is_success() => {
                            tracing::trace!("Preview uploaded");
                        }
                        Ok(resp) => {
                            tracing::trace!("Preview upload rejected: {}", resp.status());
                        }
                        Err(e) => {
                            tracing::trace!("Preview upload failed: {}", e);
                        }
                    }

                    // Delete after attempt (success or failure) so next tick starts clean
                    let _ = std::fs::remove_file(&screenshot_path);
                }
            }
        }
    });

    // ========================================================================
    // On-Demand Screenshot Task (admin-triggered "capture now")
    // ========================================================================
    // Drains the screenshot_rx channel — coordinator pushes a request_id here
    // whenever the server sends a `command: "screenshot"` message. We capture
    // via mpv to a unique temp file (so concurrent requests don't clobber each
    // other), upload via http_client.upload_preview() with X-Request-Id, and
    // clean up on every exit path.
    let screenshot_engine = playback_engine.clone();
    let screenshot_http = http_client.clone();
    let screenshot_cancel = cancel_token.clone();
    let screenshot_client_id = config.client.id.clone();
    let screenshot_api_key = config.server.api_key.clone();
    let screenshot_handle = tokio::spawn(async move {
        const SCREENSHOT_MAX_BYTES: usize = 5 * 1024 * 1024;
        tracing::info!("On-demand screenshot task started");
        loop {
            tokio::select! {
                _ = screenshot_cancel.cancelled() => {
                    tracing::info!("On-demand screenshot task shutting down");
                    break;
                }
                Some(request_id) = screenshot_rx.recv() => {
                    let path = std::env::temp_dir().join(format!(
                        "montr-screenshot-{}-{}.jpg",
                        std::process::id(),
                        request_id
                    ));
                    let path_str = path.to_string_lossy().to_string();

                    if let Err(e) = screenshot_engine.screenshot(&path_str).await {
                        tracing::warn!(
                            "Screenshot capture failed (request_id={}): {}",
                            request_id,
                            e
                        );
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }

                    // Brief delay to let mpv finish writing the file.
                    tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

                    let data = match tokio::fs::read(&path).await {
                        Ok(d) => d,
                        Err(e) => {
                            tracing::warn!(
                                "Screenshot file unreadable (request_id={}): {}",
                                request_id,
                                e
                            );
                            let _ = std::fs::remove_file(&path);
                            continue;
                        }
                    };

                    if data.len() > SCREENSHOT_MAX_BYTES {
                        tracing::warn!(
                            "On-demand screenshot {} bytes exceeds server limit ({} bytes)",
                            data.len(),
                            SCREENSHOT_MAX_BYTES
                        );
                        let _ = std::fs::remove_file(&path);
                        continue;
                    }

                    let upload_result = screenshot_http
                        .upload_preview(
                            &screenshot_client_id,
                            Some(&request_id),
                            data,
                            screenshot_api_key.as_deref(),
                        )
                        .await;

                    let _ = std::fs::remove_file(&path);

                    match upload_result {
                        Ok(()) => tracing::debug!(
                            "On-demand screenshot uploaded (request_id={})",
                            request_id
                        ),
                        Err(e) => tracing::warn!(
                            "On-demand screenshot upload failed (request_id={}): {}",
                            request_id,
                            e
                        ),
                    }
                }
                else => break,
            }
        }
    });

    // ========================================================================
    // Storage-Low Watermark Task (60s tick, throttled to 30 min)
    // ========================================================================
    // Monitors free disk and cache utilization. When either crosses the
    // warning threshold, fires a `storage_low` ClientMessage::Error (severity
    // `warn`) so the server can broadcast to admins and trigger any
    // `storage_full` notification rules. Throttled so a saturated client
    // doesn't spam the bus.
    let storage_lru = lru_manager.clone();
    let storage_ws_tx = coord_ws_tx_for_storage.clone();
    let storage_client_id = config.client.id.clone();
    let storage_cancel = cancel_token.clone();
    let storage_handle = tokio::spawn(async move {
        const CHECK_INTERVAL_SECS: u64 = 60;
        const ALERT_INTERVAL_SECS: u64 = 30 * 60;
        const DISK_LOW_BYTES: u64 = 1024 * 1024 * 1024; // 1 GB
        const CACHE_HIGH_PCT: f64 = 90.0;

        let mut tick = tokio::time::interval(tokio::time::Duration::from_secs(CHECK_INTERVAL_SECS));
        let mut last_alert: Option<tokio::time::Instant> = None;

        tracing::info!("Storage-low watermark task started");

        loop {
            tokio::select! {
                _ = storage_cancel.cancelled() => {
                    tracing::info!("Storage-low watermark task shutting down");
                    break;
                }
                _ = tick.tick() => {
                    let cache_bytes = storage_lru.current_size().await;
                    let cache_max = storage_lru.max_size_bytes();
                    let usage_pct = if cache_max > 0 {
                        (cache_bytes as f64 / cache_max as f64) * 100.0
                    } else {
                        0.0
                    };
                    let available = storage_lru.available_disk_bytes();

                    let disk_low = available.is_some_and(|a| a < DISK_LOW_BYTES);
                    let cache_high = usage_pct >= CACHE_HIGH_PCT;

                    if !(disk_low || cache_high) {
                        continue;
                    }

                    let now = tokio::time::Instant::now();
                    let due = last_alert
                        .map(|t| now.duration_since(t).as_secs() >= ALERT_INTERVAL_SECS)
                        .unwrap_or(true);
                    if !due {
                        continue;
                    }
                    last_alert = Some(now);

                    let mut ctx = std::collections::HashMap::new();
                    if let Some(a) = available {
                        ctx.insert(
                            "available_bytes".to_string(),
                            serde_json::Value::from(a),
                        );
                    }
                    ctx.insert(
                        "cache_bytes".to_string(),
                        serde_json::Value::from(cache_bytes),
                    );
                    ctx.insert(
                        "cache_max_bytes".to_string(),
                        serde_json::Value::from(cache_max),
                    );
                    ctx.insert(
                        "cache_usage_pct".to_string(),
                        serde_json::Value::from(usage_pct),
                    );

                    let msg = montr_client::network::protocol::ClientMessage::error_detailed(
                        storage_client_id.clone(),
                        Some("cache".to_string()),
                        Some(montr_client::network::ErrorSeverity::Warn),
                        "storage_low".to_string(),
                        Some(ctx),
                    );

                    if let Err(e) = storage_ws_tx.send(msg) {
                        tracing::debug!("Failed to enqueue storage_low alert: {}", e);
                    } else {
                        tracing::warn!(
                            "storage_low: cache {:.1}% ({} MB / {} MB), available {} MB",
                            usage_pct,
                            cache_bytes / 1024 / 1024,
                            cache_max / 1024 / 1024,
                            available.map(|a| a / 1024 / 1024).unwrap_or(0)
                        );
                    }
                }
            }
        }
    });

    // ========================================================================
    // Offline-Mode Watcher Task
    // ========================================================================
    // Tracks the WebSocket connection state. When the client stays
    // disconnected for more than the grace period, emits a warn-level
    // `client_error` so the server can show "offline mode active" the next
    // time the link recovers. On recovery, emits a second event with the
    // total offline duration so admins can see how long the gap was.
    let offline_ws_client = ws_client.clone();
    let offline_client_id = config.client.id.clone();
    let offline_cancel = cancel_token.clone();
    let offline_handle = tokio::spawn(async move {
        const POLL_INTERVAL_SECS: u64 = 30;
        const OFFLINE_GRACE_SECS: u64 = 60;

        let mut tick = tokio::time::interval(tokio::time::Duration::from_secs(POLL_INTERVAL_SECS));
        let mut offline_since: Option<tokio::time::Instant> = None;
        let mut announced_offline = false;

        tracing::info!("Offline-mode watcher started");

        loop {
            tokio::select! {
                _ = offline_cancel.cancelled() => {
                    tracing::info!("Offline-mode watcher shutting down");
                    break;
                }
                _ = tick.tick() => {
                    let connected = offline_ws_client.is_connected().await;

                    if !connected {
                        let since = offline_since.get_or_insert_with(tokio::time::Instant::now);
                        let elapsed = since.elapsed().as_secs();
                        if !announced_offline && elapsed >= OFFLINE_GRACE_SECS {
                            announced_offline = true;
                            // Emit it so it queues — gets delivered on reconnect.
                            let mut ctx = std::collections::HashMap::new();
                            ctx.insert(
                                "offline_secs".to_string(),
                                serde_json::Value::from(elapsed),
                            );
                            let msg =
                                montr_client::network::protocol::ClientMessage::error_detailed(
                                    offline_client_id.clone(),
                                    Some("connection".to_string()),
                                    Some(montr_client::network::ErrorSeverity::Warn),
                                    "offline_mode_active".to_string(),
                                    Some(ctx),
                                );
                            let _ = coord_ws_tx_for_offline.send(msg);
                            tracing::warn!(
                                "Offline mode active ({}s without server contact)",
                                elapsed
                            );
                        }
                    } else if let Some(since) = offline_since.take() {
                        let elapsed = since.elapsed().as_secs();
                        // Only report recovery if we'd previously crossed the
                        // grace threshold (i.e. actually announced offline).
                        if announced_offline && elapsed >= OFFLINE_GRACE_SECS {
                            let mut ctx = std::collections::HashMap::new();
                            ctx.insert(
                                "offline_secs".to_string(),
                                serde_json::Value::from(elapsed),
                            );
                            let msg =
                                montr_client::network::protocol::ClientMessage::error_detailed(
                                    offline_client_id.clone(),
                                    Some("connection".to_string()),
                                    Some(montr_client::network::ErrorSeverity::Warn),
                                    "offline_mode_recovered".to_string(),
                                    Some(ctx),
                                );
                            let _ = coord_ws_tx_for_offline.send(msg);
                            tracing::info!("Offline mode recovered after {}s", elapsed);
                        }
                        announced_offline = false;
                    }
                }
            }
        }
    });

    // ========================================================================
    // Offline Schedule Evaluator
    // ========================================================================
    // While the WS link is up, the server's evaluator is the single source of
    // truth and pushes resolved playlists via `playlist_assigned`. When the
    // link is down, we evaluate the persisted schedule definitions locally
    // and switch playback among any playlists that are already cached. The
    // tick is 30s (matching the offline-mode watcher cadence).
    let offline_eval_ws = ws_client.clone();
    let offline_eval_cancel = cancel_token.clone();
    let offline_eval_schedules = schedules_handle.clone();
    let offline_eval_state = app_state.clone();
    let offline_eval_tx = coordinator_tx.clone();
    let offline_eval_handle = tokio::spawn(async move {
        const TICK_SECS: u64 = 30;
        let mut tick = tokio::time::interval(tokio::time::Duration::from_secs(TICK_SECS));
        // Skip the immediate first tick — interval fires at 0.
        tick.tick().await;

        tracing::info!("Offline schedule evaluator started (tick: {}s)", TICK_SECS);
        let mut last_switched_playlist: Option<u32> = None;

        loop {
            tokio::select! {
                _ = offline_eval_cancel.cancelled() => {
                    tracing::info!("Offline schedule evaluator shutting down");
                    break;
                }
                _ = tick.tick() => {
                    // Online → server is authoritative; reset our debounce
                    // so the next disconnect recomputes from scratch.
                    if offline_eval_ws.is_connected().await {
                        last_switched_playlist = None;
                        continue;
                    }

                    let schedules = offline_eval_schedules.read().await.clone();
                    if schedules.is_empty() {
                        continue;
                    }

                    let now = chrono::Local::now();
                    let Some(active) =
                        montr_client::state::select_active_schedule(&schedules, now)
                    else {
                        continue;
                    };

                    // Already playing the schedule's playlist — nothing to do.
                    if let Some(current) = offline_eval_state.playlist_id().await {
                        if current == active.playlist_id {
                            last_switched_playlist = Some(active.playlist_id);
                            continue;
                        }
                    }
                    // Debounce: don't re-fire the same switch on every tick
                    // until the situation changes.
                    if last_switched_playlist == Some(active.playlist_id) {
                        continue;
                    }
                    last_switched_playlist = Some(active.playlist_id);

                    tracing::info!(
                        "Offline schedule evaluator: switching to playlist {} (schedule {})",
                        active.playlist_id,
                        active.id
                    );
                    let msg = montr_client::state::CoordinatorMessage::OfflineScheduleSwitch {
                        playlist_id: active.playlist_id,
                    };
                    if let Err(e) = offline_eval_tx.send(msg) {
                        tracing::warn!("Failed to enqueue offline schedule switch: {}", e);
                    }
                }
            }
        }
    });

    // ========================================================================
    // Periodic Update Check (every 24 hours)
    // ========================================================================
    let update_auto = config.system.auto_update;
    let update_cancel = cancel_token.clone();
    let update_handle = tokio::spawn(async move {
        let interval = tokio::time::Duration::from_secs(24 * 60 * 60);
        loop {
            tokio::select! {
                _ = update_cancel.cancelled() => break,
                _ = tokio::time::sleep(interval) => {
                    match montr_client::update::check_and_update(update_auto).await {
                        Ok(true) => {
                            tracing::info!("Update applied, restarting...");
                            match std::env::current_exe() {
                                Ok(exe) => {
                                    let args: Vec<String> = std::env::args().collect();
                                    let err = exec::execvp(&exe, &args);
                                    tracing::error!("Failed to restart after update: {}", err);
                                    std::process::exit(1);
                                }
                                Err(e) => {
                                    tracing::error!(
                                        "Update applied but cannot determine current executable path ({}); skipping restart this cycle",
                                        e
                                    );
                                }
                            }
                        }
                        Ok(false) => {}
                        Err(e) => tracing::warn!("Periodic update check failed: {}", e),
                    }
                }
            }
        }
    });

    // ========================================================================
    // Main Loop - Wait for shutdown
    // ========================================================================
    tracing::info!("Montr client fully initialized and running");
    tracing::info!("Press Ctrl+C to shutdown...");

    // Wait for cancellation
    cancel_token.cancelled().await;

    tracing::info!("Shutting down gracefully...");

    // Wait for all tasks to complete (with timeout)
    let shutdown_timeout = tokio::time::Duration::from_secs(5);

    tokio::select! {
        _ = tokio::time::sleep(shutdown_timeout) => {
            tracing::warn!("Shutdown timeout reached, some tasks may not have completed");
        }
        _ = async {
            let _ = tokio::join!(
                heartbeat_handle,
                status_handle,
                status_forward_handle,
                coord_forward_handle,
                coordinator_handle,
                ws_msg_handle,
                playback_event_handle,
                preview_handle,
                screenshot_handle,
                storage_handle,
                offline_handle,
                offline_eval_handle,
                update_handle,
            );
        } => {
            tracing::info!("All tasks completed");
        }
    }

    tracing::info!("Shutdown complete");

    Ok(())
}

/// Apply the reload-safe subset of a re-read config in response to SIGHUP.
///
/// The shared snapshot has already been swapped by the SIGHUP handler before
/// we're called, so subsystems that consume the snapshot pick up new values
/// on their next iteration without further plumbing here. Two extra steps:
///
///   * Log level — re-apply via `tracing_subscriber` reload handle (it lives
///     in a separate static, not in the snapshot).
///   * Restart-required diff — narrow list (those NOT covered by the
///     snapshot wiring); log a single warning naming them so the operator
///     sees what didn't take effect.
fn apply_safe_reload(prev: &config::Config, new_cfg: &config::Config) {
    // Log level: hot-swap via tracing_subscriber reload handle.
    if prev.system.log_level != new_cfg.system.log_level {
        match montr_client::logging::reload_log_level(&new_cfg.system.log_level) {
            Ok(()) => tracing::info!(
                "log_level: {} -> {}",
                prev.system.log_level,
                new_cfg.system.log_level
            ),
            Err(e) => tracing::error!(
                "Failed to apply new log_level '{}': {}",
                new_cfg.system.log_level,
                e
            ),
        }
    }

    // Friendly info notes for fields that are hot-applied through the shared
    // snapshot — the SIGHUP handler already swapped it, but operators benefit
    // from a confirmation line per change.
    if prev.client.preview_interval_secs != new_cfg.client.preview_interval_secs {
        tracing::info!(
            "preview_interval_secs: {} -> {} (live)",
            prev.client.preview_interval_secs,
            new_cfg.client.preview_interval_secs
        );
    }
    if prev.client.status_interval_secs != new_cfg.client.status_interval_secs {
        tracing::info!(
            "status_interval_secs: {} -> {} (live)",
            prev.client.status_interval_secs,
            new_cfg.client.status_interval_secs
        );
    }
    if prev.client.telemetry_interval_secs != new_cfg.client.telemetry_interval_secs {
        tracing::info!(
            "telemetry_interval_secs: {} -> {} (live)",
            prev.client.telemetry_interval_secs,
            new_cfg.client.telemetry_interval_secs
        );
    }
    if prev.server.heartbeat_interval != new_cfg.server.heartbeat_interval {
        tracing::info!(
            "heartbeat_interval: {} -> {} (live)",
            prev.server.heartbeat_interval,
            new_cfg.server.heartbeat_interval
        );
    }
    if prev.server.reconnect_interval != new_cfg.server.reconnect_interval {
        tracing::info!(
            "reconnect_interval: {} -> {} (live, applied on next retry)",
            prev.server.reconnect_interval,
            new_cfg.server.reconnect_interval
        );
    }
    if prev.playback.preload_next_items != new_cfg.playback.preload_next_items {
        tracing::info!(
            "preload_next_items: {} -> {} (live)",
            prev.playback.preload_next_items,
            new_cfg.playback.preload_next_items
        );
    }
    if prev.playback.preload_bytes_budget != new_cfg.playback.preload_bytes_budget {
        tracing::info!(
            "preload_bytes_budget: {:?} -> {:?} (live)",
            prev.playback.preload_bytes_budget,
            new_cfg.playback.preload_bytes_budget
        );
    }
    if prev.playback.default_image_duration != new_cfg.playback.default_image_duration {
        tracing::info!(
            "default_image_duration: {} -> {} (live, applies to next image)",
            prev.playback.default_image_duration,
            new_cfg.playback.default_image_duration
        );
    }

    // Detect changes that still require a restart and surface them. The list
    // is now narrower than before Part B since intervals and preload tunables
    // are hot-reloadable through the snapshot.
    let restart_required: Vec<&str> = [
        ("server.url", prev.server.url != new_cfg.server.url),
        (
            "server.api_key",
            prev.server.api_key != new_cfg.server.api_key,
        ),
        (
            "server.ca_cert_path",
            prev.server.ca_cert_path != new_cfg.server.ca_cert_path,
        ),
        (
            "server.tls_skip_verify",
            prev.server.tls_skip_verify != new_cfg.server.tls_skip_verify,
        ),
        ("client.id", prev.client.id != new_cfg.client.id),
        ("client.name", prev.client.name != new_cfg.client.name),
        (
            "playback.media_cache_dir",
            prev.playback.media_cache_dir != new_cfg.playback.media_cache_dir,
        ),
        (
            "playback.max_cache_size_mb",
            prev.playback.max_cache_size_mb != new_cfg.playback.max_cache_size_mb,
        ),
        (
            "display.fullscreen",
            prev.display.fullscreen != new_cfg.display.fullscreen,
        ),
        (
            "display.screen_index",
            prev.display.screen_index != new_cfg.display.screen_index,
        ),
        (
            "system.log_file",
            prev.system.log_file != new_cfg.system.log_file,
        ),
    ]
    .into_iter()
    .filter_map(|(name, changed)| if changed { Some(name) } else { None })
    .collect();

    if !restart_required.is_empty() {
        tracing::warn!(
            "SIGHUP reload: the following changes require a restart and were NOT applied: {}",
            restart_required.join(", ")
        );
    }
}

/// Interactive setup wizard — prompts for essential config values and writes a config file
fn run_setup(args: &config::CliArgs) -> std::io::Result<()> {
    use std::io::{self, Write};

    let config_path = args
        .config
        .clone()
        .unwrap_or_else(config::ConfigLoader::get_default_config_path);

    let prompt = |label: &str| -> io::Result<String> {
        eprint!("{}", label);
        io::stderr().flush()?;
        let mut buf = String::new();
        io::stdin().read_line(&mut buf)?;
        Ok(buf)
    };

    if config_path.exists() {
        let answer = prompt(&format!(
            "Config already exists at {}. Overwrite? [y/N] ",
            config_path.display()
        ))?;
        if !answer.trim().eq_ignore_ascii_case("y") {
            eprintln!("Setup cancelled.");
            std::process::exit(0);
        }
    }

    let hostname = sysinfo::System::host_name().unwrap_or_default();

    // Prompt for server URL
    let server_url_input = prompt("Server URL [http://localhost:3000]: ")?;
    let server_url = server_url_input.trim();
    let server_url = if server_url.is_empty() {
        "http://localhost:3000"
    } else {
        server_url
    };

    // Prompt for client name
    let default_name = if hostname.is_empty() {
        "montr-client"
    } else {
        &hostname
    };
    let client_name_input = prompt(&format!("Client name [{}]: ", default_name))?;
    let client_name = client_name_input.trim();
    let client_name = if client_name.is_empty() {
        default_name
    } else {
        client_name
    };

    // Prompt for fullscreen
    let fullscreen_input = prompt("Fullscreen mode? [Y/n]: ")?;
    let fullscreen = !fullscreen_input.trim().eq_ignore_ascii_case("n");

    // Prompt for TLS settings (only if HTTPS)
    let mut ca_cert_path = String::new();
    let mut tls_skip_verify = false;
    if server_url.starts_with("https://") {
        let ca_input = prompt("TLS: Custom CA certificate path (leave empty for system CA) []: ")?;
        ca_cert_path = ca_input.trim().to_string();

        if ca_cert_path.is_empty() {
            let skip_input =
                prompt("TLS: Skip certificate verification? (INSECURE, dev only) [y/N]: ")?;
            tls_skip_verify = skip_input.trim().eq_ignore_ascii_case("y");
        }
    }

    // Generate config from template, then patch values
    if let Err(e) = config::ConfigLoader::generate_default_config(&config_path) {
        eprintln!("Failed to write config: {}", e);
        std::process::exit(1);
    }

    // Read back and replace placeholder values
    let content = std::fs::read_to_string(&config_path)?;
    let content = content.replace(
        "url = \"http://localhost:3000\"",
        &format!("url = \"{}\"", server_url),
    );
    let content = content.replace("name = \"\"", &format!("name = \"{}\"", client_name));
    let content = content.replace("fullscreen = true", &format!("fullscreen = {}", fullscreen));

    // Patch TLS settings if specified
    let content = if !ca_cert_path.is_empty() {
        content.replace(
            "# ca_cert_path = \"/path/to/ca.pem\"",
            &format!("ca_cert_path = \"{}\"", ca_cert_path),
        )
    } else {
        content
    };
    let content = if tls_skip_verify {
        content.replace("# tls_skip_verify = false", "tls_skip_verify = true")
    } else {
        content
    };

    std::fs::write(&config_path, content)?;

    eprintln!();
    eprintln!("Config written to: {}", config_path.display());
    eprintln!("Starting client...");
    eprintln!();
    Ok(())
}
