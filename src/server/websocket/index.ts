import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { PlaylistModel, SystemStateModel } from '../models';
import { Playlist } from '../../shared/types/models';

export interface ClientInfo {
  id: string;
  connectedAt: Date;
  lastHeartbeat: Date;
  userAgent?: string;
  ipAddress?: string;
}

export interface WebSocketEvents {
  // Server to Client events
  'playlist-activated': (playlist: Playlist | null) => void;
  'playlist-updated': (playlist: Playlist) => void;
  'client-list-updated': (clients: ClientInfo[]) => void;
  'heartbeat-response': () => void;
  
  // Client to Server events
  'heartbeat': () => void;
  'request-active-playlist': () => void;
  'client-info': (info: { userAgent?: string }) => void;
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
      console.log(`Client connected: ${socket.id}`);
      
      // Add client to tracking
      const clientInfo: ClientInfo = {
        id: socket.id,
        connectedAt: new Date(),
        lastHeartbeat: new Date(),
        ipAddress: socket.handshake.address
      };
      
      this.connectedClients.set(socket.id, clientInfo);
      this.broadcastClientListUpdate();

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
          } else {
            socket.emit('playlist-activated', null);
          }
        } catch (error) {
          console.error('Error sending active playlist:', error);
          socket.emit('playlist-activated', null);
        }
      });

      // Handle disconnection
      socket.on('disconnect', (reason) => {
        console.log(`Client disconnected: ${socket.id}, reason: ${reason}`);
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
      } else {
        this.io.to(socketId).emit('playlist-activated', null);
      }
    } catch (error) {
      console.error('Error sending active playlist to client:', error);
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
          console.log(`Removing stale client: ${socketId}`);
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
        playlist = await PlaylistModel.findById(playlistId, true);
      }
      
      console.log(`Broadcasting playlist activation: ${playlistId ? playlist?.name : 'none'}`);
      this.io.emit('playlist-activated', playlist);
    } catch (error) {
      console.error('Error broadcasting playlist activation:', error);
    }
  }

  public async broadcastPlaylistUpdated(playlistId: string): Promise<void> {
    try {
      const playlist = await PlaylistModel.findById(playlistId, true);
      if (playlist) {
        console.log(`Broadcasting playlist update: ${playlist.name}`);
        this.io.emit('playlist-updated', playlist);
      }
    } catch (error) {
      console.error('Error broadcasting playlist update:', error);
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
    console.log('WebSocket server shut down');
  }
}

let webSocketManager: WebSocketManager | null = null;

export function initializeWebSocket(server: HTTPServer): WebSocketManager {
  if (webSocketManager) {
    console.warn('WebSocket server already initialized');
    return webSocketManager;
  }
  
  webSocketManager = new WebSocketManager(server);
  console.log('WebSocket server initialized');
  return webSocketManager;
}

export function getWebSocketManager(): WebSocketManager | null {
  return webSocketManager;
}

export { WebSocketManager };