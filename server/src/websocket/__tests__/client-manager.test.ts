/**
 * Tests for WebSocket Client Connection Manager
 */

import WebSocket from 'ws';
import { ClientConnectionManager } from '../client-manager';
import { ExtendedWebSocket, ServerMessage } from '../types';

// Mock logger
jest.mock('../../utils/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// Helper function to create mock WebSocket
function createMockWebSocket(readyState: number = WebSocket.OPEN): ExtendedWebSocket {
  const ws = new WebSocket('ws://localhost') as ExtendedWebSocket;
  Object.defineProperty(ws, 'readyState', {
    value: readyState,
    writable: true,
    configurable: true,
  });
  ws.send = jest.fn();
  ws.close = jest.fn();
  ws.ping = jest.fn();
  return ws;
}

describe('ClientConnectionManager', () => {
  let manager: ClientConnectionManager;
  let mockWs: ExtendedWebSocket;

  beforeEach(() => {
    manager = new ClientConnectionManager();
    mockWs = createMockWebSocket();
  });

  afterEach(() => {
    manager.closeAll();
    if (mockWs.readyState === WebSocket.OPEN) {
      mockWs.close();
    }
  });

  describe('addConnection', () => {
    it('should add a new connection', () => {
      const clientId = '550e8400-e29b-41d4-a716-446655440000';
      manager.addConnection(clientId, mockWs);

      expect(manager.isConnected(clientId)).toBe(true);
      expect(manager.getActiveConnectionCount()).toBe(1);
      expect(mockWs.clientId).toBe(clientId);
      expect(mockWs.isAlive).toBe(true);
    });

    it('rejects a duplicate register arriving inside the dedup window', () => {
      // CF/Caddy sometimes fans a single upstream WS into two — back-to-back
      // registers for the same clientId used to kick each other in a loop.
      // Now the newcomer is rejected with 1008 and the live session stays.
      const clientId = '550e8400-e29b-41d4-a716-446655440000';
      const oldWs = createMockWebSocket();

      manager.addConnection(clientId, oldWs);
      manager.addConnection(clientId, mockWs);

      expect(oldWs.close).not.toHaveBeenCalled();
      expect(mockWs.close).toHaveBeenCalledWith(1008, 'Duplicate connection');
      expect(manager.getConnection(clientId)).toBe(oldWs);
      expect(manager.getActiveConnectionCount()).toBe(1);
    });

    it('kicks the old connection when a real reconnect arrives after the dedup window', () => {
      const clientId = '550e8400-e29b-41d4-a716-446655440000';
      const oldWs = createMockWebSocket();

      manager.addConnection(clientId, oldWs);
      // Simulate the old session being added ~30s ago — well past the 10 s
      // dedup window, which is what a genuine reconnect after network loss
      // would look like.
      const meta = (manager as unknown as {
        metadata: Map<string, { connectedAt: Date }>;
      }).metadata.get(clientId);
      if (meta) meta.connectedAt = new Date(Date.now() - 30_000);

      manager.addConnection(clientId, mockWs);

      expect(oldWs.close).toHaveBeenCalledWith(1000, 'New connection established');
      expect(manager.getConnection(clientId)).toBe(mockWs);
      expect(manager.getActiveConnectionCount()).toBe(1);
    });

    it('should update statistics', () => {
      const clientId1 = '550e8400-e29b-41d4-a716-446655440000';
      const clientId2 = '550e8400-e29b-41d4-a716-446655440001';

      manager.addConnection(clientId1, mockWs);
      manager.addConnection(clientId2, createMockWebSocket());

      const stats = manager.getStats();
      expect(stats.totalConnections).toBe(2);
      expect(stats.activeConnections).toBe(2);
    });
  });

  describe('removeConnection', () => {
    it('should remove an existing connection', () => {
      const clientId = '550e8400-e29b-41d4-a716-446655440000';
      manager.addConnection(clientId, mockWs);
      manager.removeConnection(clientId);

      expect(manager.isConnected(clientId)).toBe(false);
      expect(manager.getActiveConnectionCount()).toBe(0);
      expect(mockWs.close).toHaveBeenCalled();
    });

    it('should handle removing non-existent connection', () => {
      const clientId = '550e8400-e29b-41d4-a716-446655440000';
      expect(() => manager.removeConnection(clientId)).not.toThrow();
    });
  });

  describe('getConnection', () => {
    it('should return the connection for a client', () => {
      const clientId = '550e8400-e29b-41d4-a716-446655440000';
      manager.addConnection(clientId, mockWs);

      const connection = manager.getConnection(clientId);
      expect(connection).toBe(mockWs);
    });

    it('should return undefined for non-existent client', () => {
      const clientId = '550e8400-e29b-41d4-a716-446655440000';
      const connection = manager.getConnection(clientId);
      expect(connection).toBeUndefined();
    });
  });

  describe('isConnected', () => {
    it('should return true for connected client', () => {
      const clientId = '550e8400-e29b-41d4-a716-446655440000';
      manager.addConnection(clientId, mockWs);

      expect(manager.isConnected(clientId)).toBe(true);
    });

    it('should return false for disconnected client', () => {
      const clientId = '550e8400-e29b-41d4-a716-446655440000';
      const closedWs = createMockWebSocket(WebSocket.CLOSED);
      manager.addConnection(clientId, closedWs);

      expect(manager.isConnected(clientId)).toBe(false);
    });

    it('should return false for non-existent client', () => {
      const clientId = '550e8400-e29b-41d4-a716-446655440000';
      expect(manager.isConnected(clientId)).toBe(false);
    });
  });

  describe('updateHeartbeat', () => {
    it('should update heartbeat timestamp', () => {
      const clientId = '550e8400-e29b-41d4-a716-446655440000';
      manager.addConnection(clientId, mockWs);

      const beforeUpdate = mockWs.lastHeartbeat;
      setTimeout(() => {
        manager.updateHeartbeat(clientId);
        const afterUpdate = mockWs.lastHeartbeat;
        expect(afterUpdate).toBeGreaterThanOrEqual(beforeUpdate!);
      }, 10);
    });

    it('should mark connection as alive', () => {
      const clientId = '550e8400-e29b-41d4-a716-446655440000';
      manager.addConnection(clientId, mockWs);
      mockWs.isAlive = false;

      manager.updateHeartbeat(clientId);
      expect(mockWs.isAlive).toBe(true);
    });
  });

  describe('sendToClient', () => {
    it('should send message to connected client', () => {
      const clientId = '550e8400-e29b-41d4-a716-446655440000';
      manager.addConnection(clientId, mockWs);

      const message: ServerMessage = {
        type: 'success',
        message: 'Test message',
      };

      const result = manager.sendToClient(clientId, message);
      expect(result).toBe(true);
      expect(mockWs.send).toHaveBeenCalledWith(JSON.stringify(message));
    });

    it('should return false for disconnected client', () => {
      const clientId = '550e8400-e29b-41d4-a716-446655440000';
      const closedWs = createMockWebSocket(WebSocket.CLOSED);
      manager.addConnection(clientId, closedWs);

      const message: ServerMessage = {
        type: 'success',
        message: 'Test message',
      };

      const result = manager.sendToClient(clientId, message);
      expect(result).toBe(false);
    });

    it('should return false for non-existent client', () => {
      const clientId = '550e8400-e29b-41d4-a716-446655440000';
      const message: ServerMessage = {
        type: 'success',
        message: 'Test message',
      };

      const result = manager.sendToClient(clientId, message);
      expect(result).toBe(false);
    });
  });

  describe('broadcastToAll', () => {
    it('should broadcast message to all connected clients', () => {
      const clientId1 = '550e8400-e29b-41d4-a716-446655440000';
      const clientId2 = '550e8400-e29b-41d4-a716-446655440001';
      const mockWs2 = createMockWebSocket();

      manager.addConnection(clientId1, mockWs);
      manager.addConnection(clientId2, mockWs2);

      const message: ServerMessage = {
        type: 'success',
        message: 'Broadcast message',
      };

      const sentCount = manager.broadcastToAll(message);
      expect(sentCount).toBe(2);
      expect(mockWs.send).toHaveBeenCalled();
      expect(mockWs2.send).toHaveBeenCalled();
    });

    it('should skip disconnected clients', () => {
      const clientId1 = '550e8400-e29b-41d4-a716-446655440000';
      const clientId2 = '550e8400-e29b-41d4-a716-446655440001';
      const mockWs2 = createMockWebSocket(WebSocket.CLOSED);

      manager.addConnection(clientId1, mockWs);
      manager.addConnection(clientId2, mockWs2);

      const message: ServerMessage = {
        type: 'success',
        message: 'Broadcast message',
      };

      const sentCount = manager.broadcastToAll(message);
      expect(sentCount).toBe(1);
      expect(mockWs.send).toHaveBeenCalled();
      expect(mockWs2.send).not.toHaveBeenCalled();
    });
  });

  describe('sendError', () => {
    it('should send error message', () => {
      const clientId = '550e8400-e29b-41d4-a716-446655440000';
      manager.addConnection(clientId, mockWs);

      const result = manager.sendError(clientId, 'Test error', 'Error details');
      expect(result).toBe(true);
      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'error_response',
          error: 'Test error',
          details: 'Error details',
        })
      );
    });
  });

  describe('sendSuccess', () => {
    it('should send success message', () => {
      const clientId = '550e8400-e29b-41d4-a716-446655440000';
      manager.addConnection(clientId, mockWs);

      const result = manager.sendSuccess(clientId, 'Success message');
      expect(result).toBe(true);
      expect(mockWs.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'success',
          message: 'Success message',
        })
      );
    });
  });

  describe('healthCheck', () => {
    it('should ping all connections', () => {
      const clientId = '550e8400-e29b-41d4-a716-446655440000';
      manager.addConnection(clientId, mockWs);

      manager.healthCheck();
      expect(mockWs.ping).toHaveBeenCalled();
    });

    it('should remove connections that failed health check', () => {
      const clientId = '550e8400-e29b-41d4-a716-446655440000';
      manager.addConnection(clientId, mockWs);
      mockWs.isAlive = false;

      manager.healthCheck();
      expect(manager.isConnected(clientId)).toBe(false);
    });
  });

  describe('closeAll', () => {
    it('should close all connections', () => {
      const clientId1 = '550e8400-e29b-41d4-a716-446655440000';
      const clientId2 = '550e8400-e29b-41d4-a716-446655440001';
      const mockWs2 = createMockWebSocket();

      manager.addConnection(clientId1, mockWs);
      manager.addConnection(clientId2, mockWs2);

      manager.closeAll();
      expect(manager.getActiveConnectionCount()).toBe(0);
      expect(mockWs.close).toHaveBeenCalled();
      expect(mockWs2.close).toHaveBeenCalled();
    });
  });

  describe('getStats', () => {
    it('should return accurate statistics', () => {
      const clientId = '550e8400-e29b-41d4-a716-446655440000';
      manager.addConnection(clientId, mockWs);
      manager.incrementMessageCount(clientId);

      const stats = manager.getStats();
      expect(stats.totalConnections).toBeGreaterThan(0);
      expect(stats.activeConnections).toBe(1);
      expect(stats.messagesReceived).toBeGreaterThan(0);
    });
  });
});
