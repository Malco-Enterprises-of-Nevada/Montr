# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Montr is a distributed media playlist system for automated playback across multiple displays. Two components: a Node.js/TypeScript **server** (web management + API) and a Rust **client** (media playback via libmpv). They communicate over WebSocket and HTTP REST.

```
Web UI (Browser) ←─ HTTP REST ─→ Server ←─ WebSocket + HTTP ─→ Client ←→ mpv Player
                                    ↓
                               SQLite + File Storage
```

## Development Commands

### Server (`cd server`)

```bash
npm run dev              # Dev server with hot-reload (nodemon + ts-node)
npm run build            # Compile TS → dist/ (also copies schema.sql)
npm start                # Production (runs compiled dist/)
npm test                 # Run all tests (Jest)
npm run test:watch       # Watch mode
npm run test:coverage    # Coverage report (70% minimum threshold)
npm run typecheck        # Type-check only (no emit)
npm run lint             # ESLint check
npm run lint:fix         # Auto-fix lint issues
npm run format           # Prettier format
npm run format:check     # Prettier check (CI-friendly)
```

### Client (`cd client`)

```bash
cargo build              # Debug build
cargo build --release    # Optimized release build (LTO + strip)
cargo run -- --config config.example.toml  # Run with config
cargo test               # Run all tests
cargo test test_name     # Run specific test
cargo test -- --nocapture  # With stdout
cargo check              # Type-check without building
```

## Architecture

### Server — Layered Architecture

Request flow: **Route → Validation Middleware → Service → Database Adapter**

- **Routes** (`src/api/routes/`): Express handlers for media, playlist, client endpoints
- **Validation** (`src/api/middleware/validation.ts`): Zod schemas validate all input
- **Services** (`src/services/`): Business logic — MediaService, PlaylistService, ClientService, StorageService
- **Database** (`src/database/adapters/`): Abstract adapter interface (`base.adapter.ts`) with SQLite implementation. Factory in `connection.ts`
- **WebSocket** (`src/websocket/`): Real-time bidirectional communication at `ws://server:3000/ws`
  - `server.ts` — WebSocket server setup
  - `client-manager.ts` — Connection tracking with health monitoring (30s heartbeat, 5min stale timeout)
  - `handlers.ts` — Routes typed messages (register, status_update, heartbeat, error)
  - `types.ts` — Message types with Zod validation schemas
- **Web UI** (`src/web/public/`): Vanilla HTML/CSS/JS SPA for management

Standard JSON response format: `{ success: boolean, data: any, error: { code, message } }`

### Client — State Machine Architecture

```
STARTING → CONNECTING → REGISTERING → WAITING_PLAYLIST → DOWNLOADING → READY → PLAYING
                ↑                                                                   ↓
                └──────────────────── ERROR (retry) ←──────────────────────────────┘
```

- **`config/`**: TOML config parsing + clap CLI args
- **`network/`**: HTTP client (reqwest) for media downloads, WebSocket (tokio-tungstenite) with auto-reconnect
- **`playback/`**: libmpv engine wrapper, playlist queue, playback events
- **`cache/`**: Local media cache with LRU eviction and checksum validation
- **`state/`**: Application state and state machine coordinator
- **`status/`**: Periodic status reporting to server

### WebSocket Protocol

- Client → Server: `register`, `status_update`, `heartbeat`, `error`
- Server → Client: `playlist_assigned`, `playlist_updated`, `command`
- JSON messages with `type` field discriminator

## Testing

### Server (Jest + ts-jest)

Tests live in `server/tests/` (unit, integration, fixtures, utils) and `server/src/websocket/__tests__/`.

Key test setup details (`tests/setup.ts`):
- Uses in-memory SQLite for tests (DB_TYPE=sqlite, no file)
- **`sharp` is mocked globally** — returns fake image buffer/metadata. If adding image processing tests, be aware of this mock
- `better-sqlite3` is mocked via Jest moduleNameMapper
- Test timeout: 10 seconds
- LOG_LEVEL set to `error` to reduce noise

Run a single test file: `npx jest tests/unit/services/media.service.test.ts`
Run tests matching a name: `npx jest -t "should create playlist"`

### Client (cargo test + mockall)

Tests in `client/tests/` (integration) and inline `#[cfg(test)]` modules.
Uses mockall for trait mocking, tempfile for temp directories, mockito for HTTP mocking.

## Key Conventions

### Adding a Server Feature
1. Define Zod schema in `src/api/middleware/validation.ts`
2. Add route handler in `src/api/routes/`
3. Implement business logic in `src/services/`
4. Add database methods: update interface in `base.adapter.ts`, implement in `sqlite.adapter.ts`
5. Add WebSocket message type in `src/websocket/types.ts` if needed

### Adding a Client Feature
1. Update state machine in `state/coordinator.rs` if new states needed
2. Implement in the appropriate module (network, playback, cache, status)
3. Errors: use `anyhow` for general, `thiserror` for typed errors in `error.rs`

### Code Style
- **TypeScript**: Airbnb + Prettier (100 char width, single quotes, semicolons, trailing commas). `@typescript-eslint/no-explicit-any: error`
- **Rust**: Standard rustfmt. No custom rustfmt.toml or clippy.toml
- **Commits**: Conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`)

### Cross-Platform (Client)
Targets Debian, Arch Linux, and Windows. Uses conditional compilation for platform-specific code (systemd vs Windows Service for auto-start, platform-appropriate default paths).

## Configuration

- Server: `.env` file (see `server/.env.example`). Key vars: PORT, DB_TYPE, DB_PATH, STORAGE_PATH
- Client: TOML config (see `client/config.example.toml`). Key sections: [server], [client], [playback], [display]

## Documentation

Detailed docs in `docs/` covering architecture, API spec, WebSocket protocol, database schema, deployment, configuration, and troubleshooting. See also `project.md` for the full implementation plan.
