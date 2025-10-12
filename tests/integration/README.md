# Montr E2E Integration Tests

This directory contains end-to-end integration tests for the Montr system, testing the interaction between the Node.js server and Rust client components.

## Overview

The integration test suite spawns real server and client processes and validates their interaction through WebSocket connections and REST API calls.

### Test Architecture

```
┌─────────────────────────────────────────────────┐
│           Jest Test Framework (Node.js)         │
│  ┌────────────────────────────────────────────┐ │
│  │         Test Cases (*.test.ts)             │ │
│  └─────────────┬──────────────────────────────┘ │
│                │                                 │
│  ┌─────────────▼──────────────────────────────┐ │
│  │       Helper Utilities                     │ │
│  │  • server-process.ts                       │ │
│  │  • client-process.ts                       │ │
│  │  • wait-for.ts                             │ │
│  │  • fixtures.ts                             │ │
│  └─────┬────────────────────────────┬─────────┘ │
└────────┼────────────────────────────┼───────────┘
         │                            │
    ┌────▼──────┐              ┌─────▼──────┐
    │  Server   │◄───WebSocket─┤   Client   │
    │  Process  │     + HTTP    │  Process   │
    │(Node.js)  │              │   (Rust)   │
    └───────────┘              └────────────┘
```

## Prerequisites

### 1. Build the Server

```bash
cd server
npm install
npm run build
```

The test helper will spawn the server using `npm start` in test mode.

### 2. Build the Client

```bash
cd client
cargo build  # Or: cargo build --release
```

The test helper expects the binary at:
- Debug build: `client/target/debug/montr-client`
- Release build: `client/target/release/montr-client`

### 3. Install Test Dependencies

```bash
cd tests/integration
npm install
```

### 4. Optional: Install ffmpeg (for media fixtures)

```bash
# Ubuntu/Debian
sudo apt-get install ffmpeg

# macOS
brew install ffmpeg

# Arch Linux
sudo pacman -S ffmpeg
```

If ffmpeg is not available, the test suite will create minimal test files as fallback.

## Running Tests

### Run All E2E Tests

```bash
cd tests/integration
npm test
```

### Run Specific Test File

```bash
npm test e2e-registration.test.ts
```

### Run Tests in Watch Mode

```bash
npm run test:watch
```

### Run Tests with Verbose Output

```bash
npm run test:verbose
```

### Debug Tests

```bash
npm run test:debug
```

Then attach a debugger to the Node.js process.

## Writing Tests

### Basic Test Structure

```typescript
import { TestServerProcess } from './helpers/server-process';
import { TestClientProcess } from './helpers/client-process';
import { waitForClientOnline } from './helpers/wait-for';

describe('E2E: My Feature', () => {
  let server: TestServerProcess;
  let client: TestClientProcess;

  beforeAll(async () => {
    // Start server once for all tests in this suite
    server = new TestServerProcess({ port: 3001 });
    await server.start();
    await server.waitUntilReady();
  }, 30000);

  afterAll(async () => {
    // Cleanup server
    await server.stop();
  });

  beforeEach(async () => {
    // Create new client for each test
    client = new TestClientProcess();
  });

  afterEach(async () => {
    // Cleanup client after each test
    await client.stop();
  });

  it('should do something', async () => {
    // Start client
    await client.start(server.getUrl());

    // Wait for client to be online
    await waitForClientOnline(
      server.getUrl(),
      client.getClientId()
    );

    // Your test assertions here
    expect(client.isRunning()).toBe(true);
  }, 15000);
});
```

### Using Different Ports for Test Suites

To avoid port conflicts when running tests in parallel or when a port is already in use, specify different ports:

```typescript
// Test suite 1
const server1 = new TestServerProcess({ port: 3001 });

// Test suite 2
const server2 = new TestServerProcess({ port: 3002 });
```

### Creating Test Fixtures

```typescript
import {
  createTestVideoFile,
  createTestImageFile,
  uploadMedia,
  createPlaylist,
  addMediaToPlaylist
} from './helpers/fixtures';

// Create test media files
const videoPath = '/tmp/test-video.mp4';
createTestVideoFile(videoPath, 5); // 5 seconds

// Upload to server
const media = await uploadMedia(server.getUrl(), videoPath);

// Create playlist
const playlist = await createPlaylist(
  server.getUrl(),
  'Test Playlist'
);

// Add media to playlist
await addMediaToPlaylist(
  server.getUrl(),
  playlist.id,
  [media.id]
);
```

Or use the convenience function:

```typescript
import {
  createCommonTestFixtures,
  createTestPlaylistWithMedia
} from './helpers/fixtures';

// Create common fixtures once
const { videoPath, imagePath } = createCommonTestFixtures();

// Create a complete test playlist
const { playlistId, mediaIds } = await createTestPlaylistWithMedia(
  server.getUrl(),
  'Test Playlist',
  [videoPath, imagePath]
);
```

## Helper Utilities

### TestServerProcess

Manages the Node.js server process.

**Methods:**
- `start()` - Start the server
- `waitUntilReady()` - Wait for server to respond to health check
- `stop()` - Stop the server
- `getUrl()` - Get HTTP URL (e.g., `http://localhost:3001`)
- `getWsUrl()` - Get WebSocket URL (e.g., `ws://localhost:3001/ws`)
- `isRunning()` - Check if server is running
- `getRecentOutput()` - Get recent server output for debugging

**Options:**
```typescript
const server = new TestServerProcess({
  port: 3001,              // Server port
  host: 'localhost',       // Server host
  dbPath: ':memory:',      // Database (in-memory by default)
  logLevel: 'error',       // Log level
  startupTimeout: 30000    // Startup timeout in ms
});
```

### TestClientProcess

Manages the Rust client process.

**Methods:**
- `start(serverUrl)` - Start the client
- `stop()` - Stop the client
- `getClientId()` - Get the client ID
- `getClientName()` - Get the client name
- `isRunning()` - Check if client is running
- `getRecentOutput()` - Get recent client output for debugging
- `getCacheDir()` - Get client cache directory
- `getLogFile()` - Get client log file path

**Options:**
```typescript
const client = new TestClientProcess({
  clientId: 'test-client-001',   // Optional: custom client ID
  clientName: 'My Test Client',  // Optional: custom client name
  binaryPath: '/path/to/binary', // Optional: custom binary path
  release: true,                 // Use release build instead of debug
  logLevel: 'debug',             // Rust log level
  cacheSizeMb: 100              // Cache size in MB
});
```

### Wait Utilities

Polling utilities for async conditions:

```typescript
import {
  waitForCondition,
  waitForServerReady,
  waitForClientRegistered,
  waitForClientOnline,
  waitForClientOffline,
  waitForPlaylistAssigned,
  waitFor,
  retryWithBackoff
} from './helpers/wait-for';

// Wait for custom condition
await waitForCondition(
  async () => {
    const response = await axios.get(url);
    return response.data.ready === true;
  },
  { timeout: 10000, interval: 500 }
);

// Wait for server to be ready
await waitForServerReady(serverUrl);

// Wait for client to be online
await waitForClientOnline(serverUrl, clientId);

// Explicit delay
await waitFor(5000); // 5 seconds

// Retry with exponential backoff
const result = await retryWithBackoff(
  async () => someFlakyOperation(),
  { maxAttempts: 5, initialDelay: 1000 }
);
```

## Test Fixtures

### Media Files

Test fixtures are created in `tests/integration/fixtures/`:
- `test-video.mp4` - 5-second test video
- `test-image.png` - Test image

These are created automatically by `createCommonTestFixtures()`.

### Test Data Cleanup

Tests use:
- In-memory SQLite database (`:memory:`) - no cleanup needed
- Temporary config files in `/tmp/montr-test-configs/`
- Temporary cache directories in `/tmp/montr-test-cache-{clientId}/`
- Temporary storage in `/tmp/montr-test-storage-{port}/`

Config files are cleaned up automatically. Cache and storage directories persist for debugging but are safe to delete.

## Debugging

### View Server Output

```typescript
const server = new TestServerProcess();
await server.start();

// Later, if test fails:
console.log('Server output:', server.getRecentOutput().join('\n'));
```

### View Client Output

```typescript
const client = new TestClientProcess();
await client.start(serverUrl);

// Later, if test fails:
console.log('Client output:', client.getRecentOutput().join('\n'));
```

### Check Client Logs

```typescript
const client = new TestClientProcess();
await client.start(serverUrl);

console.log('Client log file:', client.getLogFile());
// Then: cat /tmp/montr-client-{id}.log
```

### Run Single Test

```bash
npm test -- -t "should register client successfully"
```

### Increase Timeout

If tests are timing out, increase Jest timeout:

```typescript
it('should do something slow', async () => {
  // Test code
}, 60000); // 60 seconds
```

Or globally in `jest.config.js`:

```javascript
testTimeout: 120000, // 2 minutes
```

## Common Issues

### Port Already in Use

If you get `EADDRINUSE` errors:

```bash
# Find process using port
lsof -i :3001

# Kill the process
kill -9 <PID>
```

Or use a different port in your test:

```typescript
const server = new TestServerProcess({ port: 3002 });
```

### Client Binary Not Found

Error: `Client binary not found at client/target/debug/montr-client`

**Solution:** Build the client first:

```bash
cd client
cargo build
```

### Server Takes Too Long to Start

Increase the startup timeout:

```typescript
const server = new TestServerProcess({
  startupTimeout: 60000 // 60 seconds
});
```

### Tests Hang

If tests hang without completing:

1. Check if processes are still running:
   ```bash
   ps aux | grep "montr-client\|node.*server"
   ```

2. Kill stale processes:
   ```bash
   pkill -f montr-client
   pkill -f "node.*server"
   ```

3. Ensure `afterAll()` and `afterEach()` cleanup is working

### WebSocket Connection Fails

Check:
1. Server is running: `curl http://localhost:3001/api/health`
2. WebSocket endpoint is accessible
3. Firewall is not blocking connections
4. Client has correct server URL

## CI/CD Integration

### GitHub Actions Example

```yaml
name: E2E Integration Tests

on: [push, pull_request]

jobs:
  integration:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Setup Rust
        uses: actions-rust-lang/setup-rust-toolchain@v1

      - name: Install libmpv
        run: sudo apt-get install -y libmpv-dev

      - name: Install ffmpeg
        run: sudo apt-get install -y ffmpeg

      - name: Build server
        run: |
          cd server
          npm install
          npm run build

      - name: Build client
        run: |
          cd client
          cargo build

      - name: Install test dependencies
        run: |
          cd tests/integration
          npm install

      - name: Run E2E tests
        run: |
          cd tests/integration
          npm test
```

## Test Organization

### Recommended Test Structure

```
tests/integration/
├── e2e-registration.test.ts      # Client registration tests
├── e2e-connection.test.ts        # Connection/reconnection tests
├── e2e-playlist.test.ts          # Playlist assignment tests
├── e2e-playback.test.ts          # Playback functionality tests
├── e2e-status-updates.test.ts    # Status reporting tests
└── e2e-error-handling.test.ts    # Error scenarios
```

### Test Naming Convention

- File names: `e2e-{feature}.test.ts`
- Test suites: `describe('E2E: {Feature Name}', ...)`
- Test cases: `it('should {expected behavior}', ...)`

## Performance Considerations

- **Sequential Execution**: Tests run serially (`maxWorkers: 1`) to avoid port conflicts
- **Process Startup**: Each test suite starts a server (slow) but reuses it for multiple tests
- **In-Memory Database**: Using `:memory:` SQLite is fast and doesn't require cleanup
- **Expected Runtime**: ~5-15 minutes for a full test suite

## Best Practices

1. **Use Unique Ports**: Each test file should use a unique port to enable parallel execution
2. **Cleanup Resources**: Always stop processes in `afterAll()` and `afterEach()`
3. **Use Wait Utilities**: Don't use fixed delays, use `waitForCondition()` instead
4. **Test Critical Flows**: Focus on integration points, not unit test scenarios
5. **Keep Tests Independent**: Each test should work in isolation
6. **Descriptive Names**: Use clear, descriptive test names
7. **Add Timeouts**: Set appropriate timeouts for slow operations
8. **Log on Failure**: Output server/client logs when tests fail

## Next Steps

1. Review the helper utilities in `helpers/` directory
2. Run the example tests to verify setup
3. Write your own E2E tests for critical flows
4. Set up CI/CD integration

## Support

For issues or questions:
- Check the main project documentation: `/docs/integration-testing.md`
- Review the protocol tests: `/tests/protocol/`
- Check server tests: `/server/tests/`
