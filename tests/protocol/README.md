# Protocol Validation Tests

This directory contains cross-language protocol validation tests to ensure the Rust client and Node.js server can communicate correctly.

## Directory Structure

```
protocol/
├── fixtures/              # Shared JSON test fixtures
│   ├── register.json
│   ├── status_update.json
│   ├── heartbeat.json
│   └── playlist_assigned.json
├── server-protocol.test.ts  # Server-side tests (TypeScript)
└── README.md             # This file
```

The Rust client tests are in `client/tests/protocol_validation.rs`.

## Purpose

These tests verify that:
1. The server can parse messages the client sends
2. The client can parse messages the server sends
3. Both sides agree on the JSON structure
4. Optional/required fields are handled correctly
5. Invalid messages are properly rejected

## Running Tests

### Server-Side Tests (TypeScript)

```bash
cd server
npm test tests/protocol/server-protocol.test.ts
```

Or run all tests:
```bash
cd server
npm test
```

### Client-Side Tests (Rust)

```bash
cd client
cargo test protocol_validation
```

Or run all tests:
```bash
cd client
cargo test
```

## Test Coverage

### Client → Server Messages

✅ `register` - Client registration with capabilities
✅ `status_update` - Playback status updates
✅ `heartbeat` - Keep-alive messages
✅ `error` - Error reporting (planned)

### Server → Client Messages

✅ `playlist_assigned` - Initial playlist assignment
✅ `playlist_updated` - Playlist changes (planned)
✅ `command` - Server commands (planned)

## Adding New Message Types

When adding a new message type to the protocol:

1. **Define the type** in both codebases:
   - Server: `server/src/websocket/types.ts`
   - Client: `client/src/network/protocol.rs`

2. **Create a fixture**: Add a JSON file in `tests/protocol/fixtures/`
   ```json
   {
     "type": "new_message_type",
     "field1": "value1",
     "field2": 123
   }
   ```

3. **Add server test** in `server-protocol.test.ts`:
   ```typescript
   it('should parse new_message_type correctly', () => {
     const json = readFileSync(join(fixturesDir, 'new_message_type.json'), 'utf-8');
     const data = JSON.parse(json);
     const result = newMessageSchema.safeParse(data);
     expect(result.success).toBe(true);
   });
   ```

4. **Add client test** in `client/tests/protocol_validation.rs`:
   ```rust
   #[test]
   fn test_new_message_type_serialization() {
       let json = read_fixture("new_message_type.json");
       let parsed: ClientMessage = serde_json::from_str(&json).expect("Failed to parse");
       // Add assertions...
   }
   ```

5. **Run both test suites** to verify compatibility

## Why These Tests Matter

Protocol validation tests are your **first line of defense** against breaking changes:

- ⚡ **Fast**: Run in milliseconds, no process spawning needed
- 🔍 **Precise**: Pinpoint exact incompatibilities
- 🛡️ **Safe**: Catch issues before integration testing
- 📦 **Portable**: Run in CI/CD without complex setup
- 🔄 **Bidirectional**: Test both directions of communication

## Continuous Integration

These tests should run on every commit:

```yaml
# .github/workflows/protocol-tests.yml
- name: Run protocol validation tests
  run: |
    # Server tests
    cd server && npm test tests/protocol/

    # Client tests
    cd client && cargo test protocol_validation
```

## Troubleshooting

### Test fails: "Failed to read fixture"

Make sure you're running tests from the correct directory:
- Server tests: Run from `server/` directory
- Client tests: Run from `client/` directory

### Test fails: "Failed to parse message"

This indicates a protocol incompatibility:
1. Check the fixture JSON matches both type definitions
2. Verify all required fields are present
3. Check field names match exactly (case-sensitive)
4. Verify enum values match (e.g., "video" vs "Video")

### Want more detailed output?

Server tests:
```bash
npm test -- --verbose
```

Client tests:
```bash
cargo test protocol_validation -- --nocapture
```

## Future Enhancements

- [ ] Add command message tests
- [ ] Add error message tests
- [ ] Add playlist_updated tests
- [ ] Generate fixtures from code (schema-driven)
- [ ] Add performance benchmarks
- [ ] Test edge cases (very large playlists, special characters, etc.)

## Related Documentation

- [Integration Testing Guide](../../docs/integration-testing.md) - Full testing strategy
- [WebSocket Protocol](../../docs/websocket-protocol.md) - Protocol specification
- [API Specification](../../docs/api-specification.md) - REST API reference
