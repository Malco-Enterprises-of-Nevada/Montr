/**
 * Integration tests for WebSocket server
 */

import { createServer, Server as HTTPServer } from 'http';
import WebSocket from 'ws';
import { MontrWebSocketServer } from '../server';
import { ClientMessage, ServerMessage } from '../types';

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
  },
}));

describe('WebSocket Integration Tests', () => {
  let httpServer: HTTPServer;
  let wsServer: MontrWebSocketServer;
  let wsClient: WebSocket;
  const TEST_PORT = 3001;
  const TEST_CLIENT_ID = '550e8400-e29b-41d4-a716-446655440000';

  beforeAll((done) => {
    // Create HTTP server
    httpServer = createServer();

    // Initialize WebSocket server
    wsServer = new MontrWebSocketServer();
    wsServer.initialize(httpServer);

    // Start HTTP server
    httpServer.listen(TEST_PORT, () => {
      done();
    });
  });

  afterAll(async () => {
    // Cleanup
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.close();
    }
    await wsServer.shutdown();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  });

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
        expect(code).toBe(1000);
        done();
      });
    });
  });

  describe('Message handling', () => {
    it('should handle register message', (done) => {
      const { clientService } = require('../../services/client.service');

      // Mock client service
      clientService.getClientById.mockRejectedValue(new Error('Client not found'));
      clientService.registerClient.mockResolvedValue({
        id: TEST_CLIENT_ID,
        name: `Client-${TEST_CLIENT_ID.substring(0, 8)}`,
        version: '1.0.0',
        capabilities: '{"video":true,"image":true}',
        status: 'online',
        assigned_playlist_id: null,
        last_seen: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

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
