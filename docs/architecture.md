# Montr Architecture

## System Overview

Montr is a client-server architecture designed for distributed media playback. The system consists of:

1. **Server Component**: Central management system
2. **Client Component**: Playback application
3. **Communication Layer**: REST API and WebSocket protocol

## High-Level Architecture

```
┌───────────────────────────────────────────────────────────┐
│                     Web Browser                           │
│              (Management Interface)                       │
└─────────────────────────┬─────────────────────────────────┘
                          │ HTTPS (REST API)
                          │
┌─────────────────────────▼─────────────────────────────────┐
│                    Server (Node.js)                       │
│  ┌──────────────────────────────────────────────────────┐ │
│  │              HTTP/WebSocket Server                    │ │
│  ├──────────────────────────────────────────────────────┤ │
│  │  ┌──────────┐  ┌──────────┐  ┌─────────────────────┐ │ │
│  │  │   REST   │  │WebSocket │  │   Static File      │ │ │
│  │  │   API    │  │  Server  │  │   Server (Web UI)  │ │ │
│  │  └────┬─────┘  └────┬─────┘  └─────────────────────┘ │ │
│  └───────┼─────────────┼────────────────────────────────┘ │
│  ┌───────▼─────────────▼────────────────────────────────┐ │
│  │              Business Logic Layer                     │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │ │
│  │  │  Media   │  │ Playlist │  │   Client         │  │ │
│  │  │ Service  │  │ Service  │  │   Service        │  │ │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────────────┘  │ │
│  └───────┼─────────────┼─────────────┼────────────────┘ │
│  ┌───────▼─────────────▼─────────────▼────────────────┐ │
│  │              Data Access Layer                       │ │
│  │  ┌──────────┐  ┌──────────┐  ┌─────────────────┐  │ │
│  │  │   ORM    │  │   File   │  │   WebSocket     │  │ │
│  │  │  Models  │  │ Storage  │  │   Manager       │  │ │
│  │  └────┬─────┘  └────┬─────┘  └─────────────────┘  │ │
│  └───────┼─────────────┼────────────────────────────────┘ │
└──────────┼─────────────┼──────────────────────────────────┘
           │             │
    ┌──────▼──────┐ ┌───▼────────┐
    │  Database   │ │ File       │
    │  (SQLite/   │ │ System     │
    │   MySQL/    │ │ Storage    │
    │   MSSQL/    │ │            │
    │   MongoDB)  │ │            │
    └─────────────┘ └────────────┘
           │
           │ WebSocket + HTTP
           │
    ┌──────▼──────────────────────────────────────┐
    │         Network (LAN/WAN)                   │
    └──────┬─────────┬─────────┬─────────┬────────┘
           │         │         │         │
    ┌──────▼──┐ ┌────▼───┐ ┌──▼─────┐ ┌─▼───────┐
    │ Client 1│ │Client 2│ │Client 3│ │Client N │
    │ (Rust)  │ │(Rust)  │ │(Rust)  │ │(Rust)   │
    └──────┬──┘ └────┬───┘ └──┬─────┘ └─┬───────┘
           │         │         │         │
    ┌──────▼──┐ ┌────▼───┐ ┌──▼─────┐ ┌─▼───────┐
    │Display 1│ │Display2│ │Display3│ │Display N│
    └─────────┘ └────────┘ └────────┘ └─────────┘
```

## Server Component

### Technology Stack

- **Runtime**: Node.js 20 LTS
- **Language**: TypeScript 5.x
- **Web Framework**: Express.js
- **WebSocket**: ws library
- **Database**: better-sqlite3, mysql2, mssql, mongodb
- **File Upload**: multer
- **Validation**: zod

### Component Breakdown

#### 1. API Layer

**REST API**
- Handles HTTP requests for media, playlist, and client management
- Implements validation middleware
- Returns consistent JSON responses
- Supports file upload/download

**WebSocket Server**
- Maintains persistent connections with clients
- Broadcasts playlist updates
- Receives client status updates
- Implements heartbeat mechanism

**Static File Server**
- Serves web management interface
- Provides media file downloads to clients

#### 2. Business Logic Layer

**Media Service**
- File upload processing
- Metadata extraction (duration, resolution)
- Thumbnail generation
- Checksum calculation
- Storage management

**Playlist Service**
- Playlist CRUD operations
- Item ordering and management
- Playlist validation
- Assignment logic

**Client Service**
- Client registration
- Status tracking
- Playlist assignment
- Connection management

#### 3. Data Access Layer

**Database Models**
- Media Files: Store file metadata
- Playlists: Playlist information
- Playlist Items: Media-playlist relationships
- Clients: Connected client information
- Client Status: Real-time status data

**Database Adapters**
- Abstract interface for database operations
- SQLite adapter (default)
- MySQL adapter
- MS SQL Server adapter
- MongoDB adapter

### Server Data Flow

```
Request Flow:
1. Client/Browser → HTTP Request
2. Express Router → Middleware (validation, auth)
3. Route Handler → Service Layer
4. Service Layer → Database/File System
5. Database/File System → Response
6. Response → Client/Browser

WebSocket Flow:
1. Client → WebSocket Connection
2. Server → Connection Registration
3. Client → Status Update Message
4. Server → Store in Database
5. Server → Broadcast to Web UI
```

## Client Component

### Technology Stack

- **Language**: Rust (stable)
- **Async Runtime**: tokio
- **Media Playback**: libmpv-rs
- **HTTP Client**: reqwest
- **WebSocket**: tokio-tungstenite
- **Serialization**: serde + serde_json
- **Configuration**: toml
- **Logging**: tracing

### Component Breakdown

#### 1. Configuration Module
- Loads configuration from TOML file
- Handles CLI arguments
- Manages client ID generation
- Configuration validation

#### 2. Network Module

**HTTP Client**
- Registration with server
- Media file downloads
- Fallback status reporting

**WebSocket Client**
- Persistent connection to server
- Auto-reconnect with exponential backoff
- Message queue for offline buffering
- Heartbeat mechanism

#### 3. Playback Module

**Playback Engine**
- Initializes mpv instance
- Manages playback queue
- Handles video playback
- Handles image display (timed)
- Implements seamless transitions
- Loop functionality

**Media Cache**
- Downloads media to local storage
- Verifies file checksums
- Manages cache size (LRU eviction)
- Pre-fetches upcoming media

#### 4. Status Module

**Status Reporter**
- Periodic status updates (every 10s)
- Immediate error reporting
- Playback position tracking
- Queue management when offline

#### 5. System Integration Module

**Auto-start**
- Linux: systemd service integration
- Windows: Service or Task Scheduler

**Health Monitoring**
- System resource monitoring
- Playback health checks
- Connection status

### Client State Machine

```
┌─────────────┐
│   STARTING  │
└──────┬──────┘
       │ Load config
┌──────▼──────┐
│ CONNECTING  │◄───────────┐
└──────┬──────┘            │
       │ WebSocket         │
┌──────▼──────┐            │
│ REGISTERING │            │
└──────┬──────┘            │
       │ Send register     │
┌──────▼────────────┐      │
│ WAITING_PLAYLIST  │      │
└──────┬────────────┘      │
       │ Receive playlist  │
┌──────▼──────┐            │
│ DOWNLOADING │            │
└──────┬──────┘            │
       │ Download media    │
┌──────▼──────┐            │
│    READY    │            │
└──────┬──────┘            │
       │ Start playback    │
┌──────▼──────┐            │
│   PLAYING   │────┐       │
└──────┬──────┘    │ Loop  │
       │           │       │
       └───────────┘       │
       │                   │
       │ On error/         │
       │ disconnect        │
┌──────▼──────┐            │
│    ERROR    │────────────┘
└─────────────┘ Retry
```

## Communication Protocol

### REST API

**Endpoint Structure**
```
/api/media          - Media management
/api/playlists      - Playlist management
/api/clients        - Client management
/api/health         - Health check
```

**Response Format**
```json
{
  "success": true|false,
  "data": { /* response data */ },
  "error": { "code": "ERROR_CODE", "message": "..." } | null
}
```

### WebSocket Protocol

**Connection**
- URL: `ws://server:3000/ws`
- Protocol: JSON messages

**Message Types**

*Client → Server:*
- `register`: Client registration
- `status_update`: Playback status
- `heartbeat`: Keep-alive ping
- `error`: Error reporting

*Server → Client:*
- `playlist_assigned`: New playlist
- `playlist_updated`: Playlist modification
- `command`: Control commands (future)
- `heartbeat_ack`: Heartbeat response

### Data Synchronization

1. **Initial Sync**
   - Client connects and registers
   - Server sends assigned playlist
   - Client downloads media files
   - Client starts playback

2. **Ongoing Sync**
   - Client sends status every 10s
   - Server broadcasts to web UI
   - Playlist updates trigger re-download

3. **Offline Mode**
   - Client continues with cached playlist
   - Queues status updates
   - Reconnects with exponential backoff
   - Syncs on reconnection

## Security Considerations

### Current Implementation (v1.0)

- **Authentication**: Optional API key
- **Network**: Trusted LAN environment
- **File Access**: Server-controlled paths only
- **Input Validation**: Zod schema validation

### Future Enhancements (v1.1+)

- HTTPS/TLS support
- Client certificates
- User authentication
- Role-based access control
- Audit logging

## Scalability

### Current Capacity

- **Clients**: Up to 25 concurrent
- **Media Storage**: 50GB
- **Concurrent Uploads**: 5
- **Database**: SQLite (suitable for scale)

### Scaling Strategies

1. **Horizontal Scaling**
   - Multiple server instances
   - Load balancer
   - Shared database

2. **Vertical Scaling**
   - Upgrade server hardware
   - Use PostgreSQL/MySQL
   - Optimize caching

3. **CDN Integration**
   - Offload media delivery
   - Reduce server bandwidth
   - Improve download speed

## Error Handling

### Server

- Global error handler middleware
- Structured error responses
- Error logging (winston)
- Graceful shutdown

### Client

- Network error recovery
- Media playback fallback
- Automatic reconnection
- Error reporting to server

## Monitoring

### Server Metrics

- Active connections
- Request rate
- Error rate
- Storage usage
- Database performance

### Client Metrics

- Connection status
- Current media
- Playback position
- Cache size
- System health

### Web Dashboard

- Real-time client grid
- Active playlist overview
- Recent errors
- Storage usage
- System health

## Deployment Architecture

### Development

```
Developer Machine
├── Server (localhost:3000)
└── Client (local process)
```

### Production

```
┌─────────────────────┐
│   Production LAN    │
│                     │
│  ┌──────────────┐  │
│  │   Server     │  │
│  │ (VM/Physical)│  │
│  └──────┬───────┘  │
│         │          │
│  ┌──────┴───┬──────┴───┬──────┐
│  │ Client 1 │ Client 2 │ ...  │
│  └──────────┴──────────┴──────┘
└─────────────────────┘
```

## Technology Choices Rationale

### Why Node.js for Server?

- Fast development
- Rich ecosystem (npm)
- Good I/O performance
- Easy WebSocket integration
- Cross-platform

### Why Rust for Client?

- Native performance
- Memory safety
- Cross-compilation
- Small binary size
- Reliable in long-running scenarios

### Why SQLite as Default?

- Zero configuration
- Single file database
- Fast for read-heavy workloads
- Suitable for 25 clients
- Easy backup

### Why mpv for Playback?

- Excellent format support
- Hardware acceleration
- Reliable and stable
- Active development
- Cross-platform

## Future Architecture Considerations

### Version 1.1

- Scheduling system
- Multiple playlists per client
- Client grouping

### Version 1.2

- Remote control commands
- Live preview streaming
- Analytics pipeline

### Version 2.0

- Cloud-based deployment
- Multi-region support
- Content delivery network
- Mobile management app

---

*This document will be updated as the architecture evolves.*
