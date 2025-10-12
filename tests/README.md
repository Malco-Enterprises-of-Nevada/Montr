# Montr Integration Tests

This directory contains cross-component integration tests for the Montr media playlist system.

## Directory Structure

```
tests/
├── protocol/               # Protocol validation tests
│   ├── fixtures/          # Shared JSON fixtures
│   ├── server-protocol.test.ts
│   └── README.md
├── integration/           # E2E integration tests (planned)
│   ├── helpers/
│   ├── e2e-registration.test.ts
│   └── e2e-playlist.test.ts
└── README.md             # This file
```

## Test Types

### 1. Protocol Validation Tests ✅ (Implemented)

**Location**: `tests/protocol/`
**Purpose**: Verify JSON message compatibility between Rust client and Node.js server
**Speed**: Fast (~1 second)
**Run frequency**: Every commit

```bash
# Server side
cd server && npm test tests/protocol/

# Client side
cd client && cargo test protocol_validation
```

**See**: [protocol/README.md](protocol/README.md) for details

### 2. End-to-End Integration Tests 🚧 (Planned)

**Location**: `tests/integration/`
**Purpose**: Test real client-server communication
**Speed**: Slow (15-60 seconds)
**Run frequency**: On PR, before merge

These tests will:
- Spawn real server and client processes
- Test registration flow
- Test playlist assignment
- Test WebSocket reconnection
- Test media download and playback coordination

### 3. Docker Compose E2E Tests 🚧 (Planned)

**Location**: `docker-compose.test.yml`
**Purpose**: Full system validation with dependencies
**Speed**: Very slow (5-15 minutes)
**Run frequency**: Before releases

## Quick Start

### Prerequisites

```bash
# Install dependencies
cd server && npm install
cd client && cargo build

# For E2E tests (when implemented)
npm install --save-dev axios form-data @types/node ts-node
```

### Running All Tests

```bash
# From project root
./scripts/test-all.sh
```

Or manually:

```bash
# 1. Server unit tests
cd server && npm test

# 2. Client unit tests
cd client && cargo test

# 3. Protocol validation tests
cd server && npm test tests/protocol/
cd client && cargo test protocol_validation

# 4. E2E integration tests (when implemented)
cd tests/integration && npm test
```

## Test Strategy

The Montr project uses a **layered testing approach**:

```
┌─────────────────────────────────────────────────┐
│  Level 5: Docker Compose E2E (Pre-release)     │ ← Slowest, most comprehensive
├─────────────────────────────────────────────────┤
│  Level 4: E2E Integration (PR, Nightly)        │
├─────────────────────────────────────────────────┤
│  Level 3: Client Unit Tests (Every commit)     │
├─────────────────────────────────────────────────┤
│  Level 2: Server Unit Tests (Every commit)     │
├─────────────────────────────────────────────────┤
│  Level 1: Protocol Validation (Every commit)   │ ← Fastest, most frequent
└─────────────────────────────────────────────────┘
```

### When to Run Each Level

| Level | Trigger | Duration | Purpose |
|-------|---------|----------|---------|
| 1 | Every commit | ~1s | Catch protocol breaks immediately |
| 2 | Every commit | ~2m | Verify server logic |
| 3 | Every commit | ~3m | Verify client logic |
| 4 | PR, Nightly | ~10m | Verify integration |
| 5 | Weekly, Pre-release | ~15m | Full system validation |

## Current Test Coverage

### Server (244+ tests) ✅

- Unit tests: `server/tests/unit/`
  - Services: 95 tests
  - Database: 20+ tests
  - WebSocket: 40+ tests
- Integration tests: `server/tests/integration/`
  - Routes: 88 tests

### Client (150+ tests) ✅

- Unit tests: `client/src/*/tests.rs`
  - Config: 27 tests
  - Network: 20+ tests
  - Cache: 34 tests
  - Playback: 22 tests
  - State: 23 tests
  - Status: 8 tests

### Protocol Tests (20+ tests) ✅

- Server-side: 15+ tests in `tests/protocol/server-protocol.test.ts`
- Client-side: 12+ tests in `client/tests/protocol_validation.rs`

### Integration Tests (Planned) 🚧

- Registration flow
- Playlist assignment
- Media download
- WebSocket reconnection
- Playback coordination

## Adding New Tests

### Protocol Validation Test

1. Add fixture: `tests/protocol/fixtures/your_message.json`
2. Add server test in `tests/protocol/server-protocol.test.ts`
3. Add client test in `client/tests/protocol_validation.rs`

### E2E Integration Test

1. Create test file: `tests/integration/e2e-your-feature.test.ts`
2. Use helpers from `tests/integration/helpers/`
3. Follow pattern from existing E2E tests

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Integration Tests

on: [push, pull_request]

jobs:
  protocol-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Setup Rust
        uses: actions-rust-lang/setup-rust-toolchain@v1

      - name: Run protocol tests
        run: |
          cd server && npm install && npm test tests/protocol/
          cd client && cargo test protocol_validation

  integration-tests:
    runs-on: ubuntu-latest
    needs: protocol-tests
    steps:
      - uses: actions/checkout@v3

      - name: Install libmpv
        run: sudo apt-get install -y libmpv-dev

      - name: Build server
        run: cd server && npm install && npm run build

      - name: Build client
        run: cd client && cargo build --release

      - name: Run E2E tests
        run: npm test tests/integration/
```

## Troubleshooting

### Protocol tests fail

**Symptom**: JSON parsing errors
**Cause**: Protocol drift between client and server
**Fix**: Update type definitions to match fixtures

### E2E tests timeout

**Symptom**: Server or client doesn't start
**Cause**: Port conflicts, missing dependencies
**Fix**: Check ports are available, verify dependencies installed

### Tests flaky/intermittent failures

**Symptom**: Tests pass sometimes, fail other times
**Cause**: Race conditions, insufficient waits
**Fix**: Add proper wait conditions, increase timeouts

## Performance Benchmarks

Target execution times:

- Protocol validation: < 1 second
- Server unit tests: < 2 minutes
- Client unit tests: < 3 minutes
- E2E integration tests: < 10 minutes
- Full suite: < 15 minutes

## Related Documentation

- [Integration Testing Guide](../docs/integration-testing.md) - Comprehensive testing strategy
- [Protocol README](protocol/README.md) - Protocol validation details
- [Server Tests](../server/tests/README.md) - Server test documentation
- [WebSocket Protocol](../docs/websocket-protocol.md) - Protocol specification

## Future Roadmap

### Short-term (Phase 4)
- [x] Protocol validation tests
- [ ] E2E registration test
- [ ] E2E playlist assignment test
- [ ] WebSocket reconnection test

### Medium-term (Phase 5)
- [ ] Docker Compose E2E setup
- [ ] Performance benchmarks
- [ ] Load testing (25 concurrent clients)
- [ ] Chaos engineering tests (network failures)

### Long-term (Phase 6+)
- [ ] Visual regression tests (web UI)
- [ ] Accessibility tests
- [ ] Security penetration tests
- [ ] Stress tests (> 50GB storage)

## Contributing

When adding features:

1. Write protocol tests first (if protocol changes)
2. Add unit tests for new logic
3. Add E2E test for critical user flows
4. Update this README if adding new test types

All tests must pass before merging to main.
