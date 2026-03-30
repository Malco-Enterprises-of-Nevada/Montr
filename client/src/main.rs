use montr_client::{config, error::Result, logging};

#[tokio::main]
async fn main() -> Result<()> {
    // Step 1: Parse CLI arguments (must be first, synchronous)
    let args = config::CliArgs::parse_args();

    // Step 2: Load configuration from file (synchronous, before logging)
    let loader = config::ConfigLoader::new(args.config.clone());
    let mut cfg = match loader.load() {
        Ok(config) => config,
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
    use montr_client::{
        cache::{CacheManager, LruCacheManager},
        network::{
            protocol::{ClientCapabilities, ClientMessage},
            websocket::WebSocketClient,
            HttpClient,
        },
        playback::engine::PlaybackEngine,
        state::{app_state::AppState, coordinator::StateCoordinator},
        status::StatusReporter,
    };
    use std::sync::Arc;
    use tokio::sync::mpsc;
    use tokio_util::sync::CancellationToken;

    tracing::info!("Initializing Montr client...");

    // Create cancellation token for graceful shutdown
    let cancel_token = CancellationToken::new();
    let cancel_token_signal = cancel_token.clone();

    // Spawn signal handler (SIGINT + SIGTERM on Unix, SIGINT only on other platforms)
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::SignalKind;
            let mut sigterm = tokio::signal::unix::signal(SignalKind::terminate())
                .expect("Failed to register SIGTERM handler");
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
        #[cfg(not(unix))]
        {
            match tokio::signal::ctrl_c().await {
                Ok(()) => tracing::info!("Received shutdown signal (Ctrl+C)"),
                Err(e) => tracing::error!("Failed to listen for shutdown signal: {}", e),
            }
        }
        cancel_token_signal.cancel();
    });

    // ========================================================================
    // Initialize HTTP Client
    // ========================================================================
    tracing::info!("Initializing HTTP client");
    let http_client = Arc::new(HttpClient::new(config.server.url.clone())?);

    // ========================================================================
    // Initialize Cache Manager
    // ========================================================================
    tracing::info!("Initializing cache manager");
    let cache_manager = Arc::new(CacheManager::new(
        http_client.clone(),
        config.playback.media_cache_dir.clone(),
        cancel_token.clone(),
    )?);
    cache_manager.init().await?;

    // ========================================================================
    // Initialize LRU Cache Manager
    // ========================================================================
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
    // Initialize Application State
    // ========================================================================
    tracing::info!("Initializing application state");
    let app_state = Arc::new(AppState::new(
        config.client.id.clone(),
        config.client.name.clone(),
    ));

    // ========================================================================
    // Initialize Playback Engine
    // ========================================================================
    tracing::info!("Initializing playback engine");
    let playback_engine = Arc::new(PlaybackEngine::new(
        cancel_token.clone(),
        config.display.fullscreen,
        config.display.screen_index,
    )?);

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
    let ws_client = Arc::new(WebSocketClient::new(&config).await?);

    // Send registration message
    let capabilities = ClientCapabilities {
        video: true,
        image: true,
    };

    let register_msg = ClientMessage::register(
        config.client.id.clone(),
        montr_client::VERSION.to_string(),
        capabilities,
    );

    ws_client.send(register_msg).await?;
    tracing::info!("Registered with server");

    // ========================================================================
    // Initialize State Coordinator
    // ========================================================================
    tracing::info!("Initializing state coordinator");
    let coordinator = StateCoordinator::new(
        (*app_state).clone(),
        cache_manager.clone(),
        playback_engine.as_ref(),
        cancel_token.clone(),
        config.playback.preload_next_items,
    );

    let coordinator_tx = coordinator.message_sender();

    // Start coordinator task
    let coordinator_handle = tokio::spawn(async move {
        if let Err(e) = coordinator.run().await {
            tracing::error!("Coordinator error: {}", e);
        }
    });

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

    let status_reporter = Arc::new(StatusReporter::new(
        app_state.clone(),
        status_ws_tx,
        config.server.heartbeat_interval,
        10, // Status update interval: 10 seconds
        cancel_token.clone(),
    ));

    // Forward status reporter messages to WebSocket
    let ws_client_for_status = ws_client.clone();
    let status_forward_handle = tokio::spawn(async move {
        while let Some(msg) = status_ws_rx.recv().await {
            if let Err(e) = ws_client_for_status.send(msg).await {
                tracing::error!("Failed to forward status message: {}", e);
            }
        }
    });

    // Start reporter tasks
    let (heartbeat_handle, status_handle) = status_reporter.start();

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
                coordinator_handle,
                ws_msg_handle,
                playback_event_handle,
            );
        } => {
            tracing::info!("All tasks completed");
        }
    }

    tracing::info!("Shutdown complete");

    Ok(())
}
