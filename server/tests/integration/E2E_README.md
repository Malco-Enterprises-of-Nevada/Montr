# End-to-End Integration Tests

This directory contains end-to-end (E2E) integration tests for the Montr server that test complete workflows including client-server communication via WebSocket and REST API.

## Test Structure

```
tests/integration/
├── helpers/                      # Test helper utilities
│   ├── api-client.ts            # REST API wrapper for easy testing
│   ├── client-process.ts        # Manages test client processes
│   ├── server-process.ts        # Manages test server process
│   ├── wait-for.ts              # Async waiting utilities
│   ├── fixtures.ts              # Test data and file generation
│   └── index.ts                 # Exports all helpers
├── e2e-registration.test.ts     # Client registration tests (8 test cases)
├── e2e-playlist-assignment.test.ts  # Playlist assignment tests (9 test cases)
├── e2e-status-reporting.test.ts # Status reporting tests (8 test cases)
└── routes/                      # REST API integration tests
    ├── client.routes.test.ts
    ├── media.routes.test.ts
    └── playlist.routes.test.ts
```

## Test Suites

### 1. Client Registration Tests (`e2e-registration.test.ts`)

Tests the complete client registration and connection lifecycle:

- **Client Registration Flow** (4 tests)
  - Client registers successfully via WebSocket
  - Client disconnect changes status to offline
  - Client reconnect changes status back to online
  - Heartbeat messages update last_seen timestamp

- **Multiple Clients** (2 tests)
  - Multiple clients can register simultaneously
  - Different clients maintain separate states

- **Error Handling** (2 tests)
  - Invalid client ID format handling
  - Non-existent client error handling

**Total**: 8 test cases

### 2. Playlist Assignment Tests (`e2e-playlist-assignment.test.ts`)

Tests playlist creation, assignment, and updates:

- **Basic Playlist Assignment** (4 tests)
  - Assign playlist to client via REST API
  - Client receives playlist via WebSocket
  - Update playlist and client receives update
  - Handle playlists with multiple mixed media types
  - Handle empty playlist assignment

- **Playlist Reassignment** (2 tests)
  - Switch between different playlists
  - Unassign playlist (set to null)

- **Multiple Clients with Different Playlists** (1 test)
  - Assign different playlists to different clients

**Total**: 9 test cases

### 3. Status Reporting Tests (`e2e-status-reporting.test.ts`)

Tests client status updates and playback tracking:

- **Basic Status Updates** (3 tests)
  - Receive status updates from client
  - Update client status in database
  - Track playback position accurately

- **Status with Error Reporting** (2 tests)
  - Report and store error messages
  - Handle status updates with null media (idle state)

- **Status Updates with Playlist Playback** (1 test)
  - Track status through multiple media items

- **REST API Status Updates** (2 tests)
  - Manual status updates via REST API
  - Concurrent status updates from multiple clients

**Total**: 8 test cases

## Helper Utilities

### TestServerProcess

Manages a test server instance with automatic startup, health checking, and cleanup.

```typescript
import { TestServerProcess } from './helpers/server-process';

const server = new TestServerProcess({ port: 3101 });
await server.start();
await server.waitUntilReady();

// Use server.getUrl() for HTTP requests
// Use server.getWsUrl() for WebSocket connections

await server.stop();
```

**Features**:
- Automatic port configuration
- In-memory SQLite database for isolation
- Health check polling
- Graceful shutdown with SIGTERM/SIGKILL

### TestClientProcess

Manages a test client instance (Rust client or mock WebSocket client).

```typescript
import { TestClientProcess } from './helpers/client-process';

const client = new TestClientProcess({
  clientId: 'test-client-001',
  clientName: 'Test Client',
});

await client.start(server.getUrl());

// For mock clients only:
if (client.isMockClient()) {
  client.sendStatusUpdate(mediaId, position, isPlaying);
  client.sendError('Error message', 'ERROR_CODE');
}

await client.stop();
```

**Features**:
- Falls back to mock WebSocket client if Rust client not built
- Automatic config file generation
- Mock client simulates registration, heartbeat, and status updates
- Proper cleanup of config files and processes

### MontrApiClient

Type-safe wrapper around axios for all REST API endpoints.

```typescript
import { MontrApiClient } from './helpers/api-client';

const apiClient = new MontrApiClient('http://localhost:3101');

// Media operations
const upload = await apiClient.uploadMedia([filePath]);
const media = await apiClient.getMedia(mediaId);

// Playlist operations
const playlist = await apiClient.createPlaylist({ name: 'Test' });
await apiClient.addToPlaylist(playlistId, [mediaId]);

// Client operations
const client = await apiClient.getClient(clientId);
await apiClient.assignPlaylist(clientId, playlistId);
const status = await apiClient.getClientStatus(clientId);
```

**Features**:
- All 24 REST API endpoints covered
- TypeScript type safety
- Automatic JSON parsing
- FormData handling for file uploads

### Wait Utilities

Async utilities for polling and waiting in tests.

```typescript
import { waitFor, sleep, waitForValue, retry } from './helpers/wait-for';

// Wait for a condition
await waitFor(
  () => client.isConnected(),
  { timeout: 10000, interval: 100 }
);

// Wait for a value to be defined
const result = await waitForValue(
  () => database.getRecord(id),
  { timeout: 5000 }
);

// Retry an operation
const data = await retry(
  () => fetchData(),
  3, // max attempts
  1000 // delay between attempts
);
```

### Test Fixtures

Generate test media files and mock data.

```typescript
import {
  createTestVideoFile,
  createTestImageFile,
  cleanupTestFiles,
} from './helpers/fixtures';

// Create test files
const video = createTestVideoFile('test.mp4');
const image = createTestImageFile('test.png');

// Use files in tests...

// Cleanup
cleanupTestFiles([video, image]);
```

## Running E2E Tests

### Prerequisites

1. **Build the server**:
   ```bash
   cd server
   npm run build
   ```

2. **(Optional) Build the Rust client**:
   ```bash
   cd client
   cargo build
   ```

   If the Rust client is not built, tests will automatically use a mock WebSocket client.

### Run Tests

```bash
# Run all E2E tests
npm test tests/integration/e2e-

# Run specific test suite
npm test tests/integration/e2e-registration.test.ts

# Run with verbose output
npm test tests/integration/e2e-registration.test.ts -- --verbose

# Run in watch mode
npm test tests/integration/e2e-registration.test.ts -- --watch
```

### Test Configuration

Each test suite uses a different port to allow parallel execution:
- Registration tests: Port 3101
- Playlist assignment tests: Port 3102
- Status reporting tests: Port 3103

Each test:
- Starts with a fresh server instance
- Uses in-memory SQLite database (no state persists between tests)
- Cleans up all processes and files after completion

## Important Notes

### Mock vs Real Client

Tests are designed to work with both:

1. **Mock WebSocket Client** (default if Rust client not built):
   - Simulates basic client behavior
   - Manual control over messages sent
   - Faster and more deterministic
   - Good for testing server behavior

2. **Real Rust Client** (if built):
   - Tests full integration
   - Tests actual client implementation
   - Slower but more realistic
   - Requires libmpv installed

Tests detect which type is being used with `client.isMockClient()` and adjust assertions accordingly.

### Timeouts

E2E tests involve process spawning and network communication, so they have longer timeouts:
- Individual tests: 15-30 seconds
- `beforeAll` hooks: 40 seconds
- `afterAll` hooks: 10 seconds

### Debugging

Enable debug output:

```bash
# Show client output
DEBUG_CLIENT=1 npm test tests/integration/e2e-registration.test.ts

# Show all output
npm test tests/integration/e2e-registration.test.ts -- --verbose
```

### Common Issues

1. **Port conflicts**: If tests fail to start server, another process may be using the port. Change the port in the test file.

2. **Server build required**: Tests run the built server (`dist/index.js`), so always run `npm run build` first.

3. **Process cleanup**: If tests are interrupted, processes may not be cleaned up. Kill manually:
   ```bash
   pkill -f "node dist/index.js"
   pkill -f "montr-client"
   ```

4. **File permissions**: Tests create files in `/tmp` and `tests/fixtures`. Ensure write permissions.

## Test Coverage

E2E tests cover:

- ✅ WebSocket client registration and connection lifecycle
- ✅ Heartbeat mechanism and last_seen updates
- ✅ Client status tracking (online/offline)
- ✅ Playlist creation and assignment via REST API
- ✅ Playlist updates propagated to clients via WebSocket
- ✅ Media file uploads and management
- ✅ Client status updates and playback tracking
- ✅ Multiple concurrent clients with independent state
- ✅ Error handling and edge cases
- ✅ REST API error responses

## Integration with CI/CD

These tests are suitable for CI/CD pipelines:

```yaml
# Example GitHub Actions workflow
- name: Build server
  run: |
    cd server
    npm install
    npm run build

- name: Run E2E tests
  run: |
    cd server
    npm test tests/integration/e2e-
  timeout-minutes: 10
```

The tests will use mock clients in CI since the Rust client likely won't be built in the Node.js build stage.

## Future Enhancements

Potential improvements:

1. **Docker-based tests**: Run tests in Docker containers for better isolation
2. **Real client tests**: Separate test suite that requires built Rust client
3. **Performance tests**: Measure response times and throughput
4. **Stress tests**: Test with many concurrent clients
5. **Network failure simulation**: Test reconnection logic with network interruptions
6. **Database persistence tests**: Test with file-based SQLite database

## Contributing

When adding new E2E tests:

1. Follow the existing structure (helpers + test files)
2. Use descriptive test names
3. Clean up all resources in `afterEach`/`afterAll`
4. Add proper error messages for debugging
5. Document any new helpers or utilities
6. Ensure tests work with both mock and real clients
7. Keep tests independent (no shared state between tests)
8. Use appropriate timeouts (err on the side of longer for E2E)

## Summary

This E2E test suite provides comprehensive coverage of the Montr server's client-server interactions. With 25+ test cases across 3 test suites, it validates:

- Client lifecycle management
- WebSocket communication
- REST API functionality
- Playlist distribution
- Status tracking
- Multi-client scenarios

The tests are designed to be reliable, maintainable, and suitable for continuous integration.
