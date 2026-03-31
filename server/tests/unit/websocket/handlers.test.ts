/**
 * Comprehensive unit tests for WebSocket message handlers
 * Tests all handler functions with various scenarios
 */

import {
  handleRegister,
  handleStatusUpdate,
  handleHeartbeat,
  handleError,
  sendPlaylistToClient,
  broadcastPlaylistUpdate,
  sendCommandToClient,
  broadcastCommand,
} from '../../../src/websocket/handlers';
import { clientService } from '../../../src/services/client.service';
import { playlistService } from '../../../src/services/playlist.service';
import { clientConnectionManager } from '../../../src/websocket/client-manager';
import {
  RegisterMessage,
  StatusUpdateMessage,
  HeartbeatMessage,
  ErrorMessage,
  ExtendedWebSocket,
} from '../../../src/websocket/types';
import { AppError, ErrorCode } from '../../../src/api/middleware/error-handler';
import WebSocket from 'ws';

// Mock dependencies
jest.mock('../../../src/services/client.service');
jest.mock('../../../src/services/playlist.service');
jest.mock('../../../src/websocket/client-manager');
jest.mock('../../../src/utils/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe('WebSocket Handlers', () => {
  let mockWs: ExtendedWebSocket;
  let mockClientService: jest.Mocked<typeof clientService>;
  let mockPlaylistService: jest.Mocked<typeof playlistService>;
  let mockClientManager: jest.Mocked<typeof clientConnectionManager>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock WebSocket
    mockWs = {
      clientId: 'test-client-123',
      send: jest.fn(),
      close: jest.fn(),
      readyState: WebSocket.OPEN,
      OPEN: WebSocket.OPEN,
    } as unknown as ExtendedWebSocket;

    mockClientService = clientService as jest.Mocked<typeof clientService>;
    mockPlaylistService = playlistService as jest.Mocked<typeof playlistService>;
    mockClientManager = clientConnectionManager as jest.Mocked<typeof clientConnectionManager>;

    // Setup default mock responses
    mockClientManager.isConnected = jest.fn().mockReturnValue(true);
    mockClientManager.addConnection = jest.fn();
    mockClientManager.sendSuccess = jest.fn();
    mockClientManager.sendError = jest.fn();
    mockClientManager.updateHeartbeat = jest.fn();
    mockClientManager.sendToClient = jest.fn().mockReturnValue(true);
    mockClientManager.broadcastToPlaylist = jest.fn().mockResolvedValue(3);
    mockClientManager.broadcastToAll = jest.fn().mockReturnValue(5);
  });

  describe('handleRegister', () => {
    const validMessage: RegisterMessage = {
      type: 'register',
      clientId: 'test-client-123',
      version: '1.0.0',
      capabilities: {
        video: true,
        image: true,
      },
    };

    it('should register a new client successfully', async () => {
      const mockClient = {
        id: 'test-client-123',
        name: 'Client-test-cli',
        status: 'online' as const,
        assigned_playlist_id: null,
        version: '1.0.0',
        capabilities: '{"video":true,"image":true}',
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z',
        last_seen: '2025-01-01T00:00:00.000Z',
      };

      mockClientService.getClientById.mockRejectedValue(
        new AppError(ErrorCode.CLIENT_NOT_FOUND, 'Client not found', 404)
      );
      mockClientService.registerClient.mockResolvedValue(mockClient);
      mockClientService.updateClient.mockResolvedValue(mockClient);

      await handleRegister(mockWs, validMessage);

      expect(mockClientService.getClientById).toHaveBeenCalledWith('test-client-123');
      expect(mockClientService.registerClient).toHaveBeenCalledWith({
        id: 'test-client-123',
        name: 'Client-test-cli',
        version: '1.0.0',
        capabilities: expect.any(String),
      });
      expect(mockClientManager.addConnection).toHaveBeenCalledWith('test-client-123', mockWs);
      expect(mockClientManager.sendSuccess).toHaveBeenCalledWith(
        'test-client-123',
        'Registration successful'
      );
    });

    it('should update existing client on reconnection', async () => {
      const mockClient = {
        id: 'test-client-123',
        name: 'Existing Client',
        status: 'online' as const,
        assigned_playlist_id: null,
        version: '1.0.0',
        capabilities: '{"video":true}',
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z',
        last_seen: '2025-01-01T00:00:00.000Z',
      };

      mockClientService.getClientById.mockResolvedValue(mockClient);
      mockClientService.updateClient.mockResolvedValue({
        ...mockClient,
        version: '1.0.0',
        status: 'online',
      });

      await handleRegister(mockWs, validMessage);

      expect(mockClientService.getClientById).toHaveBeenCalled();
      expect(mockClientService.updateClient).toHaveBeenCalledWith('test-client-123', {
        version: '1.0.0',
        capabilities: expect.any(String),
        status: 'online',
        last_seen: expect.any(String),
      });
      expect(mockClientService.registerClient).not.toHaveBeenCalled();
    });

    it('should send playlist if client has assigned playlist', async () => {
      const mockClient = {
        id: 'test-client-123',
        name: 'Client',
        status: 'online' as const,
        assigned_playlist_id: 5,
        version: '1.0.0',
        capabilities: '{}',
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z',
        last_seen: '2025-01-01T00:00:00.000Z',
      };

      const mockPlaylist = {
        id: 5,
        name: 'Test Playlist',
        description: null,
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z',
        items: [],
      };

      mockClientService.getClientById.mockRejectedValue(
        new AppError(ErrorCode.CLIENT_NOT_FOUND, 'Client not found', 404)
      );
      mockClientService.registerClient.mockResolvedValue(mockClient);
      mockClientService.updateClient.mockResolvedValue(mockClient);
      mockPlaylistService.getPlaylistWithItems.mockResolvedValue(mockPlaylist);

      await handleRegister(mockWs, validMessage);

      expect(mockPlaylistService.getPlaylistWithItems).toHaveBeenCalledWith(5);
      expect(mockClientManager.sendToClient).toHaveBeenCalled();
    });

    it('should handle errors during registration', async () => {
      mockClientService.getClientById.mockRejectedValue(
        new Error('Database connection failed')
      );

      await handleRegister(mockWs, validMessage);

      expect(mockClientManager.sendError).toHaveBeenCalledWith(
        'test-client-123',
        'Database connection failed'
      );
      expect(mockWs.close).toHaveBeenCalledWith(1008, 'Registration failed');
    });

    it('should close connection when WebSocket is not OPEN', async () => {
      mockWs.readyState = WebSocket.CLOSED;
      mockClientService.getClientById.mockRejectedValue(new Error('Some error'));

      await handleRegister(mockWs, validMessage);

      expect(mockWs.close).not.toHaveBeenCalled(); // Already closed
    });
  });

  describe('handleStatusUpdate', () => {
    const validMessage: StatusUpdateMessage = {
      type: 'status_update',
      clientId: 'test-client-123',
      currentMedia: {
        id: 10,
        filename: 'video.mp4',
      },
      position: 45.5,
      isPlaying: true,
      timestamp: Date.now(),
    };

    it('should record status update successfully', async () => {
      mockClientManager.isConnected.mockReturnValue(true);
      mockClientService.recordClientStatus.mockResolvedValue(undefined as any);

      await handleStatusUpdate(mockWs, validMessage);

      expect(mockClientManager.isConnected).toHaveBeenCalledWith('test-client-123');
      expect(mockClientService.recordClientStatus).toHaveBeenCalledWith({
        client_id: 'test-client-123',
        current_media_id: 10,
        position: 45.5,
        is_playing: true,
      });
      expect(mockClientManager.updateHeartbeat).toHaveBeenCalledWith('test-client-123');
    });

    it('should handle null currentMedia', async () => {
      const messageWithoutMedia: StatusUpdateMessage = {
        type: 'status_update',
        clientId: 'test-client-123',
        currentMedia: null,
        position: 0,
        isPlaying: false,
        timestamp: Date.now(),
      };

      mockClientManager.isConnected.mockReturnValue(true);
      mockClientService.recordClientStatus.mockResolvedValue(undefined as any);

      await handleStatusUpdate(mockWs, messageWithoutMedia);

      expect(mockClientService.recordClientStatus).toHaveBeenCalledWith({
        client_id: 'test-client-123',
        current_media_id: undefined,
        position: 0,
        is_playing: false,
      });
    });

    it('should reject update from unregistered client', async () => {
      mockClientManager.isConnected.mockReturnValue(false);

      await handleStatusUpdate(mockWs, validMessage);

      expect(mockClientService.recordClientStatus).not.toHaveBeenCalled();
      expect(mockClientManager.sendError).toHaveBeenCalledWith(
        'test-client-123',
        'Client not registered'
      );
    });

    it('should handle database errors', async () => {
      mockClientManager.isConnected.mockReturnValue(true);
      mockClientService.recordClientStatus.mockRejectedValue(
        new Error('Database error')
      );

      await handleStatusUpdate(mockWs, validMessage);

      expect(mockClientManager.sendError).toHaveBeenCalledWith(
        'test-client-123',
        'Database error'
      );
    });
  });

  describe('handleHeartbeat', () => {
    const validMessage: HeartbeatMessage = {
      type: 'heartbeat',
      clientId: 'test-client-123',
      timestamp: Date.now(),
    };

    it('should update heartbeat successfully', async () => {
      mockClientManager.isConnected.mockReturnValue(true);
      mockClientService.updateHeartbeat.mockResolvedValue(undefined as any);

      await handleHeartbeat(mockWs, validMessage);

      expect(mockClientManager.isConnected).toHaveBeenCalledWith('test-client-123');
      expect(mockClientService.updateHeartbeat).toHaveBeenCalledWith('test-client-123');
      expect(mockClientManager.updateHeartbeat).toHaveBeenCalledWith('test-client-123');
    });

    it('should reject heartbeat from unregistered client', async () => {
      mockClientManager.isConnected.mockReturnValue(false);

      await handleHeartbeat(mockWs, validMessage);

      expect(mockClientService.updateHeartbeat).not.toHaveBeenCalled();
      expect(mockClientManager.sendError).toHaveBeenCalledWith(
        'test-client-123',
        'Client not registered'
      );
    });

    it('should handle database errors silently', async () => {
      mockClientManager.isConnected.mockReturnValue(true);
      mockClientService.updateHeartbeat.mockRejectedValue(new Error('DB error'));

      await handleHeartbeat(mockWs, validMessage);

      // Should not throw, just log error
      expect(mockClientService.updateHeartbeat).toHaveBeenCalled();
    });
  });

  describe('handleError', () => {
    const validMessage: ErrorMessage = {
      type: 'error',
      clientId: 'test-client-123',
      error: 'Playback failed',
      context: {
        mediaId: 10,
        position: 30,
      },
    };

    it('should record error and update client status', async () => {
      mockClientManager.isConnected.mockReturnValue(true);
      mockClientService.recordClientStatus.mockResolvedValue(undefined as any);
      mockClientService.updateClient.mockResolvedValue(undefined as any);

      await handleError(mockWs, validMessage);

      expect(mockClientService.recordClientStatus).toHaveBeenCalledWith({
        client_id: 'test-client-123',
        is_playing: false,
        error_message: 'Playback failed',
      });
      expect(mockClientService.updateClient).toHaveBeenCalledWith('test-client-123', {
        status: 'error',
        last_seen: expect.any(String),
      });
      expect(mockClientManager.updateHeartbeat).toHaveBeenCalledWith('test-client-123');
    });

    it('should ignore error from unregistered client', async () => {
      mockClientManager.isConnected.mockReturnValue(false);

      await handleError(mockWs, validMessage);

      expect(mockClientService.recordClientStatus).not.toHaveBeenCalled();
      expect(mockClientService.updateClient).not.toHaveBeenCalled();
    });

    it('should handle errors without context', async () => {
      const messageWithoutContext: ErrorMessage = {
        type: 'error',
        clientId: 'test-client-123',
        error: 'Generic error',
      };

      mockClientManager.isConnected.mockReturnValue(true);
      mockClientService.recordClientStatus.mockResolvedValue(undefined as any);
      mockClientService.updateClient.mockResolvedValue(undefined as any);

      await handleError(mockWs, messageWithoutContext);

      expect(mockClientService.recordClientStatus).toHaveBeenCalled();
    });

    it('should handle database errors silently', async () => {
      mockClientManager.isConnected.mockReturnValue(true);
      mockClientService.recordClientStatus.mockRejectedValue(new Error('DB error'));

      await handleError(mockWs, validMessage);

      // Should not throw, just log error
      expect(mockClientService.recordClientStatus).toHaveBeenCalled();
    });
  });

  describe('sendPlaylistToClient', () => {
    it('should send playlist with media items to client', async () => {
      const mockPlaylist = {
        id: 5,
        name: 'Test Playlist',
        description: 'A test playlist',
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z',
        items: [
          {
            id: 1,
            playlist_id: 5,
            media_id: 10,
            order_index: 0,
            image_duration: 5,
            created_at: '2025-01-01T00:00:00.000Z',
            media: {
              id: 10,
              filename: 'video.mp4',
              original_filename: 'myvideo.mp4',
              filepath: 'media/video.mp4',
              type: 'video' as const,
              mime_type: 'video/mp4',
              file_size: 1024,
              duration: 120,
              width: 1920,
              height: 1080,
              checksum: 'abc123',
              created_at: '2025-01-01T00:00:00.000Z',
              updated_at: '2025-01-01T00:00:00.000Z',
            },
          },
        ],
      };

      mockPlaylistService.getPlaylistWithItems.mockResolvedValue(mockPlaylist);
      mockClientManager.sendToClient.mockReturnValue(true);

      await sendPlaylistToClient('test-client-123', 5);

      expect(mockPlaylistService.getPlaylistWithItems).toHaveBeenCalledWith(5);
      expect(mockClientManager.sendToClient).toHaveBeenCalledWith('test-client-123', {
        type: 'playlist_assigned',
        playlistId: 5,
        playlistName: 'Test Playlist',
        loopPlaylist: true,
        items: [
          {
            id: 1,
            mediaId: 10,
            filename: 'video.mp4',
            downloadUrl: expect.stringContaining('/api/media/10/download'),
            type: 'video',
            duration: 120,
            checksum: 'abc123',
            orderIndex: 0,
            imageDuration: 5,
          },
        ],
      });
    });

    it('should handle image items with image_duration', async () => {
      const mockPlaylist = {
        id: 5,
        name: 'Image Playlist',
        description: null,
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z',
        items: [
          {
            id: 1,
            playlist_id: 5,
            media_id: 20,
            order_index: 0,
            image_duration: 10,
            created_at: '2025-01-01T00:00:00.000Z',
            media: {
              id: 20,
              filename: 'image.jpg',
              original_filename: 'photo.jpg',
              filepath: 'media/image.jpg',
              type: 'image' as const,
              mime_type: 'image/jpeg',
              file_size: 512,
              duration: null,
              width: 1920,
              height: 1080,
              checksum: 'def456',
              created_at: '2025-01-01T00:00:00.000Z',
              updated_at: '2025-01-01T00:00:00.000Z',
            },
          },
        ],
      };

      mockPlaylistService.getPlaylistWithItems.mockResolvedValue(mockPlaylist);
      mockClientManager.sendToClient.mockReturnValue(true);

      await sendPlaylistToClient('test-client-123', 5);

      expect(mockClientManager.sendToClient).toHaveBeenCalledWith('test-client-123', {
        type: 'playlist_assigned',
        playlistId: 5,
        playlistName: 'Image Playlist',
        loopPlaylist: true,
        items: [
          expect.objectContaining({
            type: 'image',
            duration: 10, // Should use image_duration
          }),
        ],
      });
    });

    it('should handle errors when loading playlist', async () => {
      mockPlaylistService.getPlaylistWithItems.mockRejectedValue(
        new Error('Playlist not found')
      );

      await sendPlaylistToClient('test-client-123', 999);

      expect(mockClientManager.sendError).toHaveBeenCalledWith(
        'test-client-123',
        'Playlist not found'
      );
    });

    it('should log warning if client is not connected', async () => {
      const mockPlaylist = {
        id: 5,
        name: 'Test',
        description: null,
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z',
        items: [],
      };

      mockPlaylistService.getPlaylistWithItems.mockResolvedValue(mockPlaylist);
      mockClientManager.sendToClient.mockReturnValue(false);

      await sendPlaylistToClient('test-client-123', 5);

      // Should still attempt to send
      expect(mockClientManager.sendToClient).toHaveBeenCalled();
    });
  });

  describe('broadcastPlaylistUpdate', () => {
    it('should broadcast playlist to all assigned clients', async () => {
      const mockPlaylist = {
        id: 5,
        name: 'Updated Playlist',
        description: null,
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z',
        items: [],
      };

      mockPlaylistService.getPlaylistWithItems.mockResolvedValue(mockPlaylist);
      mockClientManager.broadcastToPlaylist.mockResolvedValue(3);

      await broadcastPlaylistUpdate(5);

      expect(mockPlaylistService.getPlaylistWithItems).toHaveBeenCalledWith(5);
      expect(mockClientManager.broadcastToPlaylist).toHaveBeenCalledWith(5, {
        type: 'playlist_updated',
        playlistId: 5,
        loopPlaylist: true,
        items: [],
      });
    });

    it('should handle errors during broadcast', async () => {
      mockPlaylistService.getPlaylistWithItems.mockRejectedValue(
        new Error('Database error')
      );

      await broadcastPlaylistUpdate(5);

      // Should not throw, just log error
      expect(mockPlaylistService.getPlaylistWithItems).toHaveBeenCalled();
    });
  });

  describe('sendCommandToClient', () => {
    it('should send reload_playlist command to client', () => {
      mockClientManager.sendToClient.mockReturnValue(true);

      const result = sendCommandToClient('test-client-123', 'reload_playlist');

      expect(mockClientManager.sendToClient).toHaveBeenCalledWith('test-client-123', {
        type: 'command',
        command: 'reload_playlist',
      });
      expect(result).toBe(true);
    });

    it('should send pause command to client', () => {
      mockClientManager.sendToClient.mockReturnValue(true);

      const result = sendCommandToClient('test-client-123', 'pause');

      expect(mockClientManager.sendToClient).toHaveBeenCalledWith('test-client-123', {
        type: 'command',
        command: 'pause',
      });
      expect(result).toBe(true);
    });

    it('should send resume command to client', () => {
      mockClientManager.sendToClient.mockReturnValue(true);

      const result = sendCommandToClient('test-client-123', 'resume');

      expect(mockClientManager.sendToClient).toHaveBeenCalledWith('test-client-123', {
        type: 'command',
        command: 'resume',
      });
      expect(result).toBe(true);
    });

    it('should return false if send fails', () => {
      mockClientManager.sendToClient.mockReturnValue(false);

      const result = sendCommandToClient('test-client-123', 'pause');

      expect(result).toBe(false);
    });
  });

  describe('broadcastCommand', () => {
    it('should broadcast pause command to all clients', () => {
      mockClientManager.broadcastToAll.mockReturnValue(5);

      const result = broadcastCommand('pause');

      expect(mockClientManager.broadcastToAll).toHaveBeenCalledWith({
        type: 'command',
        command: 'pause',
      });
      expect(result).toBe(5);
    });

    it('should broadcast resume command to all clients', () => {
      mockClientManager.broadcastToAll.mockReturnValue(3);

      const result = broadcastCommand('resume');

      expect(result).toBe(3);
    });

    it('should broadcast reload_playlist command to all clients', () => {
      mockClientManager.broadcastToAll.mockReturnValue(10);

      const result = broadcastCommand('reload_playlist');

      expect(result).toBe(10);
    });
  });
});
