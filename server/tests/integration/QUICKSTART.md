# E2E Tests Quick Start Guide

## TL;DR

```bash
# 1. Build server
cd server
npm run build

# 2. Run E2E tests
npm test tests/integration/e2e-
```

## Step-by-Step

### 1. Install Dependencies (if needed)

```bash
cd server
npm install
```

Dependencies include:
- axios (HTTP client)
- form-data (file uploads)
- ws (WebSocket client)
- jest (test runner)

### 2. Build the Server

**Required**: Tests run the compiled server (`dist/index.js`)

```bash
npm run build
```

This compiles TypeScript to JavaScript.

### 3. Run Tests

**All E2E tests**:
```bash
npm test tests/integration/e2e-
```

**Individual test suites**:
```bash
# Client registration tests
npm test tests/integration/e2e-registration.test.ts

# Playlist assignment tests
npm test tests/integration/e2e-playlist-assignment.test.ts

# Status reporting tests
npm test tests/integration/e2e-status-reporting.test.ts
```

**With verbose output**:
```bash
npm test tests/integration/e2e-registration.test.ts -- --verbose
```

**With client debug output**:
```bash
DEBUG_CLIENT=1 npm test tests/integration/e2e-registration.test.ts
```

## What Gets Tested

### Client Registration (8 tests, ~30s)
- ✅ Client connects and registers via WebSocket
- ✅ Client status changes (online/offline)
- ✅ Heartbeat mechanism
- ✅ Multiple concurrent clients
- ✅ Error handling

### Playlist Assignment (9 tests, ~60s)
- ✅ Upload media files
- ✅ Create playlists
- ✅ Assign playlists to clients
- ✅ Client receives playlist via WebSocket
- ✅ Playlist updates propagation
- ✅ Mixed media types (video + image)
- ✅ Empty playlists

### Status Reporting (8 tests, ~45s)
- ✅ Client sends status updates
- ✅ Server stores status in database
- ✅ Playback position tracking
- ✅ Error reporting
- ✅ REST API status updates
- ✅ Multiple clients with independent status

**Total**: 25 test cases in ~2-3 minutes

## Expected Output

```
PASS  tests/integration/e2e-registration.test.ts (28.5s)
  E2E: Client Registration
    Client Registration Flow
      ✓ should register client successfully (3015ms)
      ✓ should handle client disconnect and status change to offline (8021ms)
      ✓ should handle client reconnect and status change back to online (12045ms)
      ✓ should send heartbeat messages and update last_seen timestamp (8023ms)
    Multiple Clients
      ✓ should handle multiple clients registering simultaneously (9012ms)
      ✓ should maintain separate states for different clients (10034ms)
    Error Handling
      ✓ should handle invalid client ID format gracefully (215ms)
      ✓ should return error for non-existent client (198ms)

Test Suites: 1 passed, 1 total
Tests:       8 passed, 8 total
```

## Troubleshooting

### "Server start timeout"

**Problem**: Server didn't start within 30 seconds

**Solutions**:
1. Ensure server is built: `npm run build`
2. Check if port is already in use: `lsof -i :3101`
3. Kill existing processes: `pkill -f "node dist/index.js"`

### "Cannot find module 'axios'"

**Problem**: Missing dependencies

**Solution**:
```bash
npm install
```

### Tests hang forever

**Problem**: Process not cleaned up

**Solution**:
```bash
# Kill all test processes
pkill -f "node dist/index.js"
pkill -f "montr-client"

# Remove temporary files
rm -f /tmp/montr-client-*.toml
rm -f /tmp/montr-client-*.log
```

### Port conflicts

**Problem**: Multiple test suites can't run in parallel

**Solution**: Tests use different ports (3101, 3102, 3103). If conflicts occur:
1. Check for processes using those ports: `lsof -i :3101`
2. Kill them: `kill <PID>`
3. Or edit test files to use different ports

## Mock vs Real Client

**By default**: Tests use a **mock WebSocket client**
- Simulates client behavior
- No Rust client needed
- Faster and more reliable

**With Rust client**: If you build the client first
```bash
cd client
cargo build
```

Tests will detect and use the real Rust client automatically.

## Common Commands

```bash
# Full test cycle
npm run build && npm test tests/integration/e2e-

# Run single test
npm test tests/integration/e2e-registration.test.ts -- -t "should register"

# Watch mode (re-run on changes)
npm test tests/integration/e2e-registration.test.ts -- --watch

# Coverage report
npm test tests/integration/e2e- -- --coverage

# Only failed tests
npm test tests/integration/e2e- -- --onlyFailures
```

## Clean Environment

To ensure a clean test environment:

```bash
# Kill processes
pkill -f "node dist/index.js"
pkill -f "montr-client"

# Remove temp files
rm -f /tmp/montr-client-*.toml
rm -f /tmp/montr-client-*.log
rm -rf /tmp/montr-test-cache-*

# Remove test fixtures
rm -f tests/fixtures/e2e-*

# Rebuild
npm run build
```

## CI/CD Usage

Example GitHub Actions:

```yaml
- name: E2E Tests
  run: |
    cd server
    npm install
    npm run build
    npm test tests/integration/e2e-
  timeout-minutes: 5
```

## Next Steps

After running tests successfully:

1. **Read the documentation**: `E2E_README.md`
2. **Write new tests**: Use existing tests as templates
3. **Customize**: Adjust timeouts, ports, or add new test cases
4. **Integrate**: Add to your CI/CD pipeline

## Need Help?

- **Documentation**: See `E2E_README.md` for detailed guide
- **Examples**: Look at existing test files
- **Helpers**: Check `helpers/` directory for utilities
- **Summary**: See `E2E_IMPLEMENTATION_SUMMARY.md` for overview

## Success Criteria

Tests are working correctly if:
- ✅ All tests pass (25/25)
- ✅ No hanging processes after completion
- ✅ Clean exit without errors
- ✅ Takes 2-3 minutes total
- ✅ No leftover temp files

Enjoy testing! 🚀
