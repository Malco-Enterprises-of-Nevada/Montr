# Troubleshooting Guide

## Quick Diagnostics

Check server health:
```bash
curl http://localhost:3000/api/health
```

A healthy response includes `"status": "ok"` and WebSocket statistics. If this fails, the server is down or unreachable.

---

## Server Issues

### Server won't start: EADDRINUSE

**Symptom:** `Port 3000 is already in use`

**Fix:** Another process is using the port. Either stop it or change `PORT` in `.env`:
```bash
lsof -i :3000           # Find the process
PORT=3001 npm run dev    # Or use a different port
```

### Server won't start: DB_TYPE required

**Symptom:** `DB_TYPE environment variable is required`

**Fix:** Ensure `.env` file exists in `server/` with `DB_TYPE=sqlite` (or mysql/mssql/mongodb). Copy from `.env.example`:
```bash
cp .env.example .env
```

### Server won't start: DB_PATH required

**Symptom:** `DB_PATH is required for SQLite`

**Fix:** Set `DB_PATH` in `.env` when using SQLite:
```bash
DB_TYPE=sqlite
DB_PATH=./data/montr.db
```

### Server won't start: MySQL/MSSQL/MongoDB connection

**Symptom:** `MYSQL_HOST, MYSQL_USER, and MYSQL_DATABASE are required for MySQL` (or equivalent for other databases)

**Fix:** Set all required database variables. See [configuration.md](configuration.md) for the full list per database type.

### API returns 401 Unauthorized

**Symptom:** `{"error":{"code":"UNAUTHORIZED","message":"API key is required"}}`

**Cause:** `API_KEY_REQUIRED=true` in `.env` but no `X-API-Key` header sent, or the key doesn't match.

**Fix:**
```bash
# Either disable auth
API_KEY_REQUIRED=false

# Or provide the correct key
curl -H "X-API-Key: your-key" http://localhost:3000/api/media
```

If `API_KEY_REQUIRED=true` but `API_KEY` is empty, the server logs a warning and rejects all authenticated requests.

### CORS errors in browser

**Symptom:** Browser console shows `Access-Control-Allow-Origin` errors.

**Fix:** Add your frontend URL to `ALLOWED_ORIGINS` in `.env`:
```bash
ALLOWED_ORIGINS=http://localhost:3000,http://your-frontend:8080
```

---

## Client Issues

### Config file not found

**Symptom:** `ConfigNotFound` error on startup.

**Fix:** Specify the config path explicitly or place it in a search path:
```bash
montr-client --config /path/to/config.toml
```

Search paths: `./config.toml`, `~/.config/montr-client/config.toml`, `/etc/montr-client/config.toml`

### Invalid client ID

**Symptom:** `InvalidClientId` error.

**Fix:** The `[client].id` field must be a valid UUID or left empty (auto-generated). Remove any non-UUID value.

### Connection refused

**Symptom:** Client can't connect to server.

**Fix:**
1. Verify server is running: `curl http://server:3000/api/health`
2. Check `[server].url` in `config.toml` matches the server address
3. Ensure the port is open (firewall rules)
4. Check the URL scheme (`http://` not `https://` unless TLS is configured)

### WebSocket keeps disconnecting

**Symptom:** Client repeatedly reconnects (visible in logs).

**Causes:**
- Network instability between client and server
- Server's `WS_STALE_TIMEOUT` too short for the client's heartbeat interval
- Firewall or proxy terminating idle connections

**Fix:** Ensure `heartbeat_interval` (client) is well under `WS_STALE_TIMEOUT` (server, default 300s). The client auto-reconnects with exponential backoff.

---

## Upload Issues

### INVALID_MEDIA_TYPE

**Symptom:** `Unsupported file type: application/pdf`

**Fix:** Only these MIME types are accepted:
- Video: `video/mp4`, `video/mpeg`, `video/quicktime`, `video/x-msvideo`, `video/x-matroska`, `video/webm`
- Image: `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `image/bmp`

### FILE_TOO_LARGE

**Symptom:** Upload rejected for exceeding size limit.

**Fix:** Increase `MAX_UPLOAD_SIZE_MB` in `.env` (default: 500 MB).

### No files provided

**Symptom:** `{"error":{"code":"BAD_REQUEST","message":"No files provided"}}`

**Fix:** The multipart form field name must be `files`:
```bash
curl -X POST http://localhost:3000/api/media/upload -F "files=@video.mp4"
```

### RESOURCE_ALREADY_EXISTS (duplicate)

**Symptom:** Upload rejected with duplicate checksum error.

**Fix:** The file has already been uploaded (same SHA-256 hash). This is intentional duplicate detection.

---

## Playback Issues

### Client not receiving playlist

**Causes:**
1. No playlist assigned: Check `GET /api/clients/:id` — `assigned_playlist_id` should not be null
2. Client not connected via WebSocket: Check `GET /api/health` for `activeConnections`
3. Playlist is empty: Check `GET /api/playlists/:id` for items

**Fix:** Assign a playlist with items:
```bash
curl -X PUT http://localhost:3000/api/clients/<uuid> \
  -H "Content-Type: application/json" \
  -d '{"assigned_playlist_id": 1}'
```

### Media download fails on client

**Causes:**
- `downloadUrl` in playlist message uses wrong base URL
- Server storage path misconfigured
- File was deleted from disk but not from database

**Fix:** Check `PUBLIC_URL` env var matches the server's reachable address. Verify the file exists at `STORAGE_PATH`.

### mpv not installed

**Symptom:** Client crashes or errors about libmpv.

**Fix:** Install the libmpv library:
```bash
# Debian/Ubuntu
sudo apt install libmpv2

# Arch Linux
sudo pacman -S mpv
```

---

## Database Issues

### DATABASE_ERROR

**Symptom:** 500 error with `DATABASE_ERROR` code.

**Fix:** Check server logs (`LOG_FILE` path or stdout) for the underlying database error. Common causes:
- Database file locked (another process has it open)
- Disk full
- Permission denied on database file

### DUPLICATE_ENTRY

**Symptom:** 409 error on create operations.

**Cause:** Unique constraint violation (e.g., duplicate media checksum, duplicate playlist item position).

---

## WebSocket Issues

### Client shows offline despite running

**Causes:**
- Heartbeat not reaching server (network issue)
- `WS_STALE_TIMEOUT` exceeded
- Client failed registration

**Fix:** Check client logs for WebSocket errors. Verify the server is receiving heartbeats by checking `GET /api/clients/:id` — `last_seen` should be recent.

### Messages not delivered to client

**Fix:** Verify the client is registered and connected:
1. Check `GET /api/health` — `activeConnections` should include the client
2. Check client logs for successful registration

---

## Logs

### Server

- **File:** Set via `LOG_FILE` env var (e.g., `./logs/server.log`). If unset, logs go to stdout.
- **Level:** Set via `LOG_LEVEL` (default: `info`)
- **Logger:** Winston

Increase verbosity:
```bash
LOG_LEVEL=debug npm run dev
```

### Client

- **File:** Set via `[system].log_file` in config.toml (platform-specific default)
- **Level:** Set via `[system].log_level` (default: `info`)
- **Logger:** tracing (Rust)

Increase verbosity:
```bash
montr-client --config config.toml --verbose    # debug level
montr-client --config config.toml --trace      # trace level
```

---

## Error Code Reference

| Code | HTTP | Description |
|------|------|-------------|
| `INTERNAL_SERVER_ERROR` | 500 | Unexpected server error |
| `BAD_REQUEST` | 400 | Malformed request |
| `NOT_FOUND` | 404 | Route not found |
| `UNAUTHORIZED` | 401 | Missing or invalid API key |
| `VALIDATION_ERROR` | 400 | Schema validation failed |
| `RESOURCE_NOT_FOUND` | 404 | Entity does not exist |
| `RESOURCE_ALREADY_EXISTS` | 409 | Duplicate resource |
| `MEDIA_NOT_FOUND` | 404 | Media file not found |
| `MEDIA_UPLOAD_FAILED` | 500 | Upload processing failed |
| `INVALID_MEDIA_TYPE` | 400 | Unsupported MIME type |
| `FILE_TOO_LARGE` | 413 | Exceeds upload size limit |
| `PLAYLIST_NOT_FOUND` | 404 | Playlist not found |
| `PLAYLIST_ITEM_NOT_FOUND` | 404 | Playlist item not found |
| `CLIENT_NOT_FOUND` | 404 | Client not found |
| `DATABASE_ERROR` | 500 | Database operation failed |
| `DUPLICATE_ENTRY` | 409 | Unique constraint violation |
| `STORAGE_ERROR` | 500 | File storage failure |
| `FILE_NOT_FOUND` | 404 | Physical file missing |

See [api-specification.md](api-specification.md) for the complete error code table.

---

## Docker Troubleshooting

### Container won't start

**Check:** `docker logs montr-server`

Common issues:
- Volume mount permissions: Ensure the container user can write to mounted volumes
- Port conflict: Change the host port mapping in `docker-compose.yml`

### Healthcheck failing

The server Dockerfile includes a healthcheck: `curl -f http://localhost:3000/api/health`. If it fails:
- The server may still be starting up (30s grace period)
- Database connection may have failed (check logs)

---

*For configuration details, see [configuration.md](configuration.md). For deployment, see [deployment.md](deployment.md).*
