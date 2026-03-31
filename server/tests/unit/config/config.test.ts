import type { Config } from '../../../src/config/config';
import { DatabaseType } from '../../../src/config/config';

describe('Config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Shallow clone to isolate env mutations per test
    process.env = { ...originalEnv };
    // Remove all config-related env vars so each test starts clean
    delete process.env.DB_TYPE;
    delete process.env.DB_PATH;
    delete process.env.MYSQL_HOST;
    delete process.env.MYSQL_PORT;
    delete process.env.MYSQL_USER;
    delete process.env.MYSQL_PASSWORD;
    delete process.env.MYSQL_DATABASE;
    delete process.env.MSSQL_SERVER;
    delete process.env.MSSQL_PORT;
    delete process.env.MSSQL_USER;
    delete process.env.MSSQL_PASSWORD;
    delete process.env.MSSQL_DATABASE;
    delete process.env.MONGO_URI;
    delete process.env.STORAGE_PATH;
    delete process.env.PORT;
    delete process.env.HOST;
    delete process.env.NODE_ENV;
    delete process.env.PUBLIC_URL;
    delete process.env.MAX_UPLOAD_SIZE_MB;
    delete process.env.API_KEY_REQUIRED;
    delete process.env.API_KEY;
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.LOG_LEVEL;
    delete process.env.LOG_FILE;
    delete process.env.WS_HEALTH_CHECK_INTERVAL;
    delete process.env.WS_STALE_TIMEOUT;
    delete process.env.WS_HEARTBEAT_TIMEOUT;
    jest.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  /**
   * Helper to import config inside jest.isolateModules with fs and dotenv mocked.
   * Accepts optional overrides for fs.existsSync behavior.
   */
  function loadConfigIsolated(
    existsSyncReturn: boolean | ((...args: unknown[]) => boolean) = true,
  ): Config {
    let loadedConfig: Config | undefined;

    jest.isolateModules(() => {
      jest.mock('fs', () => ({
        existsSync:
          typeof existsSyncReturn === 'function'
            ? jest.fn(existsSyncReturn)
            : jest.fn().mockReturnValue(existsSyncReturn),
        mkdirSync: jest.fn(),
      }));
      jest.mock('dotenv', () => ({ config: jest.fn() }));

      const mod = require('../../../src/config/config');
      loadedConfig = mod.config;
    });

    return loadedConfig!;
  }

  /**
   * Helper that expects the isolated import to throw.
   */
  function expectConfigThrows(messageMatch: string | RegExp): void {
    jest.isolateModules(() => {
      jest.mock('fs', () => ({
        existsSync: jest.fn().mockReturnValue(true),
        mkdirSync: jest.fn(),
      }));
      jest.mock('dotenv', () => ({ config: jest.fn() }));

      expect(() => {
        require('../../../src/config/config');
      }).toThrow(messageMatch);
    });
  }

  // ---------------------------------------------------------------------------
  // validateConfig
  // ---------------------------------------------------------------------------
  describe('validateConfig', () => {
    it('should throw when DB_TYPE is missing', () => {
      // DB_TYPE is already deleted in beforeEach
      expectConfigThrows('DB_TYPE environment variable is required');
    });

    it('should throw when DB_TYPE is invalid', () => {
      process.env.DB_TYPE = 'postgres';

      expectConfigThrows(/Invalid DB_TYPE: postgres/);
    });

    it('should throw when SQLite is selected without DB_PATH', () => {
      process.env.DB_TYPE = 'sqlite';
      // DB_PATH not set

      expectConfigThrows('DB_PATH is required for SQLite');
    });

    it('should throw when MySQL is selected without required vars', () => {
      process.env.DB_TYPE = 'mysql';
      // Missing MYSQL_HOST, MYSQL_USER, MYSQL_DATABASE

      expectConfigThrows(
        'MYSQL_HOST, MYSQL_USER, and MYSQL_DATABASE are required for MySQL',
      );
    });

    it('should throw when MSSQL is selected without required vars', () => {
      process.env.DB_TYPE = 'mssql';
      // Missing MSSQL_SERVER, MSSQL_USER, MSSQL_DATABASE

      expectConfigThrows(
        'MSSQL_SERVER, MSSQL_USER, and MSSQL_DATABASE are required for MSSQL',
      );
    });

    it('should throw when MongoDB is selected without MONGO_URI', () => {
      process.env.DB_TYPE = 'mongodb';
      // Missing MONGO_URI

      expectConfigThrows('MONGO_URI is required for MongoDB');
    });

    it('should not throw for valid SQLite config', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_PATH = ':memory:';

      expect(() => loadConfigIsolated()).not.toThrow();
    });

    it('should not throw for valid MySQL config', () => {
      process.env.DB_TYPE = 'mysql';
      process.env.MYSQL_HOST = 'localhost';
      process.env.MYSQL_USER = 'root';
      process.env.MYSQL_DATABASE = 'montr';

      expect(() => loadConfigIsolated()).not.toThrow();
    });

    it('should create storage directory when it does not exist', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_PATH = ':memory:';
      process.env.STORAGE_PATH = '/tmp/montr-new-storage';

      let mockMkdirSync: jest.Mock | undefined;

      jest.isolateModules(() => {
        mockMkdirSync = jest.fn();
        jest.mock('fs', () => ({
          // Storage path does not exist, but DB dir (:memory: dirname is '.') does
          existsSync: jest.fn().mockReturnValue(false),
          mkdirSync: mockMkdirSync,
        }));
        jest.mock('dotenv', () => ({ config: jest.fn() }));

        require('../../../src/config/config');
      });

      expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/montr-new-storage', {
        recursive: true,
      });
    });

    it('should not create storage directory when it already exists', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_PATH = ':memory:';
      process.env.STORAGE_PATH = '/tmp/montr-existing';

      let mockMkdirSync: jest.Mock | undefined;

      jest.isolateModules(() => {
        mockMkdirSync = jest.fn();
        jest.mock('fs', () => ({
          existsSync: jest.fn().mockReturnValue(true),
          mkdirSync: mockMkdirSync,
        }));
        jest.mock('dotenv', () => ({ config: jest.fn() }));

        require('../../../src/config/config');
      });

      // mkdirSync should not have been called for the storage path
      // (it could be called for other paths, but not for storage since it exists)
      expect(mockMkdirSync).not.toHaveBeenCalledWith('/tmp/montr-existing', {
        recursive: true,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // loadConfig
  // ---------------------------------------------------------------------------
  describe('loadConfig', () => {
    it('should populate config.database.sqlite.path for SQLite', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_PATH = '/data/montr.db';

      const cfg = loadConfigIsolated();

      expect(cfg.database.type).toBe('sqlite');
      expect(cfg.database.sqlite).toBeDefined();
      expect(cfg.database.sqlite!.path).toBe('/data/montr.db');
    });

    it('should populate MySQL config with all fields', () => {
      process.env.DB_TYPE = 'mysql';
      process.env.MYSQL_HOST = 'db.example.com';
      process.env.MYSQL_PORT = '3307';
      process.env.MYSQL_USER = 'admin';
      process.env.MYSQL_PASSWORD = 's3cret';
      process.env.MYSQL_DATABASE = 'montr_prod';

      const cfg = loadConfigIsolated();

      expect(cfg.database.type).toBe('mysql');
      expect(cfg.database.mysql).toEqual({
        host: 'db.example.com',
        port: 3307,
        user: 'admin',
        password: 's3cret',
        database: 'montr_prod',
      });
    });

    it('should use default PORT=3000 and HOST=0.0.0.0', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_PATH = ':memory:';

      const cfg = loadConfigIsolated();

      expect(cfg.server.port).toBe(3000);
      expect(cfg.server.host).toBe('0.0.0.0');
    });

    it('should use custom PORT when set', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_PATH = ':memory:';
      process.env.PORT = '8080';

      const cfg = loadConfigIsolated();

      expect(cfg.server.port).toBe(8080);
    });

    it('should set apiKeyRequired to true when API_KEY_REQUIRED=true', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_PATH = ':memory:';
      process.env.API_KEY_REQUIRED = 'true';
      process.env.API_KEY = 'my-secret-key';

      const cfg = loadConfigIsolated();

      expect(cfg.security.apiKeyRequired).toBe(true);
      expect(cfg.security.apiKey).toBe('my-secret-key');
    });

    it('should split comma-separated ALLOWED_ORIGINS', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_PATH = ':memory:';
      process.env.ALLOWED_ORIGINS =
        'http://localhost:3000, https://montr.example.com , https://admin.example.com';

      const cfg = loadConfigIsolated();

      expect(cfg.security.allowedOrigins).toEqual([
        'http://localhost:3000',
        'https://montr.example.com',
        'https://admin.example.com',
      ]);
    });

    it('should parse WebSocket intervals from environment', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_PATH = ':memory:';
      process.env.WS_HEALTH_CHECK_INTERVAL = '15000';
      process.env.WS_STALE_TIMEOUT = '120000';
      process.env.WS_HEARTBEAT_TIMEOUT = '45000';

      const cfg = loadConfigIsolated();

      expect(cfg.websocket.healthCheckInterval).toBe(15000);
      expect(cfg.websocket.staleTimeout).toBe(120000);
      expect(cfg.websocket.heartbeatTimeout).toBe(45000);
    });

    it('should create DB directory for SQLite if it does not exist', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_PATH = '/var/lib/montr/data/montr.db';

      let mockMkdirSync: jest.Mock | undefined;

      jest.isolateModules(() => {
        mockMkdirSync = jest.fn();
        jest.mock('fs', () => ({
          // First call (storage check in validateConfig) returns true,
          // second call (db dir check in loadConfig) returns false
          existsSync: jest
            .fn()
            .mockReturnValueOnce(true) // storage path exists
            .mockReturnValueOnce(false), // db directory does not exist
          mkdirSync: mockMkdirSync,
        }));
        jest.mock('dotenv', () => ({ config: jest.fn() }));

        require('../../../src/config/config');
      });

      expect(mockMkdirSync).toHaveBeenCalledWith('/var/lib/montr/data', {
        recursive: true,
      });
    });

    it('should have all four DatabaseType enum values', () => {
      expect(Object.values(DatabaseType)).toEqual([
        'sqlite',
        'mysql',
        'mssql',
        'mongodb',
      ]);
    });

    it('should default environment to development', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_PATH = ':memory:';
      delete process.env.NODE_ENV;

      const cfg = loadConfigIsolated();

      expect(cfg.server.environment).toBe('development');
    });

    it('should populate MSSQL config with all fields', () => {
      process.env.DB_TYPE = 'mssql';
      process.env.MSSQL_SERVER = 'sqlserver.example.com';
      process.env.MSSQL_PORT = '1434';
      process.env.MSSQL_USER = 'sa';
      process.env.MSSQL_PASSWORD = 'StrongP@ss';
      process.env.MSSQL_DATABASE = 'montr_db';

      const cfg = loadConfigIsolated();

      expect(cfg.database.type).toBe('mssql');
      expect(cfg.database.mssql).toEqual({
        server: 'sqlserver.example.com',
        port: 1434,
        user: 'sa',
        password: 'StrongP@ss',
        database: 'montr_db',
      });
    });

    it('should populate MongoDB config with uri', () => {
      process.env.DB_TYPE = 'mongodb';
      process.env.MONGO_URI = 'mongodb://localhost:27017/montr';

      const cfg = loadConfigIsolated();

      expect(cfg.database.type).toBe('mongodb');
      expect(cfg.database.mongodb).toEqual({
        uri: 'mongodb://localhost:27017/montr',
      });
    });

    it('should default allowedOrigins to localhost:3000 when not set', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_PATH = ':memory:';

      const cfg = loadConfigIsolated();

      expect(cfg.security.allowedOrigins).toEqual(['http://localhost:3000']);
    });

    it('should default WebSocket intervals when not set', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_PATH = ':memory:';

      const cfg = loadConfigIsolated();

      expect(cfg.websocket.healthCheckInterval).toBe(30000);
      expect(cfg.websocket.staleTimeout).toBe(300000);
      expect(cfg.websocket.heartbeatTimeout).toBe(60000);
    });

    it('should default logging level to info', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_PATH = ':memory:';
      delete process.env.LOG_LEVEL;

      const cfg = loadConfigIsolated();

      expect(cfg.logging.level).toBe('info');
    });

    it('should default storage maxUploadSizeMB to 500', () => {
      process.env.DB_TYPE = 'sqlite';
      process.env.DB_PATH = ':memory:';

      const cfg = loadConfigIsolated();

      expect(cfg.storage.maxUploadSizeMB).toBe(500);
    });
  });
});
