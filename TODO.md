# Montr — TODO

Consolidated list of all remaining work. Items are organized by project phase (see `project.md`).
Phases 1-4 are complete. This file tracks what remains.

---

## Completed Phases

- [x] **Phase 1**: Foundation — project structure, SQLite schema, base docs
- [x] **Phase 2**: Server Core — REST API, WebSocket, Web UI, services
- [x] **Phase 3**: Client Core — config, network, playback, cache, status
- [x] **Phase 4**: Integration & Testing — ~315 server test cases, ~170 client test cases, E2E infrastructure, protocol fixtures

---

## Phase 5: System Integration

### Database Adapters
- [ ] Implement MySQL adapter — `server/src/database/connection.ts:39`
- [ ] Implement MSSQL adapter — `server/src/database/connection.ts:43`
- [ ] Implement MongoDB adapter — `server/src/database/connection.ts:47`
- [ ] Add database migration runner (`server/src/database/migrations/`)

### Auto-Start / Service Integration
- [ ] Create systemd service file for server (`montr-server.service`)
- [ ] Create systemd service file for client (`montr-client.service`)
- [ ] Implement Windows Service integration in Rust client — `client/Cargo.toml:65` (dependency added, not wired up)

### Platform Compatibility
- [ ] Test mpv/libmpv on all target platforms (Debian, Arch, Windows) — risk mitigation per project.md
- [ ] Document fallback strategy if mpv unavailable (gstreamer/ffmpeg)

### Configuration Improvements
- [ ] Make WebSocket intervals configurable (health check 30s, stale timeout 5min) — `server/src/websocket/server.ts:51`
- [ ] Make UI refresh intervals configurable (dashboard 30s, toast 3s) — `server/src/web/public/js/app.js:1014`
- [ ] Add startup warning when `API_KEY_REQUIRED=true` but `API_KEY` is empty

---

## Phase 6: Packaging & Build

### Build Scripts (none exist — planned in `project.md`)
- [ ] `scripts/build/build-all.sh`
- [ ] `scripts/build/build-server.sh`
- [ ] `scripts/build/build-client-linux.sh`
- [ ] `scripts/build/build-client-windows.sh`

### Debian Packages
- [ ] `scripts/packaging/debian/server/DEBIAN/control`
- [ ] `scripts/packaging/debian/client/DEBIAN/control`
- [ ] Installation/removal scripts

### Arch Packages
- [ ] `scripts/packaging/arch/PKGBUILD-server`
- [ ] `scripts/packaging/arch/PKGBUILD-client`

### Windows Installers
- [ ] `scripts/packaging/windows/server-installer.nsi`
- [ ] `scripts/packaging/windows/client-installer.nsi`

### Containerization
- [ ] Dockerfile for server
- [ ] Dockerfile for client
- [ ] `docker-compose.yml` for local development
- [ ] `.dockerignore`

### Root Makefile
- [ ] `make build` — build server + client
- [ ] `make test` — run all tests
- [ ] `make lint` — lint both components
- [ ] `make clean` — clean build artifacts

---

## Phase 7: Documentation & Polish

### Stub Documentation (headers only, no real content)
- [ ] `docs/api-specification.md` — needs request/response schemas, error codes, examples
- [ ] `docs/database-schema.md` — needs actual DDL, relationships, ERD
- [ ] `docs/deployment.md` — needs step-by-step instructions per platform
- [ ] `docs/troubleshooting.md` — needs actual solutions for common issues
- [ ] `docs/development.md` — needs detailed dev environment setup
- [ ] `docs/websocket-protocol.md` — needs complete message specification
- [ ] `docs/configuration.md` — needs full reference for all config options
- [ ] `shared/protocol.md` — needs complete protocol specification

### Code Quality
- [ ] Replace `(req as any)` casts with typed Express request extension — `server/src/api/middleware/validation.ts:51`
- [ ] Add thumbnail failure visibility (status field or retry) — `server/src/services/media.service.ts:210`

### CI/CD
- [ ] GitHub Actions workflow: run `npm test` on push/PR
- [ ] GitHub Actions workflow: run `cargo check` / `cargo test` on push/PR
- [ ] GitHub Actions workflow: lint + typecheck + format check
- [ ] Enforce 70% code coverage threshold in CI (configured in jest.config.js, needs CI pipeline)
- [ ] Cross-platform build verification (Linux, Windows)

### Release Process
- [ ] Version tagging strategy (v1.0.0, v1.1.0, etc.)
- [ ] Release notes template
- [ ] Tag releases in git per project.md guidelines

### Pre-commit Hooks
- [ ] Set up Husky for lint/format checks on commit

---

## Future Enhancements (from project.md)

### v1.1
- [ ] Scheduling support (time-based playlist switching)
- [ ] Multiple playlists per client with schedules
- [ ] Client grouping for batch operations
- [ ] Playlist priority and interruptions

### v1.2
- [ ] Remote control (pause, skip, volume) from Web UI
- [ ] Live preview of client screens
- [ ] Analytics (playback logs, uptime)
- [ ] Email/webhook notifications

### v1.3
- [ ] Multi-server clustering
- [ ] Content approval workflow
- [ ] User roles and permissions
- [ ] HTTPS/TLS support

### v2.0
- [ ] Cloud sync option
- [ ] Mobile app for management
- [ ] Advanced scheduling (complex rules)
- [ ] A/B testing for content
