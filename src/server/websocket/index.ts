import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { PlaylistModel, SystemStateModel } from '../models';
import { Playlist } from '../../shared/types/models';
import { createComponentLogger } from '../utils/logger.js';
import { createWebSocketError } from '../middleware/errorMiddleware.js';

const wsLogger = createComponentLogger('websocket');

export interface ClientInfo {
  id: string;
  connectedAt: Date;
  lastHeartbeat: Date;
  userAgent?: string;
  ipAddress?: string;
}

export interface PlaylistDelta {
  operation: 'add' | 'remove' | 'update' | 'reorder';
  itemId?: string;
  item?: any;
  oldIndex?: number;
  newIndex?: number;
  field?: string;
  oldValue?: any;
  newValue?: any;
}

export interface PlaylistUpdate {
  type: 'full' | 'delta';
  playlist?: Playlist;
  changes?: PlaylistDelta[];
  timestamp: Date;
  version: number;
}

export interface WebSocketEvents {
  // Server to Client events
  'playlist-activated': (playlist: Playlist | null) => void;
  'playlist-updated': (playlist: Playlist) => void;
  'playlist-delta-update': (update: PlaylistUpdate) => void;
  'client-list-updated': (clients: ClientInfo[]) => void;
  'heartbeat-response': () => void;
  
  // Client to Server events
  'heartbeat': () => void;
  'request-active-playlist': () => void;
  'client-info': (info: { userAgent?: string }) => void;
  'request-playlist-sync': (playlistId: string, clientVersion?: number) => void;
}

class WebSocketManager {
  private io: SocketIOServer;
  private connectedClients: Map<string, ClientInfo> = new Map();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(server: HTTPServer) {
    this.io = new SocketIOServer(server, {
      cors: {
        origin: process.env.NODE_ENV === 'production' 
          ? process.env.ALLOWED_ORIGINS?.split(',') || []
          : true,
        methods: ['GET', 'POST'],
        credentials: true
      },
      pingTimeout: 60000,
      pingInterval: 25000
    });

    this.setupEventHandlers();
    this.startHeartbeatMonitoring();
  }

  private setupEventHandlers(): void {
    this.io.on('connection', (socket) => {
      wsLogger.info('Client connected', { 
        socketId: socket.id, 
        ipAddress: socket.handshake.address,
        userAgent: socket.handshake.headers['user-agent']
      });
      
      // Add client to tracking
      const clientInfo: ClientInfo = {
        id: socket.id,
        connectedAt: new Date(),
        lastHeartbeat: new Date(),
        ipAddress: socket.handshake.address
      };
      
      this.connectedClients.set(socket.id, clientInfo);
      this.broadcastClientListUpdate();

      // Handle socket errors
      socket.on('error', (error) => {
        wsLogger.error('Socket error', { 
          socketId: socket.id, 
          error: error.message, 
          stack: error.stack 
        });
      });

      // Handle client info update
      socket.on('client-info', (info: { userAgent?: string }) => {
        const client = this.connectedClients.get(socket.id);
        if (client) {
          client.userAgent = info.userAgent;
          this.connectedClients.set(socket.id, client);
          this.broadcastClientListUpdate();
        }
      });

      // Handle heartbeat
      socket.on('heartbeat', () => {
        const client = this.connectedClients.get(socket.id);
        if (client) {
          client.lastHeartbeat = new Date();
          this.connectedClients.set(socket.id, client);
        }
        socket.emit('heartbeat-response');
      });

      // Handle active playlist request
      socket.on('request-active-playlist', async () => {
        try {
          const activePlaylistId = await SystemStateModel.getActivePlaylistId();
          if (activePlaylistId) {
            const playlist = await PlaylistModel.findById(activePlaylistId, true);
            socket.emit('playlist-activated', playlist);
            wsLogger.debug('Active playlist sent to client', { 
              socketId: socket.id, 
              playlistId: activePlaylistId,
              playlistName: playlist?.name 
            });
          } else {
            socket.emit('playlist-activated', null);
            wsLogger.debug('No active playlist sent to client', { socketId: socket.id });
          }
        } catch (error: any) {
          wsLogger.error('Error sending active playlist', { 
            socketId: socket.id, 
            error: error.message, 
            stack: error.stack 
          });
          socket.emit('playlist-activated', null);
          socket.emit('error', createWebSocketError('Failed to retrieve active playlist'));
        }
      });

      // Handle playlist sync request
      socket.on('request-playlist-sync', async (playlistId: string, clientVersion?: number) => {
        try {
          const playlist = await PlaylistModel.findById(playlistId, true);
          if (playlist) {
            // For now, always send full update
            // In a more sophisticated implementation, we'd compare versions and send deltas
            const update: PlaylistUpdate = {
              type: 'full',
              playlist: playlist,
              timestamp: new Date(),
              version: 1 // Would be tracked in database in real implementation
            };
            socket.emit('playlist-delta-update', update);
            wsLogger.debug('Playlist sync sent to client', { 
              socketId: socket.id, 
              playlistId, 
              clientVersion,
              updateType: update.type 
            });
          } else {
            wsLogger.warn('Playlist not found for sync request', { 
              socketId: socket.id, 
              playlistId 
            });
            socket.emit('error', createWebSocketError('Playlist not found'));
          }
        } catch (error: any) {
          wsLogger.error('Error handling playlist sync request', { 
            socketId: socket.id, 
            playlistId, 
            error: error.message, 
            stack: error.stack 
          });
          socket.emit('error', createWebSocketError('Failed to sync playlist'));
        }
      });

      // Handle disconnection
      socket.on('disconnect', (reason) => {
        wsLogger.info('Client disconnected', { 
          socketId: socket.id, 
          reason,
          connectionDuration: Date.now() - clientInfo.connectedAt.getTime()
        });
        this.connectedClients.delete(socket.id);
        this.broadcastClientListUpdate();
      });

      // Send current active playlist to newly connected client
      this.sendActivePlaylistToClient(socket.id);
    });
  }

  private async sendActivePlaylistToClient(socketId: string): Promise<void> {
    try {
      const activePlaylistId = await SystemStateModel.getActivePlaylistId();
      if (activePlaylistId) {
        const playlist = await PlaylistModel.findById(activePlaylistId, true);
        this.io.to(socketId).emit('playlist-activated', playlist);
        wsLogger.debug('Active playlist sent to new client', { 
          socketId, 
          playlistId: activePlaylistId,
          playlistName: playlist?.name 
        });
      } else {
        this.io.to(socketId).emit('playlist-activated', null);
        wsLogger.debug('No active playlist sent to new client', { socketId });
      }
    } catch (error: any) {
      wsLogger.error('Error sending active playlist to client', { 
        socketId, 
        error: error.message, 
        stack: error.stack 
      });
      this.io.to(socketId).emit('error', createWebSocketError('Failed to retrieve active playlist'));
    }
  }

  private startHeartbeatMonitoring(): void {
    // Check for stale connections every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      const now = new Date();
      const staleThreshold = 90000; // 90 seconds

      for (const [socketId, client] of this.connectedClients.entries()) {
        const timeSinceLastHeartbeat = now.getTime() - client.lastHeartbeat.getTime();
        
        if (timeSinceLastHeartbeat > staleThreshold) {
          wsLogger.warn('Removing stale client', { 
            socketId, 
            timeSinceLastHeartbeat: `${timeSinceLastHeartbeat}ms`,
            threshold: `${staleThreshold}ms`
          });
          this.connectedClients.delete(socketId);
          // Disconnect the socket if it's still connected
          const socket = this.io.sockets.sockets.get(socketId);
          if (socket) {
            socket.disconnect(true);
          }
        }
      }
      
      this.broadcastClientListUpdate();
    }, 30000);
  }

  private broadcastClientListUpdate(): void {
    const clientList = Array.from(this.connectedClients.values());
    this.io.emit('client-list-updated', clientList);
  }

  // Public methods for broadcasting events
  public async broadcastPlaylistActivated(playlistId: string | null): Promise<void> {
    try {
      let playlist: Playlist | null = null;
      
      if (playlistId) {
        playlist = await PlaylistModel.findById(playlistId, false);
        // Ensure the playlist is properly serializable
        if (playlist) {
          playlist = JSON.parse(JSON.stringify(playlist));
        }
      }
      
      this.io.emit('playlist-activated', playlist);
      wsLogger.info('Playlist activation broadcasted', { 
        playlistId, 
        playlistName: playlist?.name,
        clientCount: this.connectedClients.size 
      });
    } catch (error: any) {
      wsLogger.error('Error broadcasting playlist activation', { 
        playlistId, 
        error: error.message, 
        stack: error.stack 
      });
      // Emit error to all clients
      this.io.emit('error', createWebSocketError('Failed to broadcast playlist activation'));
    }
  }

  public async broadcastPlaylistUpdated(playlistId: string): Promise<void> {
    try {
      const playlist = await PlaylistModel.findById(playlistId, true);
      if (playlist) {
        this.io.emit('playlist-updated', playlist);
        wsLogger.info('Playlist update broadcasted', { 
          playlistId, 
          playlistName: playlist.name,
          itemCount: playlist.items?.length || 0,
          clientCount: this.connectedClients.size 
        });
      } else {
        wsLogger.warn('Playlist not found for update broadcast', { playlistId });
      }
    } catch (error: any) {
      wsLogger.error('Error broadcasting playlist update', { 
        playlistId, 
        error: error.message, 
        stack: error.stack 
      });
      this.io.emit('error', createWebSocketError('Failed to broadcast playlist update'));
    }
  }

  public async broadcastPlaylistDeltaUpdate(update: PlaylistUpdate): Promise<void> {
    try {
      this.io.emit('playlist-delta-update', update);
      wsLogger.info('Playlist delta update broadcasted', { 
        updateType: update.type,
        playlistId: update.playlist?.id,
        changeCount: update.changes?.length || 0,
        clientCount: this.connectedClients.size 
      });
    } catch (error: any) {
      wsLogger.error('Error broadcasting playlist delta update', { 
        updateType: update.type,
        error: error.message, 
        stack: error.stack 
      });
      this.io.emit('error', createWebSocketError('Failed to broadcast playlist delta update'));
    }
  }

  public getConnectedClients(): ClientInfo[] {
    return Array.from(this.connectedClients.values());
  }

  public getClientCount(): number {
    return this.connectedClients.size;
  }

  public disconnect(socketId: string): void {
    const socket = this.io.sockets.sockets.get(socketId);
    if (socket) {
      socket.disconnect(true);
    }
  }

  public shutdown(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    this.io.close();
    wsLogger.info('WebSocket server shut down', { 
      connectedClients: this.connectedClients.size 
    });
  }
}

let webSocketManager: WebSocketManager | null = null;

export function initializeWebSocket(server: HTTPServer): WebSocketManager {
  if (webSocketManager) {
    wsLogger.warn('WebSocket server already initialized');
    return webSocketManager;
  }
  
  webSocketManager = new WebSocketManager(server);
  wsLogger.info('WebSocket server initialized');
  return webSocketManager;
}

export function getWebSocketManager(): WebSocketManager | null {
  return webSocketManager;
}

export { WebSocketManager };