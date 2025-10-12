import { spawn, ChildProcess } from 'child_process';
import axios from 'axios';
import { join } from 'path';

export interface ServerProcessOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  logLevel?: string;
  storagePath?: string;
}

/**
 * Helper class to manage a test server process.
 * Handles starting, stopping, and waiting for server readiness.
 */
export class TestServerProcess {
  private process: ChildProcess | null = null;
  private readonly port: number;
  private readonly host: string;
  private readonly dbPath: string;
  private readonly logLevel: string;
  private readonly storagePath: string;
  private startupTimeout = 30000; // 30 seconds

  constructor(options: ServerProcessOptions = {}) {
    this.port = options.port || 3001;
    this.host = options.host || 'localhost';
    this.dbPath = options.dbPath || ':memory:';
    this.logLevel = options.logLevel || 'info';
    this.storagePath = options.storagePath || join(__dirname, '../../../test-storage');
  }

  /**
   * Start the server process.
   * Waits for server to emit ready message.
   */
  async start(): Promise<void> {
    if (this.process) {
      throw new Error('Server process already started');
    }

    return new Promise((resolve, reject) => {
      const serverDir = join(__dirname, '../../../');

      // Start server with node (assumes built dist/ directory)
      this.process = spawn('node', ['dist/index.js'], {
        cwd: serverDir,
        env: {
          ...process.env,
          PORT: this.port.toString(),
          HOST: this.host,
          NODE_ENV: 'test',
          DB_TYPE: 'sqlite',
          DB_PATH: this.dbPath,
          LOG_LEVEL: this.logLevel,
          STORAGE_PATH: this.storagePath,
          MAX_UPLOAD_SIZE_MB: '100',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let serverStarted = false;

      this.process.stdout?.on('data', (data) => {
        const output = data.toString();
        console.log('[Server stdout]:', output);
        // Look for server ready message
        if (!serverStarted && (output.includes('Server listening') || output.includes('started successfully'))) {
          serverStarted = true;
          resolve();
        }
      });

      this.process.stderr?.on('data', (data) => {
        const error = data.toString();
        console.log('[Server stderr]:', error);
        // Look for server ready message (winston logs to stderr by default)
        if (!serverStarted && (error.includes('Server listening') || error.includes('started successfully'))) {
          serverStarted = true;
          resolve();
        }
      });

      this.process.on('error', (err) => {
        reject(new Error(`Failed to start server process: ${err.message}`));
      });

      this.process.on('exit', (code, signal) => {
        if (!serverStarted && code !== 0) {
          reject(new Error(`Server exited early with code ${code}, signal ${signal}`));
        }
      });

      // Timeout if server doesn't start
      setTimeout(() => {
        if (!serverStarted) {
          this.stop();
          reject(new Error(`Server start timeout after ${this.startupTimeout}ms`));
        }
      }, this.startupTimeout);
    });
  }

  /**
   * Wait until server is ready to accept connections.
   * Polls health endpoint until successful response.
   */
  async waitUntilReady(maxAttempts = 30, intervalMs = 200): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        await axios.get(`http://${this.host}:${this.port}/api/health`, {
          timeout: 1000,
        });
        return;
      } catch (err) {
        // Server not ready yet, wait and retry
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
    throw new Error(`Server did not become ready after ${maxAttempts} attempts`);
  }

  /**
   * Stop the server process gracefully.
   * Sends SIGTERM, then SIGKILL if needed.
   */
  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    return new Promise((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      let killed = false;

      const cleanup = () => {
        if (!killed) {
          killed = true;
          this.process = null;
          resolve();
        }
      };

      this.process.on('exit', cleanup);

      // Try graceful shutdown first
      this.process.kill('SIGTERM');

      // Force kill after 2 seconds if still running
      setTimeout(() => {
        if (this.process && !killed) {
          this.process.kill('SIGKILL');
          setTimeout(cleanup, 500);
        }
      }, 2000);
    });
  }

  /**
   * Get the base URL for HTTP requests.
   */
  getUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  /**
   * Get the WebSocket URL.
   */
  getWsUrl(): string {
    return `ws://${this.host}:${this.port}/ws`;
  }

  /**
   * Get the server port.
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Check if server process is running.
   */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }
}
