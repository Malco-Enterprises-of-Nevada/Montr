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
- [x] Implement MySQL adapter — `server/src/database/adapters/mysql.adapter.ts`
- [x] Implement MSSQL adapter — `server/src/database/adapters/mssql.adapter.ts`
- [x] Implement MongoDB adapter — `server/src/database/adapters/mongodb.adapter.ts`
- [x] Add database migration runner (`server/src/database/migrations/`)
- [x] Create SQL base adapter for shared logic (`server/src/database/adapters/sql-base.adapter.ts`)
- [x] Adapter conformance test suite (43 tests, `npm run test:adapters`)

### Auto-Start / Service Integration
- [x] Create systemd service file for server (`deploy/systemd/montr-server.service`)
- [x] Create systemd service file for client (`deploy/systemd/montr-client.service`)
- [x] Add SIGTERM handling to Rust client for systemd compatibility
- [ ] Implement Windows Service integration in Rust client — `client/Cargo.toml:65` (deferred)

### Platform Compatibility
- [x] Document platform compatibility (`docs/platform-compatibility.md`)
- [x] Document fallback strategy if mpv unavailable
- [ ] Test mpv/libmpv on all target platforms (Debian, Arch, Windows) — needs hardware

### Configuration Improvements
- [x] Make WebSocket intervals configurable — `WS_HEALTH_CHECK_INTERVAL`, `WS_STALE_TIMEOUT`, `WS_HEARTBEAT_TIMEOUT`
- [x] Make UI refresh intervals configurable — `/api/ui-config` endpoint + frontend fetch
- [x] Add startup warning when `API_KEY_REQUIRED=true` but `API_KEY` is empty

---

## Phase 6: Packaging & Build

### Build Scripts
- [x] `scripts/build/build-all.sh`
- [x] `scripts/build/build-server.sh`
- [x] `scripts/build/build-client-linux.sh` (cross-compiles via Docker)
- [ ] `scripts/build/build-client-windows.sh` (deferred — no Windows scope)

### Debian Packages
- [x] `scripts/packaging/debian/server/DEBIAN/control` + maintainer scripts
- [x] `scripts/packaging/debian/client/DEBIAN/control` + maintainer scripts
- [x] `scripts/packaging/build-deb.sh` — assembles and builds .deb packages

### Arch Packages (deferred)
- [ ] `scripts/packaging/arch/PKGBUILD-server`
- [ ] `scripts/packaging/arch/PKGBUILD-client`

### Windows Installers (deferred)
- [ ] `scripts/packaging/windows/server-installer.nsi`
- [ ] `scripts/packaging/windows/client-installer.nsi`

### Containerization
- [x] `docker/server.Dockerfile` — multi-stage (build + runtime)
- [x] `docker/client.Dockerfile` — multi-stage with binary export target
- [x] `docker-compose.yml` — server with SQLite + optional MySQL/MongoDB profiles
- [x] `.dockerignore`

### Root Makefile
- [x] `make build` — build server + client
- [x] `make test` — run all tests
- [x] `make lint` — lint both components
- [x] `make docker` — build Docker images
- [x] `make package` — build .deb packages
- [x] `make clean` — clean build artifacts

---

## Phase 7: Documentation & Polish

### Stub Documentation (headers only, no real content)
- [x] `docs/api-specification.md` — full REST API spec with schemas, error codes, curl examples
- [x] `docs/database-schema.md` — complete DDL, ER diagram, indexes, triggers, views
- [x] `docs/deployment.md` — step-by-step instructions per platform (already complete from Phase 5)
- [x] `docs/troubleshooting.md` — common issues, error codes, log locations, diagnostics
- [x] `docs/development.md` — dev setup, testing, code quality, contributing guide
- [x] `docs/websocket-protocol.md` — connection lifecycle, heartbeat, reconnection, error handling
- [x] `docs/configuration.md` — full server env var and client TOML/CLI reference
- [x] `shared/protocol.md` — complete message schemas for all 9 message types

### Code Quality
- [x] Replace `(req as any)` casts with typed Express request extension — `server/src/types/express.d.ts`
- [x] Add thumbnail failure visibility (status field + retry endpoint) — `thumbnail_status` column, migration 002, `POST /api/media/:id/thumbnail/retry`

### CI/CD
- [x] GitHub Actions workflow: run `npm test` on push/PR — `.github/workflows/ci-server.yml`
- [x] GitHub Actions workflow: run `cargo check` / `cargo test` on push/PR — `.github/workflows/ci-client.yml`
- [x] GitHub Actions workflow: lint + typecheck + format check — included in ci-server.yml and ci-client.yml
- [x] Enforce 70% code coverage threshold in CI — `npm run test:coverage` in ci-server.yml (jest.config.js thresholds)
- [x] Cross-platform build verification (Linux, Windows) — matrix in ci-server.yml, check-windows job in ci-client.yml

### Release Process
- [x] Version tagging strategy (v1.0.0, v1.1.0, etc.) — semver, tag-triggered release workflow
- [x] Release notes template — auto-generated from conventional commits in `.github/workflows/release.yml`
- [x] Tag releases in git per project.md guidelines — `git tag v1.x.x && git push origin v1.x.x`

### Pre-commit Hooks
- [x] Set up Husky for lint/format checks on commit — Husky + lint-staged in root `package.json`

---

## v1.1 — Scheduling & Grouping

### Scheduling Support
- [x] **Schema**: Add `schedules` table (id, name, client_id/group_id, playlist_id, start_time, end_time, days_of_week, priority, enabled, created_at) — migration 004
- [x] **Schema**: Add `loop` boolean column to `playlists` table — migration 004
- [x] **Server API**: `POST /api/schedules` — create schedule
- [x] **Server API**: `GET /api/schedules` — list schedules
- [x] **Server API**: `GET /api/schedules/:id` — get schedule details
- [x] **Server API**: `PUT /api/schedules/:id` — update schedule
- [x] **Server API**: `DELETE /api/schedules/:id` — delete schedule
- [x] **Server API**: `POST /api/schedules/evaluate` — manual trigger for testing
- [x] **Server service**: `ScheduleService` — evaluate active schedules, trigger playlist switches at configured times
- [x] **Server cron**: Background task evaluates schedules every 60 seconds, triggers at start_time
- [x] **WebSocket**: Uses existing `playlist_assigned` message — schedule triggers `sendPlaylistToClient`/`sendPlaylistToGroup`
- [ ] **Client**: Handle `playlist_switch` in coordinator — download new playlist, transition playback (deferred — client already handles `playlist_assigned`)
- [x] **Web UI**: Schedule management page — create/edit with time picker, day selector, target selection (all/client/group)
- [ ] **Web UI**: Calendar/timeline view showing scheduled playlists per client (deferred)
- [x] **Tests**: Schedule service unit tests (13 tests including isScheduleActive logic)

### Multiple Playlists Per Client
- [x] **Schema**: Add `client_playlists` junction table (client_id, playlist_id, priority) — migration 005. `clients.assigned_playlist_id` kept as active playlist (resolved from highest priority).
- [x] **Server API**: `POST /api/clients/:id/playlists` — assign playlist with priority
- [x] **Server API**: `GET /api/clients/:id/playlists` — list assignments ordered by priority
- [x] **Server API**: `PUT /api/clients/:id/playlists/:playlistId` — update priority
- [x] **Server API**: `DELETE /api/clients/:id/playlists/:playlistId` — remove playlist assignment
- [x] **Server service**: Priority resolution — highest priority playlist automatically becomes `assigned_playlist_id`
- [ ] **Client**: Support playlist stack — maintain multiple playlists, switch based on server commands (deferred — client already handles `playlist_assigned`)

### Client Grouping
- [x] **Schema**: Add `client_groups` table (id, name, description, created_at) — migration 003
- [x] **Schema**: Add `client_group_members` junction table (group_id, client_id) — migration 003
- [x] **Server API**: `POST /api/groups` — create group
- [x] **Server API**: `GET /api/groups` — list groups
- [x] **Server API**: `PUT /api/groups/:id` — update group (name, members)
- [x] **Server API**: `DELETE /api/groups/:id` — delete group
- [x] **Server API**: `POST /api/groups/:id/assign` — batch assign playlist to all members
- [x] **Server API**: `GET /api/groups/:id/members`, `POST /api/groups/:id/members`, `DELETE /api/groups/:id/members/:clientId` — member management
- [x] **WebSocket**: Broadcast playlist assignment to all group members simultaneously — `broadcastToGroup()`, `sendPlaylistToGroup()`, `sendCommandToGroup()`
- [x] **Web UI**: Group management page — create/edit groups, add/remove members, assign playlist to group
- [x] **Web UI**: Bulk actions toolbar — assign playlist to entire group
- [x] **Tests**: Group service unit tests (11 tests)

### Playlist Priority & Interruptions
- [x] **Schema**: Priority already on schedules and client_playlists. Added `interrupted_from_playlist_id` to clients (migration 006) for interrupt/resume tracking.
- [x] **Server service**: `interruptWithPlaylist()` saves current playlist, switches to interrupt playlist. `resumeFromInterrupt()` restores previous.
- [x] **Server API**: `POST /api/clients/:id/interrupt` and `POST /api/clients/:id/resume`
- [x] **WebSocket**: `playlist_interrupt` and `playlist_resume` message types with full playlist data
- [ ] **Client**: Playlist stack in coordinator — push interrupt playlist, pop to resume previous (deferred — client already handles playlist_assigned)
- [x] **Tests**: Interrupt/resume unit tests (5 tests)

---

## v1.2 — Remote Control & Analytics

### Remote Control from Web UI
- [x] **Server API**: `POST /api/clients/:id/command` — send command (pause, resume, skip, previous, volume, seek, reload_playlist)
- [x] **Server API**: `POST /api/groups/:id/command` — send command to group
- [x] **WebSocket**: Extended `command` message type with `CommandType` union and `args` object (volume: 0-100, position: seconds)
- [ ] **Client**: Handle volume command via mpv `volume` property (deferred — server-side ready)
- [ ] **Client**: Handle seek command via mpv `seek` property (deferred — server-side ready)
- [x] **Web UI**: Client detail panel with playback controls (play/pause, skip, previous, volume slider, seek bar), playlist assignments view
- [ ] **Web UI**: Real-time playback position updates via WebSocket (deferred)
- [x] **Tests**: All 680 existing tests pass with extended command types

### Live Preview of Client Screens
- [ ] **Client**: Periodic screenshot capture via mpv `screenshot-to-file` command (every 10s or on-demand) — deferred (server-side ready)
- [x] **Server API**: `GET /api/clients/:id/preview` — serve latest screenshot
- [x] **Server API**: `POST /api/clients/:id/preview` — upload screenshot (JPEG/PNG, max 5MB)
- [x] **Server storage**: Store latest preview per client in `previews/` dir (overwrites previous)
- [x] **Web UI**: Thumbnail grid of all client screens on clients page with auto-refresh
- [x] **Web UI**: Click-to-enlarge live preview modal
- [x] **Tests**: All 680 existing tests pass with preview storage changes

### Analytics & Playback Logs
- [x] **Schema**: Add `playback_logs` table — migration 007
- [x] **Server service**: `AnalyticsService` — playback logging, aggregation, data retention cleanup
- [x] **Server API**: `GET /api/analytics/playback` — playback history with filters (client, media, date range, limit)
- [x] **Server API**: `GET /api/analytics/summary` — playback hours by client
- [x] **Server API**: `GET /api/analytics/uptime` — client uptime statistics
- [x] **Server API**: `GET /api/analytics/media-popularity` — most-played media ranking
- [x] **Server API**: `POST /api/analytics/playback/start` and `POST /api/analytics/playback/:id/end` — log recording
- [x] **Server API**: `POST /api/analytics/cleanup` — configurable data retention cleanup
- [ ] **Client**: Report media start/end events with timestamps (deferred — server-side ready)
- [x] **Web UI**: Analytics dashboard with tables for playback summary, media popularity, client uptime, recent playback
  - [x] Playback hours per client (table)
  - [x] Media popularity ranking (table)
  - [x] Client uptime with status (table)
  - [x] Recent playback events (table)
- [x] **Data retention**: `POST /api/analytics/cleanup` with configurable retention period (default 90 days)
- [x] **Tests**: All 680 existing tests pass with analytics additions

### Email/Webhook Notifications
- [x] **Schema**: Add `notification_rules` and `notification_history` tables — migration 008
- [x] **Server service**: `NotificationService` — rule CRUD, event evaluation, dispatch to email/webhook
- [x] **Events to notify on**: client_offline, client_error, playlist_empty, storage_full
- [x] **Email**: SMTP integration (nodemailer) — configurable via SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
- [x] **Webhooks**: HTTP POST to configured URL with JSON payload (source, timestamp, event data)
- [x] **Server API**: `POST /api/notifications/rules` — create notification rule
- [x] **Server API**: `GET /api/notifications/rules` — list rules
- [x] **Server API**: `GET /api/notifications/rules/:id` — get rule
- [x] **Server API**: `DELETE /api/notifications/rules/:id` — delete rule
- [x] **Server API**: `GET /api/notifications/history` — recent notifications sent
- [x] **Server API**: `POST /api/notifications/test` — fire test notification
- [x] **Web UI**: Notification settings page — add/delete rules, view history
- [x] **Tests**: All existing tests pass with notification additions

---

## v1.3 — Security & Scale

### Multi-Server Clustering
- [x] **Architecture**: SessionStore interface with pluggable backends (in-memory default, Redis-ready)
- [x] **Server**: SessionStore abstraction (`cluster/session-store.ts`) — get/set/delete/keys with TTL
- [ ] **Server**: WebSocket connection handoff between cluster nodes (deferred — requires Redis pub/sub)
- [ ] **Server**: Shared media storage (NFS, S3, or distributed filesystem) (deferred)
- [ ] **Load balancer**: HAProxy/Nginx config (deferred — documented in deployment guide)
- [x] **Config**: `CLUSTER_ENABLED`, `CLUSTER_NODE_ID`, `CLUSTER_DISCOVERY_URL`, `CLUSTER_REDIS_URL` env vars
- [x] **Health**: Cluster-aware health endpoint — `/api/health` includes `node` object with nodeId, cluster status
- [ ] **Tests**: Multi-node integration tests (deferred — requires infrastructure)

### Content Approval Workflow
- [x] **Schema**: Add `approval_status` column to `media_files` (pending/approved/rejected) and `approval_logs` table — migration 009
- [x] **Server API**: `POST /api/media/:id/approve` — approve media
- [x] **Server API**: `POST /api/media/:id/reject` — reject media with optional comment
- [x] **Server API**: `GET /api/media/pending` — list media pending approval
- [x] **Server API**: `GET /api/media/:id/approval-logs` — approval history
- [ ] **Server service**: Only approved media can be added to playlists (enforcement deferred — API ready)
- [ ] **Web UI**: Approval queue page (deferred — API endpoints ready)
- [ ] **Notifications**: Alert when new media needs approval (can use existing notification system)
- [x] **Tests**: All 680 existing tests pass with approval additions

### User Roles & Permissions
- [x] **Schema**: Add `users` table (id, username, email, password_hash, role, created_at) — migration 010
- [x] **Schema**: Roles as TypeScript union type: admin, editor, viewer
- [x] **Server**: JWT authentication (jsonwebtoken + bcryptjs), backward compatible — if no users exist, auth is skipped (bootstrap mode)
- [x] **Server middleware**: `requireAuth()` and `requireRole()` RBAC middleware
- [x] **Permissions matrix**: Admin (full access), Editor (manage content), Viewer (read-only). Enforced on user management routes.
- [x] **Server API**: `POST /api/auth/login` — login with username/password, returns JWT
- [x] **Server API**: `POST /api/auth/setup` — create first admin user (one-time bootstrap)
- [x] **Server API**: `GET /api/auth/me` — get current user info
- [x] **Server API**: CRUD for `/api/users` (admin only) — GET list, POST create, DELETE
- [ ] **Web UI**: Login page, user management page (deferred — API endpoints ready)
- [x] **Tests**: All 680 existing tests pass (bootstrap mode ensures backward compatibility)

### HTTPS/TLS Support
- [x] **Server**: TLS configuration — reads cert/key from `TLS_CERT_PATH` and `TLS_KEY_PATH`
- [x] **Server**: Auto-redirect HTTP to HTTPS on `TLS_HTTP_PORT` (default 80)
- [x] **Server**: WebSocket over WSS (automatic when TLS enabled — same HTTPS server)
- [x] **Client**: TLS certificate validation, optional CA bundle config — `ca_cert_path` and `tls_skip_verify` in `[server]` config
- [x] **Config**: `TLS_ENABLED`, `TLS_CERT_PATH`, `TLS_KEY_PATH`, `TLS_HTTP_PORT` env vars added to .env.example
- [ ] **Docs**: Certificate generation guide (deferred)
- [x] **Tests**: All 680 existing tests pass (TLS is opt-in, no impact on HTTP mode)

---

## v2.0 — Cloud & Mobile

### Cloud Sync
- [ ] **Architecture**: Optional cloud backend (AWS S3 / Azure Blob / GCP Storage) for media
- [ ] **Server**: Cloud storage adapter alongside local storage
- [ ] **Server**: Media upload to cloud with local cache
- [ ] **Server**: CDN-friendly download URLs for clients
- [ ] **Client**: Download from cloud URLs instead of server
- [ ] **Config**: Cloud provider settings (provider, bucket, region, credentials)
- [ ] **Sync**: Multi-server media synchronization via cloud storage
- [ ] **Tests**: Cloud upload/download mocks, CDN URL generation tests

### Mobile App for Management
- [ ] **Tech choice**: React Native or Flutter for iOS + Android
- [ ] **Features**: Dashboard, media upload (camera roll), playlist management, client monitoring
- [ ] **Auth**: OAuth2/JWT token-based auth from mobile
- [ ] **Push notifications**: FCM/APNs for client alerts (offline, error)
- [ ] **API**: Ensure all server APIs are mobile-friendly (pagination, image optimization)
- [ ] **Offline**: Local caching of dashboard data for spotty connectivity
- [ ] **Tests**: Mobile E2E tests (Detox or similar)

### Advanced Scheduling
- [ ] **Complex rules**: Cron-like expressions for schedule triggers
- [ ] **Conditional rules**: Weather-based, date-based (holidays), event-triggered playlists
- [ ] **Schedule templates**: Pre-built templates (business hours, weekday/weekend, seasonal)
- [ ] **Conflict resolution**: When multiple rules match, configurable resolution strategy
- [ ] **Preview**: Calendar view showing what will play when, with simulation mode
- [ ] **Web UI**: Visual rule builder with condition chains
- [ ] **Tests**: Complex rule evaluation tests, conflict resolution tests

### A/B Testing for Content
- [ ] **Schema**: Add `experiments` table (id, name, playlist_a_id, playlist_b_id, split_ratio, start_date, end_date, status)
- [ ] **Schema**: Add `experiment_results` table (id, experiment_id, client_id, variant, engagement_metric)
- [ ] **Server service**: `ExperimentService` — assign clients to variants, track results
- [ ] **Server API**: CRUD for `/api/experiments`
- [ ] **Server API**: `GET /api/experiments/:id/results` — statistical analysis of variants
- [ ] **Assignment**: Consistent hashing of client ID to variant (stable assignment)
- [ ] **Metrics**: Track completion rate, dwell time, error rate per variant
- [ ] **Web UI**: Experiment creation wizard, results dashboard with statistical significance indicator
- [ ] **Tests**: Variant assignment tests, metrics aggregation tests
