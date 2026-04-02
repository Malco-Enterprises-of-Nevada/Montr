/**
 * WebSocket Integration Tests
 *
 * These tests verify the WebSocket protocol layer used by the Montr client,
 * including message serialization/deserialization, JSON format correctness,
 * and end-to-end message exchange against a local test WebSocket server.
 *
 * Tests are organized into two categories:
 * 1. Protocol-level tests that validate message formats without a server
 * 2. Integration tests that spin up a local WebSocket server to verify
 *    actual message exchange over the wire
 */
mod common;

use futures_util::{SinkExt, StreamExt};
use montr_client::network::protocol::*;
use std::collections::HashMap;
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

// ============================================================================
// Helper: Local WebSocket Test Server
// ============================================================================

/// Start a local WebSocket echo server on an ephemeral port.
///
/// Returns the bound address and a join handle for the server task.
/// The server accepts a single connection and echoes back any text or
/// binary messages it receives until the client disconnects.
async fn start_test_ws_server() -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        if let Ok((stream, _)) = listener.accept().await {
            if let Ok(ws_stream) = accept_async(stream).await {
                let (mut write, mut read) = ws_stream.split();
                while let Some(Ok(msg)) = read.next().await {
                    if msg.is_text() || msg.is_binary() {
                        let _ = write.send(msg).await;
                    }
                }
            }
        }
    });
    (addr, handle)
}

/// Start a local WebSocket server that responds with a predefined message
/// after receiving any text message from the client.
async fn start_test_ws_server_with_response(
    response_json: String,
) -> (std::net::SocketAddr, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        if let Ok((stream, _)) = listener.accept().await {
            if let Ok(ws_stream) = accept_async(stream).await {
                let (mut write, mut read) = ws_stream.split();
                // Wait for the first message from the client, then respond
                if let Some(Ok(_msg)) = read.next().await {
                    let _ = write.send(Message::Text(response_json)).await;
                }
            }
        }
    });
    (addr, handle)
}

// ============================================================================
// Test 1: Register Message Format
// ============================================================================

#[test]
fn test_register_message_format() {
    let msg = ClientMessage::register(
        "ws-test-client-001".to_string(),
        "1.0.0".to_string(),
        ClientCapabilities {
            video: true,
            image: true,
        },
        Some("Test-Client-1".to_string()),
    );

    let json = msg.to_json().expect("Failed to serialize Register message");
    let parsed: serde_json::Value =
        serde_json::from_str(&json).expect("Failed to parse JSON output");

    // Verify discriminator field
    assert_eq!(parsed["type"], "register");

    // Verify required fields and their camelCase names
    assert_eq!(parsed["clientId"], "ws-test-client-001");
    assert_eq!(parsed["version"], "1.0.0");

    // Verify capabilities object
    assert_eq!(parsed["capabilities"]["video"], true);
    assert_eq!(parsed["capabilities"]["image"], true);

    // Verify no unexpected null fields for required data
    assert!(!parsed["clientId"].is_null());
    assert!(!parsed["version"].is_null());
    assert!(!parsed["capabilities"].is_null());
}

// ============================================================================
// Test 2: Status Update Message Format
// ============================================================================

#[test]
fn test_status_update_message_format() {
    let msg = ClientMessage::status_update(
        "ws-test-client-002".to_string(),
        Some(CurrentMediaInfo {
            id: 99,
            filename: "presentation.mp4".to_string(),
        }),
        Some(45.75),
        true,
    );

    let json = msg
        .to_json()
        .expect("Failed to serialize StatusUpdate message");
    let parsed: serde_json::Value =
        serde_json::from_str(&json).expect("Failed to parse JSON output");

    // Verify discriminator
    assert_eq!(parsed["type"], "status_update");

    // Verify camelCase field names used by the wire protocol
    assert_eq!(parsed["clientId"], "ws-test-client-002");
    assert_eq!(parsed["isPlaying"], true);
    assert_eq!(parsed["position"], 45.75);

    // Verify nested currentMedia object
    assert_eq!(parsed["currentMedia"]["id"], 99);
    assert_eq!(parsed["currentMedia"]["filename"], "presentation.mp4");

    // Verify timestamp is a positive integer (milliseconds since epoch)
    let timestamp = parsed["timestamp"]
        .as_u64()
        .expect("timestamp should be u64");
    assert!(timestamp > 0, "timestamp should be positive");
}

// ============================================================================
// Test 3: Heartbeat Message Format
// ============================================================================

#[test]
fn test_heartbeat_message_format() {
    let msg = ClientMessage::heartbeat("ws-test-client-003".to_string());

    let json = msg
        .to_json()
        .expect("Failed to serialize Heartbeat message");
    let parsed: serde_json::Value =
        serde_json::from_str(&json).expect("Failed to parse JSON output");

    // Verify discriminator
    assert_eq!(parsed["type"], "heartbeat");

    // Verify fields
    assert_eq!(parsed["clientId"], "ws-test-client-003");

    // Verify timestamp presence and validity
    let timestamp = parsed["timestamp"]
        .as_u64()
        .expect("timestamp should be u64");
    assert!(timestamp > 0, "timestamp should be positive");

    // Heartbeat should be minimal: only type, clientId, and timestamp
    let obj = parsed.as_object().expect("should be a JSON object");
    assert_eq!(
        obj.len(),
        3,
        "Heartbeat should have exactly 3 fields (type, clientId, timestamp), got: {:?}",
        obj.keys().collect::<Vec<_>>()
    );
}

// ============================================================================
// Test 4: Server Message Parsing
// ============================================================================

#[test]
fn test_server_message_parsing() {
    // Test playlist_assigned
    let playlist_json = r#"{
        "type": "playlist_assigned",
        "playlistId": 42,
        "playlistName": "Lobby Display",
        "items": [
            {
                "id": 1,
                "mediaId": 100,
                "filename": "welcome.mp4",
                "downloadUrl": "http://server:3000/api/media/100/download",
                "type": "video",
                "duration": 60.0,
                "checksum": "abc123def456",
                "orderIndex": 0,
                "imageDuration": 0
            },
            {
                "id": 2,
                "mediaId": 101,
                "filename": "promo.jpg",
                "downloadUrl": "http://server:3000/api/media/101/download",
                "type": "image",
                "checksum": "789xyz",
                "orderIndex": 1,
                "imageDuration": 15
            }
        ],
        "loopPlaylist": true
    }"#;

    let msg = ServerMessage::from_json(playlist_json).expect("Failed to parse playlist_assigned");
    match msg {
        ServerMessage::PlaylistAssigned(assigned) => {
            assert_eq!(assigned.playlist_id, 42);
            assert_eq!(assigned.playlist_name, "Lobby Display");
            assert_eq!(assigned.loop_playlist, true);
            assert_eq!(assigned.items.len(), 2);

            assert_eq!(assigned.items[0].filename, "welcome.mp4");
            assert_eq!(assigned.items[0].media_type, "video");
            assert_eq!(assigned.items[0].duration, Some(60.0));
            assert_eq!(assigned.items[0].order_index, 0);

            assert_eq!(assigned.items[1].filename, "promo.jpg");
            assert_eq!(assigned.items[1].media_type, "image");
            assert_eq!(assigned.items[1].image_duration, 15);
            assert_eq!(assigned.items[1].order_index, 1);
        }
        _ => panic!("Expected PlaylistAssigned, got {:?}", msg),
    }

    // Test command
    let command_json = r#"{
        "type": "command",
        "command": "skip",
        "args": {"direction": "next"}
    }"#;

    let msg = ServerMessage::from_json(command_json).expect("Failed to parse command");
    match msg {
        ServerMessage::Command(cmd) => {
            assert_eq!(cmd.command, "skip");
            let args = cmd.args.as_ref().expect("args should be present");
            assert_eq!(args["direction"], "next");
        }
        _ => panic!("Expected Command, got {:?}", msg),
    }

    // Test playlist_updated
    let updated_json = r#"{
        "type": "playlist_updated",
        "playlistId": 42,
        "items": [],
        "loopPlaylist": false
    }"#;

    let msg = ServerMessage::from_json(updated_json).expect("Failed to parse playlist_updated");
    match msg {
        ServerMessage::PlaylistUpdated(updated) => {
            assert_eq!(updated.playlist_id, 42);
            assert_eq!(updated.loop_playlist, false);
            assert!(updated.items.is_empty());
        }
        _ => panic!("Expected PlaylistUpdated, got {:?}", msg),
    }
}

// ============================================================================
// Test 5: Protocol Message Serialization Roundtrip
// ============================================================================

#[test]
fn test_protocol_message_serialization_roundtrip() {
    // Register roundtrip
    let register = ClientMessage::register(
        "roundtrip-client".to_string(),
        "2.0.0".to_string(),
        ClientCapabilities {
            video: true,
            image: false,
        },
        None,
    );

    let json = register.to_json().unwrap();
    let deserialized: ClientMessage = serde_json::from_str(&json).unwrap();

    match deserialized {
        ClientMessage::Register(msg) => {
            assert_eq!(msg.client_id, "roundtrip-client");
            assert_eq!(msg.version, "2.0.0");
            assert_eq!(msg.capabilities.video, true);
            assert_eq!(msg.capabilities.image, false);
        }
        _ => panic!("Register roundtrip failed: wrong variant"),
    }

    // StatusUpdate roundtrip (with media)
    let status = ClientMessage::status_update(
        "roundtrip-client".to_string(),
        Some(CurrentMediaInfo {
            id: 7,
            filename: "clip.mp4".to_string(),
        }),
        Some(120.25),
        true,
    );

    let json = status.to_json().unwrap();
    let deserialized: ClientMessage = serde_json::from_str(&json).unwrap();

    match deserialized {
        ClientMessage::StatusUpdate(msg) => {
            assert_eq!(msg.client_id, "roundtrip-client");
            assert_eq!(msg.is_playing, true);
            assert_eq!(msg.position, Some(120.25));
            let media = msg.current_media.expect("current_media should be Some");
            assert_eq!(media.id, 7);
            assert_eq!(media.filename, "clip.mp4");
        }
        _ => panic!("StatusUpdate roundtrip failed: wrong variant"),
    }

    // StatusUpdate roundtrip (idle, no media)
    let idle_status =
        ClientMessage::status_update("roundtrip-client".to_string(), None, None, false);

    let json = idle_status.to_json().unwrap();
    let deserialized: ClientMessage = serde_json::from_str(&json).unwrap();

    match deserialized {
        ClientMessage::StatusUpdate(msg) => {
            assert!(msg.current_media.is_none());
            assert!(msg.position.is_none());
            assert_eq!(msg.is_playing, false);
        }
        _ => panic!("Idle StatusUpdate roundtrip failed: wrong variant"),
    }

    // Heartbeat roundtrip
    let heartbeat = ClientMessage::heartbeat("roundtrip-client".to_string());

    let json = heartbeat.to_json().unwrap();
    let deserialized: ClientMessage = serde_json::from_str(&json).unwrap();

    match deserialized {
        ClientMessage::Heartbeat(msg) => {
            assert_eq!(msg.client_id, "roundtrip-client");
            assert!(msg.timestamp > 0);
        }
        _ => panic!("Heartbeat roundtrip failed: wrong variant"),
    }

    // Error message roundtrip
    let mut context = HashMap::new();
    context.insert("media_id".to_string(), serde_json::json!(42));
    context.insert("path".to_string(), serde_json::json!("/cache/video.mp4"));

    let error = ClientMessage::error(
        "roundtrip-client".to_string(),
        "Decode error: unsupported codec".to_string(),
        Some(context),
    );

    let json = error.to_json().unwrap();
    let deserialized: ClientMessage = serde_json::from_str(&json).unwrap();

    match deserialized {
        ClientMessage::Error(msg) => {
            assert_eq!(msg.client_id, "roundtrip-client");
            assert_eq!(msg.error, "Decode error: unsupported codec");
            let ctx = msg.context.expect("context should be present");
            assert_eq!(ctx["media_id"], serde_json::json!(42));
            assert_eq!(ctx["path"], serde_json::json!("/cache/video.mp4"));
        }
        _ => panic!("Error roundtrip failed: wrong variant"),
    }
}

// ============================================================================
// Test 6: WebSocket Echo Integration (client message over the wire)
// ============================================================================

#[tokio::test]
async fn test_websocket_echo_client_messages() {
    let (addr, server_handle) = start_test_ws_server().await;
    let ws_url = format!("ws://{}", addr);

    // Connect to the test server using tokio-tungstenite directly
    let (ws_stream, _) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .expect("Failed to connect to test WebSocket server");

    let (mut write, mut read) = ws_stream.split();

    // Send a Register message
    let register = ClientMessage::register(
        "echo-test-client".to_string(),
        "1.0.0".to_string(),
        ClientCapabilities::default(),
        None,
    );
    let register_json = register.to_json().unwrap();
    write
        .send(Message::Text(register_json.clone()))
        .await
        .expect("Failed to send register");

    // Read the echoed message
    let echoed = read
        .next()
        .await
        .expect("Stream ended unexpectedly")
        .expect("Failed to read echoed message");

    match echoed {
        Message::Text(text) => {
            assert_eq!(
                text, register_json,
                "Echoed message should match sent message"
            );

            // Parse the echoed JSON back into a ClientMessage to confirm integrity
            let parsed: ClientMessage = serde_json::from_str(&text)
                .expect("Echoed message should be valid ClientMessage JSON");

            match parsed {
                ClientMessage::Register(msg) => {
                    assert_eq!(msg.client_id, "echo-test-client");
                    assert_eq!(msg.version, "1.0.0");
                }
                _ => panic!("Echoed message should be Register variant"),
            }
        }
        other => panic!("Expected Text message, got: {:?}", other),
    }

    // Send a Heartbeat message
    let heartbeat = ClientMessage::heartbeat("echo-test-client".to_string());
    let heartbeat_json = heartbeat.to_json().unwrap();
    write
        .send(Message::Text(heartbeat_json.clone()))
        .await
        .expect("Failed to send heartbeat");

    let echoed = read
        .next()
        .await
        .expect("Stream ended unexpectedly")
        .expect("Failed to read echoed heartbeat");

    match echoed {
        Message::Text(text) => {
            let parsed: ClientMessage =
                serde_json::from_str(&text).expect("Echoed heartbeat should be valid JSON");
            match parsed {
                ClientMessage::Heartbeat(msg) => {
                    assert_eq!(msg.client_id, "echo-test-client");
                }
                _ => panic!("Expected Heartbeat variant"),
            }
        }
        other => panic!("Expected Text message, got: {:?}", other),
    }

    // Send a StatusUpdate message
    let status = ClientMessage::status_update(
        "echo-test-client".to_string(),
        Some(CurrentMediaInfo {
            id: 5,
            filename: "intro.mp4".to_string(),
        }),
        Some(10.0),
        true,
    );
    let status_json = status.to_json().unwrap();
    write
        .send(Message::Text(status_json.clone()))
        .await
        .expect("Failed to send status update");

    let echoed = read
        .next()
        .await
        .expect("Stream ended unexpectedly")
        .expect("Failed to read echoed status");

    match echoed {
        Message::Text(text) => {
            let parsed: ClientMessage =
                serde_json::from_str(&text).expect("Echoed status should be valid JSON");
            match parsed {
                ClientMessage::StatusUpdate(msg) => {
                    assert_eq!(msg.client_id, "echo-test-client");
                    assert_eq!(msg.is_playing, true);
                    assert_eq!(msg.position, Some(10.0));
                    let media = msg.current_media.unwrap();
                    assert_eq!(media.id, 5);
                    assert_eq!(media.filename, "intro.mp4");
                }
                _ => panic!("Expected StatusUpdate variant"),
            }
        }
        other => panic!("Expected Text message, got: {:?}", other),
    }

    // Clean up
    drop(write);
    drop(read);
    let _ = server_handle.await;
}

// ============================================================================
// Test 7: WebSocket Server Message Reception
// ============================================================================

#[tokio::test]
async fn test_websocket_server_message_reception() {
    // Server will respond with a playlist_assigned message
    let server_response = serde_json::json!({
        "type": "playlist_assigned",
        "playlistId": 77,
        "playlistName": "Integration Test Playlist",
        "items": [
            {
                "id": 1,
                "mediaId": 200,
                "filename": "test_video.mp4",
                "downloadUrl": "http://localhost:3000/api/media/200/download",
                "type": "video",
                "duration": 30.0,
                "checksum": "sha256abc",
                "orderIndex": 0,
                "imageDuration": 0
            }
        ],
        "loopPlaylist": true
    })
    .to_string();

    let (addr, server_handle) = start_test_ws_server_with_response(server_response).await;
    let ws_url = format!("ws://{}", addr);

    let (ws_stream, _) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .expect("Failed to connect to test server");

    let (mut write, mut read) = ws_stream.split();

    // Send any message to trigger the server response
    let trigger = ClientMessage::heartbeat("reception-test".to_string());
    write
        .send(Message::Text(trigger.to_json().unwrap()))
        .await
        .expect("Failed to send trigger message");

    // Read the server's response
    let response = read
        .next()
        .await
        .expect("Stream ended unexpectedly")
        .expect("Failed to read server response");

    match response {
        Message::Text(text) => {
            // Parse as ServerMessage, which is what the real client would do
            let server_msg =
                ServerMessage::from_json(&text).expect("Should parse as valid ServerMessage");

            match server_msg {
                ServerMessage::PlaylistAssigned(assigned) => {
                    assert_eq!(assigned.playlist_id, 77);
                    assert_eq!(assigned.playlist_name, "Integration Test Playlist");
                    assert_eq!(assigned.loop_playlist, true);
                    assert_eq!(assigned.items.len(), 1);

                    let item = &assigned.items[0];
                    assert_eq!(item.media_id, 200);
                    assert_eq!(item.filename, "test_video.mp4");
                    assert_eq!(item.media_type, "video");
                    assert_eq!(item.duration, Some(30.0));
                    assert_eq!(item.order_index, 0);
                }
                _ => panic!("Expected PlaylistAssigned, got {:?}", server_msg),
            }
        }
        other => panic!("Expected Text message, got: {:?}", other),
    }

    drop(write);
    drop(read);
    let _ = server_handle.await;
}

// ============================================================================
// Test 8: WebSocket Command Message Reception
// ============================================================================

#[tokio::test]
async fn test_websocket_command_message_reception() {
    let server_response = serde_json::json!({
        "type": "command",
        "command": "reload_playlist",
        "args": {
            "force": true,
            "reason": "playlist_modified"
        }
    })
    .to_string();

    let (addr, server_handle) = start_test_ws_server_with_response(server_response).await;
    let ws_url = format!("ws://{}", addr);

    let (ws_stream, _) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .expect("Failed to connect");

    let (mut write, mut read) = ws_stream.split();

    // Send trigger
    write
        .send(Message::Text(
            ClientMessage::heartbeat("cmd-test".to_string())
                .to_json()
                .unwrap(),
        ))
        .await
        .expect("Failed to send");

    // Read command response
    let response = read
        .next()
        .await
        .expect("Stream ended")
        .expect("Read failed");

    match response {
        Message::Text(text) => {
            let server_msg =
                ServerMessage::from_json(&text).expect("Should parse as ServerMessage");
            match server_msg {
                ServerMessage::Command(cmd) => {
                    assert_eq!(cmd.command, "reload_playlist");
                    let args = cmd.args.expect("args should be present");
                    assert_eq!(args["force"], serde_json::json!(true));
                    assert_eq!(args["reason"], serde_json::json!("playlist_modified"));
                }
                _ => panic!("Expected Command, got {:?}", server_msg),
            }
        }
        other => panic!("Expected Text, got {:?}", other),
    }

    drop(write);
    drop(read);
    let _ = server_handle.await;
}
