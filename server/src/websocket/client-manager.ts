/**
 * WebSocket Client Connection Manager
 * Tracks and manages active WebSocket connections
 */

import { getLogger } from '../utils/logger';
import { ExtendedWebSocket, ServerMessage, ConnectionMetadata, WebSocketStats } from './types';

const logger = getLogger();

/**
 * Manages WebSocket client connections
 */
export class ClientConnectionManager {
  private connections: Map<string, ExtendedWebSocket>;

  private metadata: Map<string, ConnectionMetadata>;

  private stats: WebSocketStats;

  constructor() {
    this.connections = new Map();
    this.metadata = new Map();
    this.stats = {
      totalConnections: 0,
      activeConnections: 0,
      messagesSent: 0,
      messagesReceived: 0,
      errors: 0,
    };
  }

  /**
   * Adds a new client connection
   */
  addConnection(clientId: string, ws: ExtendedWebSocket): void {
    // Close existing connection if present
    if (this.connections.has(clientId)) {
      logger.warn(`Client ${clientId} already connected, closing old connection`);
      const oldWs = this.connections.get(clientId);
      if (oldWs && oldWs.readyState === oldWs.OPEN) {
        oldWs.close(1000, 'New connection established');
      }
    }

    // Store connection
    this.connections.set(clientId, ws);
    ws.clientId = clientId;
    ws.isAlive = true;
    ws.lastHeartbeat = Date.now();

    // Store metadata
    this.metadata.set(clientId, {
      clientId,
      connectedAt: new Date(),
      lastHeartbeat: new Date(),
      messageCount: 0,
    });

    // Update stats
    this.stats.totalConnections += 1;
    this.stats.activeConnections = this.connections.size;

    logger.info(
      `Client ${clientId} connection added (total active: ${this.stats.activeConnections})`
    );
  }

  /**
   * Removes a client connection
   */
  removeConnection(clientId: string): void {
    const ws = this.connections.get(clientId);

    if (ws) {
      // Close the connection if still open
      if (ws.readyState === ws.OPEN) {
        ws.close(1000, 'Connection removed');
      }

      this.connections.delete(clientId);
      this.metadata.delete(clientId);
      this.stats.activeConnections = this.connections.size;

      logger.info(
        `Client ${clientId} connection removed (total active: ${this.stats.activeConnections})`
      );
    }
  }

  /**
   * Gets a client connection by ID
   */
  getConnection(clientId: string): ExtendedWebSocket | undefined {
    return this.connections.get(clientId);
  }

  /**
   * Checks if a client is connected
   */
  isConnected(clientId: string): boolean {
    const ws = this.connections.get(clientId);
    return ws !== undefined && ws.readyState === ws.OPEN;
  }

  /**
   * Gets all connected client IDs
   */
  getConnectedClientIds(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Gets connection metadata for a client
   */
  getConnectionMetadata(clientId: string): ConnectionMetadata | undefined {
    return this.metadata.get(clientId);
  }

  /**
   * Updates last heartbeat timestamp for a client
   */
  updateHeartbeat(clientId: string): void {
    const ws = this.connections.get(clientId);
    const meta = this.metadata.get(clientId);

    if (ws) {
      ws.isAlive = true;
      ws.lastHeartbeat = Date.now();
    }

    if (meta) {
      meta.lastHeartbeat = new Date();
    }
  }

  /**
   * Increments message count for a client
   */
  incrementMessageCount(clientId: string): void {
    const meta = this.metadata.get(clientId);
    if (meta) {
      meta.messageCount += 1;
    }
    this.stats.messagesReceived += 1;
  }

  /**
   * Sends a message to a specific client
   */
  sendToClient(clientId: string, message: ServerMessage): boolean {
    const ws = this.connections.get(clientId);

    if (!ws || ws.readyState !== ws.OPEN) {
      logger.warn(`Cannot send message to client ${clientId}: not connected`);
      return false;
    }

    try {
      const data = JSON.stringify(message);
      ws.send(data);
      this.stats.messagesSent += 1;
      logger.debug(`Sent ${message.type} message to client ${clientId}`);
      return true;
    } catch (error) {
      logger.error(`Error sending message to client ${clientId}:`, error);
      this.stats.errors += 1;
      return false;
    }
  }

  /**
   * Broadcasts a message to all connected clients
   */
  broadcastToAll(message: ServerMessage): number {
    let sentCount = 0;

    this.connections.forEach((_ws, clientId) => {
      if (this.sendToClient(clientId, message)) {
        sentCount += 1;
      }
    });

    logger.info(`Broadcast ${message.type} message to ${sentCount} clients`);
    return sentCount;
  }

  /**
   * Broadcasts a message to clients with a specific playlist assigned
   */
  async broadcastToPlaylist(playlistId: number, message: ServerMessage): Promise<number> {
    // Import here to avoid circular dependencies
    const { getDatabase } = await import('../database/connection');
    const db = await getDatabase();

    // Get all clients with this playlist
    const clients = await db.getAllClients({ assigned_playlist_id: playlistId });
    let sentCount = 0;

    clients.forEach((client) => {
      if (this.sendToClient(client.id, message)) {
        sentCount += 1;
      }
    });

    logger.info(
      `Broadcast ${message.type} message to ${sentCount} clients with playlist ${playlistId}`
    );
    return sentCount;
  }

  /**
   * Broadcasts a message to all clients in a group
   */
  async broadcastToGroup(groupId: number, message: ServerMessage): Promise<number> {
    const { getDatabase } = await import('../database/connection');
    const db = await getDatabase();

    const members = await db.getGroupMembers(groupId);
    let sentCount = 0;

    members.forEach((client) => {
      if (this.sendToClient(client.id, message)) {
        sentCount += 1;
      }
    });

    logger.info(`Broadcast ${message.type} message to ${sentCount} clients in group ${groupId}`);
    return sentCount;
  }

  /**
   * Sends an error message to a client
   */
  sendError(clientId: string, error: string, details?: string): boolean {
    return this.sendToClient(clientId, {
      type: 'error_response',
      error,
      details,
    });
  }

  /**
   * Sends a success message to a client
   */
  sendSuccess(clientId: string, message: string): boolean {
    return this.sendToClient(clientId, {
      type: 'success',
      message,
    });
  }

  /**
   * Performs health check on all connections
   * Marks connections as alive/dead based on heartbeat
   */
  healthCheck(heartbeatTimeout: number = 60000): void {
    const now = Date.now();
    const timeout = heartbeatTimeout;

    this.connections.forEach((ws, clientId) => {
      if (!ws.isAlive) {
        logger.warn(`Client ${clientId} failed health check, terminating connection`);
        this.removeConnection(clientId);
        return;
      }

      // Check if heartbeat is too old
      if (ws.lastHeartbeat && now - ws.lastHeartbeat > timeout) {
        logger.warn(`Client ${clientId} heartbeat timeout, marking as not alive`);
        ws.isAlive = false;
        return;
      }

      // Ping the client
      if (ws.readyState === ws.OPEN) {
        ws.isAlive = false;
        ws.ping();
      }
    });
  }

  /**
   * Removes stale connections
   * @param maxAge - Maximum age in milliseconds (default: 5 minutes)
   */
  removeStaleConnections(maxAge: number = 300000): number {
    const now = Date.now();
    let removedCount = 0;

    this.connections.forEach((ws, clientId) => {
      if (ws.lastHeartbeat && now - ws.lastHeartbeat > maxAge) {
        logger.info(`Removing stale connection for client ${clientId}`);
        this.removeConnection(clientId);
        removedCount += 1;
      }
    });

    return removedCount;
  }

  /**
   * Closes all connections
   */
  closeAll(): void {
    logger.info(`Closing all WebSocket connections (${this.connections.size} active)`);

    this.connections.forEach((ws, _clientId) => {
      if (ws.readyState === ws.OPEN) {
        ws.close(1000, 'Server shutting down');
      }
    });

    this.connections.clear();
    this.metadata.clear();
    this.stats.activeConnections = 0;
  }

  /**
   * Gets current statistics
   */
  getStats(): WebSocketStats {
    return {
      ...this.stats,
      activeConnections: this.connections.size,
    };
  }

  /**
   * Gets the number of active connections
   */
  getActiveConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Increments error count
   */
  incrementErrorCount(): void {
    this.stats.errors += 1;
  }
}

// Export singleton instance
export const clientConnectionManager = new ClientConnectionManager();
