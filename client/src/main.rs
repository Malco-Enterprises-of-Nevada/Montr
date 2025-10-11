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
/// This is where the actual client logic will run.
/// Currently a placeholder for Phase 3, Tasks 2-5:
/// - Task 2: Network layer (HTTP client, WebSocket client)
/// - Task 3: Playback engine (mpv integration, playlist queue)
/// - Task 4: Media cache (download manager, checksum verification)
/// - Task 5: Status reporting (periodic updates to server)
async fn run_client(_config: config::Config) -> Result<()> {
    tracing::info!("Client initialization complete");
    tracing::info!(
        "Waiting for Phase 3, Tasks 2-5 implementation (network, playback, cache, status reporting)"
    );

    // TODO: Phase 3, Task 2 - Network Layer
    // - Initialize HTTP client
    // - Initialize WebSocket client with auto-reconnect
    // - Register with server
    // - Handle incoming messages

    // TODO: Phase 3, Task 3 - Playback Engine
    // - Initialize mpv
    // - Set up playlist queue
    // - Start playback loop

    // TODO: Phase 3, Task 4 - Media Cache
    // - Initialize download manager
    // - Set up cache directory
    // - Implement LRU eviction

    // TODO: Phase 3, Task 5 - Status Reporting
    // - Start status reporter task
    // - Report heartbeat every N seconds
    // - Report playback status

    // For now, just run until Ctrl+C is pressed
    tracing::info!("Press Ctrl+C to shutdown...");

    // Wait for shutdown signal
    match tokio::signal::ctrl_c().await {
        Ok(()) => {
            tracing::info!("Received shutdown signal (Ctrl+C)");
        }
        Err(e) => {
            tracing::error!("Failed to listen for shutdown signal: {}", e);
        }
    }

    // Graceful shutdown
    tracing::info!("Shutting down gracefully...");

    // TODO: In future phases, clean up resources:
    // - Close WebSocket connection
    // - Stop playback
    // - Flush logs
    // - Save state if needed

    tracing::info!("Shutdown complete");

    Ok(())
}
