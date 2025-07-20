import { Server as HTTPServer } from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import { io as Client, Socket as ClientSocket } from 'socket.io-client';
import { initializeWebSocket, WebSocketManager } from '../index';
import { initializeDatabase } from '../../database';

describe('WebSocket Core Functionality', () => {
  let httpServer: HTTPServer;
  let wsManager: WebSocketManager;
  let clientSocket: ClientSocket;
  let serverPort: number;

  beforeAll(async () => {
    // Initialize test database
    await initializeDatabase(':memory:');
    
    // Create HTTP server
    const app = express();
    httpServer = new HTTPServer(app);
    
    // Initialize WebSocket server
    wsManager = initializeWebSocket(httpServer);
    
    // Start server on random port
    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        serverPort = (httpServer.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (clientSocket && clientSocket.connected) {
      clientSocket.disconnect();
    }
    
    if (wsManager) {
      wsManager.shutdown();
    }
    
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    }
  });

  afterEach(async () => {
    if (clientSocket && clientSocket.connected) {
      clientSocket.disconnect();
      await new Promise(resolve => setTimeout(resolve, 100)); // Wait for cleanup
    }
  });

  test('should establish WebSocket connection', (done) => {
    clientSocket = Client(`http://localhost:${serverPort}`);
    
    clientSocket.on('connect', () => {
      expect(clientSocket.connected).toBe(true);
      expect(wsManager.getClientCount()).toBe(1);
      done();
    });
  });

  test('should handle heartbeat communication', (done) => {
    clientSocket = Client(`http://localhost:${serverPort}`);
    
    clientSocket.on('connect', () => {
      clientSocket.emit('heartbeat');
    });
    
    clientSocket.on('heartbeat-response', () => {
      expect(wsManager.getClientCount()).toBe(1);
      done();
    });
  });

  test('should track client connections', (done) => {
    clientSocket = Client(`http://localhost:${serverPort}`);
    
    clientSocket.on('connect', () => {
      const clients = wsManager.getConnectedClients();
      expect(clients).toHaveLength(1);
      expect(clients[0].id).toBe(clientSocket.id);
      expect(clients[0].connectedAt).toBeInstanceOf(Date);
      expect(clients[0].lastHeartbeat).toBeInstanceOf(Date);
      done();
    });
  });

  test('should handle client info updates', (done) => {
    clientSocket = Client(`http://localhost:${serverPort}`);
    
    clientSocket.on('connect', () => {
      clientSocket.emit('client-info', { userAgent: 'test-client-core' });
      
      setTimeout(() => {
        const clients = wsManager.getConnectedClients();
        expect(clients).toHaveLength(1);
        expect(clients[0].userAgent).toBe('test-client-core');
        done();
      }, 100);
    });
  });

  test('should broadcast client list updates', (done) => {
    clientSocket = Client(`http://localhost:${serverPort}`);
    
    clientSocket.on('connect', () => {
      // Verify client is tracked
      const clients = wsManager.getConnectedClients();
      expect(clients).toHaveLength(1);
      expect(clients[0].id).toBe(clientSocket.id);
      done();
    });
  });

  test('should handle null playlist activation', (done) => {
    let callCount = 0;
    clientSocket = Client(`http://localhost:${serverPort}`);
    
    clientSocket.on('connect', async () => {
      await wsManager.broadcastPlaylistActivated(null);
    });
    
    clientSocket.on('playlist-activated', (receivedPlaylist: any) => {
      callCount++;
      if (callCount === 1) {
        // First call is automatic on connection (should be null since no active playlist)
        expect(receivedPlaylist).toBeNull();
      } else if (callCount === 2) {
        // Second call is from our broadcast
        expect(receivedPlaylist).toBeNull();
        done();
      }
    });
  });

  test('should handle request for active playlist when none exists', (done) => {
    clientSocket = Client(`http://localhost:${serverPort}`);
    
    clientSocket.on('connect', () => {
      clientSocket.emit('request-active-playlist');
    });
    
    clientSocket.on('playlist-activated', (receivedPlaylist: any) => {
      expect(receivedPlaylist).toBeNull();
      done();
    });
  });
});