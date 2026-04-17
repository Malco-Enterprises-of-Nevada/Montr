# Communication Protocol

Protocol version: **1.1.0**

All messages are JSON-encoded and exchanged over WebSocket. Messages are discriminated by a top-level `type` field (no outer envelope or version wrapper).

This document defines the **message contract** that both the TypeScript server and Rust client implement. For connection lifecycle, heartbeat timing, and reconnection behavior, see [docs/websocket-protocol.md](../docs/websocket-protocol.md).

---

## Client-to-Server Messages

### register

Sent as the first message after connecting. Identifies the client and its capabilities.

```json
{
  "type": "register",
  "clientId": "550e8400-e29b-41d4-a716-446655440000",
  "version": "1.0.0",
  "capabilities": {
    "video": true,
    "image": true
  }
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `type` | string | yes | Literal `"register"` |
| `clientId` | string | yes | Valid UUID |
| `version` | string | yes | Non-empty |
| `capabilities` | object | yes | `{ video: boolean, image: boolean }` |

### status_update

Reports current playback state. Sent periodically (default every 10 seconds) and on state changes.

```json
{
  "type": "status_update",
  "clientId": "550e8400-e29b-41d4-a716-446655440000",
  "currentMedia": {
    "id": 1,
    "filename": "video.mp4"
  },
  "position": 45.2,
  "isPlaying": true,
  "timestamp": 1711800000000
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `type` | string | yes | Literal `"status_update"` |
| `clientId` | string | yes | Valid UUID |
| `currentMedia` | object\|null | yes | `{ id: number, filename: string }` or `null` |
| `position` | number\|null | yes | >= 0 or `null` |
| `isPlaying` | boolean | yes | |
| `timestamp` | number | yes | Unix epoch milliseconds |

### heartbeat

Keep-alive signal. Sent every 30 seconds (configurable).

```json
{
  "type": "heartbeat",
  "clientId": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": 1711800000000
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `type` | string | yes | Literal `"heartbeat"` |
| `clientId` | string | yes | Valid UUID |
| `timestamp` | number | yes | Unix epoch milliseconds |

### error

Reports a client-side error to the server.

```json
{
  "type": "error",
  "clientId": "550e8400-e29b-41d4-a716-446655440000",
  "error": "Failed to download media file",
  "context": {
    "mediaId": "5",
    "httpStatus": "404"
  },
  "timestamp": 1711800000000
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `type` | string | yes | Literal `"error"` |
| `clientId` | string | yes | Valid UUID |
| `error` | string | yes | Non-empty |
| `context` | object | no | Key-value map of additional context |
| `timestamp` | number | no | Unix epoch milliseconds |

---

## Server-to-Client Messages

### playlist_assigned

Sent when a playlist is assigned to the client (via REST API or on registration if a playlist is already assigned).

```json
{
  "type": "playlist_assigned",
  "playlistId": 1,
  "playlistName": "Lobby Display",
  "loopPlaylist": true,
  "items": [
    {
      "id": 10,
      "mediaId": 1,
      "filename": "video.mp4",
      "downloadUrl": "/api/media/1/download",
      "type": "video",
      "duration": 120.5,
      "checksum": "abc123sha256hash",
      "orderIndex": 0,
      "imageDuration": 5
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | Literal `"playlist_assigned"` |
| `playlistId` | number | yes | Playlist ID |
| `playlistName` | string | yes | Playlist display name |
| `loopPlaylist` | boolean | yes | Whether to loop playback |
| `items` | array | yes | Array of PlaylistMediaItem (see below) |

### playlist_updated

Sent when a playlist's items are modified (add, remove, reorder) while assigned to a connected client.

```json
{
  "type": "playlist_updated",
  "playlistId": 1,
  "loopPlaylist": true,
  "items": [ ... ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | Literal `"playlist_updated"` |
| `playlistId` | number | yes | Playlist ID |
| `loopPlaylist` | boolean | yes | Whether to loop playback |
| `items` | array | yes | Updated PlaylistMediaItem array |

### command

Remote control command sent to a client.

```json
{
  "type": "command",
  "command": "pause"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | Literal `"command"` |
| `command` | string | yes | One of: `"reload_playlist"`, `"pause"`, `"resume"` |

**Note:** The Rust client also defines an `args` field (`HashMap<String, Value>`) for future extensibility (e.g., skip with target index). The TypeScript server does not currently send `args`.

### error_response

Sent when the server encounters an error processing a client message.

```json
{
  "type": "error_response",
  "error": "Client not registered",
  "details": "Send a register message first"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | Literal `"error_response"` |
| `error` | string | yes | Error description |
| `details` | string | no | Additional detail |

### success

Acknowledgment of a successful operation (e.g., registration).

```json
{
  "type": "success",
  "message": "Client registered successfully"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | yes | Literal `"success"` |
| `message` | string | yes | Success description |

---

## Shared Types

### PlaylistMediaItem

Represents a single item in a playlist, sent within `playlist_assigned` and `playlist_updated` messages.

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Playlist item ID |
| `mediaId` | number | Media file ID |
| `filename` | string | Generated filename |
| `downloadUrl` | string | HTTP path to download the file (e.g., `/api/media/1/download`) |
| `type` | string | `"video"` or `"image"` |
| `duration` | number\|undefined | Duration in seconds (videos only) |
| `checksum` | string\|null | SHA-256 hash for integrity verification |
| `orderIndex` | number | 0-indexed position in playlist |
| `imageDuration` | number | Display duration for images in seconds |
| `subtitles` | SubtitleTrack[] | Subtitle tracks for this item (always an array; empty if none). **Added in 1.1.0.** |

### SubtitleTrack

Represents one subtitle track attached to a media item. Two kinds exist:
- `external`: a standalone `.srt` or `.vtt` file uploaded and served by the server.
- `embedded`: a subtitle stream already carried inside the video container (e.g. MKV).

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Subtitle track ID |
| `kind` | string | `"external"` or `"embedded"` |
| `language` | string\|null | ISO 639-2 language code (e.g. `"eng"`) when known |
| `label` | string\|null | User-visible display name |
| `isDefault` | boolean | Server-marked default track for its media |
| `isForced` | boolean | Forced-display track (plays without user toggle) |
| `downloadUrl` | string | *(external only)* HTTP path to download the subtitle file |
| `filename` | string | *(external only)* Suggested cache-local filename hint |
| `format` | string | *(external only)* `"srt"` or `"vtt"` |
| `checksum` | string | *(external only)* SHA-256 hash for integrity verification |
| `streamIndex` | number | *(embedded only)* ffprobe stream index inside the parent container |
| `codec` | string | *(embedded only)* e.g. `"subrip"`, `"mov_text"`, `"webvtt"` |

### CurrentMediaInfo

Sent within `status_update` to identify the currently playing media.

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Media file ID |
| `filename` | string | Media filename |

### ClientCapabilities

Declares what media types the client can play.

| Field | Type | Description |
|-------|------|-------------|
| `video` | boolean | Can play video files |
| `image` | boolean | Can display images |

---

## Serialization Notes

- **JSON field names** use camelCase (e.g., `clientId`, `isPlaying`, `orderIndex`)
- **TypeScript** uses interfaces with Zod validation schemas for runtime type checking. Messages are parsed via `z.discriminatedUnion('type', [...])`.
- **Rust** uses serde with `#[serde(tag = "type", rename_all = "snake_case")]` for the discriminated union encoding. Individual fields use `#[serde(rename = "camelCase")]` to match the JSON wire format.
- **Direction:** Rust `ClientMessage` derives `Serialize` only; `ServerMessage` derives `Deserialize` only. TypeScript handles both directions.

## Compatibility

Both the TypeScript server (`server/src/websocket/types.ts`) and Rust client (`client/src/network/protocol.rs`) must be kept in sync. Any protocol change requires updating both files.

The Rust client's `ServerMessage` enum currently handles `playlist_assigned`, `playlist_updated`, and `command`. The `error_response` and `success` message types are handled separately as raw JSON in the client's WebSocket message processing.

## Changelog

- **1.1.0** — Added `subtitles: SubtitleTrack[]` to `PlaylistMediaItem`. Additive only; 1.0.0 clients safely ignore the new field (Rust deserializer uses `serde(default)`).
- **1.0.0** — Initial versioned contract.

---

*This document reflects protocol version 1.1.0.*
