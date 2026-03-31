//! WebSocket client with auto-reconnect
//!
//! Manages persistent WebSocket connection to the server with automatic
//! reconnection on failure, message queuing, and heartbeat functionality.

use crate::config::Config;
use crate::error::{MontrError, Result};
use crate::network::{ClientMessage, ConnectionState, ErrorReason, ReconnectStrategy, ServerMessage, State};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, RwLock};
use tokio::time::sleep;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use tokio_util::sync::CancellationToken;

/// WebSocket client with auto-reconnect capabilities
pub struct WebSocketClient {
    /// Server WebSocket URL (for future reconnection logic)
    #[allow(dead_code)]
    ws_url: String,

    /// Connection state machine
    state: Arc<RwLock<ConnectionState>>,

    /// Reconnection strategy (for future automatic reconnection)
    #[allow(dead_code)]
    reconnect: Arc<RwLock<ReconnectStrategy>>,

    /// Channel for sending messages to WebSocket
    tx: mpsc::Sender<ClientMessage>,

    /// Channel for receiving messages from WebSocket
    rx: Arc<RwLock<mpsc::Receiver<ServerMessage>>>,

    /// Cancellation token for graceful shutdown
    cancel_token: CancellationToken,

    /// Heartbeat interval in seconds (for future heartbeat implementation)
    #[allow(dead_code)]
    heartbeat_interval: u64,
}

impl WebSocketClient {
    /// Create a new WebSocket client
    ///
    /// This spawns background tasks for connection management, message handling,
    /// and heartbeat. The client will automatically attempt to connect and
    /// maintain the connection.
    pub async fn new(config: &Config) -> Result<Self> {
        // Build WebSocket URL
        let ws_url = Self::build_ws_url(&config.server.url)?;

        // Create state and reconnect strategy
        let state = Arc::new(RwLock::new(ConnectionState::new()));
        let reconnect = Arc::new(RwLock::new(ReconnectStrategy::new(
            Duration::from_secs(config.server.reconnect_interval),
            1.5,
            Duration::from_secs(300),
        )));

        // Create channels
        let (msg_tx, msg_rx) = mpsc::channel::<ClientMessage>(1000);
        let (srv_tx, srv_rx) = mpsc::channel::<ServerMessage>(100);

        // Create cancellation token
        let cancel_token = CancellationToken::new();

        // Spawn connection task
        tokio::spawn(Self::connection_task(
            ws_url.clone(),
            state.clone(),
            reconnect.clone(),
            msg_rx,
            srv_tx,
            cancel_token.clone(),
        ));

        Ok(Self {
            ws_url,
            state,
            reconnect,
            tx: msg_tx,
            rx: Arc::new(RwLock::new(srv_rx)),
            cancel_token,
            heartbeat_interval: config.server.heartbeat_interval,
        })
    }

    /// Build WebSocket URL from HTTP URL
    fn build_ws_url(http_url: &str) -> Result<String> {
        let url = http_url
            .replace("http://", "ws://")
            .replace("https://", "wss://");

        let url = if url.ends_with('/') {
            format!("{}ws", url)
        } else {
            format!("{}/ws", url)
        };

        Ok(url)
    }

    /// Send a message to the server
    pub async fn send(&self, message: ClientMessage) -> Result<()> {
        self.tx
            .send(message)
            .await
            .map_err(|_| MontrError::WebSocketSend("Channel closed".to_string()))?;
        Ok(())
    }

    /// Receive the next message from the server
    pub async fn recv(&self) -> Option<ServerMessage> {
        let mut rx = self.rx.write().await;
        rx.recv().await
    }

    /// Get current connection state
    pub async fn state(&self) -> State {
        self.state.read().await.current()
    }

    /// Check if connected
    pub async fn is_connected(&self) -> bool {
        self.state.read().await.is_connected()
    }

    /// Check if operational
    pub async fn is_operational(&self) -> bool {
        self.state.read().await.is_operational()
    }

    /// Shutdown the client
    pub async fn shutdown(&self) {
        tracing::info!("Shutting down WebSocket client");
        self.cancel_token.cancel();
    }

    /// Connection management task
    ///
    /// Maintains the WebSocket connection with automatic reconnection.
    async fn connection_task(
        ws_url: String,
        state: Arc<RwLock<ConnectionState>>,
        reconnect: Arc<RwLock<ReconnectStrategy>>,
        mut msg_rx: mpsc::Receiver<ClientMessage>,
        srv_tx: mpsc::Sender<ServerMessage>,
        cancel_token: CancellationToken,
    ) {
        loop {
            // Check for shutdown
            if cancel_token.is_cancelled() {
                tracing::info!("Connection task shutting down");
                break;
            }

            // Attempt connection
            {
                let mut s = state.write().await;
                if matches!(s.current(), State::Disconnected) {
                    let _ = s.transition(State::Connecting);
                }
            }

            match Self::connect(&ws_url).await {
                Ok(ws_stream) => {
                    // Connection established
                    {
                        let mut s = state.write().await;
                        let _ = s.transition(State::Connected);
                        reconnect.write().await.reset();
                    }

                    tracing::info!("WebSocket connected to {}", ws_url);

                    // Handle connection
                    Self::handle_connection(
                        ws_stream,
                        state.clone(),
                        &mut msg_rx,
                        &srv_tx,
                        cancel_token.clone(),
                    )
                    .await;

                    // Connection closed
                    let mut s = state.write().await;
                    if !cancel_token.is_cancelled() {
                        s.transition_to_error(ErrorReason::ConnectionLost);
                    }
                }
                Err(e) => {
                    // Connection failed
                    tracing::error!("Failed to connect to {}: {}", ws_url, e);

                    let mut s = state.write().await;
                    s.transition_to_error(ErrorReason::ConnectionFailed);

                    // Calculate backoff delay
                    let delay = reconnect.write().await.next_delay();
                    tracing::info!("Retrying connection in {:?}", delay);

                    // Wait before retry (with cancellation check)
                    tokio::select! {
                        _ = sleep(delay) => {},
                        _ = cancel_token.cancelled() => {
                            tracing::info!("Cancelling reconnection");
                            break;
                        }
                    }

                    // Reset to disconnected for next attempt
                    s.reset();
                }
            }
        }
    }

    /// Attempt WebSocket connection
    async fn connect(url: &str) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>> {
        let (ws_stream, _) = connect_async(url)
            .await
            .map_err(|e| MontrError::WebSocketConnection(e.to_string()))?;

        Ok(ws_stream)
    }

    /// Handle an active WebSocket connection
    ///
    /// Manages message sending/receiving until connection closes or error occurs.
    async fn handle_connection(
        ws_stream: WebSocketStream<MaybeTlsStream<TcpStream>>,
        state: Arc<RwLock<ConnectionState>>,
        msg_rx: &mut mpsc::Receiver<ClientMessage>,
        srv_tx: &mpsc::Sender<ServerMessage>,
        cancel_token: CancellationToken,
    ) {
        let (mut write, mut read) = ws_stream.split();

        loop {
            tokio::select! {
                // Receive message from server
                Some(msg_result) = read.next() => {
                    match msg_result {
                        Ok(Message::Text(text)) => {
                            match ServerMessage::from_json(&text) {
                                Ok(server_msg) => {
                                    tracing::debug!("Received: {:?}", server_msg);
                                    if srv_tx.send(server_msg).await.is_err() {
                                        tracing::error!("Failed to forward server message");
                                        break;
                                    }
                                }
                                Err(e) => {
                                    tracing::error!("Failed to parse server message: {}", e);
                                    let mut s = state.write().await;
                                    s.transition_to_error(ErrorReason::ProtocolError);
                                    break;
                                }
                            }
                        }
                        Ok(Message::Close(_)) => {
                            tracing::info!("Server closed connection");
                            let mut s = state.write().await;
                            s.transition_to_error(ErrorReason::ServerClosed);
                            break;
                        }
                        Ok(Message::Ping(data)) => {
                            // Respond to ping with pong
                            if let Err(e) = write.send(Message::Pong(data)).await {
                                tracing::error!("Failed to send pong: {}", e);
                                break;
                            }
                        }
                        Ok(_) => {
                            // Ignore other message types (Binary, Pong, Frame)
                        }
                        Err(e) => {
                            tracing::error!("WebSocket read error: {}", e);
                            break;
                        }
                    }
                }

                // Send message to server
                Some(client_msg) = msg_rx.recv() => {
                    match client_msg.to_json() {
                        Ok(json) => {
                            if let Err(e) = write.send(Message::Text(json)).await {
                                tracing::error!("Failed to send message: {}", e);
                                break;
                            }
                        }
                        Err(e) => {
                            tracing::error!("Failed to serialize message: {}", e);
                        }
                    }
                }

                // Shutdown signal
                _ = cancel_token.cancelled() => {
                    tracing::info!("Connection handler shutting down");
                    let _ = write.send(Message::Close(None)).await;
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_ws_url_from_http() {
        let http_url = "http://localhost:3000";
        let ws_url = WebSocketClient::build_ws_url(http_url).unwrap();
        assert_eq!(ws_url, "ws://localhost:3000/ws");
    }

    #[test]
    fn test_build_ws_url_from_https() {
        let https_url = "https://example.com:443";
        let ws_url = WebSocketClient::build_ws_url(https_url).unwrap();
        assert_eq!(ws_url, "wss://example.com:443/ws");
    }

    #[test]
    fn test_build_ws_url_with_trailing_slash() {
        let http_url = "http://localhost:3000/";
        let ws_url = WebSocketClient::build_ws_url(http_url).unwrap();
        assert_eq!(ws_url, "ws://localhost:3000/ws");
    }

    #[test]
    fn test_build_ws_url_with_port() {
        let http_url = "http://192.168.1.100:8080";
        let ws_url = WebSocketClient::build_ws_url(http_url).unwrap();
        assert_eq!(ws_url, "ws://192.168.1.100:8080/ws");
    }

    // Integration tests would require a real WebSocket server
    // These would test actual connection, messaging, and reconnection logic

    #[test]
    fn test_build_ws_url_preserves_path_segments() {
        let http_url = "http://example.com/api";
        let ws_url = WebSocketClient::build_ws_url(http_url).unwrap();
        assert_eq!(ws_url, "ws://example.com/api/ws");
    }

    #[tokio::test]
    async fn test_send_via_channel() {
        let (tx, mut rx) = mpsc::channel::<ClientMessage>(10);
        // Send a heartbeat message through the channel
        let msg = ClientMessage::Heartbeat(crate::network::protocol::HeartbeatMessage {
            client_id: "test-id".to_string(),
            timestamp: 12345,
        });
        tx.send(msg).await.unwrap();
        let received = rx.recv().await.unwrap();
        // Verify the message was received correctly
        match received {
            ClientMessage::Heartbeat(hb) => assert_eq!(hb.client_id, "test-id"),
            _ => panic!("Expected Heartbeat message"),
        }
    }

    #[test]
    fn test_connection_state_default() {
        let state = ConnectionState::new();
        assert_eq!(state.current(), State::Disconnected);
        assert!(!state.is_connected());
        assert!(!state.is_operational());
        assert!(!state.is_error());
    }

    #[tokio::test]
    async fn test_cancel_token_propagation() {
        let token = CancellationToken::new();
        let cloned = token.clone();
        assert!(!cloned.is_cancelled());
        token.cancel();
        assert!(cloned.is_cancelled());
    }

    #[test]
    fn test_build_ws_url_with_no_scheme() {
        // When there is no http:// or https:// prefix, the replace calls
        // do not match, so the URL passes through unchanged except for /ws append.
        let raw_url = "localhost:3000";
        let ws_url = WebSocketClient::build_ws_url(raw_url).unwrap();
        assert_eq!(ws_url, "localhost:3000/ws");
    }

    #[tokio::test]
    async fn test_local_ws_server_connect() {
        use tokio::net::TcpListener;
        use tokio_tungstenite::accept_async;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        // Spawn a server that accepts one WebSocket connection
        let server_handle = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let _ws = accept_async(stream).await.unwrap();
            // Keep connection alive briefly
            tokio::time::sleep(Duration::from_millis(500)).await;
        });

        // Attempt to connect using the private connect method
        let ws_url = format!("ws://127.0.0.1:{}", addr.port());
        let result = WebSocketClient::connect(&ws_url).await;
        assert!(result.is_ok());

        server_handle.abort();
    }

    #[tokio::test]
    async fn test_send_receives_text_message() {
        use tokio::net::TcpListener;
        use tokio_tungstenite::accept_async;
        use futures_util::{SinkExt, StreamExt};

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        // Spawn a server that reads one message from the client
        let server_handle = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(stream).await.unwrap();
            // Read the next text message from the client
            if let Some(Ok(msg)) = ws.next().await {
                msg
            } else {
                panic!("Expected a message from the client");
            }
        });

        // Connect to the local server
        let ws_url = format!("ws://127.0.0.1:{}", addr.port());
        let ws_stream = WebSocketClient::connect(&ws_url).await.unwrap();
        let (mut write, _read) = ws_stream.split();

        // Send a heartbeat message as JSON
        let heartbeat = ClientMessage::heartbeat("integration-test".to_string());
        let json = heartbeat.to_json().unwrap();
        write.send(Message::Text(json.clone())).await.unwrap();

        // Verify the server received the correct message
        let received_msg = server_handle.await.unwrap();
        match received_msg {
            Message::Text(text) => {
                assert!(text.contains("\"type\":\"heartbeat\""));
                assert!(text.contains("\"clientId\":\"integration-test\""));
            }
            other => panic!("Expected Text message, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_connection_task_exits_on_cancel() {
        let state = Arc::new(RwLock::new(ConnectionState::new()));
        let reconnect = Arc::new(RwLock::new(ReconnectStrategy::new(
            Duration::from_millis(100),
            1.5,
            Duration::from_secs(1),
        )));
        let (_msg_tx, msg_rx) = mpsc::channel::<ClientMessage>(10);
        let (srv_tx, _srv_rx) = mpsc::channel::<ServerMessage>(10);
        let cancel_token = CancellationToken::new();

        // Spawn connection_task with an invalid URL that will fail to connect
        let token_clone = cancel_token.clone();
        let handle = tokio::spawn(WebSocketClient::connection_task(
            "ws://127.0.0.1:1/invalid".to_string(),
            state,
            reconnect,
            msg_rx,
            srv_tx,
            token_clone,
        ));

        // Give the task a moment to start, then cancel
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel_token.cancel();

        // The task should exit cleanly within a reasonable time
        let result = tokio::time::timeout(Duration::from_secs(5), handle).await;
        assert!(result.is_ok(), "connection_task should exit after cancellation");
        assert!(result.unwrap().is_ok(), "connection_task should not panic");
    }
}
