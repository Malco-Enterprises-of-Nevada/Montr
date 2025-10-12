# E2E Test Helpers - Quick Reference

This is a quick reference guide for the E2E test helper utilities.

## Table of Contents

1. [TestServerProcess](#testserverprocess)
2. [TestClientProcess](#testclientprocess)
3. [Wait Utilities](#wait-utilities)
4. [Fixture Utilities](#fixture-utilities)
5. [Common Patterns](#common-patterns)

---

## TestServerProcess

Manages the Node.js server process for testing.

### Import

```typescript
import { TestServerProcess } from './helpers';
```

### Constructor

```typescript
const server = new TestServerProcess({
  port?: number;              // Default: 3001
  host?: string;              // Default: 'localhost'
  dbPath?: string;            // Default: ':memory:'
  logLevel?: string;          // Default: 'error'
  startupTimeout?: number;    // Default: 30000 (30s)
});
```

### Methods

| Method | Description | Returns |
|--------|-------------|---------|
| `start()` | Start the server | `Promise<void>` |
| `waitUntilReady(maxAttempts?, intervalMs?)` | Wait for server health check | `Promise<void>` |
| `stop()` | Stop the server | `Promise<void>` |
| `getUrl()` | Get HTTP URL | `string` |
| `getWsUrl()` | Get WebSocket URL | `string` |
| `getPort()` | Get server port | `number` |
| `getHost()` | Get server host | `string` |
| `isRunning()` | Check if running | `boolean` |
| `getRecentOutput()` | Get recent output for debugging | `string[]` |

### Example

```typescript
const server = new TestServerProcess({ port: 3001 });
await server.start();
await server.waitUntilReady();

console.log(server.getUrl());     // http://localhost:3001
console.log(server.getWsUrl());   // ws://localhost:3001/ws

await server.stop();
```

---

## TestClientProcess

Manages the Rust client process for testing.

### Import

```typescript
import { TestClientProcess } from './helpers';
```

### Constructor

```typescript
const client = new TestClientProcess({
  clientId?: string;          // Default: auto-generated UUID
  clientName?: string;        // Default: 'Test Client {id}'
  binaryPath?: string;        // Default: auto-detected
  release?: boolean;          // Default: false (use debug build)
  logLevel?: string;          // Default: 'debug'
  cacheSizeMb?: number;       // Default: 100
});
```

### Methods

| Method | Description | Returns |
|--------|-------------|---------|
| `start(serverUrl)` | Start the client | `Promise<void>` |
| `stop()` | Stop the client | `Promise<void>` |
| `getClientId()` | Get client ID | `string` |
| `getClientName()` | Get client name | `string` |
| `isRunning()` | Check if running | `boolean` |
| `getRecentOutput()` | Get recent output for debugging | `string[]` |
| `getCacheDir()` | Get cache directory path | `string` |
| `getLogFile()` | Get log file path | `string` |

### Example

```typescript
const client = new TestClientProcess({
  clientName: 'My Test Client'
});

await client.start('http://localhost:3001');

console.log(client.getClientId());     // test-client-uuid
console.log(client.getLogFile());      // /tmp/montr-client-uuid.log

await client.stop();
```

---

## Wait Utilities

Functions for waiting on async conditions.

### Import

```typescript
import {
  waitForCondition,
  waitForServerReady,
  waitForClientRegistered,
  waitForClientOnline,
  waitForClientOffline,
  waitForPlaylistExists,
  waitForPlaylistAssigned,
  waitFor,
  retryWithBackoff,
} from './helpers';
```

### waitForCondition

Wait for a custom condition to become true.

```typescript
await waitForCondition(
  async () => {
    // Return true when condition is met
    return someAsyncCheck();
  },
  {
    timeout?: number;        // Default: 10000 (10s)
    interval?: number;       // Default: 500 (0.5s)
    errorMessage?: string;   // Custom error message
  }
);
```

### waitForServerReady

Wait for server to respond to health check.

```typescript
await waitForServerReady(
  serverUrl: string,
  options?: WaitOptions
);
```

### waitForClientRegistered

Wait for client to be registered on server.

```typescript
await waitForClientRegistered(
  serverUrl: string,
  clientId: string,
  options?: WaitOptions
);
```

### waitForClientOnline

Wait for client status to be 'online'.

```typescript
await waitForClientOnline(
  serverUrl: string,
  clientId: string,
  options?: WaitOptions
);
```

### waitForClientOffline

Wait for client status to be 'offline'.

```typescript
await waitForClientOffline(
  serverUrl: string,
  clientId: string,
  options?: WaitOptions
);
```

### waitForPlaylistExists

Wait for playlist to exist.

```typescript
await waitForPlaylistExists(
  serverUrl: string,
  playlistId: number,
  options?: WaitOptions
);
```

### waitForPlaylistAssigned

Wait for playlist to be assigned to client.

```typescript
await waitForPlaylistAssigned(
  serverUrl: string,
  clientId: string,
  playlistId: number,
  options?: WaitOptions
);
```

### waitFor

Simple delay utility.

```typescript
await waitFor(milliseconds: number);
```

### retryWithBackoff

Retry an operation with exponential backoff.

```typescript
const result = await retryWithBackoff(
  async () => {
    return someFlakyOperation();
  },
  {
    maxAttempts?: number;      // Default: 5
    initialDelay?: number;     // Default: 1000 (1s)
    maxDelay?: number;         // Default: 10000 (10s)
    backoffFactor?: number;    // Default: 2
  }
);
```

---

## Fixture Utilities

Functions for creating and managing test data.

### Import

```typescript
import {
  createTestVideoFile,
  createTestImageFile,
  uploadMedia,
  uploadMultipleMedia,
  createPlaylist,
  addMediaToPlaylist,
  assignPlaylist,
  getClient,
  getPlaylist,
  getAllClients,
  createTestPlaylistWithMedia,
  createCommonTestFixtures,
} from './helpers';
```

### createTestVideoFile

Create a test video file (requires ffmpeg or creates minimal file).

```typescript
createTestVideoFile(
  outputPath: string,
  durationSeconds?: number    // Default: 5
): void;
```

### createTestImageFile

Create a test image file (requires ffmpeg or creates minimal file).

```typescript
createTestImageFile(
  outputPath: string,
  width?: number,             // Default: 1920
  height?: number             // Default: 1080
): void;
```

### uploadMedia

Upload a single media file to server.

```typescript
const media = await uploadMedia(
  serverUrl: string,
  filePath: string
);
// Returns: { id: number, filename: string }
```

### uploadMultipleMedia

Upload multiple media files to server.

```typescript
const mediaFiles = await uploadMultipleMedia(
  serverUrl: string,
  filePaths: string[]
);
// Returns: Array<{ id: number, filename: string }>
```

### createPlaylist

Create a playlist on server.

```typescript
const playlist = await createPlaylist(
  serverUrl: string,
  name: string,
  description?: string
);
// Returns: { id: number, name: string }
```

### addMediaToPlaylist

Add media items to a playlist.

```typescript
await addMediaToPlaylist(
  serverUrl: string,
  playlistId: number,
  mediaIds: number[]
): Promise<void>;
```

### assignPlaylist

Assign a playlist to a client.

```typescript
await assignPlaylist(
  serverUrl: string,
  clientId: string,
  playlistId: number
): Promise<void>;
```

### getClient

Get client details from server.

```typescript
const client = await getClient(
  serverUrl: string,
  clientId: string
);
```

### getPlaylist

Get playlist details from server.

```typescript
const playlist = await getPlaylist(
  serverUrl: string,
  playlistId: number
);
```

### getAllClients

Get all clients from server.

```typescript
const clients = await getAllClients(serverUrl: string);
```

### createTestPlaylistWithMedia

Convenience function: upload media, create playlist, add media to playlist.

```typescript
const result = await createTestPlaylistWithMedia(
  serverUrl: string,
  playlistName: string,
  mediaFiles: string[]
);
// Returns: { playlistId: number, mediaIds: number[] }
```

### createCommonTestFixtures

Create common test fixtures (video and image).

```typescript
const fixtures = createCommonTestFixtures();
// Returns: {
//   videoPath: string,
//   imagePath: string,
//   fixturesDir: string
// }
```

---

## Common Patterns

### Basic Test Structure

```typescript
describe('E2E: My Feature', () => {
  let server: TestServerProcess;

  beforeAll(async () => {
    server = new TestServerProcess({ port: 3001 });
    await server.start();
    await server.waitUntilReady();
  }, 30000);

  afterAll(async () => {
    await server.stop();
  });

  it('should do something', async () => {
    const client = new TestClientProcess();

    try {
      await client.start(server.getUrl());
      // Test logic here
    } finally {
      await client.stop();
    }
  });
});
```

### Testing Client Registration

```typescript
it('should register client', async () => {
  const client = new TestClientProcess();

  try {
    await client.start(server.getUrl());

    await waitForClientOnline(
      server.getUrl(),
      client.getClientId()
    );

    const clientData = await getClient(
      server.getUrl(),
      client.getClientId()
    );

    expect(clientData.status).toBe('online');
  } finally {
    await client.stop();
  }
});
```

### Testing Playlist Assignment

```typescript
it('should assign playlist', async () => {
  const client = new TestClientProcess();

  try {
    await client.start(server.getUrl());
    await waitForClientOnline(server.getUrl(), client.getClientId());

    // Create test data
    const { videoPath } = createCommonTestFixtures();
    const { playlistId } = await createTestPlaylistWithMedia(
      server.getUrl(),
      'Test Playlist',
      [videoPath]
    );

    // Assign playlist
    await assignPlaylist(
      server.getUrl(),
      client.getClientId(),
      playlistId
    );

    // Verify
    await waitForPlaylistAssigned(
      server.getUrl(),
      client.getClientId(),
      playlistId
    );

    const clientData = await getClient(
      server.getUrl(),
      client.getClientId()
    );
    expect(clientData.assignedPlaylistId).toBe(playlistId);
  } finally {
    await client.stop();
  }
});
```

### Testing Reconnection

```typescript
it('should reconnect after disconnect', async () => {
  const client = new TestClientProcess();

  try {
    // Initial connection
    await client.start(server.getUrl());
    await waitForClientOnline(server.getUrl(), client.getClientId());

    // Disconnect
    await client.stop();
    await waitForClientOffline(server.getUrl(), client.getClientId());

    // Reconnect
    await client.start(server.getUrl());
    await waitForClientOnline(server.getUrl(), client.getClientId());

    const clientData = await getClient(
      server.getUrl(),
      client.getClientId()
    );
    expect(clientData.status).toBe('online');
  } finally {
    await client.stop();
  }
});
```

### Testing Multiple Clients

```typescript
it('should handle multiple clients', async () => {
  const clients = [
    new TestClientProcess({ clientName: 'Client 1' }),
    new TestClientProcess({ clientName: 'Client 2' }),
    new TestClientProcess({ clientName: 'Client 3' }),
  ];

  try {
    // Start all clients
    await Promise.all(
      clients.map(c => c.start(server.getUrl()))
    );

    // Wait for all to come online
    await Promise.all(
      clients.map(c =>
        waitForClientOnline(server.getUrl(), c.getClientId())
      )
    );

    // Verify all are registered
    const allClients = await getAllClients(server.getUrl());
    expect(allClients.length).toBeGreaterThanOrEqual(3);
  } finally {
    await Promise.all(clients.map(c => c.stop()));
  }
});
```

### Debugging Failed Tests

```typescript
it('should debug on failure', async () => {
  const client = new TestClientProcess();

  try {
    await client.start(server.getUrl());

    // Your test logic

  } catch (error) {
    // Log output on failure
    console.log('Server output:', server.getRecentOutput());
    console.log('Client output:', client.getRecentOutput());
    console.log('Client log:', client.getLogFile());
    throw error;
  } finally {
    await client.stop();
  }
});
```

---

## Type Definitions

All helpers are fully typed with TypeScript. Import types as needed:

```typescript
import type {
  ServerProcessOptions,
  ClientProcessOptions,
  WaitOptions,
} from './helpers';
```

---

## Error Handling

All async helper functions throw descriptive errors on failure:

```typescript
try {
  await waitForClientOnline(serverUrl, clientId, { timeout: 5000 });
} catch (error) {
  // Error message includes context:
  // "Client {id} did not come online (timeout: 5000ms)"
}
```

---

For more information, see:
- Full documentation: [README.md](./README.md)
- Example tests: [e2e-example.test.ts](./e2e-example.test.ts)
- Integration testing guide: [../../docs/integration-testing.md](../../docs/integration-testing.md)
