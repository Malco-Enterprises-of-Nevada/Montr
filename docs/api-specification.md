# API Specification

The Montr server exposes a REST API at `http://<host>:<port>/api/`. All request and response bodies are JSON unless otherwise noted.

---

## Response Format

Every response follows a standard envelope:

```json
// Success
{
  "success": true,
  "data": { ... },
  "error": null
}

// Error
{
  "success": false,
  "data": null,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description",
    "details": null
  }
}
```

## Authentication

Authentication is controlled by the `API_KEY_REQUIRED` environment variable (default: `false`).

When enabled, all `/api/media`, `/api/playlists`, and `/api/clients` routes require an `X-API-Key` header. Utility endpoints (`/api/health`, `/api/version`, `/api/ui-config`) are always public.

```bash
curl -H "X-API-Key: your-secret-key" http://localhost:3000/api/media
```

| Scenario | Status | Response |
|----------|--------|----------|
| Auth disabled | 200 | Normal response |
| No header provided | 401 | `UNAUTHORIZED` — "API key is required" |
| Wrong key | 401 | `UNAUTHORIZED` — "Invalid API key" |

## Validation Errors

Request bodies and query parameters are validated using Zod schemas. A validation failure returns:

```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "details": [
      { "field": "name", "message": "Playlist name is required" }
    ]
  }
}
```

---

## Utility Endpoints

### GET /api/health

Returns server health status and WebSocket statistics.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "status": "ok",
    "timestamp": "2026-03-30T12:00:00.000Z",
    "uptime": 3600.5,
    "environment": "production",
    "websocket": {
      "totalConnections": 10,
      "activeConnections": 3,
      "messagesSent": 150,
      "messagesReceived": 200,
      "errors": 2
    }
  },
  "error": null
}
```

### GET /api/version

**Response 200:**
```json
{
  "success": true,
  "data": {
    "version": "1.0.0",
    "name": "Montr Server"
  },
  "error": null
}
```

### GET /api/ui-config

Returns configurable UI parameters. No authentication required.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "dashboardRefreshInterval": 30000,
    "toastDisplayDuration": 3000
  },
  "error": null
}
```

---

## Media Endpoints

### POST /api/media/upload

Upload one or more media files.

**Content-Type:** `multipart/form-data`
**Field name:** `files` (up to 10 files per request)

**Allowed MIME types:**
- `video/mp4`, `video/mpeg`, `video/quicktime`, `video/x-msvideo`, `video/x-matroska`, `video/webm`
- `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/bmp`

**Max file size:** Controlled by `MAX_UPLOAD_SIZE_MB` (default: 500 MB)

```bash
curl -X POST http://localhost:3000/api/media/upload \
  -F "files=@video.mp4" \
  -F "files=@photo.jpg"
```

**Response 201:**
```json
{
  "success": true,
  "data": {
    "uploaded": [
      {
        "id": 1,
        "filename": "a1b2c3d4-video.mp4",
        "original_filename": "video.mp4",
        "filepath": "media/a1b2c3d4-video.mp4",
        "type": "video",
        "mime_type": "video/mp4",
        "file_size": 10485760,
        "duration": 120.5,
        "width": 1920,
        "height": 1080,
        "checksum": "sha256-hash",
        "created_at": "2026-03-30T12:00:00.000Z",
        "updated_at": "2026-03-30T12:00:00.000Z"
      }
    ],
    "errors": [],
    "count": 1
  },
  "error": null
}
```

**Errors:** `BAD_REQUEST` (no files), `INVALID_MEDIA_TYPE`, `FILE_TOO_LARGE`, `RESOURCE_ALREADY_EXISTS` (duplicate checksum)

### GET /api/media

List media files with pagination and filtering.

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | integer | 1 | Page number (> 0) |
| `limit` | integer | 20 | Items per page (1-100) |
| `type` | string | | Filter by `video` or `image` |
| `search` | string | | Search in filename |

```bash
curl "http://localhost:3000/api/media?page=1&limit=10&type=video"
```

**Response 200:**
```json
{
  "success": true,
  "data": {
    "data": [ ... ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 42,
      "totalPages": 5
    }
  },
  "error": null
}
```

### GET /api/media/:id

Get a single media file by ID.

**Path Parameters:**
- `id` — positive integer

**Response 200:** Single media file object (same shape as upload response items)

**Errors:** `RESOURCE_NOT_FOUND`

### DELETE /api/media/:id

Delete a media file and remove it from all playlists.

**Response 200:**
```json
{
  "success": true,
  "data": { "message": "Media file deleted successfully", "id": 1 },
  "error": null
}
```

### GET /api/media/:id/download

Download the raw media file. Returns the binary file with `Content-Disposition: attachment` header.

### GET /api/media/:id/thumbnail

Returns the thumbnail image for a media file. Generated automatically on upload; generated on-demand if missing.

---

## Playlist Endpoints

### POST /api/playlists

Create a new playlist.

**Body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `name` | string | yes | 1-255 characters, trimmed |
| `description` | string | no | max 1000 characters, trimmed |

```bash
curl -X POST http://localhost:3000/api/playlists \
  -H "Content-Type: application/json" \
  -d '{"name": "Lobby Display", "description": "Videos for the lobby screen"}'
```

**Response 201:** Created playlist object

### GET /api/playlists

List all playlists. No parameters.

**Response 200:** Array of playlist objects

### GET /api/playlists/:id

Get a playlist with all its items and associated media details.

**Response 200:** Playlist object with `items` array, each containing the `media` object

### PUT /api/playlists/:id

Update a playlist's name and/or description. At least one field must be provided.

**Body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `name` | string | no | 1-255 characters if provided |
| `description` | string | no | max 1000 characters |

**Response 200:** Updated playlist object

### DELETE /api/playlists/:id

Delete a playlist and all its items (CASCADE).

**Response 200:**
```json
{
  "success": true,
  "data": { "message": "Playlist deleted successfully", "id": 1 },
  "error": null
}
```

### POST /api/playlists/:id/items

Add media items to a playlist.

**Body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `mediaIds` | number[] | yes | 1-100 positive integers |

```bash
curl -X POST http://localhost:3000/api/playlists/1/items \
  -H "Content-Type: application/json" \
  -d '{"mediaIds": [1, 2, 3]}'
```

**Response 201:** `{ items: [...], count: 3 }`

### PUT /api/playlists/:id/items/:itemId

Update a playlist item's position or image display duration. At least one field required.

**Body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `order_index` | integer | no | >= 0 |
| `image_duration` | integer | no | 1-3600 seconds |

**Response 200:** Updated playlist item

### DELETE /api/playlists/:id/items/:itemId

Remove an item from a playlist.

**Response 200:** `{ message: "Playlist item removed successfully", itemId: 5 }`

### POST /api/playlists/:id/reorder

Reorder all items in a playlist.

**Body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `itemIds` | number[] | yes | Unique positive integers, must include all items |

**Response 200:** `{ message: "Playlist items reordered successfully", playlistId: 1 }`

### GET /api/playlists/:id/stats

Get statistics for a playlist (item count, total duration, etc.).

**Response 200:** Playlist statistics object

---

## Client Endpoints

### POST /api/clients/register

Register a new playback client.

**Body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `id` | string | yes | Valid UUID |
| `name` | string | yes | 1-255 characters, trimmed |
| `version` | string | no | max 50 characters |
| `capabilities` | string | no | Valid JSON string |

```bash
curl -X POST http://localhost:3000/api/clients/register \
  -H "Content-Type: application/json" \
  -d '{"id": "550e8400-e29b-41d4-a716-446655440000", "name": "Lobby Display 1"}'
```

**Response 201:** Created client object

### GET /api/clients

List all clients with optional filters.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Filter by `online`, `offline`, or `error` |
| `assigned_playlist_id` | integer | Filter by assigned playlist |

**Response 200:** Array of client objects

### GET /api/clients/:id

Get a client by UUID.

**Response 200:** Client object

### PUT /api/clients/:id

Update a client (assign playlist, change name).

**Body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `name` | string | no | 1-255 characters if provided |
| `assigned_playlist_id` | integer\|null | no | Positive integer or null to unassign |

At least one field must be provided. Setting `assigned_playlist_id` triggers a `playlist_assigned` WebSocket message to the connected client.

**Response 200:** Updated client object

### DELETE /api/clients/:id

Unregister a client. Removes the client and all its status history (CASCADE).

**Response 200:** `{ message: "Client unregistered successfully", id: "uuid" }`

### GET /api/clients/:id/status

Get a client with its latest playback status.

**Response 200:** Client object with `current_status` field containing the most recent status entry

### POST /api/clients/:id/status

Report playback status (used by clients).

**Body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `is_playing` | boolean | yes | |
| `current_media_id` | integer | no | Positive integer |
| `position` | number | no | >= 0 |
| `error_message` | string | no | max 1000 characters |

**Response 201:** Created status record

### POST /api/clients/:id/heartbeat

Record a client heartbeat. Updates `last_seen` timestamp.

**Response 200:**
```json
{
  "success": true,
  "data": {
    "message": "Heartbeat recorded",
    "timestamp": "2026-03-30T12:00:00.000Z"
  },
  "error": null
}
```

---

## Error Code Reference

| Code | HTTP Status | Description |
|------|------------|-------------|
| `INTERNAL_SERVER_ERROR` | 500 | Unexpected server error |
| `BAD_REQUEST` | 400 | Malformed request |
| `NOT_FOUND` | 404 | Route not found |
| `UNAUTHORIZED` | 401 | Missing or invalid API key |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `VALIDATION_ERROR` | 400 | Request body/query failed schema validation |
| `INVALID_INPUT` | 400 | Semantically invalid input |
| `RESOURCE_NOT_FOUND` | 404 | Requested entity does not exist |
| `RESOURCE_ALREADY_EXISTS` | 409 | Duplicate resource (e.g., checksum collision) |
| `MEDIA_NOT_FOUND` | 404 | Media file not found |
| `MEDIA_UPLOAD_FAILED` | 500 | File processing failed during upload |
| `INVALID_MEDIA_TYPE` | 400 | Unsupported MIME type |
| `FILE_TOO_LARGE` | 413 | Exceeds `MAX_UPLOAD_SIZE_MB` |
| `PLAYLIST_NOT_FOUND` | 404 | Playlist not found |
| `PLAYLIST_ITEM_NOT_FOUND` | 404 | Playlist item not found |
| `PLAYLIST_EMPTY` | 400 | Playlist has no items |
| `INVALID_PLAYLIST_ORDER` | 400 | Invalid reorder request |
| `CLIENT_NOT_FOUND` | 404 | Client not found |
| `CLIENT_ALREADY_REGISTERED` | 409 | Client UUID already exists |
| `CLIENT_OFFLINE` | 400 | Client is not connected |
| `INVALID_CLIENT_STATUS` | 400 | Invalid status value |
| `DATABASE_ERROR` | 500 | Database operation failed |
| `DATABASE_CONNECTION_FAILED` | 500 | Cannot connect to database |
| `DUPLICATE_ENTRY` | 409 | Unique constraint violation |
| `STORAGE_ERROR` | 500 | File storage operation failed |
| `FILE_NOT_FOUND` | 404 | Physical file missing from storage |
| `INSUFFICIENT_STORAGE` | 507 | Storage capacity exceeded |

---

## Common Workflow Example

```bash
# 1. Upload media
curl -X POST http://localhost:3000/api/media/upload -F "files=@video.mp4"

# 2. Create a playlist
curl -X POST http://localhost:3000/api/playlists \
  -H "Content-Type: application/json" \
  -d '{"name": "Lobby"}'

# 3. Add media to playlist
curl -X POST http://localhost:3000/api/playlists/1/items \
  -H "Content-Type: application/json" \
  -d '{"mediaIds": [1]}'

# 4. Assign playlist to a client
curl -X PUT http://localhost:3000/api/clients/550e8400-e29b-41d4-a716-446655440000 \
  -H "Content-Type: application/json" \
  -d '{"assigned_playlist_id": 1}'

# 5. Check client status
curl http://localhost:3000/api/clients/550e8400-e29b-41d4-a716-446655440000/status
```

---

*For real-time communication, see [websocket-protocol.md](websocket-protocol.md). For database schema details, see [database-schema.md](database-schema.md).*
