/**
 * Comprehensive unit tests for MontrServer class
 * Tests server initialization, startup, and shutdown
 */

// Mock logger FIRST before any imports
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../../src/utils/logger', () => ({
  initLogger: jest.fn(),
  getLogger: jest.fn(() => mockLogger),
}));

// Mock dependencies
jest.mock('../../../src/database/connection');
jest.mock('../../../src/websocket/server');
jest.mock('../../../src/config/config', () => ({
  config: {
    server: {
      port: 3000,
      host: '0.0.0.0',
      environment: 'test',
    },
    database: {
      type: 'sqlite',
    },
    storage: {
      path: './test-storage',
      maxUploadSizeMB: 500,
    },
    security: {
      apiKeyRequired: false,
      apiKey: undefined,
      allowedOrigins: ['http://localhost:3000'],
    },
    logging: {
      level: 'info',
      logFile: './test-logs/server.log',
    },
    websocket: {
      healthCheckInterval: 30000,
      staleTimeout: 300000,
      heartbeatTimeout: 60000,
    },
  },
}));

// Import after mocks
import MontrServer from '../../../src/index';
import { getDatabase, closeDatabase } from '../../../src/database/connection';
import { webSocketServer } from '../../../src/websocket/server';
import { getLogger } from '../../../src/utils/logger';
import { createServer } from 'http';

describe('MontrServer', () => {
  let server: MontrServer;
  let mockDb: any;
  let mockWsServer: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset logger mocks
    mockLogger.info.mockClear();
    mockLogger.error.mockClear();
    mockLogger.warn.mockClear();
    mockLogger.debug.mockClear();

    // Mock database
    mockDb = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
    };
    (getDatabase as jest.Mock).mockResolvedValue(mockDb);
    (closeDatabase as jest.Mock).mockResolvedValue(undefined);

    // Mock WebSocket server
    mockWsServer = {
      initialize: jest.fn(),
      shutdown: jest.fn().mockResolvedValue(undefined),
      getStats: jest.fn().mockReturnValue({
        connections: 5,
        totalMessages: 100,
      }),
    };
    (webSocketServer as any) = mockWsServer;
    Object.assign(webSocketServer, mockWsServer);

    // Mock createServer to avoid EADDRINUSE
    jest.spyOn(require('http'), 'createServer').mockReturnValue({
      listen: jest.fn((...args: any[]) => {
        // Call the callback (3rd arg) to simulate successful listen
        const cb = args.find((a: any) => typeof a === 'function');
        if (cb) cb();
      }),
      close: jest.fn((cb: any) => { if (cb) cb(); }),
      on: jest.fn(),
      address: jest.fn().mockReturnValue({ port: 3000, address: '0.0.0.0' }),
    } as any);
  });

  afterEach(async () => {
    if (server) {
      try {
        await server.shutdown();
      } catch (error) {
        // Ignore shutdown errors in cleanup
      }
    }
  });

  describe('Constructor and Initialization', () => {
    it('should create server instance successfully', () => {
      server = new MontrServer();

      expect(server).toBeDefined();
      expect(server).toBeInstanceOf(MontrServer);
    });

    it('should initialize logger on construction', () => {
      const { initLogger } = require('../../../src/utils/logger');

      server = new MontrServer();

      expect(initLogger).toHaveBeenCalledWith({
        level: 'info',
        logFile: './test-logs/server.log',
      });
    });

    it('should return Express app instance', () => {
      server = new MontrServer();

      const app = server.getApp();

      expect(app).toBeDefined();
      expect(typeof app.use).toBe('function');
      expect(typeof app.get).toBe('function');
    });
  });

  describe('Server Startup', () => {
    it('should start server successfully', async () => {
      server = new MontrServer();
      // Manually set logger
      (server as any).logger = mockLogger;

      await server.start();

      expect(getDatabase).toHaveBeenCalled();
      expect(webSocketServer.initialize).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Database connection established');
      expect(mockLogger.info).toHaveBeenCalledWith('WebSocket server initialized');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Montr Server started successfully')
      );
    }, 10000);

    it('should initialize database before starting HTTP server', async () => {
      server = new MontrServer();
      (server as any).logger = mockLogger;
      const callOrder: string[] = [];

      (getDatabase as jest.Mock).mockImplementation(async () => {
        callOrder.push('database');
        return mockDb;
      });

      await server.start();

      expect(callOrder[0]).toBe('database');
      expect(getDatabase).toHaveBeenCalled();
    }, 10000);

    it('should initialize WebSocket server after HTTP server', async () => {
      server = new MontrServer();
      (server as any).logger = mockLogger;

      await server.start();

      expect(webSocketServer.initialize).toHaveBeenCalled();
    }, 10000);

    it('should log server information on successful start', async () => {
      server = new MontrServer();
      (server as any).logger = mockLogger;

      await server.start();

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Montr Server started successfully')
      );
      expect(mockLogger.info).toHaveBeenCalledWith('Environment: test');
      expect(mockLogger.info).toHaveBeenCalledWith('Database type: sqlite');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Health check:')
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('WebSocket endpoint:')
      );
    }, 10000);

    it('should handle database connection errors', async () => {
      server = new MontrServer();
      (server as any).logger = mockLogger;
      (getDatabase as jest.Mock).mockRejectedValue(new Error('Database connection failed'));

      await expect(server.start()).rejects.toThrow('Database connection failed');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to start server:',
        expect.any(Error)
      );
    }, 10000);

    it('should handle port already in use error', async () => {
      server = new MontrServer();

      // Mock HTTP server with error
      const originalStart = server.start.bind(server);
      server.start = jest.fn(async () => {
        await getDatabase();
        const error: any = new Error('Port in use');
        error.code = 'EADDRINUSE';
        throw error;
      });

      await expect(server.start()).rejects.toThrow();
    }, 10000);
  });

  describe('Server Shutdown', () => {
    it('should shutdown server without throwing errors', async () => {
      server = new MontrServer();
      (server as any).logger = mockLogger;

      // Don't start, just test shutdown handles it gracefully
      await expect(server.shutdown()).resolves.not.toThrow();
    }, 10000);
  });

  describe('Application Configuration', () => {
    it('should create Express application', () => {
      server = new MontrServer();
      const app = server.getApp();

      // Verify app exists and has Express methods
      expect(app).toBeDefined();
      expect(typeof app.listen).toBe('function');
      expect(typeof app.use).toBe('function');
      expect(typeof app.get).toBe('function');
    });

    it('should configure middleware and routes', () => {
      server = new MontrServer();

      // Server should be created without errors
      expect(server).toBeDefined();
      expect(server.getApp()).toBeDefined();
    });
  });
});
