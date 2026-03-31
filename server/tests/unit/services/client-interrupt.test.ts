/**
 * Client Interrupt/Resume Tests
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
  assigned_playlist_id: 1,
  interrupted_from_playlist_id: null as number | null,
  status: 'online' as const,
  last_seen: '2026-01-01T00:00:00.000Z',
  version: '1.0.0',
  capabilities: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const mockPlaylist = {
  id: 2,
  name: 'Emergency Announcement',
  description: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

describe('Client Interrupt/Resume', () => {
  beforeEach(() => {
    (getDatabase as jest.Mock).mockResolvedValue(mockDb);
  });

  describe('interruptWithPlaylist', () => {
    it('should interrupt and save previous playlist', async () => {
      mockDb.getClientById.mockResolvedValue({ ...mockClient, assigned_playlist_id: 1 });
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.updateClient.mockResolvedValue({
        ...mockClient,
        assigned_playlist_id: 2,
        interrupted_from_playlist_id: 1,
      });

      const result = await clientService.interruptWithPlaylist(mockClient.id, 2);
      expect(result.assigned_playlist_id).toBe(2);
      expect(result.interrupted_from_playlist_id).toBe(1);
      expect(mockDb.updateClient).toHaveBeenCalledWith(mockClient.id, {
        assigned_playlist_id: 2,
        interrupted_from_playlist_id: 1,
      });
    });

    it('should preserve existing interrupted_from if already interrupted', async () => {
      // Already interrupted from playlist 1, now interrupting with playlist 3
      mockDb.getClientById.mockResolvedValue({
        ...mockClient,
        assigned_playlist_id: 2,
        interrupted_from_playlist_id: 1,
      });
      mockDb.getPlaylistById.mockResolvedValue({ ...mockPlaylist, id: 3 });
      mockDb.updateClient.mockResolvedValue({
        ...mockClient,
        assigned_playlist_id: 3,
        interrupted_from_playlist_id: 1,
      });

      const result = await clientService.interruptWithPlaylist(mockClient.id, 3);
      // Should keep the original interrupted_from (1), not the current (2)
      expect(mockDb.updateClient).toHaveBeenCalledWith(mockClient.id, {
        assigned_playlist_id: 3,
        interrupted_from_playlist_id: 1,
      });
    });

    it('should throw if playlist not found', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.getPlaylistById.mockResolvedValue(null);

      await expect(
        clientService.interruptWithPlaylist(mockClient.id, 999),
      ).rejects.toThrow(AppError);
    });

    it('should throw if client not found', async () => {
      mockDb.getClientById.mockResolvedValue(null);

      await expect(
        clientService.interruptWithPlaylist('nonexistent', 2),
      ).rejects.toThrow(AppError);
    });
  });

  describe('resumeFromInterrupt', () => {
    it('should resume to previous playlist', async () => {
      mockDb.getClientById.mockResolvedValue({
        ...mockClient,
        assigned_playlist_id: 2,
        interrupted_from_playlist_id: 1,
      });
      mockDb.updateClient.mockResolvedValue({
        ...mockClient,
        assigned_playlist_id: 1,
        interrupted_from_playlist_id: null,
      });

      const result = await clientService.resumeFromInterrupt(mockClient.id);
      expect(result.assigned_playlist_id).toBe(1);
      expect(result.interrupted_from_playlist_id).toBeNull();
      expect(mockDb.updateClient).toHaveBeenCalledWith(mockClient.id, {
        assigned_playlist_id: 1,
        interrupted_from_playlist_id: null,
      });
    });

    it('should throw if not interrupted', async () => {
      mockDb.getClientById.mockResolvedValue({
        ...mockClient,
        interrupted_from_playlist_id: null,
      });

      await expect(
        clientService.resumeFromInterrupt(mockClient.id),
      ).rejects.toThrow(AppError);
    });
  });
});
