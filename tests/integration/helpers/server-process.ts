import { spawn, ChildProcess } from 'child_process';
import axios from 'axios';
import { join } from 'path';

export interface ServerProcessOptions {
  port?: number;
  host?: string;
  dbPath?: string;
  logLevel?: string;
  startupTimeout?: number;
}

export class TestServerProcess {
  private process: ChildProcess | null = null;
  private readonly port: number;
  private readonly host: string;
  private readonly dbPath: string;
  private readonly logLevel: string;
  private readonly startupTimeout: number;
  private outputBuffer: string[] = [];

  constructor(options: ServerProcessOptions = {}) {
    this.port = options.port ?? 3001;
    this.host = options.host ?? 'localhost';
    this.dbPath = options.dbPath ?? ':memory:';
    this.logLevel = options.logLevel ?? 'error';
    this.startupTimeout = options.startupTimeout ?? 30000;
  }

  async start(): Promise<void> {
    if (this.process) {
      throw new Error('Server process is already running');
    }

    const serverPath = join(__dirname, '../../../server');

    return new Promise((resolve, reject) => {
      // Start server in test mode
      this.process = spawn('npm', ['start'], {
        cwd: serverPath,
        env: {
          ...process.env,
          PORT: this.port.toString(),
          HOST: this.host,
          NODE_ENV: 'test',
          DB_PATH: this.dbPath,
          LOG_LEVEL: this.logLevel,
          STORAGE_PATH: `/tmp/montr-test-storage-${this.port}`,
        },
      });

      let startupError = '';
      let started = false;

      this.process.stdout?.on('data', (data) => {
        const output = data.toString();
        this.outputBuffer.push(output);

        // Keep only last 100 lines
        if (this.outputBuffer.length > 100) {
          this.outputBuffer.shift();
        }

        // Look for startup indicators
        if (output.includes('Server listening') || output.includes('listening on')) {
          if (!started) {
            started = true;
            // Give it a moment to fully initialize
            setTimeout(() => resolve(), 500);
          }
        }
      });

      this.process.stderr?.on('data', (data) => {
        const error = data.toString();
        this.outputBuffer.push(`STDERR: ${error}`);
        startupError += error;
      });

      this.process.on('error', (err) => {
        reject(new Error(`Failed to start server process: ${err.message}`));
      });

      this.process.on('exit', (code, signal) => {
        if (!started && code !== 0) {
          reject(
            new Error(
              `Server exited with code ${code} (signal: ${signal}). Error: ${startupError}`
            )
          );
        }
      });

      // Timeout after configured duration
      setTimeout(() => {
        if (!started) {
          this.stop();
          reject(
            new Error(
              `Server start timeout after ${this.startupTimeout}ms. Last output: ${this.outputBuffer.slice(-10).join('')}`
            )
          );
        }
      }, this.startupTimeout);
    });
  }

  async waitUntilReady(maxAttempts = 30, intervalMs = 1000): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await axios.get(`http://${this.host}:${this.port}/api/health`, {
          timeout: 1000,
        });

        if (response.status === 200) {
          return;
        }
      } catch (err) {
        // Server not ready yet, wait and retry
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(
      `Server did not become ready in time (${maxAttempts * intervalMs}ms). ` +
        `Last output: ${this.outputBuffer.slice(-10).join('')}`
    );
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    return new Promise((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      const proc = this.process;
      this.process = null;

      // Try graceful shutdown first
      proc.kill('SIGTERM');

      const forceKillTimeout = setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      }, 5000);

      proc.on('exit', () => {
        clearTimeout(forceKillTimeout);
        resolve();
      });

      // Fallback in case exit event doesn't fire
      setTimeout(() => {
        clearTimeout(forceKillTimeout);
        resolve();
      }, 6000);
    });
  }

  getUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  getWsUrl(): string {
    return `ws://${this.host}:${this.port}/ws`;
  }

  getPort(): number {
    return this.port;
  }

  getHost(): string {
    return this.host;
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  getRecentOutput(): string[] {
    return [...this.outputBuffer];
  }
}
