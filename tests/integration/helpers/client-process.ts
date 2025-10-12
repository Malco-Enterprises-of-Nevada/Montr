import { spawn, ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

export interface ClientProcessOptions {
  clientId?: string;
  clientName?: string;
  binaryPath?: string;
  release?: boolean;
  logLevel?: string;
  cacheSizeMb?: number;
}

export class TestClientProcess {
  private process: ChildProcess | null = null;
  private configPath: string | null = null;
  private readonly clientId: string;
  private readonly clientName: string;
  private readonly binaryPath: string;
  private readonly logLevel: string;
  private readonly cacheSizeMb: number;
  private outputBuffer: string[] = [];

  constructor(options: ClientProcessOptions = {}) {
    this.clientId = options.clientId ?? `test-client-${uuidv4()}`;
    this.clientName = options.clientName ?? `Test Client ${this.clientId}`;
    this.logLevel = options.logLevel ?? 'debug';
    this.cacheSizeMb = options.cacheSizeMb ?? 100;

    const clientDir = join(__dirname, '../../../client');
    const buildType = options.release ? 'release' : 'debug';
    this.binaryPath = options.binaryPath ?? join(clientDir, `target/${buildType}/montr-client`);
  }

  async start(serverUrl: string): Promise<void> {
    if (this.process) {
      throw new Error('Client process is already running');
    }

    // Check if binary exists
    if (!existsSync(this.binaryPath)) {
      throw new Error(
        `Client binary not found at ${this.binaryPath}. ` +
          `Please build the client with 'cargo build' first.`
      );
    }

    // Create temporary config directory
    const configDir = `/tmp/montr-test-configs`;
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    // Create temporary config file
    this.configPath = join(configDir, `montr-client-${this.clientId}.toml`);
    const cacheDir = `/tmp/montr-test-cache-${this.clientId}`;
    const logFile = `/tmp/montr-client-${this.clientId}.log`;

    const config = `
[server]
url = "${serverUrl}"
reconnect_interval = 1
heartbeat_interval = 5

[client]
id = "${this.clientId}"
name = "${this.clientName}"

[playback]
default_image_duration = 5
loop_playlist = true
media_cache_dir = "${cacheDir}"
max_cache_size_mb = ${this.cacheSizeMb}

[display]
fullscreen = false
screen_index = 0

[system]
log_level = "${this.logLevel}"
log_file = "${logFile}"
`;
    writeFileSync(this.configPath, config);

    // Create cache directory
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }

    // Start client process
    return new Promise((resolve, reject) => {
      this.process = spawn(this.binaryPath, ['--config', this.configPath!], {
        env: {
          ...process.env,
          RUST_LOG: this.logLevel,
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
        if (
          output.includes('Client started') ||
          output.includes('Connected to server') ||
          output.includes('Registered successfully')
        ) {
          if (!started) {
            started = true;
            resolve();
          }
        }
      });

      this.process.stderr?.on('data', (data) => {
        const error = data.toString();
        this.outputBuffer.push(`STDERR: ${error}`);
        startupError += error;
      });

      this.process.on('error', (err) => {
        reject(new Error(`Failed to start client process: ${err.message}`));
      });

      this.process.on('exit', (code, signal) => {
        if (!started && code !== 0) {
          reject(
            new Error(
              `Client exited with code ${code} (signal: ${signal}). Error: ${startupError}`
            )
          );
        }
      });

      // Timeout after 15 seconds
      setTimeout(() => {
        if (!started) {
          // Don't reject immediately, client might still be starting
          // Just resolve and let the test wait for registration
          resolve();
        }
      }, 15000);
    });
  }

  async stop(): Promise<void> {
    if (!this.process) {
      // Still cleanup config if it exists
      this.cleanupConfig();
      return;
    }

    return new Promise((resolve) => {
      if (!this.process) {
        this.cleanupConfig();
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
      }, 3000);

      proc.on('exit', () => {
        clearTimeout(forceKillTimeout);
        this.cleanupConfig();
        resolve();
      });

      // Fallback in case exit event doesn't fire
      setTimeout(() => {
        clearTimeout(forceKillTimeout);
        this.cleanupConfig();
        resolve();
      }, 4000);
    });
  }

  private cleanupConfig(): void {
    if (this.configPath) {
      try {
        if (existsSync(this.configPath)) {
          unlinkSync(this.configPath);
        }
      } catch (err) {
        // Ignore cleanup errors
      }
      this.configPath = null;
    }
  }

  getClientId(): string {
    return this.clientId;
  }

  getClientName(): string {
    return this.clientName;
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  getRecentOutput(): string[] {
    return [...this.outputBuffer];
  }

  getCacheDir(): string {
    return `/tmp/montr-test-cache-${this.clientId}`;
  }

  getLogFile(): string {
    return `/tmp/montr-client-${this.clientId}.log`;
  }
}
