use crate::error::Result;
use anyhow::anyhow;
use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use windows_service::service::{
    ServiceAccess, ServiceControl, ServiceControlAccept, ServiceErrorControl, ServiceExitCode,
    ServiceInfo, ServiceStartType, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_service::{define_windows_service, service_dispatcher};

const SERVICE_NAME: &str = "MontrClient";
const SERVICE_DISPLAY_NAME: &str = "Montr Media Client";
const SERVICE_DESCRIPTION: &str = "Montr distributed media playlist client for automated playback";

define_windows_service!(ffi_service_main, montr_service_main);

/// Dispatch to the Windows Service Control Manager.
/// This call blocks until the service is stopped.
pub fn run_service_dispatcher() -> Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
        .map_err(|e| anyhow!("Failed to start service dispatcher: {}", e))?;
    Ok(())
}

/// Entry point called by the SCM via the dispatcher.
fn montr_service_main(arguments: Vec<OsString>) {
    if let Err(e) = run_service(arguments) {
        eprintln!("Service error: {}", e);
    }
}

/// Main service logic — registers the control handler, loads config, runs the client.
fn run_service(arguments: Vec<OsString>) -> Result<()> {
    let cancel_token = CancellationToken::new();
    let cancel_for_handler = cancel_token.clone();

    // Register the service control handler
    let status_handle = service_control_handler::register(
        SERVICE_NAME,
        move |control_event| -> ServiceControlHandlerResult {
            match control_event {
                ServiceControl::Stop => {
                    cancel_for_handler.cancel();
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
                _ => ServiceControlHandlerResult::NotImplemented,
            }
        },
    )
    .map_err(|e| anyhow!("Failed to register service control handler: {}", e))?;

    // Report running status to the SCM
    status_handle
        .set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: ServiceState::Running,
            controls_accepted: ServiceControlAccept::STOP,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::default(),
            process_id: None,
        })
        .map_err(|e| anyhow!("Failed to set service status to Running: {}", e))?;

    // Build the tokio runtime and run the client
    let runtime = tokio::runtime::Runtime::new()
        .map_err(|e| anyhow!("Failed to create tokio runtime: {}", e))?;

    let result = runtime.block_on(async {
        // Determine config path from service arguments or default location
        let config_path = arguments
            .iter()
            .skip(1) // first arg is service name
            .find(|arg| {
                let s = arg.to_string_lossy();
                !s.starts_with('-')
            })
            .map(PathBuf::from);

        // If --config was passed via service args, find it
        let config_path = config_path.or_else(|| {
            let args: Vec<String> = arguments
                .iter()
                .map(|a| a.to_string_lossy().to_string())
                .collect();
            args.windows(2)
                .find(|pair| pair[0] == "--config" || pair[0] == "-c")
                .map(|pair| PathBuf::from(&pair[1]))
        });

        let loader = crate::config::ConfigLoader::new(config_path);
        let cfg = loader.load()?;

        crate::logging::init_logging(&cfg)?;
        tracing::info!("Montr client starting as Windows Service");

        // Run the client (imported from main.rs crate root — we call the inner function)
        // The run_client_inner function lives in main.rs and is not accessible from lib.
        // Instead, we replicate the initialization here by calling through.
        // Since run_client_inner is defined in the binary crate (main.rs), we need to
        // re-create the core logic. The cleanest approach: make run_client_inner available
        // from lib.rs or call the subsystem initialization directly.
        //
        // For now, we invoke the same subsystem startup inline.
        run_client_as_service(cfg, cancel_token).await
    });

    // Report stopped status
    let exit_code = if result.is_ok() {
        ServiceExitCode::Win32(0)
    } else {
        ServiceExitCode::Win32(1)
    };

    let _ = status_handle.set_service_status(ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: ServiceState::Stopped,
        controls_accepted: ServiceControlAccept::empty(),
        exit_code,
        checkpoint: 0,
        wait_hint: Duration::default(),
        process_id: None,
    });

    result
}

/// Runs the client in service mode — identical to console mode but without signal handlers.
async fn run_client_as_service(
    config: crate::config::Config,
    cancel_token: CancellationToken,
) -> Result<()> {
    use crate::{
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

    tracing::info!("Initializing Montr client (service mode)...");

    let http_client = Arc::new(HttpClient::new(config.server.url.clone())?);

    let cache_manager = Arc::new(
        CacheManager::new(
            http_client.clone(),
            config.playback.media_cache_dir.clone(),
            cancel_token.clone(),
        )?
        .with_api_key(config.server.api_key.clone()),
    );
    cache_manager.init().await?;

    let lru_manager = Arc::new(LruCacheManager::new(
        config.playback.max_cache_size_mb,
        config.playback.media_cache_dir.clone(),
        cancel_token.clone(),
    )?);
    lru_manager.init().await?;
    let _lru_cleanup_handle = lru_manager.clone().start_cleanup_task();

    let app_state = Arc::new(AppState::new(
        config.client.id.clone(),
        config.client.name.clone(),
    ));

    let playback_engine = Arc::new(PlaybackEngine::new(
        cancel_token.clone(),
        config.display.fullscreen,
        config.display.screen_index,
    )?);

    let playback_event_handle = {
        let engine = playback_engine.clone();
        tokio::spawn(async move {
            if let Err(e) = engine.run().await {
                tracing::error!("Playback engine error: {}", e);
            }
        })
    };

    let ws_client = Arc::new(WebSocketClient::new(&config).await?);

    let capabilities = ClientCapabilities {
        video: true,
        image: true,
    };
    let register_msg = ClientMessage::register(
        config.client.id.clone(),
        crate::VERSION.to_string(),
        capabilities,
        Some(config.client.name.clone()),
    );
    ws_client.set_on_connect(register_msg.clone()).await;
    ws_client.send(register_msg).await?;
    tracing::info!("Registered with server");

    let coordinator = StateCoordinator::new(
        (*app_state).clone(),
        cache_manager.clone(),
        playback_engine.as_ref(),
        cancel_token.clone(),
        config.playback.preload_next_items,
    );
    let coordinator_tx = coordinator.message_sender();

    let coordinator_handle = tokio::spawn(async move {
        if let Err(e) = coordinator.run().await {
            tracing::error!("Coordinator error: {}", e);
        }
    });

    // Bridge playback events to coordinator
    {
        let coordinator_tx = coordinator_tx.clone();
        let engine = playback_engine.clone();
        let cancel = cancel_token.clone();
        tokio::spawn(async move {
            use crate::state::coordinator::{CoordinatorMessage, PlaybackEventMessage};
            let mut event_rx = engine.subscribe_events().await;
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    Some(event) = event_rx.recv() => {
                        let msg = match event {
                            crate::playback::PlaybackEvent::EndFile => {
                                Some(PlaybackEventMessage::MediaFinished { media_id: 0 })
                            }
                            crate::playback::PlaybackEvent::PositionChanged { position } => {
                                Some(PlaybackEventMessage::PositionUpdate { position })
                            }
                            crate::playback::PlaybackEvent::Error { message } => {
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

    let ws_msg_handle = {
        let ws_client = ws_client.clone();
        let coordinator_tx = coordinator_tx.clone();
        let cancel_token = cancel_token.clone();
        tokio::spawn(async move {
            use crate::state::coordinator::CoordinatorMessage;
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

    let (status_ws_tx, mut status_ws_rx) = mpsc::unbounded_channel();
    let status_reporter = Arc::new(StatusReporter::new(
        app_state.clone(),
        status_ws_tx,
        config.server.heartbeat_interval,
        10,
        cancel_token.clone(),
    ));

    let ws_client_for_status = ws_client.clone();
    let status_forward_handle = tokio::spawn(async move {
        while let Some(msg) = status_ws_rx.recv().await {
            if let Err(e) = ws_client_for_status.send(msg).await {
                tracing::error!("Failed to forward status message: {}", e);
            }
        }
    });

    let (heartbeat_handle, status_handle) = status_reporter.start();

    // Preview screenshot task
    let preview_engine = playback_engine.clone();
    let preview_cancel = cancel_token.clone();
    let preview_server_url = config.server.url.clone();
    let preview_client_id = config.client.id.clone();
    let preview_api_key = config.server.api_key.clone();
    let preview_handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(10));
        let screenshot_path = std::env::temp_dir()
            .join(format!("montr-preview-{}.jpg", std::process::id()))
            .to_string_lossy()
            .to_string();
        let client = reqwest::Client::new();

        loop {
            tokio::select! {
                _ = preview_cancel.cancelled() => {
                    let _ = std::fs::remove_file(&screenshot_path);
                    break;
                }
                _ = interval.tick() => {
                    if let Err(e) = preview_engine.screenshot(&screenshot_path).await {
                        tracing::trace!("Screenshot capture skipped: {}", e);
                        continue;
                    }
                    tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
                    match tokio::fs::read(&screenshot_path).await {
                        Ok(data) => {
                            let part = reqwest::multipart::Part::bytes(data)
                                .file_name("preview.jpg")
                                .mime_str("image/jpeg")
                                .unwrap();
                            let form = reqwest::multipart::Form::new().part("preview", part);
                            let url = format!("{}/api/clients/{}/preview", preview_server_url, preview_client_id);
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
                        }
                        Err(_) => {}
                    }
                }
            }
        }
    });

    tracing::info!("Montr client fully initialized and running (service mode)");

    cancel_token.cancelled().await;
    tracing::info!("Service stop requested, shutting down...");

    let shutdown_timeout = tokio::time::Duration::from_secs(5);
    tokio::select! {
        _ = tokio::time::sleep(shutdown_timeout) => {
            tracing::warn!("Shutdown timeout reached");
        }
        _ = async {
            let _ = tokio::join!(
                heartbeat_handle,
                status_handle,
                status_forward_handle,
                coordinator_handle,
                ws_msg_handle,
                playback_event_handle,
                preview_handle,
            );
        } => {
            tracing::info!("All tasks completed");
        }
    }

    tracing::info!("Shutdown complete");
    Ok(())
}

/// Install the Montr client as a Windows Service.
pub fn install_service() -> Result<()> {
    let manager =
        ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CREATE_SERVICE)
            .map_err(|e| anyhow!("Failed to open Service Control Manager: {}", e))?;

    let executable_path =
        std::env::current_exe().map_err(|e| anyhow!("Failed to get executable path: {}", e))?;

    // Determine config path — use ProgramData default
    let config_path = r"C:\ProgramData\Montr\config.toml";

    let service_info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(SERVICE_DISPLAY_NAME),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path,
        launch_arguments: vec![
            OsString::from("--run-service"),
            OsString::from("--config"),
            OsString::from(config_path),
        ],
        dependencies: vec![],
        account_name: None, // LocalSystem
        account_password: None,
    };

    let service = manager
        .create_service(
            &service_info,
            ServiceAccess::CHANGE_CONFIG | ServiceAccess::START,
        )
        .map_err(|e| anyhow!("Failed to create service: {}", e))?;

    // Set the service description
    service
        .set_description(SERVICE_DESCRIPTION)
        .map_err(|e| anyhow!("Failed to set service description: {}", e))?;

    println!("Service '{}' installed successfully.", SERVICE_DISPLAY_NAME);
    println!("Config path: {}", config_path);
    println!("Start with: net start {}", SERVICE_NAME);

    Ok(())
}

/// Uninstall the Montr client Windows Service.
pub fn uninstall_service() -> Result<()> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(|e| anyhow!("Failed to open Service Control Manager: {}", e))?;

    let service = manager
        .open_service(
            SERVICE_NAME,
            ServiceAccess::STOP | ServiceAccess::QUERY_STATUS | ServiceAccess::DELETE,
        )
        .map_err(|e| anyhow!("Failed to open service '{}': {}", SERVICE_NAME, e))?;

    // Stop the service if it's running
    let status = service
        .query_status()
        .map_err(|e| anyhow!("Failed to query service status: {}", e))?;

    if status.current_state != ServiceState::Stopped {
        println!("Stopping service...");
        let _ = service.stop();

        // Wait up to 10 seconds for the service to stop
        for _ in 0..20 {
            std::thread::sleep(Duration::from_millis(500));
            let status = service
                .query_status()
                .map_err(|e| anyhow!("Failed to query service status: {}", e))?;
            if status.current_state == ServiceState::Stopped {
                break;
            }
        }
    }

    service
        .delete()
        .map_err(|e| anyhow!("Failed to delete service: {}", e))?;

    println!(
        "Service '{}' uninstalled successfully.",
        SERVICE_DISPLAY_NAME
    );

    Ok(())
}
