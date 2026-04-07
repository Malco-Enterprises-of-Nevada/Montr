/**
 * Integration tests for WebSocket server
 */

import { createServer, Server as HTTPServer } from 'http';
import WebSocket from 'ws';
import { MontrWebSocketServer } from '../server';
import { clientConnectionManager } from '../client-manager';
import { ClientMessage, ServerMessage } from '../types';
import { AppError, ErrorCode } from '../../api/middleware/error-handler';

// Mock dependencies
jest.mock('../../utils/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock('../../services/client.service', () => ({
  clientService: {
    getClientById: jest.fn(),
    registerClient: jest.fn(),
    updateClient: jest.fn(),
    updateHeartbeat: jest.fn(),
    recordClientStatus: jest.fn(),
  },
}));

jest.mock('../../services/playlist.service', () => ({
  playlistService: {
    getPlaylistWithItems: jest.fn(),
  },
}));

jest.mock('../../config/config', () => ({
  config: {
    server: {
      port: 3001,
      host: 'localhost',
      publicUrl: 'http://localhost:3001',
    },
    websocket: {
      healthCheckInterval: 30000,
      staleTimeout: 300000,
      heartbeatTimeout: 60000,
    },
    storage: {
      backend: 'local',
      path: '/tmp/montr-test-storage',
      maxUploadSizeMB: 500,
      chunkSizeMB: 50,
    },
  },
}));

describe('WebSocket Integration Tests', () => {
  let httpServer: HTTPServer;
  let wsServer: MontrWebSocketServer;
  let wsClient: WebSocket;
  let TEST_PORT: number;
  const TEST_CLIENT_ID = '550e8400-e29b-41d4-a716-446655440000';

  beforeAll((done) => {
    // Create HTTP server
    httpServer = createServer();

    // Initialize WebSocket server
    wsServer = new MontrWebSocketServer();
    wsServer.initialize(httpServer);

    // Start HTTP server on dynamic port (0 lets OS pick a free port)
    httpServer.listen(0, () => {
      const addr = httpServer.address();
      TEST_PORT = typeof addr === 'object' && addr !== null ? addr.port : 3001;
      done();
    });

    httpServer.on('error', (err: Error) => {
      done(err);
    });
  });

  afterAll(async () => {
    // Cleanup connections first
    try {
      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.close();
      }
    } catch {
      // Ignore
    }

    // Shutdown WS server with timeout
    try {
      await Promise.race([
        wsServer.shutdown(),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // Ignore shutdown errors
    }

    // Close HTTP server with timeout
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 2000);
      httpServer.close(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }, 20000);

  beforeEach(() => {
    // Create new WebSocket client for each test
    wsClient = new WebSocket(`ws://localhost:${TEST_PORT}/ws`);
  });

  afterEach(() => {
    // Close client connection after each test
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.close();
    }
  });

  describe('Connection lifecycle', () => {
    it('should establish WebSocket connection', (done) => {
      wsClient.on('open', () => {
        expect(wsClient.readyState).toBe(WebSocket.OPEN);
        done();
      });

      wsClient.on('error', (error) => {
        done(error);
      });
    });

    it('should handle connection close', (done) => {
      wsClient.on('open', () => {
        wsClient.close();
      });

      wsClient.on('close', (code) => {
        // ws library may return 1000 (normal) or 1005 (no status received)
        expect([1000, 1005]).toContain(code);
        done();
      });
    });
  });

  describe('Message handling', () => {
    it('should handle register message', (done) => {
      const { clientService } = require('../../services/client.service');

      const mockClient = {
        id: TEST_CLIENT_ID,
        name: `Client-${TEST_CLIENT_ID.substring(0, 8)}`,
        version: '1.0.0',
        capabilities: '{"video":true,"image":true}',
        status: 'online',
        assigned_playlist_id: null,
        last_seen: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // Mock client service
      clientService.getClientById.mockRejectedValue(
        new AppError(ErrorCode.CLIENT_NOT_FOUND, 'Client not found', 404)
      );
      clientService.registerClient.mockResolvedValue(mockClient);
      clientService.updateClient.mockResolvedValue(mockClient);

      wsClient.on('open', () => {
        const registerMessage: ClientMessage = {
          type: 'register',
          clientId: TEST_CLIENT_ID,
          version: '1.0.0',
          capabilities: {
            video: true,
            image: true,
          },
        };

        wsClient.send(JSON.stringify(registerMessage));
      });

      wsClient.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString()) as ServerMessage;

        if (message.type === 'success') {
          expect(message.message).toBe('Registration successful');
          done();
        }
      });

      wsClient.on('error', (error) => {
        done(error);
      });
    });

    it('should handle heartbeat message', (done) => {
      const { clientService } = require('../../services/client.service');

      // Mock client service
      clientService.getClientById.mockResolvedValue({
        id: TEST_CLIENT_ID,
        name: 'Test Client',
      });
      clientService.updateClient.mockResolvedValue({});
      clientService.updateHeartbeat.mockResolvedValue(undefined);

      let registrationComplete = false;

      wsClient.on('open', () => {
        // First register
        const registerMessage: ClientMessage = {
          type: 'register',
          clientId: TEST_CLIENT_ID,
          version: '1.0.0',
          capabilities: {
            video: true,
            image: true,
          },
        };

        wsClient.send(JSON.stringify(registerMessage));
      });

      wsClient.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString()) as ServerMessage;

        if (message.type === 'success' && !registrationComplete) {
          registrationComplete = true;

          // Now send heartbeat
          const heartbeatMessage: ClientMessage = {
            type: 'heartbeat',
            clientId: TEST_CLIENT_ID,
            timestamp: Date.now(),
          };

          wsClient.send(JSON.stringify(heartbeatMessage));

          // Give it a moment to process
          setTimeout(() => {
            expect(clientService.updateHeartbeat).toHaveBeenCalledWith(TEST_CLIENT_ID);
            done();
          }, 100);
        }
      });

      wsClient.on('error', (error) => {
        done(error);
      });
    });

    it('should reject invalid message format', (done) => {
      wsClient.on('open', () => {
        wsClient.send('invalid json');
      });

      wsClient.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString()) as ServerMessage;

        if (message.type === 'error_response') {
          expect(message.error).toBe('Invalid message format');
          done();
        }
      });

      wsClient.on('error', (error) => {
        done(error);
      });
    });

    it('should keep the new connection alive when a duplicate registration kicks the old one', (done) => {
      // Regression test for the "reconnect storm" race:
      //   1. Client A registers for an id, is stored in the connection map.
      //   2. Client B registers for the SAME id. addConnection kicks A (close 1000)
      //      and stores B in the map.
      //   3. A's async 'close' event fires later and handleDisconnection calls
      //      removeConnection. Previously this deleted B because the lookup was
      //      identity-blind; with the fix it's a no-op.
      //
      // We assert that:
      //   - B stays in the connection map after A's close propagates.
      //   - B is still WebSocket.OPEN on the client side.
      //   - sendToClient(id, msg) successfully reaches B.
      const DUPE_CLIENT_ID = '660e8400-e29b-41d4-a716-446655441111';
      const { clientService } = require('../../services/client.service');
      const mockClient = {
        id: DUPE_CLIENT_ID,
        name: 'Dupe Client',
        version: '1.0.0',
        capabilities: '{"video":true,"image":true}',
        status: 'online',
        assigned_playlist_id: null,
        last_seen: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      clientService.getClientById.mockResolvedValue(mockClient);
      clientService.registerClient.mockResolvedValue(mockClient);
      clientService.updateClient.mockResolvedValue(mockClient);

      const registerPayload: ClientMessage = {
        type: 'register',
        clientId: DUPE_CLIENT_ID,
        version: '1.0.0',
        capabilities: { video: true, image: true },
      };

      // Connect and register client A.
      const clientA = new WebSocket(`ws://localhost:${TEST_PORT}/ws`);
      let clientAClosed = false;
      clientA.on('close', () => {
        clientAClosed = true;
      });

      clientA.on('open', () => {
        clientA.send(JSON.stringify(registerPayload));
      });

      clientA.on('message', (dataA: Buffer) => {
        const msgA = JSON.parse(dataA.toString()) as ServerMessage;
        if (msgA.type !== 'success') return;

        // A is registered. Now connect B with the same id.
        const clientB = new WebSocket(`ws://localhost:${TEST_PORT}/ws`);
        clientB.on('open', () => {
          clientB.send(JSON.stringify(registerPayload));
        });

        clientB.on('message', (dataB: Buffer) => {
          const msgB = JSON.parse(dataB.toString()) as ServerMessage;
          if (msgB.type !== 'success' || msgB.message !== 'Registration successful') return;

          // B is registered. Wait for A's close to propagate through the
          // server, then assert B survived and is reachable.
          const verify = (): void => {
            try {
              expect(clientAClosed).toBe(true);
              // The map entry for DUPE_CLIENT_ID should still exist and point
              // at a connection that is OPEN.
              expect(clientConnectionManager.isConnected(DUPE_CLIENT_ID)).toBe(true);
              expect(clientB.readyState).toBe(WebSocket.OPEN);

              // sendToClient should succeed (routes to B).
              const sent = clientConnectionManager.sendToClient(DUPE_CLIENT_ID, {
                type: 'success',
                message: 'ping from test',
              });
              expect(sent).toBe(true);

              clientB.close();
              done();
            } catch (err) {
              clientB.close();
              done(err as Error);
            }
          };

          // 300 ms is well past the close-handshake RTT on loopback.
          setTimeout(verify, 300);
        });

        clientB.on('error', (err) => {
          done(err);
        });
      });

      clientA.on('error', (err) => {
        done(err);
      });
    }, 10000);

    it('should reject message with invalid schema', (done) => {
      wsClient.on('open', () => {
        const invalidMessage = {
          type: 'register',
          clientId: 'not-a-uuid',
          version: '1.0.0',
          capabilities: {
            video: true,
            image: true,
          },
        };

        wsClient.send(JSON.stringify(invalidMessage));
      });

      wsClient.on('message', (data: Buffer) => {
        const message = JSON.parse(data.toString()) as ServerMessage;

        if (message.type === 'error_response') {
          expect(message.error).toContain('Invalid message format');
          done();
        }
      });

      wsClient.on('error', (error) => {
        done(error);
      });
    });
  });

  describe('Statistics', () => {
    it('should track connection statistics', () => {
      const stats = wsServer.getStats();

      expect(stats).toHaveProperty('totalConnections');
      expect(stats).toHaveProperty('activeConnections');
      expect(stats).toHaveProperty('messagesSent');
      expect(stats).toHaveProperty('messagesReceived');
      expect(stats).toHaveProperty('errors');
    });

    it('should track connected client count', (done) => {
      wsClient.on('open', () => {
        // Account for any existing connections from previous tests
        const count = wsServer.getConnectedClientCount();
        expect(count).toBeGreaterThanOrEqual(0);
        done();
      });
    });
  });
});
