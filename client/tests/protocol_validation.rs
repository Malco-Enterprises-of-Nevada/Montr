/**
 * Protocol Validation Tests - Client Side (Rust)
 *
 * These tests verify that the Rust client can correctly parse
 * messages from the server and serialize messages to send.
 * Uses shared JSON fixtures to ensure compatibility with server.
 */

#[cfg(test)]
mod protocol_validation_tests {
    use serde_json;
    use std::fs;
    use std::path::PathBuf;

    // Import the protocol types
    use montr_client::network::protocol::*;

    fn get_fixture_path(filename: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/protocol/fixtures")
            .join(filename)
    }

    fn read_fixture(filename: &str) -> String {
        let path = get_fixture_path(filename);
        fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("Failed to read fixture {}: {}", filename, e))
    }

    #[test]
    fn test_register_message_serialization() {
        let json = read_fixture("register.json");

        // Parse as ClientMessage
        let parsed: ClientMessage = serde_json::from_str(&json)
            .expect("Failed to parse register message");

        match parsed {
            ClientMessage::Register(msg) => {
                assert_eq!(msg.client_id, "550e8400-e29b-41d4-a716-446655440000");
                assert_eq!(msg.version, "1.0.0");
                assert!(msg.capabilities.video);
                assert!(msg.capabilities.image);
            }
            _ => panic!("Expected Register message, got {:?}", parsed),
        }
    }

    #[test]
    fn test_status_update_message_serialization() {
        let json = read_fixture("status_update.json");

        let parsed: ClientMessage = serde_json::from_str(&json)
            .expect("Failed to parse status_update message");

        match parsed {
            ClientMessage::StatusUpdate(msg) => {
                assert_eq!(msg.client_id, "550e8400-e29b-41d4-a716-446655440000");
                assert!(msg.current_media.is_some());

                if let Some(media) = msg.current_media {
                    assert_eq!(media.id, 42);
                    assert_eq!(media.filename, "video.mp4");
                }

                assert_eq!(msg.position, Some(15.5));
                assert_eq!(msg.is_playing, true);
                assert_eq!(msg.timestamp, 1704067200000);
            }
            _ => panic!("Expected StatusUpdate message"),
        }
    }

    #[test]
    fn test_heartbeat_message_serialization() {
        let json = read_fixture("heartbeat.json");

        let parsed: ClientMessage = serde_json::from_str(&json)
            .expect("Failed to parse heartbeat message");

        match parsed {
            ClientMessage::Heartbeat(msg) => {
                assert_eq!(msg.client_id, "550e8400-e29b-41d4-a716-446655440000");
                assert_eq!(msg.timestamp, 1704067200000);
            }
            _ => panic!("Expected Heartbeat message"),
        }
    }

    #[test]
    fn test_playlist_assigned_message_deserialization() {
        let json = read_fixture("playlist_assigned.json");

        let parsed: ServerMessage = serde_json::from_str(&json)
            .expect("Failed to parse playlist_assigned message");

        match parsed {
            ServerMessage::PlaylistAssigned(msg) => {
                assert_eq!(msg.playlist_id, 1);
                assert_eq!(msg.items.len(), 2);

                // Check first item (video)
                let video = &msg.items[0];
                assert_eq!(video.id, 1);
                assert_eq!(video.media_id, 42);
                assert_eq!(video.filename, "video.mp4");
                assert_eq!(video.media_type, "video");
                assert_eq!(video.duration, Some(120.5));
                assert_eq!(video.order_index, 0);

                // Check second item (image)
                let image = &msg.items[1];
                assert_eq!(image.id, 2);
                assert_eq!(image.media_id, 43);
                assert_eq!(image.filename, "image.jpg");
                assert_eq!(image.media_type, "image");
                assert_eq!(image.image_duration, 10);
                assert_eq!(image.order_index, 1);
            }
            _ => panic!("Expected PlaylistAssigned message"),
        }
    }

    #[test]
    fn test_round_trip_serialization_register() {
        // Create a message
        let original = ClientMessage::register(
            "test-client-999".to_string(),
            "1.0.0".to_string(),
            ClientCapabilities {
                video: true,
                image: true,
            },
        );

        // Serialize to JSON
        let json = serde_json::to_string(&original)
            .expect("Failed to serialize");

        // Deserialize back
        let parsed: ClientMessage = serde_json::from_str(&json)
            .expect("Failed to deserialize");

        // Verify match
        match (original, parsed) {
            (ClientMessage::Register(orig), ClientMessage::Register(parsed)) => {
                assert_eq!(orig.client_id, parsed.client_id);
                assert_eq!(orig.version, parsed.version);
                assert_eq!(orig.capabilities.video, parsed.capabilities.video);
                assert_eq!(orig.capabilities.image, parsed.capabilities.image);
            }
            _ => panic!("Message type mismatch after round-trip"),
        }
    }

    #[test]
    fn test_round_trip_serialization_status_update() {
        let original = ClientMessage::status_update(
            "test-client-123".to_string(),
            Some(CurrentMediaInfo {
                id: 42,
                filename: "test.mp4".to_string(),
            }),
            Some(30.5),
            true,
        );

        let json = serde_json::to_string(&original)
            .expect("Failed to serialize");

        let parsed: ClientMessage = serde_json::from_str(&json)
            .expect("Failed to deserialize");

        match (original, parsed) {
            (ClientMessage::StatusUpdate(orig), ClientMessage::StatusUpdate(parsed)) => {
                assert_eq!(orig.client_id, parsed.client_id);
                assert_eq!(orig.is_playing, parsed.is_playing);

                if let (Some(orig_media), Some(parsed_media)) = (orig.current_media, parsed.current_media) {
                    assert_eq!(orig_media.id, parsed_media.id);
                    assert_eq!(orig_media.filename, parsed_media.filename);
                }

                assert_eq!(orig.position, parsed.position);
            }
            _ => panic!("Message type mismatch"),
        }
    }

    #[test]
    fn test_invalid_message_handling() {
        // Test that invalid JSON is properly rejected
        let invalid_json = r#"{"type": "invalid_type"}"#;

        let result: Result<ClientMessage, _> = serde_json::from_str(invalid_json);
        assert!(result.is_err(), "Should reject invalid message type");
    }

    #[test]
    fn test_missing_required_fields() {
        // Test that messages with missing required fields are rejected
        let incomplete_json = r#"{"type": "register"}"#;

        let result: Result<ClientMessage, _> = serde_json::from_str(incomplete_json);
        assert!(result.is_err(), "Should reject incomplete message");
    }

    #[test]
    fn test_optional_fields_handling() {
        // Test that optional fields work correctly
        let minimal_status = r#"{
            "type": "status_update",
            "clientId": "test-123",
            "currentMedia": null,
            "position": null,
            "isPlaying": false,
            "timestamp": 1704067200000
        }"#;

        let parsed: ClientMessage = serde_json::from_str(minimal_status)
            .expect("Should parse message with only required fields");

        match parsed {
            ClientMessage::StatusUpdate(msg) => {
                assert_eq!(msg.client_id, "test-123");
                assert_eq!(msg.is_playing, false);
                assert!(msg.current_media.is_none());
                assert!(msg.position.is_none());
            }
            _ => panic!("Expected StatusUpdate message"),
        }
    }

    #[test]
    fn test_compatibility_with_server_fixtures() {
        // This test ensures all fixtures can be parsed
        // If this fails, it means the protocol has drifted

        let fixtures = vec![
            "register.json",
            "status_update.json",
            "heartbeat.json",
        ];

        for fixture in fixtures {
            let json = read_fixture(fixture);
            let result: Result<ClientMessage, _> = serde_json::from_str(&json);

            assert!(
                result.is_ok(),
                "Failed to parse fixture {}: {:?}",
                fixture,
                result.err()
            );
        }

        // Test server → client messages
        let json = read_fixture("playlist_assigned.json");
        let result: Result<ServerMessage, _> = serde_json::from_str(&json);

        assert!(
            result.is_ok(),
            "Failed to parse playlist_assigned fixture: {:?}",
            result.err()
        );
    }
}
