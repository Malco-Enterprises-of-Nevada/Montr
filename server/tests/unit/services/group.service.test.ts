/**
 * Group Service Tests
 */

import { GroupService } from '../../../src/services/group.service';
import { getDatabase } from '../../../src/database/connection';
import { AppError, ErrorCode } from '../../../src/api/middleware/error-handler';
import { DatabaseAdapter } from '../../../src/database/adapters/base.adapter';
import { mockVideoFile } from '../../fixtures/media.fixtures';

// Mock the database connection
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
};

const groupService = new GroupService();

const mockGroup = {
  id: 1,
  name: 'Lobby Displays',
  description: 'All displays in the lobby',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const mockClient = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  name: 'Display-01',
  assigned_playlist_id: null,
  interrupted_from_playlist_id: null,
  status: 'online' as const,
  last_seen: '2026-01-01T00:00:00.000Z',
  version: '1.0.0',
  capabilities: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

describe('GroupService', () => {
  beforeEach(() => {
    (getDatabase as jest.Mock).mockResolvedValue(mockDb);
  });

  describe('createGroup', () => {
    it('should create a group', async () => {
      mockDb.createClientGroup.mockResolvedValue(mockGroup);

      const result = await groupService.createGroup({
        name: 'Lobby Displays',
        description: 'All displays in the lobby',
      });

      expect(result).toEqual(mockGroup);
      expect(mockDb.createClientGroup).toHaveBeenCalledWith({
        name: 'Lobby Displays',
        description: 'All displays in the lobby',
      });
    });
  });

  describe('getGroupById', () => {
    it('should return a group', async () => {
      mockDb.getClientGroupById.mockResolvedValue(mockGroup);

      const result = await groupService.getGroupById(1);
      expect(result).toEqual(mockGroup);
    });

    it('should throw if group not found', async () => {
      mockDb.getClientGroupById.mockResolvedValue(null);

      await expect(groupService.getGroupById(999)).rejects.toThrow(AppError);
    });
  });

  describe('getGroupWithMembers', () => {
    it('should return group with members', async () => {
      mockDb.getClientGroupWithMembers.mockResolvedValue({
        ...mockGroup,
        members: [mockClient],
      });

      const result = await groupService.getGroupWithMembers(1);
      expect(result.name).toBe('Lobby Displays');
      expect(result.members).toHaveLength(1);
    });
  });

  describe('getAllGroups', () => {
    it('should return all groups', async () => {
      mockDb.getAllClientGroups.mockResolvedValue([mockGroup]);

      const result = await groupService.getAllGroups();
      expect(result).toHaveLength(1);
    });
  });

  describe('updateGroup', () => {
    it('should update a group', async () => {
      mockDb.getClientGroupById.mockResolvedValue(mockGroup);
      mockDb.updateClientGroup.mockResolvedValue({ ...mockGroup, name: 'Updated' });

      const result = await groupService.updateGroup(1, { name: 'Updated' });
      expect(result.name).toBe('Updated');
    });
  });

  describe('deleteGroup', () => {
    it('should delete a group', async () => {
      mockDb.getClientGroupById.mockResolvedValue(mockGroup);
      mockDb.deleteClientGroup.mockResolvedValue();

      await expect(groupService.deleteGroup(1)).resolves.toBeUndefined();
    });
  });

  describe('addMember', () => {
    it('should add a client to a group', async () => {
      mockDb.getClientGroupById.mockResolvedValue(mockGroup);
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.getGroupMembers.mockResolvedValue([]);
      mockDb.addClientToGroup.mockResolvedValue({
        id: 1,
        group_id: 1,
        client_id: mockClient.id,
        added_at: '2026-01-01T00:00:00.000Z',
      });

      const result = await groupService.addMember(1, mockClient.id);
      expect(result.group_id).toBe(1);
      expect(result.client_id).toBe(mockClient.id);
    });

    it('should throw if client not found', async () => {
      mockDb.getClientGroupById.mockResolvedValue(mockGroup);
      mockDb.getClientById.mockResolvedValue(null);

      await expect(groupService.addMember(1, 'nonexistent')).rejects.toThrow(AppError);
    });
  });

  describe('assignPlaylistToGroup', () => {
    it('should assign playlist to all group members', async () => {
      mockDb.getClientGroupById.mockResolvedValue(mockGroup);
      mockDb.getPlaylistById.mockResolvedValue({
        id: 1,
        name: 'Test Playlist',
        description: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });
      mockDb.getGroupMembers.mockResolvedValue([mockClient]);
      mockDb.updateClient.mockResolvedValue({
        ...mockClient,
        assigned_playlist_id: 1,
      });

      const result = await groupService.assignPlaylistToGroup(1, 1);
      expect(result.updated).toBe(1);
      expect(result.clients).toHaveLength(1);
      expect(mockDb.updateClient).toHaveBeenCalledWith(mockClient.id, {
        assigned_playlist_id: 1,
      });
    });

    it('should throw if playlist not found', async () => {
      mockDb.getClientGroupById.mockResolvedValue(mockGroup);
      mockDb.getPlaylistById.mockResolvedValue(null);

      await expect(groupService.assignPlaylistToGroup(1, 999)).rejects.toThrow(AppError);
    });
  });
});
