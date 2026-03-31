# WebSocket Protocol

The Montr server provides a WebSocket endpoint for real-time bidirectional communication with playback clients. For the complete message schema reference, see [shared/protocol.md](../shared/protocol.md).

---

## Connection

- **Endpoint:** `ws://<host>:<port>/ws`
- **Transport:** JSON over WebSocket
- **Authentication:** None at the WebSocket level. The `register` message serves as identification.

## Lifecycle

```
Client                                  Server
  │                                       │
  │──── WebSocket connect ──────────────►│  ws://server:3000/ws
  │                                       │  Sets isAlive=true, lastHeartbeat=now
  │                                       │
  │──── register ──────────────────────►│  Creates/updates client in DB
  │◄──── success ───────────────────────│  "Registration successful"
  │◄──── playlist_assigned ─────────────│  (if client has assigned playlist)
  │                                       │
  │──── heartbeat (every 30s) ─────────►│  Updates last_seen in DB
  │◄──── ping (every 30s) ──────────────│  Health check
  │──── pong ──────────────────────────►│  Marks connection alive
  │                                       │
  │──── status_update (every 10s) ─────►│  Records playback status in DB
  │                                       │
  │◄──── playlist_updated ──────────────│  (when playlist items change)
  │◄──── command ───────────────────────│  (reload_playlist, pause, resume)
  │                                       │
  │──── close / disconnect ────────────►│  Sets client status to "offline"
  │                                       │
```

## Registration

The first message a client sends **must** be `register`. Sending any other message type before registering results in an `error_response`.

**On success:**
1. Server creates the client in the database (or updates if it already exists)
2. Connection is added to `ClientConnectionManager`
3. Server sends `{ type: "success", message: "Registration successful" }`
4. If the client has an `assigned_playlist_id`, server immediately sends `playlist_assigned`

**On failure:**
- Server sends `error_response` and closes the connection with WebSocket close code `1008`

**Reconnection:** If a client reconnects with the same `clientId`, the old connection is closed (code `1000`, "New connection established") and replaced.

## Heartbeat Mechanism

Two independent heartbeat mechanisms run in parallel:

### Application-level heartbeat
- Client sends `heartbeat` messages at a configurable interval (default: 30 seconds, set via `[server].heartbeat_interval` in client config)
- Server updates `last_seen` in the database and refreshes the connection's `lastHeartbeat` timestamp

### WebSocket-level ping/pong
- Server pings all connections at `WS_HEALTH_CHECK_INTERVAL` (default: 30,000 ms)
- Each ping sets `isAlive = false` for the connection
- A pong response sets `isAlive = true`
- On the next health check, connections still marked `isAlive = false` are terminated

### Heartbeat timeout
- If a connection's `lastHeartbeat` exceeds `WS_HEARTBEAT_TIMEOUT` (default: 5,000 ms since the health check compares against this), the connection is marked not alive
- This is a two-strike system: miss one health check cycle and you're warned, miss two and you're disconnected

## Stale Connection Cleanup

A separate interval runs at `WS_STALE_TIMEOUT` (default: 300,000 ms / 5 minutes):
- Scans all connections
- Any connection whose `lastHeartbeat` is older than `WS_STALE_TIMEOUT` is removed
- Client status is set to `"offline"` in the database

## Client Reconnection Strategy

The Rust client implements automatic reconnection with exponential backoff:

- **Base delay:** 5 seconds
- **Multiplier:** 1.5x per attempt
- **Maximum delay:** 300 seconds (5 minutes)
- **Jitter:** +/-20% to prevent thundering herd
- **Reset:** Delay resets to base on successful connection

The client maintains a channel-based outgoing message queue (1,000-message buffer). Messages queued during disconnection are sent after reconnection and re-registration.

## Message Routing

The server routes incoming messages by the `type` field:

| Type | Handler | Requires Registration |
|------|---------|----------------------|
| `register` | Creates/updates client, sends playlist | No |
| `status_update` | Records playback status in DB | Yes |
| `heartbeat` | Updates last_seen timestamp | Yes |
| `error` | Logs error, sets client status to `"error"` | Yes |

Unregistered clients sending `status_update`, `heartbeat`, or `error` receive an `error_response` with "Client not registered".

## Playlist Distribution

### On assignment (via REST API)
When `PUT /api/clients/:id` sets `assigned_playlist_id`, the server:
1. Loads the playlist with all items
2. Builds `PlaylistMediaItem` objects with `downloadUrl` pointing to `/api/media/:id/download`
3. Sends `playlist_assigned` to the connected client

### On playlist modification
When playlist items are added, removed, reordered, or updated:
1. Server loads the updated playlist
2. Broadcasts `playlist_updated` to all connected clients assigned to that playlist

The `downloadUrl` field uses `PUBLIC_URL` if configured, otherwise defaults to `http://localhost:<port>`.

## Commands

The server can send `command` messages to clients:

| Command | Effect |
|---------|--------|
| `reload_playlist` | Client re-downloads and restarts the current playlist |
| `pause` | Client pauses playback |
| `resume` | Client resumes playback |

Commands can target a single client (`sendCommandToClient`) or all connected clients (`broadcastCommand`).

## Error Handling

| Scenario | Server Action |
|----------|--------------|
| Invalid JSON | Sends `error_response` with "Invalid message format" |
| Zod validation failure | Sends `error_response` with validation error details |
| Unregistered client (non-register message) | Sends `error_response` with "Client not registered" |
| Registration failure | Sends `error_response`, closes connection (code 1008) |
| Unknown message type | Sends `error_response` with "Unknown message type" |

## Disconnection

When a WebSocket connection closes:
1. Server logs the close code and reason
2. Connection is removed from `ClientConnectionManager`
3. Client status is updated to `"offline"` in the database
4. Unregistered connections (never sent `register`) are silently dropped

## Connection Statistics

The `WebSocketStats` object is available via `GET /api/health`:

| Field | Type | Description |
|-------|------|-------------|
| `totalConnections` | number | Cumulative connections since server start |
| `activeConnections` | number | Currently open connections |
| `messagesSent` | number | Total messages sent to clients |
| `messagesReceived` | number | Total messages received from clients |
| `errors` | number | Cumulative error count |

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_HEARTBEAT_INTERVAL` | 30000 ms | Interval for application heartbeat (client config) |
| `WS_HEARTBEAT_TIMEOUT` | 5000 ms | Time before a connection is marked not alive |
| `WS_HEALTH_CHECK_INTERVAL` | 30000 ms | Server-side ping/pong health check interval |
| `WS_STALE_TIMEOUT` | 300000 ms | Time before a stale connection is removed |

---

*For message schemas, see [shared/protocol.md](../shared/protocol.md). For REST API, see [api-specification.md](api-specification.md).*
