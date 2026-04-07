/**
 * Comprehensive unit tests for MontrWebSocketServer
 * Tests initialization, connection handling, message routing, disconnection, and shutdown
 */

// Stable mock functions for ws.WebSocketServer instances
const mockWssOn = jest.fn();
const mockWssClose = jest.fn((cb: (err?: Error) => void) => cb());

jest.mock('ws', () => ({
  WebSocketServer: jest.fn(() => ({
    on: mockWssOn,
    close: mockWssClose,
  })),
  WebSocket: { OPEN: 1 },
}));

jest.mock('../../../src/utils/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock('../../../src/config/config', () => ({
  config: {
    websocket: {
      healthCheckInterval: 30000,
      staleTimeout: 300000,
      heartbeatTimeout: 60000,
    },
  },
}));

jest.mock('../../../src/websocket/client-manager', () => ({
  clientConnectionManager: {
    healthCheck: jest.fn(),
    removeStaleConnections: jest.fn().mockReturnValue(0),
    incrementErrorCount: jest.fn(),
    incrementMessageCount: jest.fn(),
    sendError: jest.fn(),
    removeConnection: jest.fn(),
    closeAll: jest.fn(),
    broadcastToAdmins: jest.fn().mockReturnValue(0),
    addAdminConnection: jest.fn(),
    removeAdminConnection: jest.fn(),
    getActiveConnectionCount: jest.fn().mockReturnValue(0),
    getStats: jest.fn().mockReturnValue({}),
  },
}));

jest.mock('../../../src/websocket/handlers', () => ({
  handleRegister: jest.fn(),
  handleStatusUpdate: jest.fn(),
  handleHeartbeat: jest.fn(),
  handleError: jest.fn(),
}));

jest.mock('../../../src/websocket/types', () => ({
  parseClientMessage: jest.fn(),
}));

jest.mock('../../../src/services/client.service', () => ({
  clientService: {
    updateClient: jest.fn().mockResolvedValue(undefined),
  },
}));

import { Server as HTTPServer } from 'http';
import { WebSocketServer } from 'ws';
import { MontrWebSocketServer } from '../../../src/websocket/server';
import { clientConnectionManager } from '../../../src/websocket/client-manager';
import { parseClientMessage } from '../../../src/websocket/types';
import {
  handleRegister,
  handleStatusUpdate,
  handleHeartbeat,
  handleError,
} from '../../../src/websocket/handlers';
import { clientService } from '../../../src/services/client.service';

describe('MontrWebSocketServer', () => {
  let server: MontrWebSocketServer;
  let mockHttpServer: HTTPServer;
  let mockManager: jest.Mocked<typeof clientConnectionManager>;
  let mockParseClientMessage: jest.MockedFunction<typeof parseClientMessage>;

  beforeEach(() => {
    jest.useFakeTimers();

    // Re-apply the WebSocketServer constructor implementation (resetMocks strips it)
    (WebSocketServer as unknown as jest.Mock).mockImplementation(() => ({
      on: mockWssOn,
      close: mockWssClose,
    }));

    // Reset mock call history but keep stable references
    mockWssOn.mockReset();
    mockWssClose.mockReset().mockImplementation((cb: (err?: Error) => void) => cb());

    // Restore default return values on manager mocks (resetMocks strips them)
    mockManager = clientConnectionManager as jest.Mocked<typeof clientConnectionManager>;
    (mockManager.removeStaleConnections as jest.Mock).mockReturnValue(0);
    (mockManager.getActiveConnectionCount as jest.Mock).mockReturnValue(0);
    (mockManager.getStats as jest.Mock).mockReturnValue({});

    // Restore client service mock
    (clientService.updateClient as jest.Mock).mockResolvedValue(undefined);

    mockParseClientMessage = parseClientMessage as jest.MockedFunction<typeof parseClientMessage>;

    server = new MontrWebSocketServer();
    mockHttpServer = {} as HTTPServer;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Helper: initialize the server and extract captured event handlers from mockWssOn
  function initializeAndGetHandlers() {
    server.initialize(mockHttpServer);
    const handlers: Record<string, Function> = {};
    for (const call of mockWssOn.mock.calls) {
      handlers[call[0]] = call[1];
    }
    return handlers;
  }

  // Helper: create a mock ExtendedWebSocket with event tracking
  function createMockWs(overrides: Record<string, unknown> = {}) {
    const eventHandlers: Record<string, Function> = {};
    return {
      ws: {
        isAlive: undefined as boolean | undefined,
        lastHeartbeat: undefined as number | undefined,
        clientId: undefined as string | undefined,
        readyState: 1, // WebSocket.OPEN
        on: jest.fn((event: string, handler: Function) => {
          eventHandlers[event] = handler;
        }),
        send: jest.fn(),
        ...overrides,
      },
      eventHandlers,
    };
  }

  describe('initialize', () => {
    it('should create WebSocketServer with correct options', () => {
      server.initialize(mockHttpServer);

      expect(WebSocketServer).toHaveBeenCalledWith({
        server: mockHttpServer,
        path: '/ws',
        clientTracking: true,
      });
    });

    it('should set up connection handler on the WebSocketServer', () => {
      server.initialize(mockHttpServer);

      const connectionCall = mockWssOn.mock.calls.find(
        (call) => call[0] === 'connection'
      );
      expect(connectionCall).toBeDefined();
      expect(typeof connectionCall![1]).toBe('function');
    });

    it('should set up error handler on the WebSocketServer', () => {
      server.initialize(mockHttpServer);

      const errorCall = mockWssOn.mock.calls.find(
        (call) => call[0] === 'error'
      );
      expect(errorCall).toBeDefined();
      expect(typeof errorCall![1]).toBe('function');
    });

    it('should start health check interval that calls clientConnectionManager.healthCheck', () => {
      server.initialize(mockHttpServer);

      expect(mockManager.healthCheck).not.toHaveBeenCalled();

      jest.advanceTimersByTime(30000);

      expect(mockManager.healthCheck).toHaveBeenCalledWith(60000);
    });

    it('should start stale connection cleanup interval', () => {
      server.initialize(mockHttpServer);

      expect(mockManager.removeStaleConnections).not.toHaveBeenCalled();

      jest.advanceTimersByTime(300000);

      expect(mockManager.removeStaleConnections).toHaveBeenCalledWith(300000);
    });
  });

  describe('handleConnection', () => {
    it('should set isAlive and lastHeartbeat on the WebSocket', () => {
      const handlers = initializeAndGetHandlers();
      const { ws } = createMockWs();

      const now = Date.now();
      handlers['connection'](ws);

      expect(ws.isAlive).toBe(true);
      expect(ws.lastHeartbeat).toBeGreaterThanOrEqual(now);
    });

    it('should set up message, pong, close, and error handlers on the WebSocket', () => {
      const handlers = initializeAndGetHandlers();
      const { ws } = createMockWs();

      handlers['connection'](ws);

      const registeredEvents = ws.on.mock.calls.map(
        (call: [string, Function]) => call[0]
      );
      expect(registeredEvents).toContain('message');
      expect(registeredEvents).toContain('pong');
      expect(registeredEvents).toContain('close');
      expect(registeredEvents).toContain('error');
    });

    it('should set isAlive to true when pong is received', () => {
      const handlers = initializeAndGetHandlers();
      const { ws, eventHandlers } = createMockWs();

      handlers['connection'](ws);

      // Manually set isAlive to false, then trigger pong
      ws.isAlive = false;
      eventHandlers['pong']();

      expect(ws.isAlive).toBe(true);
    });

    it('should set up error handler that increments error count', () => {
      const handlers = initializeAndGetHandlers();
      const { ws, eventHandlers } = createMockWs({ clientId: 'client-1' });

      handlers['connection'](ws);
      eventHandlers['error'](new Error('connection reset'));

      expect(mockManager.incrementErrorCount).toHaveBeenCalled();
    });
  });

  describe('message handling', () => {
    it('should route register message to handleRegister', async () => {
      const handlers = initializeAndGetHandlers();
      const { ws, eventHandlers } = createMockWs({ clientId: 'client-1' });
      handlers['connection'](ws);

      const registerMsg = {
        type: 'register',
        clientId: 'client-1',
        version: '1.0.0',
        capabilities: { video: true, image: true },
      };
      mockParseClientMessage.mockReturnValue(registerMsg as any);

      const messageData = Buffer.from(JSON.stringify(registerMsg));
      await eventHandlers['message'](messageData);

      expect(handleRegister).toHaveBeenCalledWith(ws, registerMsg);
      expect(mockManager.incrementMessageCount).toHaveBeenCalledWith('client-1');
    });

    it('should route status_update message to handleStatusUpdate', async () => {
      const handlers = initializeAndGetHandlers();
      const { ws, eventHandlers } = createMockWs({ clientId: 'client-1' });
      handlers['connection'](ws);

      const statusMsg = {
        type: 'status_update',
        clientId: 'client-1',
        currentMedia: null,
        position: 0,
        isPlaying: false,
        timestamp: Date.now(),
      };
      mockParseClientMessage.mockReturnValue(statusMsg as any);

      const messageData = Buffer.from(JSON.stringify(statusMsg));
      await eventHandlers['message'](messageData);

      expect(handleStatusUpdate).toHaveBeenCalledWith(ws, statusMsg);
    });

    it('should route heartbeat message to handleHeartbeat', async () => {
      const handlers = initializeAndGetHandlers();
      const { ws, eventHandlers } = createMockWs({ clientId: 'client-1' });
      handlers['connection'](ws);

      const heartbeatMsg = {
        type: 'heartbeat',
        clientId: 'client-1',
        timestamp: Date.now(),
      };
      mockParseClientMessage.mockReturnValue(heartbeatMsg as any);

      const messageData = Buffer.from(JSON.stringify(heartbeatMsg));
      await eventHandlers['message'](messageData);

      expect(handleHeartbeat).toHaveBeenCalledWith(ws, heartbeatMsg);
    });

    it('should send error response on invalid JSON when no clientId', async () => {
      const handlers = initializeAndGetHandlers();
      const { ws, eventHandlers } = createMockWs({ clientId: undefined, readyState: 1 });
      handlers['connection'](ws);

      const invalidData = Buffer.from('not valid json');
      await eventHandlers['message'](invalidData);

      expect(ws.send).toHaveBeenCalled();
      const sentData = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sentData.type).toBe('error_response');
      expect(sentData.error).toBe('Invalid message format');
      expect(mockManager.incrementErrorCount).toHaveBeenCalled();
    });

    it('should send error via clientConnectionManager when clientId exists and parsing fails', async () => {
      const handlers = initializeAndGetHandlers();
      const { ws, eventHandlers } = createMockWs({ clientId: 'client-1' });
      handlers['connection'](ws);

      mockParseClientMessage.mockImplementation(() => {
        throw new Error('Validation failed');
      });

      const messageData = Buffer.from(JSON.stringify({ type: 'invalid' }));
      await eventHandlers['message'](messageData);

      expect(mockManager.sendError).toHaveBeenCalledWith('client-1', 'Validation failed');
      expect(mockManager.incrementErrorCount).toHaveBeenCalled();
    });

    it('should not increment message count when clientId is not set', async () => {
      const handlers = initializeAndGetHandlers();
      const { ws, eventHandlers } = createMockWs({ clientId: undefined });
      handlers['connection'](ws);

      const registerMsg = {
        type: 'register',
        clientId: 'new-client',
        version: '1.0.0',
        capabilities: { video: true, image: true },
      };
      mockParseClientMessage.mockReturnValue(registerMsg as any);

      const messageData = Buffer.from(JSON.stringify(registerMsg));
      await eventHandlers['message'](messageData);

      expect(mockManager.incrementMessageCount).not.toHaveBeenCalled();
      expect(handleRegister).toHaveBeenCalledWith(ws, registerMsg);
    });
  });

  describe('handleDisconnection', () => {
    it('should remove connection from manager when clientId exists', () => {
      const handlers = initializeAndGetHandlers();
      const { ws, eventHandlers } = createMockWs({ clientId: 'client-1' });
      handlers['connection'](ws);

      eventHandlers['close'](1000, Buffer.from('normal closure'));

      // handleDisconnection passes the ws instance for the identity check
      // (see fix(ws): stop reconnect storm caused by identity-blind
      // removeConnection). The mocked manager receives both args.
      expect(mockManager.removeConnection).toHaveBeenCalledWith('client-1', ws);
    });

    it('should not remove connection or throw when clientId is not set', () => {
      const handlers = initializeAndGetHandlers();
      const { ws, eventHandlers } = createMockWs({ clientId: undefined });
      handlers['connection'](ws);

      // Should not throw
      eventHandlers['close'](1006, Buffer.from(''));

      expect(mockManager.removeConnection).not.toHaveBeenCalled();
    });

    it('should attempt to update client status to offline in database', async () => {
      // Use real timers for this test since the dynamic import() inside
      // updateClientStatusOffline does not resolve under fake timers.
      jest.useRealTimers();

      const mockClientService = clientService as jest.Mocked<typeof clientService>;

      // Re-initialize with real timers (the intervals will run but are harmless)
      const localServer = new MontrWebSocketServer();
      (WebSocketServer as unknown as jest.Mock).mockImplementation(() => ({
        on: mockWssOn,
        close: mockWssClose,
      }));
      mockWssOn.mockReset();
      localServer.initialize(mockHttpServer);

      const localHandlers: Record<string, Function> = {};
      for (const call of mockWssOn.mock.calls) {
        localHandlers[call[0]] = call[1];
      }

      const { ws, eventHandlers } = createMockWs({ clientId: 'client-1' });
      localHandlers['connection'](ws);

      eventHandlers['close'](1000, Buffer.from('bye'));

      // Wait for the async fire-and-forget chain (dynamic import + updateClient)
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockClientService.updateClient).toHaveBeenCalledWith('client-1', {
        status: 'offline',
        last_seen: expect.any(String),
      });

      // Clean up the server to clear its real intervals
      mockWssClose.mockImplementation((cb: (err?: Error) => void) => cb());
      await localServer.shutdown();

      // Restore fake timers for subsequent tests
      jest.useFakeTimers();
    });
  });

  describe('shutdown', () => {
    it('should clear health check and stale connection intervals', async () => {
      server.initialize(mockHttpServer);

      await server.shutdown();

      // After shutdown, intervals should not fire
      (mockManager.healthCheck as jest.Mock).mockClear();
      (mockManager.removeStaleConnections as jest.Mock).mockClear();

      jest.advanceTimersByTime(600000);

      expect(mockManager.healthCheck).not.toHaveBeenCalled();
      expect(mockManager.removeStaleConnections).not.toHaveBeenCalled();
    });

    it('should call closeAll on clientConnectionManager', async () => {
      server.initialize(mockHttpServer);

      await server.shutdown();

      expect(mockManager.closeAll).toHaveBeenCalled();
    });

    it('should close the WebSocketServer', async () => {
      server.initialize(mockHttpServer);

      await server.shutdown();

      expect(mockWssClose).toHaveBeenCalled();
    });

    it('should reject if WebSocketServer close returns an error', async () => {
      server.initialize(mockHttpServer);

      const closeError = new Error('close failed');
      mockWssClose.mockImplementation((cb: (err?: Error) => void) => cb(closeError));

      await expect(server.shutdown()).rejects.toThrow('close failed');
    });

    it('should resolve gracefully when no WebSocketServer was initialized', async () => {
      // Do not call initialize; wss is null
      await expect(server.shutdown()).resolves.toBeUndefined();

      expect(mockManager.closeAll).toHaveBeenCalled();
    });
  });

  describe('getConnectedClientCount', () => {
    it('should delegate to clientConnectionManager.getActiveConnectionCount', () => {
      (mockManager.getActiveConnectionCount as jest.Mock).mockReturnValue(5);

      const count = server.getConnectedClientCount();

      expect(count).toBe(5);
      expect(mockManager.getActiveConnectionCount).toHaveBeenCalled();
    });
  });

  describe('getStats', () => {
    it('should delegate to clientConnectionManager.getStats', () => {
      const stats = {
        totalConnections: 10,
        activeConnections: 3,
        messagesSent: 100,
        messagesReceived: 200,
        errors: 2,
      };
      (mockManager.getStats as jest.Mock).mockReturnValue(stats);

      const result = server.getStats();

      expect(result).toEqual(stats);
      expect(mockManager.getStats).toHaveBeenCalled();
    });
  });

  describe('getServer', () => {
    it('should return null before initialization', () => {
      expect(server.getServer()).toBeNull();
    });

    it('should return the WebSocketServer instance after initialization', () => {
      server.initialize(mockHttpServer);

      const wss = server.getServer();
      expect(wss).toBeDefined();
      expect(wss).not.toBeNull();
    });
  });

  describe('server error handling', () => {
    it('should increment error count when server error occurs', () => {
      const handlers = initializeAndGetHandlers();

      handlers['error'](new Error('EADDRINUSE'));

      expect(mockManager.incrementErrorCount).toHaveBeenCalled();
    });
  });

  describe('stale connection logging', () => {
    it('should log when stale connections are removed', () => {
      server.initialize(mockHttpServer);

      (mockManager.removeStaleConnections as jest.Mock).mockReturnValue(3);
      jest.advanceTimersByTime(300000);

      expect(mockManager.removeStaleConnections).toHaveBeenCalledWith(300000);
    });

    it('should not log when no stale connections are removed', () => {
      server.initialize(mockHttpServer);

      (mockManager.removeStaleConnections as jest.Mock).mockReturnValue(0);
      jest.advanceTimersByTime(300000);

      expect(mockManager.removeStaleConnections).toHaveBeenCalledWith(300000);
    });
  });
});
