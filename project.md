# Media Playlist System - Detailed Implementation Plan

## Executive Summary

A distributed media playlist system consisting of:
- **Server**: Node.js/TypeScript server with web UI for managing media and playlists
- **Client**: Rust native application for automated media playback
- **Target**: 25 clients, 50GB storage, looping playlists with future scheduling support

---

## 1. Project Structure

```
montr/
├── README.md                          # Project overview, quick start
├── LICENSE
├── .gitignore
├── project.md                         # This detailed plan
├── docs/
│   ├── architecture.md                # System design, component interaction
│   ├── api-specification.md           # REST API endpoints (OpenAPI 3.0)
│   ├── websocket-protocol.md          # WebSocket message specifications
│   ├── database-schema.md             # Schema design with ERD
│   ├── deployment.md                  # Installation guides per platform
│   ├── development.md                 # Dev environment setup
│   ├── configuration.md               # Configuration reference
│   └── troubleshooting.md             # Common issues & solutions
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── .env.example
│   ├── src/
│   │   ├── index.ts                   # Entry point
│   │   ├── config/
│   │   │   └── config.ts              # Configuration management
│   │   ├── api/
│   │   │   ├── routes.ts              # Route registration
│   │   │   ├── media.routes.ts
│   │   │   ├── playlist.routes.ts
│   │   │   ├── client.routes.ts
│   │   │   └── middleware/
│   │   │       ├── auth.ts
│   │   │       ├── error-handler.ts
│   │   │       └── validation.ts
│   │   ├── database/
│   │   │   ├── connection.ts
│   │   │   ├── adapters/
│   │   │   │   ├── base.adapter.ts    # Abstract interface
│   │   │   │   ├── sqlite.adapter.ts
│   │   │   │   ├── mysql.adapter.ts
│   │   │   │   ├── mssql.adapter.ts
│   │   │   │   └── mongodb.adapter.ts
│   │   │   ├── models/
│   │   │   │   ├── media.model.ts
│   │   │   │   ├── playlist.model.ts
│   │   │   │   ├── client.model.ts
│   │   │   │   └── status.model.ts
│   │   │   ├── migrations/
│   │   │   │   ├── 001_initial.ts
│   │   │   │   └── migration-runner.ts
│   │   │   └── seeds/
│   │   │       └── demo-data.ts
│   │   ├── services/
│   │   │   ├── media.service.ts       # Business logic
│   │   │   ├── playlist.service.ts
│   │   │   ├── client.service.ts
│   │   │   └── storage.service.ts     # File storage management
│   │   ├── websocket/
│   │   │   ├── server.ts              # WebSocket server setup
│   │   │   ├── handlers.ts            # Message handlers
│   │   │   ├── client-manager.ts      # Connected clients tracking
│   │   │   └── types.ts               # Message type definitions
│   │   ├── web/                       # Management UI
│   │   │   ├── public/
│   │   │   │   ├── index.html
│   │   │   │   ├── css/
│   │   │   │   │   └── styles.css
│   │   │   │   └── js/
│   │   │   │       ├── app.js
│   │   │   │       ├── media-manager.js
│   │   │   │       ├── playlist-builder.js
│   │   │   │       └── client-dashboard.js
│   │   │   └── views/
│   │   └── utils/
│   │       ├── logger.ts
│   │       ├── validator.ts
│   │       └── file-helper.ts
│   ├── tests/
│   │   ├── unit/
│   │   ├── integration/
│   │   └── fixtures/
│   ├── storage/                       # Media file storage
│   │   └── .gitkeep
│   └── README.md                      # Server-specific docs
├── client/
│   ├── Cargo.toml
│   ├── Cargo.lock
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs
│   │   ├── config/
│   │   │   ├── mod.rs
│   │   │   ├── settings.rs            # Config file management
│   │   │   └── args.rs                # CLI arguments
│   │   ├── network/
│   │   │   ├── mod.rs
│   │   │   ├── http_client.rs         # REST API client
│   │   │   ├── websocket.rs           # WebSocket connection
│   │   │   └── reconnect.rs           # Reconnection logic
│   │   ├── playback/
│   │   │   ├── mod.rs
│   │   │   ├── engine.rs              # mpv wrapper
│   │   │   ├── playlist.rs            # Queue management
│   │   │   └── media_cache.rs         # Local media caching
│   │   ├── system/
│   │   │   ├── mod.rs
│   │   │   ├── autostart.rs           # OS-specific autostart
│   │   │   └── health.rs              # Health monitoring
│   │   ├── status/
│   │   │   ├── mod.rs
│   │   │   └── reporter.rs            # Status reporting to server
│   │   └── error.rs                   # Error types
│   ├── tests/
│   │   ├── integration/
│   │   └── unit/
│   ├── config.example.toml
│   └── README.md
├── shared/
│   └── protocol.md                    # Protocol specification
└── scripts/
    ├── build/
    │   ├── build-all.sh
    │   ├── build-client-linux.sh
    │   ├── build-client-windows.sh
    │   └── build-server.sh
    ├── packaging/
    │   ├── debian/
    │   │   ├── server/
    │   │   │   ├── DEBIAN/
    │   │   │   │   └── control
    │   │   │   └── usr/
    │   │   └── client/
    │   │       ├── DEBIAN/
    │   │       └── usr/
    │   ├── arch/
    │   │   ├── PKGBUILD-server
    │   │   └── PKGBUILD-client
    │   └── windows/
    │       ├── server-installer.nsi
    │       └── client-installer.nsi
    └── dev/
        ├── setup-dev-env.sh
        └── seed-demo-data.sh
```

---

## 2. Detailed Component Specifications

### 2.1 Server Architecture

#### Technology Stack
- **Runtime**: Node.js 20 LTS
- **Language**: TypeScript 5.x
- **Framework**: Express.js (familiar) or Fastify (performance)
- **Database**:
  - Default: SQLite with better-sqlite3
  - Optional: MySQL, MS SQL Server, MongoDB
- **WebSocket**: ws library
- **File Upload**: multer
- **Validation**: zod or joi
- **Logging**: winston or pino

#### Core Features

**Media Management**
- Upload video/image files
- Automatic metadata extraction (duration, resolution, codec)
- Thumbnail generation
- File validation (type, size limits)
- Storage organization by date/type
- Duplicate detection (hash-based)

**Playlist Management**
- Create/update/delete playlists
- Add/remove/reorder media items
- Configure per-item settings (image duration)
- Clone playlists
- Playlist templates

**Client Management**
- Client registration with unique ID
- Assign playlist to client
- View client status dashboard
- Manual client commands (future: pause, skip)
- Client grouping (future feature)

**Web UI Features**
- Responsive dashboard
- Media library with search/filter
- Drag-and-drop playlist builder
- Real-time client status grid
- Upload progress indicators
- Error notifications

#### API Endpoints

**Media Routes** (`/api/media`)
- `POST /upload` - Upload media file(s)
- `GET /` - List all media (with pagination, filters)
- `GET /:id` - Get media details
- `DELETE /:id` - Delete media file
- `GET /:id/download` - Download media file
- `GET /:id/thumbnail` - Get thumbnail

**Playlist Routes** (`/api/playlists`)
- `POST /` - Create playlist
- `GET /` - List all playlists
- `GET /:id` - Get playlist with items
- `PUT /:id` - Update playlist
- `DELETE /:id` - Delete playlist
- `POST /:id/items` - Add items to playlist
- `PUT /:id/items/:itemId` - Update item (order, duration)
- `DELETE /:id/items/:itemId` - Remove item

**Client Routes** (`/api/clients`)
- `POST /register` - Register new client
- `GET /` - List all clients
- `GET /:id` - Get client details
- `PUT /:id` - Update client (assign playlist)
- `DELETE /:id` - Unregister client
- `GET /:id/status` - Get current status

#### WebSocket Protocol

**Client → Server Messages**
```typescript
{
  type: "register",
  clientId: string,
  version: string,
  capabilities: { video: boolean, image: boolean }
}

{
  type: "status_update",
  clientId: string,
  currentMedia: { id: number, filename: string },
  position: number,  // seconds
  isPlaying: boolean,
  timestamp: number
}

{
  type: "heartbeat",
  clientId: string,
  timestamp: number
}

{
  type: "error",
  clientId: string,
  error: string,
  context: object
}
```

**Server → Client Messages**
```typescript
{
  type: "playlist_assigned",
  playlistId: number,
  items: Array<{
    id: number,
    mediaId: number,
    filename: string,
    downloadUrl: string,
    type: "video" | "image",
    duration?: number,  // for images
    checksum: string    // for cache validation
  }>
}

{
  type: "playlist_updated",
  playlistId: number,
  items: [/* same as above */]
}

{
  type: "command",
  command: "reload_playlist" | "pause" | "resume"  // future
}
```

#### Database Schema

**SQLite Schema**
```sql
CREATE TABLE media_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  filepath TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('video', 'image')),
  mime_type TEXT,
  file_size INTEGER,
  duration REAL,  -- NULL for images
  width INTEGER,
  height INTEGER,
  checksum TEXT UNIQUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE playlist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL,
  media_id INTEGER NOT NULL,
  order_index INTEGER NOT NULL,
  image_duration INTEGER DEFAULT 5,  -- seconds, only for images
  FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
  FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE
);

CREATE TABLE clients (
  id TEXT PRIMARY KEY,  -- UUID
  name TEXT NOT NULL,
  assigned_playlist_id INTEGER,
  status TEXT DEFAULT 'offline' CHECK(status IN ('online', 'offline', 'error')),
  last_seen DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (assigned_playlist_id) REFERENCES playlists(id) ON DELETE SET NULL
);

CREATE TABLE client_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  current_media_id INTEGER,
  position REAL,  -- seconds
  is_playing BOOLEAN,
  error_message TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (current_media_id) REFERENCES media_files(id) ON DELETE SET NULL
);

CREATE INDEX idx_playlist_items_playlist ON playlist_items(playlist_id);
CREATE INDEX idx_client_status_client ON client_status(client_id);
```

---

### 2.2 Client Architecture

#### Technology Stack
- **Language**: Rust (stable)
- **Dependencies**:
  - `tokio` - Async runtime
  - `libmpv` or `libmpv-rs` - Video/image playback
  - `reqwest` - HTTP client
  - `tokio-tungstenite` - WebSocket client
  - `serde` + `serde_json` - Serialization
  - `toml` - Config file parsing
  - `clap` - CLI arguments
  - `uuid` - Client ID generation
  - `sha2` - File checksums
  - `tokio-util` - Utilities
  - `tracing` - Logging

#### Core Components

**Configuration Module**
```toml
# config.toml
[server]
url = "http://192.168.1.100:3000"
api_key = "optional-api-key"
reconnect_interval = 5  # seconds

[client]
id = "auto-generated-uuid"
name = "Client-01"

[playback]
default_image_duration = 5  # seconds
loop_playlist = true
media_cache_dir = "./cache"
max_cache_size_mb = 5000  # 5GB

[system]
auto_start = true
log_level = "info"
log_file = "./client.log"
```

**Network Module**
- HTTP client for:
  - Registration
  - Media file downloads (with resume support)
  - Status updates (fallback if WebSocket fails)
- WebSocket client with:
  - Auto-reconnect with exponential backoff
  - Heartbeat every 30 seconds
  - Message queue for offline buffering
  - Connection state management

**Playback Engine**
- Initialize mpv with video output for displays
- Load media files into queue
- Handle video playback
- Handle image "playback" (display for N seconds)
- Seamless transitions
- Loop at playlist end
- Error recovery (skip corrupted files)

**Media Cache**
- Download media files to local cache
- Verify checksums
- Manage cache size (LRU eviction)
- Pre-fetch upcoming media
- Clean orphaned files

**Status Reporter**
- Report current media every 10 seconds
- Report playback position for videos
- Report errors immediately
- Queue updates when offline

**System Integration**
- Auto-start on boot:
  - Linux: systemd service
  - Windows: Windows Service or Task Scheduler
- Logging to file with rotation
- Graceful shutdown handling

#### Client State Machine

```
States:
1. STARTING → Load config → CONNECTING
2. CONNECTING → WebSocket connect → REGISTERING
3. REGISTERING → Send register message → WAITING_PLAYLIST
4. WAITING_PLAYLIST → Receive playlist → DOWNLOADING
5. DOWNLOADING → Download media → READY
6. READY → Start playback → PLAYING
7. PLAYING → (loop) → PLAYING
8. ERROR → Retry logic → CONNECTING

Triggers:
- Playlist update → DOWNLOADING
- Network error → ERROR
- Server disconnect → CONNECTING
```

---

### 2.3 Communication Protocol

#### REST API

All endpoints return JSON:
```json
{
  "success": true,
  "data": { /* response data */ },
  "error": null
}
```

Error responses:
```json
{
  "success": false,
  "data": null,
  "error": {
    "code": "MEDIA_NOT_FOUND",
    "message": "Media file with ID 123 not found"
  }
}
```

#### WebSocket

- **Connection**: `ws://server:3000/ws`
- **Format**: JSON messages with `type` field
- **Heartbeat**: Client sends every 30s, server responds
- **Reconnect**: Exponential backoff (1s, 2s, 4s, 8s, max 60s)

---

## 3. Implementation Phases

### Phase 1: Foundation (Days 1-2)

**Tasks:**
1. Clean repository, set up structure
2. Initialize server:
   - `npm init`, install dependencies
   - TypeScript configuration
   - ESLint + Prettier
3. Initialize client:
   - `cargo init`
   - Add dependencies to Cargo.toml
4. Database:
   - Create schema SQL file
   - Implement SQLite adapter
   - Write migration runner
   - Create seed data script
5. Documentation:
   - Write architecture.md
   - Write protocol.md
   - Update README.md

**Deliverables:**
- Working project structure
- Database initialized with schema
- Basic documentation

---

### Phase 2: Server Core (Days 3-4)

**Tasks:**
1. API implementation:
   - Express server setup
   - Media routes (upload, list, delete)
   - Playlist routes (CRUD)
   - Client routes (register, list)
   - Validation middleware
   - Error handling middleware
2. Services:
   - Media service (file storage, metadata)
   - Playlist service (business logic)
   - Client service (management)
3. WebSocket server:
   - Connection handling
   - Message routing
   - Client tracking
4. Basic web UI:
   - Static file serving
   - Simple HTML interface
   - Media upload form
   - Playlist manager

**Deliverables:**
- Functional REST API
- WebSocket server
- Basic web UI for testing

---

### Phase 3: Client Core (Days 5-6)

**Tasks:**
1. Foundation:
   - Config file loading
   - CLI argument parsing
   - Logging setup
2. Network layer:
   - HTTP client implementation
   - WebSocket client with reconnect
   - Registration flow
3. Playback engine:
   - mpv integration
   - Video playback
   - Image playback with timers
   - Playlist queue
   - Loop functionality
4. Media cache:
   - Download manager
   - Checksum verification
   - Cache management
5. Status reporting:
   - Periodic status updates
   - Error reporting

**Deliverables:**
- Functional client application
- Can connect to server
- Can play assigned playlists

---

### Phase 4: Integration & Testing (Day 7)

**Tasks:**
1. End-to-end testing:
   - Server-client communication
   - Playlist assignment flow
   - Media playback
   - Reconnection scenarios
2. Error handling:
   - Network failures
   - Corrupted media
   - Server downtime
3. Performance testing:
   - 25 concurrent clients
   - Large playlists
   - Memory usage
4. Bug fixes

**Deliverables:**
- Stable system
- Integration test suite

---

### Phase 5: System Integration (Days 8-9)

**Tasks:**
1. Auto-start configuration:
   - Linux systemd service files
   - Windows service wrapper
   - Installation scripts
2. Database adapters (if time):
   - MySQL adapter
   - MSSQL adapter
   - MongoDB adapter
3. Configuration management:
   - Server .env handling
   - Client config wizard
4. Enhanced web UI:
   - Dashboard improvements
   - Real-time updates
   - Better UX

**Deliverables:**
- Auto-start configured
- Polished web UI
- Multiple database support

---

### Phase 6: Packaging (Days 10-11)

**Tasks:**
1. Build scripts:
   - Server bundling
   - Client cross-compilation
   - Asset compilation
2. Debian packages:
   - .deb for server
   - .deb for client
   - Installation/removal scripts
3. Arch packages:
   - PKGBUILD for server
   - PKGBUILD for client
4. Windows installers:
   - MSI or NSIS for server
   - MSI or NSIS for client
5. Testing on clean systems

**Deliverables:**
- Installable packages for all platforms
- Installation documentation

---

### Phase 7: Documentation & Polish (Day 12)

**Tasks:**
1. Complete documentation:
   - API specification (OpenAPI)
   - Deployment guide
   - User manual
   - Developer guide
   - Troubleshooting guide
2. Code cleanup:
   - Remove debug code
   - Add comments
   - Code review
3. Final testing:
   - Clean install testing
   - Documentation verification

**Deliverables:**
- Complete documentation
- Production-ready system

---

## 4. Deployment Strategy

### Server Deployment

**Debian/Ubuntu:**
```bash
# Install package
sudo dpkg -i montr-server_1.0.0_amd64.deb

# Configure
sudo nano /etc/montr-server/config.env

# Start service
sudo systemctl start montr-server
sudo systemctl enable montr-server

# Access web UI
http://localhost:3000
```

**Arch Linux:**
```bash
# Install from AUR
yay -S montr-server

# Configure
sudo nano /etc/montr-server/config.env

# Start service
sudo systemctl start montr-server
sudo systemctl enable montr-server
```

**Windows:**
```
1. Run MontrServerSetup.msi
2. Follow installation wizard
3. Service auto-starts
4. Configure via web UI
```

### Client Deployment

**Debian/Ubuntu:**
```bash
# Install package
sudo dpkg -i montr-client_1.0.0_amd64.deb

# Configure
sudo nano /etc/montr-client/config.toml
# Set server URL, client name

# Start service
sudo systemctl start montr-client
sudo systemctl enable montr-client

# Check status
sudo systemctl status montr-client
journalctl -u montr-client -f
```

**Arch Linux:**
```bash
# Install from AUR
yay -S montr-client

# Configure
sudo nano /etc/montr-client/config.toml

# Start service
sudo systemctl start montr-client
sudo systemctl enable montr-client
```

**Windows:**
```
1. Run MontrClientSetup.msi
2. Enter server URL during installation
3. Service auto-starts
4. Check status: Services → Montr Client
```

---

## 5. Configuration Reference

### Server Configuration

**Environment Variables (.env):**
```bash
# Server
PORT=3000
HOST=0.0.0.0

# Database
DB_TYPE=sqlite  # sqlite, mysql, mssql, mongodb
DB_PATH=./data/montr.db  # for SQLite

# MySQL
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=montr
MYSQL_PASSWORD=secure_password
MYSQL_DATABASE=montr

# MSSQL
MSSQL_SERVER=localhost
MSSQL_PORT=1433
MSSQL_USER=sa
MSSQL_PASSWORD=secure_password
MSSQL_DATABASE=montr

# MongoDB
MONGO_URI=mongodb://localhost:27017/montr

# Storage
STORAGE_PATH=./storage
MAX_UPLOAD_SIZE_MB=500

# Security
API_KEY_REQUIRED=false
API_KEY=optional-server-api-key

# Logging
LOG_LEVEL=info
LOG_FILE=./logs/server.log
```

### Client Configuration

**config.toml:**
```toml
[server]
url = "http://192.168.1.100:3000"
api_key = ""  # if server requires it
reconnect_interval = 5
heartbeat_interval = 30

[client]
id = "auto-generated-uuid-here"
name = "Display-01"

[playback]
default_image_duration = 5
loop_playlist = true
media_cache_dir = "/var/lib/montr-client/cache"
max_cache_size_mb = 5000
preload_next_items = 2

[system]
auto_start = true
log_level = "info"
log_file = "/var/log/montr-client/client.log"
log_max_size_mb = 100
log_max_files = 5

[display]
fullscreen = true
screen_index = 0  # for multi-monitor setups
```

---

## 6. Future Enhancements

### Version 1.1
- Scheduling support (time-based playlist switching)
- Multiple playlists per client with schedules
- Client grouping for batch operations
- Playlist priority and interruptions

### Version 1.2
- Remote control (pause, skip, volume)
- Live preview of client screens
- Analytics (playback logs, uptime)
- Email/webhook notifications

### Version 1.3
- Multi-server clustering
- Content approval workflow
- User roles and permissions
- HTTPS/TLS support

### Version 2.0
- Cloud sync option
- Mobile app for management
- Advanced scheduling (complex rules)
- A/B testing for content

---

## 7. Success Criteria

- ✅ Server runs on Debian, Arch, Windows
- ✅ Client runs on Debian, Arch, Windows
- ✅ Can manage 25 concurrent clients
- ✅ Supports up to 50GB media storage
- ✅ Playlists loop continuously
- ✅ Auto-start on system boot
- ✅ Graceful handling of network interruptions
- ✅ Real-time status monitoring
- ✅ Easy installation via packages
- ✅ Complete documentation

---

## 8. Risk Mitigation

**Risk: mpv library compatibility issues**
- Mitigation: Test on all target platforms early
- Backup: Consider alternative player (gstreamer, ffmpeg)

**Risk: Cross-compilation complexity**
- Mitigation: Use CI/CD for builds
- Set up build VMs for each platform

**Risk: Database adapter complexity**
- Mitigation: Start with SQLite only
- Add others in subsequent versions

**Risk: Network instability in production**
- Mitigation: Robust reconnection logic
- Local caching of playlists
- Offline mode support

---

## 9. Development Guidelines

### Code Style
- **Server**: Airbnb TypeScript style guide
- **Client**: Rust standard formatting (rustfmt)
- **Commits**: Conventional commits format

### Testing
- Unit tests for business logic
- Integration tests for API endpoints
- E2E tests for critical flows
- Minimum 70% code coverage

### Documentation
- Inline code comments for complex logic
- JSDoc/Rustdoc for public APIs
- Keep docs up to date with code changes

### Version Control
- Feature branches from main
- PR required for merging
- Squash commits on merge
- Tag releases (v1.0.0, v1.1.0, etc.)

---

*This document serves as the master plan for the Montr media playlist system. It will be updated as the project evolves.*
