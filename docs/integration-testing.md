# Integration Testing Guide: Client-Server Testing

This guide explains how to test the interaction between the Rust client and Node.js server in the Montr system.

## Table of Contents

1. [Testing Approaches](#testing-approaches)
2. [Protocol Validation Tests](#protocol-validation-tests)
3. [End-to-End Integration Tests](#end-to-end-integration-tests)
4. [Mock-Based Testing](#mock-based-testing)
5. [Docker Compose E2E Testing](#docker-compose-e2e-testing)
6. [Setup Instructions](#setup-instructions)

---

## Testing Approaches

### Overview of Test Types

| Test Type | Scope | Language | Speed | Cost | When to Use |
|-----------|-------|----------|-------|------|-------------|
| **Protocol Validation** | Message serialization | Both | Fast | Low | Always - ensures compatibility |
| **Server-side Mock Client** | Server behavior | TypeScript | Fast | Low | Unit/integration tests |
| **Client-side Mock Server** | Client behavior | Rust | Fast | Low | Unit/integration tests |
| **E2E with Real Processes** | Full system | Both | Slow | High | CI/CD, major releases |
| **Docker Compose E2E** | Full system + deps | Both | Slow | High | Pre-deployment validation |

---

## 1. Protocol Validation Tests

**Goal**: Ensure both client and server can serialize/deserialize the same messages correctly.

### Approach

Create a shared test suite that validates JSON message compatibility:

```
tests/
├── protocol/
│   ├── fixtures/
│   │   ├── register.json
│   │   ├── status_update.json
│   │   ├── playlist_assigned.json
│   │   └── ...
│   ├── server-protocol.test.ts  (TypeScript tests)
│   └── client-protocol.rs       (Rust tests)
```

### Implementation

**Step 1**: Create JSON fixtures for all message types

**File**: `tests/protocol/fixtures/register.json`
```json
{
  "type": "register",
  "clientId": "550e8400-e29b-41d4-a716-446655440000",
  "version": "1.0.0",
  "platform": "linux",
  "capabilities": {
    "video": true,
    "image": true
  }
}
```

**Step 2**: Server-side validation test

**File**: `tests/protocol/server-protocol.test.ts`
```typescript
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  registerMessageSchema,
  statusUpdateMessageSchema,
  playlistAssignedMessageSchema,
} from '../../server/src/websocket/types';

describe('Protocol Validation - Server', () => {
  const fixturesDir = join(__dirname, 'fixtures');

  it('should parse register message correctly', () => {
    const json = readFileSync(join(fixturesDir, 'register.json'), 'utf-8');
    const data = JSON.parse(json);

    const result = registerMessageSchema.safeParse(data);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.clientId).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(result.data.version).toBe('1.0.0');
      expect(result.data.capabilities.video).toBe(true);
    }
  });

  // Test all message types...
});
```

**Step 3**: Client-side validation test

**File**: `client/tests/protocol_validation.rs`
```rust
#[cfg(test)]
mod protocol_validation_tests {
    use montr_client::network::protocol::*;
    use std::fs;

    #[test]
    fn test_register_message_compatibility() {
        let json = fs::read_to_string("../tests/protocol/fixtures/register.json")
            .expect("Failed to read fixture");

        let parsed: ClientMessage = serde_json::from_str(&json)
            .expect("Failed to parse register message");

        match parsed {
            ClientMessage::Register(msg) => {
                assert_eq!(msg.client_id, "550e8400-e29b-41d4-a716-446655440000");
                assert_eq!(msg.version, "1.0.0");
                assert!(msg.capabilities.video);
                assert!(msg.capabilities.image);
            }
            _ => panic!("Expected Register message"),
        }
    }

    #[test]
    fn test_playlist_assigned_message_compatibility() {
        let json = fs::read_to_string("../tests/protocol/fixtures/playlist_assigned.json")
            .expect("Failed to read fixture");

        let parsed: ServerMessage = serde_json::from_str(&json)
            .expect("Failed to parse playlist assigned message");

        match parsed {
            ServerMessage::PlaylistAssigned(msg) => {
                assert_eq!(msg.playlist_id, 1);
                assert!(!msg.items.is_empty());
            }
            _ => panic!("Expected PlaylistAssigned message"),
        }
    }
}
```

### Benefits

- ✅ Fast execution (milliseconds)
- ✅ No process spawning required
- ✅ Catches serialization incompatibilities early
- ✅ Easy to maintain
- ✅ Runs in CI/CD without special setup

### Limitations

- ❌ Doesn't test actual network communication
- ❌ Doesn't validate business logic

---

## 2. End-to-End Integration Tests

**Goal**: Test real client and server processes communicating over WebSocket and HTTP.

### Approach

Create a separate test suite that spawns both processes and validates interactions:

```
tests/
├── integration/
│   ├── helpers/
│   │   ├── server-process.ts
│   │   ├── client-process.ts
│   │   └── wait-for.ts
│   ├── e2e-registration.test.ts
│   ├── e2e-playlist-assignment.test.ts
│   └── e2e-playback.test.ts
```

### Implementation

**Step 1**: Server process helper

**File**: `tests/integration/helpers/server-process.ts`
```typescript
import { spawn, ChildProcess } from 'child_process';
import axios from 'axios';

export class TestServerProcess {
  private process: ChildProcess | null = null;
  private readonly port: number;
  private readonly host: string;

  constructor(port = 3001, host = 'localhost') {
    this.port = port;
    this.host = host;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Start server in test mode
      this.process = spawn('npm', ['start'], {
        cwd: './server',
        env: {
          ...process.env,
          PORT: this.port.toString(),
          HOST: this.host,
          NODE_ENV: 'test',
          DB_PATH: ':memory:', // Use in-memory SQLite for tests
          LOG_LEVEL: 'error',
        },
      });

      this.process.stdout?.on('data', (data) => {
        const output = data.toString();
        if (output.includes('Server listening')) {
          resolve();
        }
      });

      this.process.stderr?.on('data', (data) => {
        console.error('Server error:', data.toString());
      });

      this.process.on('error', reject);

      // Timeout after 10 seconds
      setTimeout(() => reject(new Error('Server start timeout')), 10000);
    });
  }

  async waitUntilReady(): Promise<void> {
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await axios.get(`http://${this.host}:${this.port}/api/health`, {
          timeout: 1000,
        });
        return;
      } catch (err) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error('Server did not become ready in time');
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (!this.process.killed) {
        this.process.kill('SIGKILL');
      }
      this.process = null;
    }
  }

  getUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  getWsUrl(): string {
    return `ws://${this.host}:${this.port}/ws`;
  }
}
```

**Step 2**: Client process helper

**File**: `tests/integration/helpers/client-process.ts`
```typescript
import { spawn, ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

export class TestClientProcess {
  private process: ChildProcess | null = null;
  private configPath: string | null = null;
  private readonly clientId: string;

  constructor(clientId = 'test-client-001') {
    this.clientId = clientId;
  }

  async start(serverUrl: string): Promise<void> {
    // Create temporary config
    this.configPath = join('/tmp', `montr-client-${this.clientId}.toml`);
    const config = `
[server]
url = "${serverUrl}"
reconnect_interval = 1
heartbeat_interval = 5

[client]
id = "${this.clientId}"
name = "Test Client ${this.clientId}"

[playback]
default_image_duration = 5
loop_playlist = true
media_cache_dir = "/tmp/montr-test-cache-${this.clientId}"
max_cache_size_mb = 100

[system]
log_level = "debug"
log_file = "/tmp/montr-client-${this.clientId}.log"
`;
    writeFileSync(this.configPath, config);

    // Start client
    this.process = spawn('./target/debug/montr-client', [
      '--config',
      this.configPath,
    ], {
      cwd: './client',
      env: {
        ...process.env,
        RUST_LOG: 'debug',
      },
    });

    this.process.stdout?.on('data', (data) => {
      console.log(`[Client ${this.clientId}]:`, data.toString());
    });

    this.process.stderr?.on('data', (data) => {
      console.error(`[Client ${this.clientId} Error]:`, data.toString());
    });

    // Wait for client to be ready
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!this.process.killed) {
        this.process.kill('SIGKILL');
      }
      this.process = null;
    }

    // Cleanup config
    if (this.configPath) {
      try {
        unlinkSync(this.configPath);
      } catch (err) {
        // Ignore
      }
      this.configPath = null;
    }
  }

  getClientId(): string {
    return this.clientId;
  }
}
```

**Step 3**: E2E test example

**File**: `tests/integration/e2e-registration.test.ts`
```typescript
import { TestServerProcess } from './helpers/server-process';
import { TestClientProcess } from './helpers/client-process';
import axios from 'axios';

describe('E2E: Client Registration', () => {
  let server: TestServerProcess;
  let client: TestClientProcess;

  beforeAll(async () => {
    // Start server
    server = new TestServerProcess(3001);
    await server.start();
    await server.waitUntilReady();
  }, 30000);

  afterAll(async () => {
    await server.stop();
  });

  beforeEach(async () => {
    client = new TestClientProcess('test-client-001');
  });

  afterEach(async () => {
    await client.stop();
  });

  it('should register client successfully', async () => {
    // Start client
    await client.start(server.getUrl());

    // Wait for registration
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Verify client is registered in server
    const response = await axios.get(
      `${server.getUrl()}/api/clients/${client.getClientId()}`
    );

    expect(response.status).toBe(200);
    expect(response.data.success).toBe(true);
    expect(response.data.data.id).toBe(client.getClientId());
    expect(response.data.data.status).toBe('online');
  }, 15000);

  it('should handle client disconnect and reconnect', async () => {
    // Start client
    await client.start(server.getUrl());
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Stop client
    await client.stop();
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Verify client is offline
    let response = await axios.get(
      `${server.getUrl()}/api/clients/${client.getClientId()}`
    );
    expect(response.data.data.status).toBe('offline');

    // Restart client
    await client.start(server.getUrl());
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Verify client is online again
    response = await axios.get(
      `${server.getUrl()}/api/clients/${client.getClientId()}`
    );
    expect(response.data.data.status).toBe('online');
  }, 30000);
});
```

**Step 4**: Playlist assignment E2E test

**File**: `tests/integration/e2e-playlist-assignment.test.ts`
```typescript
import { TestServerProcess } from './helpers/server-process';
import { TestClientProcess } from './helpers/client-process';
import axios from 'axios';
import FormData from 'form-data';
import { createReadStream } from 'fs';

describe('E2E: Playlist Assignment', () => {
  let server: TestServerProcess;
  let client: TestClientProcess;

  beforeAll(async () => {
    server = new TestServerProcess(3002);
    await server.start();
    await server.waitUntilReady();
  }, 30000);

  afterAll(async () => {
    await server.stop();
  });

  it('should assign playlist to client and receive it via WebSocket', async () => {
    // Upload test media
    const form = new FormData();
    form.append('files', createReadStream('./tests/fixtures/test-video.mp4'));

    const uploadResponse = await axios.post(
      `${server.getUrl()}/api/media/upload`,
      form,
      { headers: form.getHeaders() }
    );

    const mediaId = uploadResponse.data.data[0].id;

    // Create playlist
    const playlistResponse = await axios.post(
      `${server.getUrl()}/api/playlists`,
      {
        name: 'Test Playlist',
        description: 'E2E test playlist',
      }
    );

    const playlistId = playlistResponse.data.data.id;

    // Add media to playlist
    await axios.post(
      `${server.getUrl()}/api/playlists/${playlistId}/items`,
      {
        mediaIds: [mediaId],
      }
    );

    // Start client
    client = new TestClientProcess('test-client-002');
    await client.start(server.getUrl());
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Assign playlist to client
    await axios.put(
      `${server.getUrl()}/api/clients/${client.getClientId()}`,
      {
        assignedPlaylistId: playlistId,
      }
    );

    // Wait for client to receive playlist
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Verify client received and started downloading
    // (Check client logs or cache directory)
    // This is a basic test - you could add more validation

    await client.stop();
  }, 60000);
});
```

### Benefits

- ✅ Tests real communication
- ✅ Validates full integration flow
- ✅ Catches network issues
- ✅ Tests reconnection logic
- ✅ Validates business logic end-to-end

### Limitations

- ❌ Slower execution (seconds to minutes)
- ❌ Requires both codebases built
- ❌ More complex setup
- ❌ Flaky if not carefully written
- ❌ Requires test fixtures (media files)

---

## 3. Mock-Based Testing

### 3A. Server-Side Mock Client Tests

**Goal**: Test server WebSocket handlers with mock client messages.

This is **already implemented** in the server test suite:

**File**: `server/tests/unit/websocket/handlers.test.ts`

Example:
```typescript
it('should handle client registration', async () => {
  const mockWs = createMockWebSocket();
  const message: RegisterMessage = {
    type: 'register',
    clientId: 'test-123',
    version: '1.0.0',
    capabilities: { video: true, image: true },
  };

  await handleRegister(mockWs, message);

  expect(clientService.registerClient).toHaveBeenCalled();
  expect(mockWs.send).toHaveBeenCalled();
});
```

### 3B. Client-Side Mock Server Tests

**Goal**: Test Rust client with mock HTTP/WebSocket responses.

**File**: `client/tests/integration/mock_server_tests.rs`
```rust
#[cfg(test)]
mod mock_server_tests {
    use mockito::{mock, Server};
    use montr_client::network::http::HttpClient;
    use montr_client::network::protocol::*;

    #[tokio::test]
    async fn test_download_media_from_mock_server() {
        let mut server = Server::new_async().await;

        // Mock download endpoint
        let mock_download = server.mock("GET", "/api/media/1/download")
            .with_status(200)
            .with_header("content-type", "video/mp4")
            .with_header("content-length", "1024")
            .with_body(vec![0u8; 1024])
            .create_async()
            .await;

        let client = HttpClient::new(server.url(), None);
        let result = client.download_media(1, "test.mp4", "/tmp", None).await;

        assert!(result.is_ok());
        mock_download.assert_async().await;
    }

    #[tokio::test]
    async fn test_websocket_message_handling() {
        // Use tokio-tungstenite mock server
        // This is more complex - see below for full example
    }
}
```

### Benefits (Mock Tests)

- ✅ Very fast
- ✅ Isolated testing
- ✅ Deterministic
- ✅ Easy to test error conditions
- ✅ No external dependencies

### Limitations (Mock Tests)

- ❌ Doesn't test real integration
- ❌ Mocks can drift from real behavior
- ❌ Requires mock maintenance

---

## 4. Docker Compose E2E Testing

**Goal**: Test the full system with Docker Compose, including dependencies.

### Implementation

**File**: `docker-compose.test.yml`
```yaml
version: '3.8'

services:
  server:
    build:
      context: ./server
      dockerfile: Dockerfile
    environment:
      - PORT=3000
      - DB_TYPE=sqlite
      - DB_PATH=/data/test.db
      - LOG_LEVEL=debug
    ports:
      - "3000:3000"
    volumes:
      - ./server-data:/data
      - ./server-storage:/app/storage
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]
      interval: 5s
      timeout: 3s
      retries: 10

  client:
    build:
      context: ./client
      dockerfile: Dockerfile
    environment:
      - RUST_LOG=debug
    depends_on:
      server:
        condition: service_healthy
    volumes:
      - ./client-cache:/cache
    command: >
      /app/montr-client
      --server-url http://server:3000
      --client-name "Docker Test Client"

  test-runner:
    image: node:20
    working_dir: /tests
    volumes:
      - ./tests:/tests
      - ./server:/server
    depends_on:
      server:
        condition: service_healthy
    environment:
      - SERVER_URL=http://server:3000
    command: npm test
```

**Run tests**:
```bash
# Start services and run tests
docker-compose -f docker-compose.test.yml up --abort-on-container-exit

# Cleanup
docker-compose -f docker-compose.test.yml down -v
```

### Benefits

- ✅ Tests production-like environment
- ✅ Includes all dependencies
- ✅ Reproducible across machines
- ✅ Great for CI/CD

### Limitations

- ❌ Slowest approach
- ❌ Requires Docker
- ❌ Complex debugging

---

## 5. Setup Instructions

### Prerequisites

1. **Build both projects**:
```bash
# Server
cd server
npm install
npm run build

# Client
cd client
cargo build --release
```

2. **Install test dependencies**:
```bash
# For integration tests
npm install --save-dev \
  axios \
  form-data \
  @types/node \
  ts-node

# For Rust mock tests
cd client
cargo add --dev mockito tokio-test
```

### Running Tests

**Protocol validation tests**:
```bash
# Create fixtures first
mkdir -p tests/protocol/fixtures

# Run server-side tests
cd server
npm test tests/protocol/

# Run client-side tests
cd client
cargo test protocol_validation
```

**E2E integration tests**:
```bash
# Build both first
npm run build:all  # Or build each separately

# Run E2E tests
cd tests/integration
npm test
```

**CI/CD Integration**:
```yaml
# .github/workflows/integration-tests.yml
name: Integration Tests

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

      - name: Build server
        run: |
          cd server
          npm install
          npm run build

      - name: Build client
        run: |
          cd client
          cargo build --release

      - name: Run protocol tests
        run: npm test tests/protocol/

      - name: Run E2E tests
        run: npm test tests/integration/
```

---

## Recommended Testing Strategy

For the Montr project, use this layered approach:

### Level 1: Protocol Validation (Always Run)
- Fast, catches breaking changes early
- Run on every commit
- **Time**: < 1 minute

### Level 2: Server-Side Mock Client Tests (Run Frequently)
- Already implemented in `server/tests/unit/websocket/`
- Run on every commit
- **Time**: < 2 minutes

### Level 3: Client-Side Unit Tests (Run Frequently)
- Test individual modules with mocks
- Run on every commit
- **Time**: < 3 minutes

### Level 4: E2E Integration Tests (Run Selectively)
- Test critical flows (registration, playlist assignment)
- Run on PR, before merge, nightly
- **Time**: 5-15 minutes

### Level 5: Docker Compose E2E (Run Rarely)
- Full system validation
- Run before releases, weekly
- **Time**: 10-30 minutes

---

## Next Steps

1. **Immediate**: Implement protocol validation tests (low effort, high value)
2. **Short-term**: Add 2-3 E2E integration tests for critical flows
3. **Long-term**: Set up Docker Compose testing for pre-release validation

## Conclusion

Integration testing across Rust client and Node.js server is achievable with multiple complementary approaches. Start with protocol validation for quick feedback, then add E2E tests for critical user flows.
