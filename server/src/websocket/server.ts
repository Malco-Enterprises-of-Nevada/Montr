/**
 * WebSocket Server
 * Handles WebSocket connections and message routing for Montr clients
 */

import { Server as HTTPServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { getLogger } from '../utils/logger';
import { config } from '../config/config';
import { clientConnectionManager } from './client-manager';
import { ExtendedWebSocket, parseClientMessage, ClientMessage } from './types';
import {
  handleRegister,
  handleStatusUpdate,
  handleHeartbeat,
  handleError,
  handleTelemetry,
  handleLogEvent,
} from './handlers';

const logger = getLogger();

/**
 * WebSocket Server class
 */
export class MontrWebSocketServer {
  private wss: WebSocketServer | null = null;

  private healthCheckInterval: NodeJS.Timeout | null = null;

  private staleConnectionInterval: NodeJS.Timeout | null = null;

  private offlineCheckInterval: NodeJS.Timeout | null = null;

  /**
   * Initializes the WebSocket server
   */
  public initialize(httpServer: HTTPServer): void {
    logger.info('Initializing WebSocket server...');

    // Create WebSocket server attached to HTTP server
    this.wss = new WebSocketServer({
      server: httpServer,
      path: '/ws',
      clientTracking: true,
    });

    // Set up event handlers
    this.wss.on('connection', this.handleConnection.bind(this));
    this.wss.on('error', this.handleServerError.bind(this));

    // Start health check interval
    this.healthCheckInterval = setInterval(() => {
      clientConnectionManager.healthCheck(config.websocket.heartbeatTimeout);
    }, config.websocket.healthCheckInterval);

    // Start stale connection cleanup
    this.staleConnectionInterval = setInterval(() => {
      const removed = clientConnectionManager.removeStaleConnections(config.websocket.staleTimeout);
      if (removed > 0) {
        logger.info(`Removed ${removed} stale connections`);
      }
    }, config.websocket.staleTimeout);

    // Start periodic offline client check (catches clients that disconnected without clean close)
    this.startOfflineCheck();

    logger.info('WebSocket server initialized successfully');
  }

  /**
   * Starts periodic check for clients whose last_seen exceeds the timeout
   */
  private startOfflineCheck(): void {
    this.offlineCheckInterval = setInterval(() => {
      import('../services/client.service')
        .then(({ clientService }) => clientService.markOfflineClients())
        .then((count) => {
          if (count > 0) {
            logger.info(`Marked ${count} client(s) offline (stale heartbeat)`);
          }
        })
        .catch((error) => {
          logger.error('Error during offline client check:', error);
        });
    }, 60000);
  }

  /**
   * Handles new WebSocket connection
   */
  private handleConnection(ws: WebSocket): void {
    const extWs = ws as ExtendedWebSocket;

    logger.info('New WebSocket connection established');

    // Initialize connection properties
    extWs.isAlive = true;
    extWs.lastHeartbeat = Date.now();

    // Set up WebSocket event handlers
    extWs.on('message', (data: Buffer) => {
      this.handleMessage(extWs, data).catch((error) => {
        logger.error('Error handling message:', error);
        clientConnectionManager.incrementErrorCount();
      });
    });

    extWs.on('pong', () => {
      extWs.isAlive = true;
    });

    extWs.on('close', (code: number, reason: Buffer) => {
      this.handleDisconnection(extWs, code, reason.toString());
    });

    extWs.on('error', (error: Error) => {
      this.handleConnectionError(extWs, error);
    });
  }

  /**
   * Handles incoming WebSocket message
   */
  private async handleMessage(ws: ExtendedWebSocket, data: Buffer): Promise<void> {
    try {
      // Parse message as JSON
      const rawMessage = data.toString();
      const parsedData = JSON.parse(rawMessage);

      // Handle admin_register before full validation (admin messages don't have clientId)
      if (parsedData.type === 'admin_register') {
        clientConnectionManager.addAdminConnection(ws);
        ws.on('close', () => {
          clientConnectionManager.removeAdminConnection(ws);
        });
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'success', message: 'Admin registered' }));
        }
        return;
      }

      // Validate and parse client message
      const message: ClientMessage = parseClientMessage(parsedData);

      // Update message count
      if (ws.clientId) {
        clientConnectionManager.incrementMessageCount(ws.clientId);
      }

      // Route message to appropriate handler
      await this.routeMessage(ws, message);
    } catch (error) {
      logger.error('Error processing message:', error);

      // Send error response to client
      if (ws.clientId) {
        const errorMessage = error instanceof Error ? error.message : 'Invalid message format';
        clientConnectionManager.sendError(ws.clientId, errorMessage);
      } else {
        // If no client ID, we can't route the error properly
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'error_response',
              error: 'Invalid message format',
              details: error instanceof Error ? error.message : undefined,
            })
          );
        }
      }

      clientConnectionManager.incrementErrorCount();
    }
  }

  /**
   * Routes message to appropriate handler
   */
  private async routeMessage(ws: ExtendedWebSocket, message: ClientMessage): Promise<void> {
    logger.debug(`Routing ${message.type} message from client ${message.clientId}`);

    switch (message.type) {
      case 'register':
        await handleRegister(ws, message);
        break;

      case 'status_update':
        await handleStatusUpdate(ws, message);
        break;

      case 'heartbeat':
        await handleHeartbeat(ws, message);
        break;

      case 'error':
        await handleError(ws, message);
        break;

      case 'telemetry':
        await handleTelemetry(ws, message);
        break;

      case 'log_event':
        await handleLogEvent(ws, message);
        break;

      default:
        // This should never happen due to discriminated union typing
        logger.warn(`Unknown message type: ${(message as ClientMessage).type}`);
        if (ws.clientId) {
          clientConnectionManager.sendError(ws.clientId, 'Unknown message type');
        }
    }
  }

  /**
   * Handles client disconnection
   */
  private handleDisconnection(ws: ExtendedWebSocket, code: number, reason: string): void {
    if (ws.clientId) {
      logger.info(
        `Client ${ws.clientId} disconnected (code: ${code}, reason: ${reason || 'none'})`
      );
      // Identity-checked removal: if a newer connection has already replaced
      // this one in the map (e.g. because addConnection kicked us), this is a
      // no-op and won't tear down the replacement.
      clientConnectionManager.removeConnection(ws.clientId, ws);

      // Broadcast offline state to admin browsers
      clientConnectionManager.broadcastToAdmins({
        type: 'client_state_change',
        clientId: ws.clientId,
        status: 'offline',
      });

      // Update client status in database asynchronously
      this.updateClientStatusOffline(ws.clientId).catch((error) => {
        logger.error(`Error updating client ${ws.clientId} status to offline:`, error);
      });
    } else {
      logger.info(`Unregistered connection disconnected (code: ${code})`);
    }
  }

  /**
   * Updates client status to offline in database
   */
  private async updateClientStatusOffline(clientId: string): Promise<void> {
    const { clientService } = await import('../services/client.service');

    try {
      await clientService.updateClient(clientId, {
        status: 'offline',
        last_seen: new Date().toISOString(),
      });
    } catch (error) {
      // Client might not exist in database, log and continue
      logger.debug(`Could not update client ${clientId} to offline:`, error);
    }
  }

  /**
   * Handles WebSocket connection error
   */
  private handleConnectionError(ws: ExtendedWebSocket, error: Error): void {
    const clientId = ws.clientId || 'unknown';
    logger.error(`WebSocket error for client ${clientId}:`, error);
    clientConnectionManager.incrementErrorCount();
  }

  /**
   * Handles WebSocket server error
   */
  private handleServerError(error: Error): void {
    logger.error('WebSocket server error:', error);
    clientConnectionManager.incrementErrorCount();
  }

  /**
   * Gets the number of connected clients
   */
  public getConnectedClientCount(): number {
    return clientConnectionManager.getActiveConnectionCount();
  }

  /**
   * Gets WebSocket server statistics
   */
  public getStats() {
    return clientConnectionManager.getStats();
  }

  /**
   * Gracefully shuts down the WebSocket server
   */
  public async shutdown(): Promise<void> {
    logger.info('Shutting down WebSocket server...');

    // Clear intervals
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.staleConnectionInterval) {
      clearInterval(this.staleConnectionInterval);
      this.staleConnectionInterval = null;
    }

    if (this.offlineCheckInterval) {
      clearInterval(this.offlineCheckInterval);
      this.offlineCheckInterval = null;
    }

    // Close all client connections
    clientConnectionManager.closeAll();

    // Close the WebSocket server
    if (this.wss) {
      await new Promise<void>((resolve, reject) => {
        this.wss!.close((error) => {
          if (error) {
            logger.error('Error closing WebSocket server:', error);
            reject(error);
          } else {
            logger.info('WebSocket server closed successfully');
            resolve();
          }
        });
      });
    }
  }

  /**
   * Gets the WebSocket server instance
   */
  public getServer(): WebSocketServer | null {
    return this.wss;
  }
}

// Export singleton instance
export const webSocketServer = new MontrWebSocketServer();
