# Configuration Reference

The server is configured via environment variables (`.env` file). The client uses a TOML config file with CLI argument overrides.

---

## Server Configuration

Set these in a `.env` file in the `server/` directory (see `server/.env.example`).

### Server

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `3000` | No | HTTP/WebSocket listen port |
| `HOST` | `0.0.0.0` | No | Bind address |
| `NODE_ENV` | `development` | No | `development` or `production` |
| `PUBLIC_URL` | | No | Base URL for download links (e.g., `https://montr.example.com`). Defaults to `http://localhost:<PORT>` |

### Database

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `DB_TYPE` | | **Yes** | `sqlite`, `mysql`, `mssql`, or `mongodb` |

#### SQLite

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `DB_PATH` | | **Yes** (when DB_TYPE=sqlite) | Path to SQLite file (e.g., `./data/montr.db`). Directory is created automatically. |

#### MySQL

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `MYSQL_HOST` | | **Yes** | MySQL hostname |
| `MYSQL_PORT` | `3306` | No | MySQL port |
| `MYSQL_USER` | | **Yes** | MySQL username |
| `MYSQL_PASSWORD` | `""` | No | MySQL password |
| `MYSQL_DATABASE` | | **Yes** | Database name |

#### MSSQL

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `MSSQL_SERVER` | | **Yes** | SQL Server hostname |
| `MSSQL_PORT` | `1433` | No | SQL Server port |
| `MSSQL_USER` | | **Yes** | SQL Server username |
| `MSSQL_PASSWORD` | `""` | No | SQL Server password |
| `MSSQL_DATABASE` | | **Yes** | Database name |

#### MongoDB

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `MONGO_URI` | | **Yes** | Connection string (e.g., `mongodb://localhost:27017/montr`) |

### Storage

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `STORAGE_PATH` | `./storage` | No | Directory for uploaded media files. Created automatically. |
| `MAX_UPLOAD_SIZE_MB` | `500` | No | Maximum upload size per file in MB |

### Security

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `API_KEY_REQUIRED` | `false` | No | Enable API key authentication |
| `API_KEY` | | No | The API key value (required if `API_KEY_REQUIRED=true`) |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | No | Comma-separated CORS origins |

When `API_KEY_REQUIRED=true` but `API_KEY` is empty, the server logs a warning and all authenticated requests are rejected.

### Logging

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `LOG_LEVEL` | `info` | No | `error`, `warn`, `info`, `debug` |
| `LOG_FILE` | | No | Path to log file (e.g., `./logs/server.log`). Omit for stdout only. |

### WebSocket

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `WS_HEALTH_CHECK_INTERVAL` | `30000` | No | Server ping/pong interval (ms) |
| `WS_HEARTBEAT_TIMEOUT` | `60000` | No | Time before marking connection not alive (ms) |
| `WS_STALE_TIMEOUT` | `300000` | No | Time before removing stale connections (ms) |

### UI

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `UI_DASHBOARD_REFRESH_MS` | `30000` | No | Dashboard auto-refresh interval (ms) |
| `UI_TOAST_DURATION_MS` | `3000` | No | Toast notification display duration (ms) |

---

## Client Configuration

The client reads a TOML config file. CLI arguments override config file values.

### Config File Search Order

1. Path specified by `--config / -c` argument
2. `./config.toml` (current directory)
3. Platform-specific user config:
   - Linux: `~/.config/montr-client/config.toml`
   - Windows: `%APPDATA%\Montr\config.toml`
4. Platform-specific system config:
   - Linux: `/etc/montr-client/config.toml`
   - Windows: `C:\ProgramData\Montr\config.toml`

### TOML Sections

#### [server]

| Key | Default | Required | Description |
|-----|---------|----------|-------------|
| `url` | | **Yes** | Server base URL (e.g., `http://192.168.1.100:3000`) |
| `api_key` | `""` | No | API key (if server requires authentication) |
| `reconnect_interval` | `5` | No | Seconds between reconnection attempts (base delay) |
| `heartbeat_interval` | `30` | No | Seconds between heartbeat messages |

#### [client]

| Key | Default | Required | Description |
|-----|---------|----------|-------------|
| `id` | Auto-generated UUID | No | Client UUID. If empty, a random UUID is generated on first run. |
| `name` | | **Yes** | Display name for this client |

#### [playback]

| Key | Default | Required | Description |
|-----|---------|----------|-------------|
| `default_image_duration` | `5` | No | Seconds to display each image |
| `loop_playlist` | `true` | No | Restart playlist after last item |
| `media_cache_dir` | Platform-specific | No | Directory for cached media files |
| `max_cache_size_mb` | `5000` | No | Maximum cache size in MB (minimum: 100) |
| `preload_next_items` | `2` | No | Number of upcoming items to preload |

#### [system]

| Key | Default | Required | Description |
|-----|---------|----------|-------------|
| `auto_start` | `false` | No | Register as system service on startup |
| `log_level` | `info` | No | `error`, `warn`, `info`, `debug`, `trace` |
| `log_file` | Platform-specific | No | Path to log file |
| `log_max_size_mb` | `100` | No | Maximum log file size before rotation |
| `log_max_files` | `5` | No | Number of rotated log files to keep |

#### [display]

| Key | Default | Required | Description |
|-----|---------|----------|-------------|
| `fullscreen` | `true` | No | Run in fullscreen mode |
| `screen_index` | `0` | No | Display index for multi-monitor setups |
| `window_width` | | No | Window width (windowed mode only) |
| `window_height` | | No | Window height (windowed mode only) |

### CLI Arguments

CLI arguments override TOML config values.

| Argument | Short | Description |
|----------|-------|-------------|
| `--config <path>` | `-c` | Path to config file |
| `--server-url <url>` | `-s` | Override server URL |
| `--client-name <name>` | `-n` | Override client name |
| `--log-level <level>` | `-l` | Override log level |
| `--fullscreen` | `-f` | Force fullscreen mode |
| `--no-fullscreen` | | Force windowed mode |
| `--verbose` | `-v` | Set log level to `debug` |
| `--trace` | `-t` | Set log level to `trace` |

### Platform-Specific Defaults

The client uses the `directories` crate to resolve platform-appropriate paths:

| Value | Linux | Windows |
|-------|-------|---------|
| Cache dir | `~/.cache/montr-client` | `%LOCALAPPDATA%\Montr\cache` |
| Log file | `~/.local/share/montr-client/logs/client.log` | `%LOCALAPPDATA%\Montr\logs\client.log` |

---

## Example: Production Server

```bash
# .env
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
PUBLIC_URL=https://montr.example.com
DB_TYPE=sqlite
DB_PATH=/opt/montr-server/data/montr.db
STORAGE_PATH=/opt/montr-server/storage
MAX_UPLOAD_SIZE_MB=1000
API_KEY_REQUIRED=true
API_KEY=your-secret-api-key
ALLOWED_ORIGINS=https://montr.example.com
LOG_LEVEL=info
LOG_FILE=/opt/montr-server/logs/server.log
```

## Example: Client Display Node

```toml
[server]
url = "https://montr.example.com"
api_key = "your-secret-api-key"
heartbeat_interval = 30

[client]
name = "Lobby-Display-01"

[playback]
default_image_duration = 10
loop_playlist = true
max_cache_size_mb = 10000

[system]
log_level = "info"

[display]
fullscreen = true
screen_index = 0
```

---

*See also: [deployment.md](deployment.md) for installation and service configuration.*
