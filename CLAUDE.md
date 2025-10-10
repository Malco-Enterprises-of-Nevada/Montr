# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Montr is a distributed media playlist system for automated playback across multiple displays. It consists of:
- **Server**: Node.js/TypeScript backend with web-based management interface
- **Client**: Rust native application for reliable media playback
- **Target Scale**: 25 concurrent clients, 50GB storage, looping playlists

## Development Commands

### Server (Node.js/TypeScript)

```bash
cd server

# Development (with hot-reload)
npm run dev

# Build TypeScript to JavaScript
npm run build

# Production
npm start

# Testing
npm test                # Run all tests
npm run test:watch      # Watch mode

# Code Quality
npm run lint            # Check linting
npm run lint:fix        # Fix linting issues
npm run format          # Format with Prettier
```

### Client (Rust)

```bash
cd client

# Development build
cargo build

# Run in development
cargo run -- --config config.example.toml

# Release build (optimized)
cargo build --release

# Testing
cargo test              # Run all tests
cargo test -- --nocapture  # With output
cargo test test_name    # Run specific test

# Check without building
cargo check
```

## Architecture Overview

### Two-Component System

The system uses a client-server architecture with persistent WebSocket connections:

1. **Server Component**
   - Express.js REST API for media/playlist/client management
   - WebSocket server for real-time communication
   - Static web UI for management
   - Database layer with multiple adapter support (SQLite default)
   - File storage service for media files

2. **Client Component**
   - Async Rust application using tokio runtime
   - libmpv-based playback engine
   - WebSocket client with auto-reconnect
   - HTTP client for media downloads
   - Local media cache with LRU eviction

### Communication Flow

```
Web UI (Browser) ←─ HTTP REST ─→ Server ←─ WebSocket + HTTP ─→ Client ←→ mpv Player
                                    ↓
                               Database + File Storage
```

## Key Architecture Patterns

### Server Architecture

**Layered Architecture**:
1. **API Layer** (`src/api/`): Express routes, middleware, validation
2. **Service Layer** (`src/services/`): Business logic (MediaService, PlaylistService, ClientService)
3. **Data Layer** (`src/database/`): Database adapters, models, migrations

**Database Abstraction**:
- Abstract adapter interface in `src/database/adapters/base.adapter.ts`
- Concrete implementations for SQLite, MySQL, MSSQL, MongoDB
- Default is SQLite for simplicity

**WebSocket Management**:
- Server at `src/websocket/server.ts` handles client connections
- ClientManager tracks active connections
- Message handlers route typed messages (register, status_update, heartbeat, error)

### Client Architecture

**State Machine Pattern**:
```
STARTING → CONNECTING → REGISTERING → WAITING_PLAYLIST → DOWNLOADING → READY → PLAYING
                ↑                                                                   ↓
                └──────────────────── ERROR (retry) ←──────────────────────────────┘
```

**Module Organization**:
- `config/`: TOML configuration and CLI args
- `network/`: HTTP client and WebSocket with reconnection logic
- `playback/`: mpv engine wrapper, playlist queue, media cache
- `status/`: Periodic status reporting to server
- `system/`: Auto-start (systemd/Windows Service) and health monitoring

### Communication Protocol

**REST API** (`/api/*`):
- Standard JSON responses: `{ success, data, error }`
- Media management: upload, list, delete, download
- Playlist CRUD: create, update, delete, add/remove/reorder items
- Client management: register, list, update, assign playlist

**WebSocket Protocol** (`ws://server:3000/ws`):
- Client → Server: `register`, `status_update`, `heartbeat`, `error`
- Server → Client: `playlist_assigned`, `playlist_updated`, `command`
- JSON messages with `type` field
- Heartbeat every 30 seconds

## Database Schema

Key tables (SQLite schema in `server/src/database/schema.sql`):
- `media_files`: filename, filepath, type (video/image), duration, resolution, checksum
- `playlists`: name, description, timestamps
- `playlist_items`: playlist_id, media_id, order_index, image_duration
- `clients`: id (UUID), name, assigned_playlist_id, status, last_seen
- `client_status`: client_id, current_media_id, position, is_playing, error_message

Foreign keys with CASCADE deletes maintain referential integrity.

## Project Structure

```
montr/
├── server/               # Node.js server
│   ├── src/
│   │   ├── index.ts      # Entry point
│   │   ├── config/       # Configuration management
│   │   ├── api/          # Routes and middleware
│   │   ├── services/     # Business logic layer
│   │   ├── database/     # Adapters, models, migrations
│   │   ├── websocket/    # WebSocket server
│   │   ├── web/public/   # Static web UI
│   │   └── utils/        # Logging, validation, helpers
│   └── package.json
├── client/               # Rust client
│   ├── src/
│   │   ├── main.rs       # Entry point
│   │   ├── config/       # Settings and args
│   │   ├── network/      # HTTP and WebSocket
│   │   ├── playback/     # mpv engine and caching
│   │   ├── status/       # Status reporter
│   │   └── system/       # Auto-start and health
│   └── Cargo.toml
├── docs/                 # Detailed documentation
│   ├── architecture.md
│   ├── api-specification.md
│   ├── websocket-protocol.md
│   ├── database-schema.md
│   ├── deployment.md
│   ├── development.md
│   ├── configuration.md
│   └── troubleshooting.md
├── shared/               # Shared protocol specs
├── scripts/              # Build and packaging scripts
└── project.md            # Complete project plan
```

## Configuration

### Server (.env file)

```bash
# Server
PORT=3000
HOST=0.0.0.0

# Database
DB_TYPE=sqlite              # sqlite, mysql, mssql, mongodb
DB_PATH=./data/montr.db     # SQLite path

# Storage
STORAGE_PATH=./storage
MAX_UPLOAD_SIZE_MB=500

# Logging
LOG_LEVEL=info
LOG_FILE=./logs/server.log
```

### Client (config.toml)

```toml
[server]
url = "http://server-ip:3000"
reconnect_interval = 5
heartbeat_interval = 30

[client]
id = "auto-generated-uuid"
name = "Display-01"

[playback]
default_image_duration = 5
loop_playlist = true
media_cache_dir = "/var/lib/montr-client/cache"
max_cache_size_mb = 5000

[display]
fullscreen = true
screen_index = 0
```

## Development Workflow

### Phase 1 Foundation (Current)
Project structure, database schema, basic documentation completed.

### Working on Server Code
1. Changes to API routes require updating both handler and service layer
2. New database operations require adapter interface changes
3. Always validate input with zod schemas in middleware
4. WebSocket messages must match protocol types in `websocket/types.ts`

### Working on Client Code
1. Network operations should handle reconnection gracefully
2. All state transitions go through the main state machine
3. Playback errors should not crash the client - log and skip to next media
4. Cache management runs periodically to enforce size limits
5. Status updates queue when offline and flush on reconnect

### Adding New Features
1. Server: Route → Middleware → Service → Database
2. Client: Update state machine if needed, implement in appropriate module
3. Update WebSocket protocol if new message types required
4. Update documentation in `docs/` directory

## Testing Strategy

- **Server**: Jest for unit and integration tests
- **Client**: Cargo test with mockall for mocking
- **Integration**: End-to-end tests simulate server-client communication
- **Target**: Minimum 70% code coverage

## Dependencies

### Server Key Dependencies
- `express`: Web framework
- `ws`: WebSocket library
- `better-sqlite3`: SQLite database
- `multer`: File upload handling
- `zod`: Schema validation
- `winston`: Logging
- `sharp`: Image processing/thumbnails

### Client Key Dependencies
- `tokio`: Async runtime
- `libmpv`: Media playback
- `reqwest`: HTTP client
- `tokio-tungstenite`: WebSocket client
- `serde`/`serde_json`: Serialization
- `toml`: Config parsing
- `tracing`: Logging

## Important Conventions

### Commit Messages
Use conventional commits format:
- `feat:` - New feature
- `fix:` - Bug fix
- `refactor:` - Code refactoring
- `docs:` - Documentation changes
- `test:` - Test additions/changes
- `chore:` - Build/tooling changes

### Code Style
- **TypeScript**: Airbnb style guide, enforced by ESLint
- **Rust**: Standard rustfmt formatting
- Run linters before committing

### Error Handling
- Server: Structured errors with error codes, caught by middleware
- Client: Use anyhow for general errors, thiserror for custom error types
- Always log errors with context

## Cross-Platform Considerations

The system runs on Debian, Arch Linux, and Windows:
- Server uses Node.js (naturally cross-platform)
- Client uses conditional compilation for platform-specific code
- Auto-start: systemd (Linux) vs Windows Service
- Paths: Use platform-appropriate defaults

## Future Roadmap

### Version 1.1
- Time-based scheduling for playlist switching
- Multiple playlists per client with schedules
- Client grouping for batch operations

### Version 1.2
- Remote control (pause, skip, volume)
- Live preview of client screens
- Analytics and uptime tracking

## Troubleshooting Common Issues

### Server Issues
- Port conflicts: Change PORT in .env
- Database connection fails: Verify DB_TYPE and connection settings
- Upload failures: Check STORAGE_PATH permissions and MAX_UPLOAD_SIZE_MB

### Client Issues
- Connection failures: Verify server URL, check firewall, test with `curl http://server:3000/api/health`
- Playback issues: Check mpv installation (`mpv --version`), verify media formats
- Cache issues: Monitor cache directory size, check max_cache_size_mb setting

## References

For detailed information, see:
- `project.md` - Complete implementation plan and phases
- `docs/architecture.md` - Detailed system architecture
- `docs/api-specification.md` - REST API and endpoints
- `docs/websocket-protocol.md` - WebSocket message specifications
- `docs/database-schema.md` - Complete database design
- Server README: `server/README.md`
- Client README: `client/README.md`
