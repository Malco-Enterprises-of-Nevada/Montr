/**
 * Unit tests for ClientService
 */

import { ClientService } from '../../../src/services/client.service';
import { getDatabase } from '../../../src/database/connection';
import { AppError, ErrorCode } from '../../../src/api/middleware/error-handler';
import { createMockDatabase } from '../../utils/database.mock';
import {
  mockClient,
  mockClient2,
  mockClients,
  mockClientId,
  mockClientStatus,
  mockClientWithStatus,
  mockCreateClientInput,
  mockUpdateClientInput,
  mockClientStatusInput,
  mockClientStatusInputWithError,
} from '../../fixtures/client.fixtures';
import { mockPlaylist } from '../../fixtures/playlist.fixtures';

// Mock dependencies
jest.mock('../../../src/database/connection');

describe('ClientService', () => {
  let clientService: ClientService;
  let mockDb: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = createMockDatabase();
    (getDatabase as jest.Mock).mockResolvedValue(mockDb);
    clientService = new ClientService();
  });

  describe('registerClient', () => {
    it('should register a new client successfully', async () => {
      mockDb.getClientById.mockResolvedValue(null);
      mockDb.createClient.mockResolvedValue(mockClient);

      const result = await clientService.registerClient(mockCreateClientInput);

      expect(result).toEqual(mockClient);
      expect(mockDb.createClient).toHaveBeenCalledWith(mockCreateClientInput);
    });

    it('should throw error when client already exists', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);

      await expect(clientService.registerClient(mockCreateClientInput)).rejects.toThrow(AppError);
      await expect(clientService.registerClient(mockCreateClientInput)).rejects.toMatchObject({
        code: ErrorCode.CLIENT_ALREADY_REGISTERED,
        statusCode: 409,
      });
    });
  });

  describe('getClientById', () => {
    it('should return client by ID', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);

      const result = await clientService.getClientById(mockClientId);

      expect(result).toEqual(mockClient);
      expect(mockDb.getClientById).toHaveBeenCalledWith(mockClientId);
    });

    it('should throw error when client not found', async () => {
      mockDb.getClientById.mockResolvedValue(null);

      await expect(clientService.getClientById('unknown-uuid')).rejects.toThrow(AppError);
      await expect(clientService.getClientById('unknown-uuid')).rejects.toMatchObject({
        code: ErrorCode.CLIENT_NOT_FOUND,
        statusCode: 404,
      });
    });
  });

  describe('getClientWithStatus', () => {
    it('should return client with latest status', async () => {
      mockDb.getClientWithStatus.mockResolvedValue(mockClientWithStatus);

      const result = await clientService.getClientWithStatus(mockClientId);

      expect(result).toEqual(mockClientWithStatus);
      expect(result).toHaveProperty('current_status');
      expect(mockDb.getClientWithStatus).toHaveBeenCalledWith(mockClientId);
    });

    it('should throw error when client not found', async () => {
      mockDb.getClientWithStatus.mockResolvedValue(null);

      await expect(clientService.getClientWithStatus('unknown-uuid')).rejects.toThrow(AppError);
    });
  });

  describe('getAllClients', () => {
    it('should return all clients without filters', async () => {
      mockDb.getAllClients.mockResolvedValue(mockClients);

      const result = await clientService.getAllClients();

      expect(result).toEqual(mockClients);
      expect(result).toHaveLength(2);
      expect(mockDb.getAllClients).toHaveBeenCalledWith(undefined);
    });

    it('should filter clients by status', async () => {
      mockDb.getAllClients.mockResolvedValue([mockClient]);

      const result = await clientService.getAllClients({ status: 'online' });

      expect(result).toHaveLength(1);
      expect(mockDb.getAllClients).toHaveBeenCalledWith({ status: 'online' });
    });

    it('should filter clients by assigned playlist', async () => {
      mockDb.getAllClients.mockResolvedValue([mockClient]);

      const result = await clientService.getAllClients({ assigned_playlist_id: 1 });

      expect(result).toHaveLength(1);
      expect(mockDb.getAllClients).toHaveBeenCalledWith({ assigned_playlist_id: 1 });
    });

    it('should return empty array when no clients exist', async () => {
      mockDb.getAllClients.mockResolvedValue([]);

      const result = await clientService.getAllClients();

      expect(result).toEqual([]);
    });
  });

  describe('updateClient', () => {
    it('should update client successfully', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist); // Mock playlist check
      mockDb.updateClient.mockResolvedValue({ ...mockClient, ...mockUpdateClientInput });

      const result = await clientService.updateClient(mockClientId, mockUpdateClientInput);

      expect(result.name).toBe(mockUpdateClientInput.name);
      expect(mockDb.updateClient).toHaveBeenCalledWith(mockClientId, mockUpdateClientInput);
    });

    it('should verify playlist exists when assigning', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.updateClient.mockResolvedValue({ ...mockClient, assigned_playlist_id: 1 });

      await clientService.updateClient(mockClientId, { assigned_playlist_id: 1 });

      expect(mockDb.getPlaylistById).toHaveBeenCalledWith(1);
      expect(mockDb.updateClient).toHaveBeenCalled();
    });

    it('should throw error when assigning non-existent playlist', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.getPlaylistById.mockResolvedValue(null);

      await expect(
        clientService.updateClient(mockClientId, { assigned_playlist_id: 999 })
      ).rejects.toThrow(AppError);
      await expect(
        clientService.updateClient(mockClientId, { assigned_playlist_id: 999 })
      ).rejects.toMatchObject({
        code: ErrorCode.PLAYLIST_NOT_FOUND,
      });
    });

    it('should allow unassigning playlist with null', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.updateClient.mockResolvedValue({ ...mockClient, assigned_playlist_id: null });

      await clientService.updateClient(mockClientId, { assigned_playlist_id: null });

      expect(mockDb.getPlaylistById).not.toHaveBeenCalled();
      expect(mockDb.updateClient).toHaveBeenCalledWith(mockClientId, { assigned_playlist_id: null });
    });

    it('should throw error when updating non-existent client', async () => {
      mockDb.getClientById.mockResolvedValue(null);

      await expect(clientService.updateClient('unknown-uuid', mockUpdateClientInput)).rejects.toThrow(
        AppError
      );
    });
  });

  describe('unregisterClient', () => {
    it('should unregister client successfully', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.deleteClient.mockResolvedValue(undefined);

      await clientService.unregisterClient(mockClientId);

      expect(mockDb.deleteClient).toHaveBeenCalledWith(mockClientId);
    });

    it('should throw error when unregistering non-existent client', async () => {
      mockDb.getClientById.mockResolvedValue(null);

      await expect(clientService.unregisterClient('unknown-uuid')).rejects.toThrow(AppError);
    });
  });

  describe('updateHeartbeat', () => {
    it('should update client heartbeat and status', async () => {
      mockDb.updateClient.mockResolvedValue({ ...mockClient, status: 'online' });

      await clientService.updateHeartbeat(mockClientId);

      expect(mockDb.updateClient).toHaveBeenCalledWith(
        mockClientId,
        expect.objectContaining({
          status: 'online',
          last_seen: expect.any(String),
        })
      );
    });
  });

  describe('recordClientStatus', () => {
    it('should record client status successfully', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.createClientStatus.mockResolvedValue(mockClientStatus);
      mockDb.updateClient.mockResolvedValue({ ...mockClient, status: 'online' });

      const result = await clientService.recordClientStatus(mockClientStatusInput);

      expect(result).toEqual(mockClientStatus);
      expect(mockDb.createClientStatus).toHaveBeenCalledWith(mockClientStatusInput);
      expect(mockDb.updateClient).toHaveBeenCalledWith(
        mockClientId,
        expect.objectContaining({
          status: 'online',
          last_seen: expect.any(String),
        })
      );
    });

    it('should set client status to error when error message present', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.createClientStatus.mockResolvedValue({
        ...mockClientStatus,
        error_message: 'Test error',
      });
      mockDb.updateClient.mockResolvedValue({ ...mockClient, status: 'error' });

      await clientService.recordClientStatus(mockClientStatusInputWithError);

      expect(mockDb.updateClient).toHaveBeenCalledWith(
        mockClientId,
        expect.objectContaining({
          status: 'error',
        })
      );
    });

    it('should throw error when client not found', async () => {
      mockDb.getClientById.mockResolvedValue(null);

      await expect(clientService.recordClientStatus(mockClientStatusInput)).rejects.toThrow(AppError);
    });
  });

  describe('getLatestClientStatus', () => {
    it('should return latest client status', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.getLatestClientStatus.mockResolvedValue(mockClientStatus);

      const result = await clientService.getLatestClientStatus(mockClientId);

      expect(result).toEqual(mockClientStatus);
      expect(mockDb.getLatestClientStatus).toHaveBeenCalledWith(mockClientId);
    });

    it('should return null when no status exists', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.getLatestClientStatus.mockResolvedValue(null);

      const result = await clientService.getLatestClientStatus(mockClientId);

      expect(result).toBeNull();
    });

    it('should throw error when client not found', async () => {
      mockDb.getClientById.mockResolvedValue(null);

      await expect(clientService.getLatestClientStatus('unknown-uuid')).rejects.toThrow(AppError);
    });
  });

  describe('assignPlaylist', () => {
    it('should assign playlist to client', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.updateClient.mockResolvedValue({ ...mockClient, assigned_playlist_id: 1 });

      const result = await clientService.assignPlaylist(mockClientId, 1);

      expect(result.assigned_playlist_id).toBe(1);
      expect(mockDb.getPlaylistById).toHaveBeenCalledWith(1);
    });

    it('should unassign playlist with null', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.updateClient.mockResolvedValue({ ...mockClient, assigned_playlist_id: null });

      const result = await clientService.assignPlaylist(mockClientId, null);

      expect(result.assigned_playlist_id).toBeNull();
      expect(mockDb.getPlaylistById).not.toHaveBeenCalled();
    });

    it('should throw error when playlist not found', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.getPlaylistById.mockResolvedValue(null);

      await expect(clientService.assignPlaylist(mockClientId, 999)).rejects.toThrow(AppError);
    });
  });

  describe('markOfflineClients', () => {
    it('should mark clients offline after timeout', async () => {
      const oldTimestamp = new Date(Date.now() - 200000).toISOString(); // 200 seconds ago
      const onlineClient = { ...mockClient, last_seen: oldTimestamp };

      mockDb.getAllClients.mockResolvedValue([onlineClient]);
      mockDb.updateClient.mockResolvedValue({ ...onlineClient, status: 'offline' });

      const result = await clientService.markOfflineClients(120000); // 2 minute timeout

      expect(result).toBe(1);
      expect(mockDb.updateClient).toHaveBeenCalledWith(mockClientId, { status: 'offline' });
    });

    it('should not mark recently active clients offline', async () => {
      const recentTimestamp = new Date(Date.now() - 30000).toISOString(); // 30 seconds ago
      const onlineClient = { ...mockClient, last_seen: recentTimestamp };

      mockDb.getAllClients.mockResolvedValue([onlineClient]);

      const result = await clientService.markOfflineClients(120000);

      expect(result).toBe(0);
      expect(mockDb.updateClient).not.toHaveBeenCalled();
    });

    it('should handle clients with null last_seen', async () => {
      const clientWithoutLastSeen = { ...mockClient, last_seen: null };

      mockDb.getAllClients.mockResolvedValue([clientWithoutLastSeen]);

      const result = await clientService.markOfflineClients(120000);

      expect(result).toBe(0);
      expect(mockDb.updateClient).not.toHaveBeenCalled();
    });

    it('should return zero when no online clients', async () => {
      mockDb.getAllClients.mockResolvedValue([]);

      const result = await clientService.markOfflineClients();

      expect(result).toBe(0);
    });
  });

  describe('getClientStats', () => {
    it('should return client statistics', async () => {
      const clientsWithStatus = [
        { ...mockClient, status: 'online' as const },
        { ...mockClient2, status: 'offline' as const },
        { ...mockClient, id: 'test-3', status: 'error' as const },
      ];
      mockDb.getAllClients.mockResolvedValue(clientsWithStatus);

      const result = await clientService.getClientStats();

      expect(result).toEqual({
        total: 3,
        online: 1,
        offline: 1,
        error: 1,
      });
    });

    it('should return zero stats when no clients exist', async () => {
      mockDb.getAllClients.mockResolvedValue([]);

      const result = await clientService.getClientStats();

      expect(result).toEqual({
        total: 0,
        online: 0,
        offline: 0,
        error: 0,
      });
    });
  });
});
