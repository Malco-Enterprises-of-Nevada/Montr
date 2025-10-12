import { spawn, ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import WebSocket = require('ws');

export interface ClientProcessOptions {
  clientId?: string;
  clientName?: string;
  heartbeatInterval?: number;
  reconnectInterval?: number;
  cacheDir?: string;
}

/**
 * Helper class to manage a test client process.
 * Can work with either a real Rust client or a mock WebSocket client.
 */
export class TestClientProcess {
  private process: ChildProcess | null = null;
  private configPath: string | null = null;
  private readonly clientId: string;
  private readonly clientName: string;
  private readonly heartbeatInterval: number;
  private readonly reconnectInterval: number;
  private readonly cacheDir: string;
  private mockClient: WebSocket | null = null;
  private useMockClient = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: ClientProcessOptions = {}) {
    this.clientId = options.clientId || randomUUID();
    this.clientName = options.clientName || `Test Client ${this.clientId}`;
    this.heartbeatInterval = options.heartbeatInterval || 5;
    this.reconnectInterval = options.reconnectInterval || 1;
    this.cacheDir = options.cacheDir || join('/tmp', `montr-test-cache-${this.clientId}`);
  }

  /**
   * Start the client process.
   * If Rust client is not available, falls back to mock WebSocket client.
   *
   * @param serverUrl - Base URL of the server (e.g., http://localhost:3001)
   */
  async start(serverUrl: string): Promise<void> {
    const fs = require('fs');

    // Check for Rust client binary in release first, then debug
    const releaseBinary = join(__dirname, '../../../client/target/release/montr-client');
    const debugBinary = join(__dirname, '../../../client/target/debug/montr-client');

    let clientBinary: string | null = null;
    if (fs.existsSync(releaseBinary)) {
      clientBinary = releaseBinary;
    } else if (fs.existsSync(debugBinary)) {
      clientBinary = debugBinary;
    }

    // Check if Rust client binary exists
    if (clientBinary) {
      await this.startRustClient(serverUrl, clientBinary);
    } else {
      // Fall back to mock client for testing
      console.log('[TestClient] Rust client not found, using mock WebSocket client');
      await this.startMockClient(serverUrl);
    }
  }

  /**
   * Start the actual Rust client process.
   */
  private async startRustClient(serverUrl: string, clientBinary: string): Promise<void> {
    // Create cache directory
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }

    // Create temporary config file
    this.configPath = join('/tmp', `montr-client-${this.clientId}.toml`);
    const config = `
[server]
url = "${serverUrl}"
reconnect_interval = ${this.reconnectInterval}
heartbeat_interval = ${this.heartbeatInterval}

[client]
id = "${this.clientId}"
name = "${this.clientName}"

[playback]
default_image_duration = 5
loop_playlist = true
media_cache_dir = "${this.cacheDir}"
max_cache_size_mb = 100

[system]
log_level = "debug"
log_file = "/tmp/montr-client-${this.clientId}.log"
`;
    writeFileSync(this.configPath, config);

    // Start client process
    this.process = spawn(clientBinary, ['--config', this.configPath], {
      env: {
        ...process.env,
        RUST_LOG: 'debug',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (data) => {
      const output = data.toString();
      if (process.env.DEBUG_CLIENT) {
        console.log(`[Client ${this.clientId}]:`, output);
      }
    });

    this.process.stderr?.on('data', (data) => {
      const error = data.toString();
      if (process.env.DEBUG_CLIENT) {
        console.error(`[Client ${this.clientId} Error]:`, error);
      }
    });

    // Wait for client to initialize
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  /**
   * Start a mock WebSocket client for testing when Rust client is unavailable.
   * Simulates basic client behavior (registration, heartbeat).
   */
  private async startMockClient(serverUrl: string): Promise<void> {
    this.useMockClient = true;
    const wsUrl = serverUrl.replace('http://', 'ws://') + '/ws';

    return new Promise((resolve, reject) => {
      this.mockClient = new WebSocket(wsUrl);
      let registrationResolved = false;

      this.mockClient.on('open', () => {
        // Send registration message
        const registerMsg = {
          type: 'register',
          clientId: this.clientId,
          version: '1.0.0',
          capabilities: {
            video: true,
            image: true,
          },
        };

        this.mockClient?.send(JSON.stringify(registerMsg));

        // Start heartbeat - store timer reference for cleanup
        this.heartbeatTimer = setInterval(() => {
          if (this.mockClient?.readyState === WebSocket.OPEN) {
            this.mockClient.send(
              JSON.stringify({
                type: 'heartbeat',
                clientId: this.clientId,
                timestamp: Date.now(), // Unix timestamp in milliseconds
              })
            );
          } else {
            this.stopHeartbeat();
          }
        }, this.heartbeatInterval * 1000);
      });

      this.mockClient.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (process.env.DEBUG_CLIENT) {
          console.log(`[Mock Client ${this.clientId}] Received:`, message);
        }

        // Resolve promise when registration is successful
        if (message.type === 'success' && !registrationResolved) {
          registrationResolved = true;
          resolve();
        }

        // Handle playlist assignment
        if (message.type === 'playlist_assigned') {
          this.sendStatusUpdate(message.playlist?.items?.[0]?.mediaId || null);
        }
      });

      this.mockClient.on('error', (error) => {
        console.error(`[Mock Client ${this.clientId}] Error:`, error.message);
        if (!registrationResolved) {
          registrationResolved = true;
          reject(error);
        }
      });

      this.mockClient.on('close', () => {
        if (!registrationResolved) {
          registrationResolved = true;
          reject(new Error('Connection closed before registration completed'));
        }
      });

      // Timeout if registration doesn't complete
      setTimeout(() => {
        if (!registrationResolved) {
          registrationResolved = true;
          reject(new Error('Mock client registration timeout'));
        }
      }, 5000);
    });
  }

  /**
   * Send a status update message (mock client only).
   */
  sendStatusUpdate(currentMediaId: number | null, position = 0, isPlaying = true): void {
    if (!this.useMockClient || !this.mockClient) {
      return;
    }

    const statusMsg = {
      type: 'status_update',
      clientId: this.clientId,
      currentMedia: currentMediaId ? { id: currentMediaId, filename: 'test.mp4' } : null,
      position,
      isPlaying,
      timestamp: Date.now(), // Unix timestamp in milliseconds
    };

    if (this.mockClient.readyState === WebSocket.OPEN) {
      this.mockClient.send(JSON.stringify(statusMsg));
    }
  }

  /**
   * Send an error message (mock client only).
   */
  sendError(errorMessage: string, context?: Record<string, unknown>): void {
    if (!this.useMockClient || !this.mockClient) {
      return;
    }

    const errorMsg = {
      type: 'error',
      clientId: this.clientId,
      error: errorMessage,
      context: context || { timestamp: Date.now() },
    };

    if (this.mockClient.readyState === WebSocket.OPEN) {
      this.mockClient.send(JSON.stringify(errorMsg));
    }
  }

  /**
   * Stop heartbeat timer
   */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Stop the client process.
   */
  async stop(): Promise<void> {
    // Stop heartbeat timer first
    this.stopHeartbeat();

    // Stop mock client
    if (this.mockClient) {
      this.mockClient.close();
      this.mockClient = null;
    }

    // Stop real client process
    if (this.process) {
      return new Promise((resolve) => {
        if (!this.process) {
          resolve();
          return;
        }

        this.process.on('exit', () => {
          this.process = null;
          resolve();
        });

        this.process.kill('SIGTERM');

        // Force kill after 2 seconds
        setTimeout(() => {
          if (this.process && !this.process.killed) {
            this.process.kill('SIGKILL');
            setTimeout(resolve, 500);
          }
        }, 2000);
      });
    }

    // Cleanup config file
    if (this.configPath) {
      try {
        unlinkSync(this.configPath);
      } catch (err) {
        // Ignore cleanup errors
      }
      this.configPath = null;
    }
  }

  /**
   * Get the client ID.
   */
  getClientId(): string {
    return this.clientId;
  }

  /**
   * Get the client name.
   */
  getClientName(): string {
    return this.clientName;
  }

  /**
   * Check if this is using a mock client.
   */
  isMockClient(): boolean {
    return this.useMockClient;
  }

  /**
   * Check if client is connected (mock client only).
   */
  isConnected(): boolean {
    if (this.useMockClient) {
      return this.mockClient?.readyState === WebSocket.OPEN;
    }
    return this.process !== null && !this.process.killed;
  }
}
