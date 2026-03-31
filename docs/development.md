# Development Guide

## Prerequisites

| Dependency | Version | Purpose |
|-----------|---------|---------|
| Node.js | >= 20.0.0 | Server runtime |
| npm | (bundled with Node) | Package manager |
| Rust | >= 1.75 (stable) | Client build toolchain |
| libmpv | (system package) | Client media playback |
| Git | any | Version control |
| Docker | (optional) | Containerized builds, test databases |
| Python 3 + build tools | (optional) | Native Node addon compilation (better-sqlite3, sharp) |

**Installing libmpv:**
- Debian/Ubuntu: `sudo apt install libmpv-dev`
- Arch Linux: `sudo pacman -S mpv`
- Windows: See [platform-compatibility.md](platform-compatibility.md)

---

## Repository Structure

```
montr/
  server/          # Node.js/TypeScript server
  client/          # Rust playback client
  shared/          # Shared protocol specification
  docs/            # Documentation
  docker/          # Dockerfiles
  deploy/          # Systemd service files
  scripts/         # Build and packaging scripts
  Makefile         # Root build targets
```

---

## Server Development

```bash
cd server
npm install
cp .env.example .env    # Edit as needed (DB_TYPE, DB_PATH, etc.)
npm run dev             # Starts with hot-reload (nodemon + ts-node)
```

The dev server restarts automatically on file changes. Default URL: `http://localhost:3000`.

### Server Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Development server with hot-reload |
| `npm run build` | Compile TypeScript to `dist/` (also copies schema.sql and web UI) |
| `npm start` | Run compiled production server |
| `npm run typecheck` | Type-check without emitting |
| `npm run lint` | ESLint check |
| `npm run lint:fix` | ESLint with auto-fix |
| `npm run format` | Prettier format all files |
| `npm run format:check` | Prettier check (CI-friendly) |

---

## Client Development

```bash
cd client
cp config.example.toml config.toml    # Edit server URL
cargo build                            # Debug build
cargo run -- --config config.toml      # Run with config
```

For release builds with optimizations:

```bash
cargo build --release    # LTO + strip enabled
```

---

## Testing

### Server Tests (Jest + ts-jest)

```bash
cd server
npm test                 # Run all tests
npm run test:watch       # Watch mode
npm run test:coverage    # Coverage report (70% minimum threshold)
```

**Running specific tests:**
```bash
npx jest tests/unit/services/media.service.test.ts
npx jest -t "should create playlist"
```

**Test setup details** (`tests/setup.ts`):
- Uses in-memory SQLite (`DB_TYPE=sqlite`, `DB_PATH=:memory:`)
- `sharp` is globally mocked (returns fake image buffer/metadata)
- `better-sqlite3` is mocked via Jest moduleNameMapper
- Test timeout: 10 seconds
- All mocks auto-reset between tests (`clearMocks`, `resetMocks`, `restoreMocks`)

**Adapter conformance tests** (requires real databases via Docker):
```bash
docker compose -f docker-compose.test.yml up -d   # Start test databases
npm run test:adapters                               # Run adapter tests
```

### Client Tests (cargo test + mockall)

```bash
cd client
cargo test                    # Run all tests
cargo test test_name          # Run specific test
cargo test -- --nocapture     # Show stdout
```

Tests use `mockall` for trait mocking, `tempfile` for temp directories, and `mockito` for HTTP mocking.

### Integration Tests

See [integration-testing.md](integration-testing.md) for E2E testing with protocol validation fixtures.

---

## Code Quality

### Server

```bash
cd server
npm run lint           # ESLint (Airbnb + TypeScript rules)
npm run lint:fix       # Auto-fix
npm run format:check   # Prettier check
npm run format         # Prettier format
npm run typecheck      # TypeScript strict mode check
```

### Client

```bash
cd client
cargo clippy -- -D warnings    # Lint (warnings are errors)
cargo fmt                      # Format
cargo fmt -- --check           # Format check
```

### From Root (Makefile)

```bash
make test     # Run all tests (server + client)
make lint     # Lint both components
make build    # Build both components
make clean    # Remove build artifacts
make help     # Show all targets
```

---

## Docker Development

```bash
# Server with SQLite (default)
docker compose up

# Server with MySQL
docker compose --profile mysql up

# Server with MongoDB
docker compose --profile mongodb up

# Build Docker images
make docker
```

---

## Adding Features

### Server Feature Checklist

1. Define Zod schema in `src/api/middleware/validation.ts`
2. Add route handler in `src/api/routes/`
3. Implement business logic in `src/services/`
4. Add database methods: update interface in `src/database/adapters/base.adapter.ts`, implement in all adapters
5. Add WebSocket message type in `src/websocket/types.ts` (if needed)

### Client Feature Checklist

1. Update state machine in `state/coordinator.rs` if new states needed
2. Implement in the appropriate module (`network/`, `playback/`, `cache/`, `status/`)
3. Errors: use `anyhow` for general errors, `thiserror` for typed errors in `error.rs`

---

## Code Style

- **TypeScript:** Airbnb + Prettier (100 char line width, single quotes, semicolons, trailing commas). `@typescript-eslint/no-explicit-any: error`.
- **Rust:** Standard `rustfmt`. No custom `rustfmt.toml`.
- **Commits:** Conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).

---

*See also: [configuration.md](configuration.md) for all config options, [deployment.md](deployment.md) for production setup.*
