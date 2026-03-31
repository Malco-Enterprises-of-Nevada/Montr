/**
 * Client Multi-Playlist & Priority Resolution Tests
 */

import { ClientService } from '../../../src/services/client.service';
import { getDatabase } from '../../../src/database/connection';
import { AppError } from '../../../src/api/middleware/error-handler';
import { DatabaseAdapter } from '../../../src/database/adapters/base.adapter';

jest.mock('../../../src/database/connection');

const mockDb: jest.Mocked<DatabaseAdapter> = {
  connect: jest.fn(),
  disconnect: jest.fn(),
  isConnected: jest.fn(),
  createMedia: jest.fn(),
  getMediaById: jest.fn(),
  getAllMedia: jest.fn(),
  updateMedia: jest.fn(),
  deleteMedia: jest.fn(),
  getMediaByChecksum: jest.fn(),
  createPlaylist: jest.fn(),
  getPlaylistById: jest.fn(),
  getPlaylistWithItems: jest.fn(),
  getAllPlaylists: jest.fn(),
  updatePlaylist: jest.fn(),
  deletePlaylist: jest.fn(),
  addPlaylistItem: jest.fn(),
  getPlaylistItems: jest.fn(),
  getPlaylistItemById: jest.fn(),
  updatePlaylistItem: jest.fn(),
  deletePlaylistItem: jest.fn(),
  reorderPlaylistItems: jest.fn(),
  createClient: jest.fn(),
  getClientById: jest.fn(),
  getAllClients: jest.fn(),
  updateClient: jest.fn(),
  deleteClient: jest.fn(),
  createClientStatus: jest.fn(),
  getLatestClientStatus: jest.fn(),
  getClientWithStatus: jest.fn(),
  createClientGroup: jest.fn(),
  getClientGroupById: jest.fn(),
  getClientGroupWithMembers: jest.fn(),
  getAllClientGroups: jest.fn(),
  updateClientGroup: jest.fn(),
  deleteClientGroup: jest.fn(),
  addClientToGroup: jest.fn(),
  removeClientFromGroup: jest.fn(),
  getGroupMembers: jest.fn(),
  getClientGroups: jest.fn(),
  createSchedule: jest.fn(),
  getScheduleById: jest.fn(),
  getAllSchedules: jest.fn(),
  updateSchedule: jest.fn(),
  deleteSchedule: jest.fn(),
  getEnabledSchedules: jest.fn(),
  addClientPlaylist: jest.fn(),
  removeClientPlaylist: jest.fn(),
  getClientPlaylists: jest.fn(),
  updateClientPlaylistPriority: jest.fn(),
};

const clientService = new ClientService();

const mockClient = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  name: 'Display-01',
  assigned_playlist_id: null as number | null,
  interrupted_from_playlist_id: null,
  status: 'online' as const,
  last_seen: '2026-01-01T00:00:00.000Z',
  version: '1.0.0',
  capabilities: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const mockPlaylist1 = {
  id: 1,
  name: 'Morning',
  description: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const mockPlaylist2 = {
  id: 2,
  name: 'Evening',
  description: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

describe('Client Multi-Playlist', () => {
  beforeEach(() => {
    (getDatabase as jest.Mock).mockResolvedValue(mockDb);
  });

  describe('addPlaylistAssignment', () => {
    it('should add a playlist and resolve active', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist1);
      mockDb.addClientPlaylist.mockResolvedValue({
        id: 1,
        client_id: mockClient.id,
        playlist_id: 1,
        priority: 50,
        assigned_at: '2026-01-01T00:00:00.000Z',
      });
      mockDb.getClientPlaylists.mockResolvedValue([
        {
          id: 1,
          client_id: mockClient.id,
          playlist_id: 1,
          priority: 50,
          assigned_at: '2026-01-01T00:00:00.000Z',
          playlist_name: 'Morning',
        },
      ]);
      mockDb.updateClient.mockResolvedValue({ ...mockClient, assigned_playlist_id: 1 });

      const result = await clientService.addPlaylistAssignment(mockClient.id, 1, 50);
      expect(result.playlist_id).toBe(1);
      expect(mockDb.updateClient).toHaveBeenCalledWith(mockClient.id, {
        assigned_playlist_id: 1,
      });
    });

    it('should throw if playlist not found', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.getPlaylistById.mockResolvedValue(null);

      await expect(
        clientService.addPlaylistAssignment(mockClient.id, 999),
      ).rejects.toThrow(AppError);
    });
  });

  describe('resolveActivePlaylist', () => {
    it('should pick highest priority playlist', async () => {
      mockDb.getClientPlaylists.mockResolvedValue([
        {
          id: 2,
          client_id: mockClient.id,
          playlist_id: 2,
          priority: 80,
          assigned_at: '2026-01-01T00:00:00.000Z',
          playlist_name: 'Evening',
        },
        {
          id: 1,
          client_id: mockClient.id,
          playlist_id: 1,
          priority: 50,
          assigned_at: '2026-01-01T00:00:00.000Z',
          playlist_name: 'Morning',
        },
      ]);
      mockDb.updateClient.mockResolvedValue({ ...mockClient, assigned_playlist_id: 2 });

      const result = await clientService.resolveActivePlaylist(mockClient.id);
      expect(result).toBe(2);
      expect(mockDb.updateClient).toHaveBeenCalledWith(mockClient.id, {
        assigned_playlist_id: 2,
      });
    });

    it('should set null when no playlists assigned', async () => {
      mockDb.getClientPlaylists.mockResolvedValue([]);
      mockDb.updateClient.mockResolvedValue({ ...mockClient, assigned_playlist_id: null });

      const result = await clientService.resolveActivePlaylist(mockClient.id);
      expect(result).toBeNull();
      expect(mockDb.updateClient).toHaveBeenCalledWith(mockClient.id, {
        assigned_playlist_id: null,
      });
    });
  });

  describe('removePlaylistAssignment', () => {
    it('should remove and re-resolve', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.removeClientPlaylist.mockResolvedValue();
      mockDb.getClientPlaylists.mockResolvedValue([
        {
          id: 1,
          client_id: mockClient.id,
          playlist_id: 1,
          priority: 50,
          assigned_at: '2026-01-01T00:00:00.000Z',
          playlist_name: 'Morning',
        },
      ]);
      mockDb.updateClient.mockResolvedValue({ ...mockClient, assigned_playlist_id: 1 });

      await clientService.removePlaylistAssignment(mockClient.id, 2);

      expect(mockDb.removeClientPlaylist).toHaveBeenCalledWith(mockClient.id, 2);
      expect(mockDb.updateClient).toHaveBeenCalledWith(mockClient.id, {
        assigned_playlist_id: 1,
      });
    });
  });

  describe('updatePlaylistPriority', () => {
    it('should update priority and re-resolve', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.updateClientPlaylistPriority.mockResolvedValue({
        id: 1,
        client_id: mockClient.id,
        playlist_id: 1,
        priority: 90,
        assigned_at: '2026-01-01T00:00:00.000Z',
      });
      mockDb.getClientPlaylists.mockResolvedValue([
        {
          id: 1,
          client_id: mockClient.id,
          playlist_id: 1,
          priority: 90,
          assigned_at: '2026-01-01T00:00:00.000Z',
          playlist_name: 'Morning',
        },
      ]);
      mockDb.updateClient.mockResolvedValue({ ...mockClient, assigned_playlist_id: 1 });

      const result = await clientService.updatePlaylistPriority(mockClient.id, 1, 90);
      expect(result.priority).toBe(90);
    });
  });

  describe('getPlaylistAssignments', () => {
    it('should return assignments ordered by priority', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.getClientPlaylists.mockResolvedValue([
        {
          id: 2,
          client_id: mockClient.id,
          playlist_id: 2,
          priority: 80,
          assigned_at: '2026-01-01T00:00:00.000Z',
          playlist_name: 'Evening',
        },
        {
          id: 1,
          client_id: mockClient.id,
          playlist_id: 1,
          priority: 50,
          assigned_at: '2026-01-01T00:00:00.000Z',
          playlist_name: 'Morning',
        },
      ]);

      const result = await clientService.getPlaylistAssignments(mockClient.id);
      expect(result).toHaveLength(2);
      expect(result[0].priority).toBeGreaterThan(result[1].priority);
    });
  });
});
