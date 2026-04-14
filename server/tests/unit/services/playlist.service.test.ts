/**
 * Unit tests for PlaylistService
 */

import { PlaylistService } from '../../../src/services/playlist.service';
import { getDatabase } from '../../../src/database/connection';
import { AppError, ErrorCode } from '../../../src/api/middleware/error-handler';
import { config } from '../../../src/config/config';
import { createMockDatabase } from '../../utils/database.mock';
import {
  mockPlaylist,
  mockPlaylists,
  mockPlaylistWithItems,
  mockPlaylistItems,
  mockPlaylistItem1,
  mockCreatePlaylistInput,
  mockUpdatePlaylistInput,
  mockEmptyPlaylist,
} from '../../fixtures/playlist.fixtures';
import { mockVideoFile, mockImageFile } from '../../fixtures/media.fixtures';

// Mock dependencies
jest.mock('../../../src/database/connection');

describe('PlaylistService', () => {
  let playlistService: PlaylistService;
  let mockDb: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = createMockDatabase();
    (getDatabase as jest.Mock).mockResolvedValue(mockDb);
    playlistService = new PlaylistService();
  });

  describe('createPlaylist', () => {
    it('should create a new playlist successfully', async () => {
      mockDb.createPlaylist.mockResolvedValue(mockPlaylist);

      const result = await playlistService.createPlaylist(mockCreatePlaylistInput);

      expect(result).toEqual(mockPlaylist);
      expect(mockDb.createPlaylist).toHaveBeenCalledWith(mockCreatePlaylistInput);
    });

    it('should create a playlist without description', async () => {
      const inputWithoutDesc = { name: 'Test Playlist' };
      mockDb.createPlaylist.mockResolvedValue({ ...mockPlaylist, description: null });

      const result = await playlistService.createPlaylist(inputWithoutDesc);

      expect(result.description).toBeNull();
      expect(mockDb.createPlaylist).toHaveBeenCalledWith(inputWithoutDesc);
    });
  });

  describe('getPlaylistById', () => {
    it('should return playlist by ID', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);

      const result = await playlistService.getPlaylistById(1);

      expect(result).toEqual(mockPlaylist);
      expect(mockDb.getPlaylistById).toHaveBeenCalledWith(1);
    });

    it('should throw error when playlist not found', async () => {
      mockDb.getPlaylistById.mockResolvedValue(null);

      await expect(playlistService.getPlaylistById(999)).rejects.toThrow(AppError);
      await expect(playlistService.getPlaylistById(999)).rejects.toMatchObject({
        code: ErrorCode.PLAYLIST_NOT_FOUND,
        statusCode: 404,
      });
    });
  });

  describe('getPlaylistWithItems', () => {
    it('should return playlist with all items', async () => {
      mockDb.getPlaylistWithItems.mockResolvedValue(mockPlaylistWithItems);

      const result = await playlistService.getPlaylistWithItems(1);

      expect(result).toEqual(mockPlaylistWithItems);
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toHaveProperty('media');
      expect(mockDb.getPlaylistWithItems).toHaveBeenCalledWith(1);
    });

    it('should return empty items array for playlist with no items', async () => {
      mockDb.getPlaylistWithItems.mockResolvedValue(mockEmptyPlaylist);

      const result = await playlistService.getPlaylistWithItems(1);

      expect(result.items).toHaveLength(0);
    });

    it('should throw error when playlist not found', async () => {
      mockDb.getPlaylistWithItems.mockResolvedValue(null);

      await expect(playlistService.getPlaylistWithItems(999)).rejects.toThrow(AppError);
      await expect(playlistService.getPlaylistWithItems(999)).rejects.toMatchObject({
        code: ErrorCode.PLAYLIST_NOT_FOUND,
      });
    });
  });

  describe('getAllPlaylists', () => {
    it('should return all playlists', async () => {
      mockDb.getAllPlaylists.mockResolvedValue(mockPlaylists);

      const result = await playlistService.getAllPlaylists();

      expect(result).toEqual(mockPlaylists);
      expect(result).toHaveLength(2);
      expect(mockDb.getAllPlaylists).toHaveBeenCalled();
    });

    it('should return empty array when no playlists exist', async () => {
      mockDb.getAllPlaylists.mockResolvedValue([]);

      const result = await playlistService.getAllPlaylists();

      expect(result).toEqual([]);
    });
  });

  describe('updatePlaylist', () => {
    it('should update playlist successfully', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.updatePlaylist.mockResolvedValue({ ...mockPlaylist, ...mockUpdatePlaylistInput });

      const result = await playlistService.updatePlaylist(1, mockUpdatePlaylistInput);

      expect(result.name).toBe(mockUpdatePlaylistInput.name);
      expect(result.description).toBe(mockUpdatePlaylistInput.description);
      expect(mockDb.updatePlaylist).toHaveBeenCalledWith(1, mockUpdatePlaylistInput);
    });

    it('should update only specified fields', async () => {
      const partialUpdate = { name: 'New Name Only' };
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.updatePlaylist.mockResolvedValue({ ...mockPlaylist, name: 'New Name Only' });

      const result = await playlistService.updatePlaylist(1, partialUpdate);

      expect(result.name).toBe('New Name Only');
      expect(mockDb.updatePlaylist).toHaveBeenCalledWith(1, partialUpdate);
    });

    it('should throw error when updating non-existent playlist', async () => {
      mockDb.getPlaylistById.mockResolvedValue(null);

      await expect(playlistService.updatePlaylist(999, mockUpdatePlaylistInput)).rejects.toThrow(
        AppError
      );
    });
  });

  describe('deletePlaylist', () => {
    it('should delete playlist successfully', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.deletePlaylist.mockResolvedValue(undefined);

      await playlistService.deletePlaylist(1);

      expect(mockDb.deletePlaylist).toHaveBeenCalledWith(1);
    });

    it('should throw error when deleting non-existent playlist', async () => {
      mockDb.getPlaylistById.mockResolvedValue(null);

      await expect(playlistService.deletePlaylist(999)).rejects.toThrow(AppError);
      await expect(playlistService.deletePlaylist(999)).rejects.toMatchObject({
        code: ErrorCode.PLAYLIST_NOT_FOUND,
      });
    });
  });

  describe('addPlaylistItem', () => {
    it('should add item to playlist successfully', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getMediaById.mockResolvedValue(mockVideoFile);
      mockDb.getPlaylistItems.mockResolvedValue([]);
      mockDb.addPlaylistItem.mockResolvedValue(mockPlaylistItem1);

      const result = await playlistService.addPlaylistItem({
        playlist_id: 1,
        media_id: 1,
        order_index: 0,
        image_duration: 5,
      });

      expect(result).toEqual(mockPlaylistItem1);
      expect(mockDb.addPlaylistItem).toHaveBeenCalled();
    });

    it('should auto-increment order_index when not provided', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getMediaById.mockResolvedValue(mockVideoFile);
      mockDb.getPlaylistItems.mockResolvedValue(mockPlaylistItems); // 2 existing items
      mockDb.addPlaylistItem.mockResolvedValue({ ...mockPlaylistItem1, order_index: 2 });

      await playlistService.addPlaylistItem({
        playlist_id: 1,
        media_id: 1,
        image_duration: 5,
      });

      expect(mockDb.addPlaylistItem).toHaveBeenCalledWith(
        expect.objectContaining({
          order_index: 2, // Should be auto-set to length of existing items
        })
      );
    });

    it('should throw error when playlist not found', async () => {
      mockDb.getPlaylistById.mockResolvedValue(null);

      await expect(
        playlistService.addPlaylistItem({
          playlist_id: 999,
          media_id: 1,
          order_index: 0,
          image_duration: 5,
        })
      ).rejects.toThrow(AppError);
    });

    it('should throw error when media not found', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getMediaById.mockResolvedValue(null);

      await expect(
        playlistService.addPlaylistItem({
          playlist_id: 1,
          media_id: 999,
          order_index: 0,
          image_duration: 5,
        })
      ).rejects.toThrow(AppError);
      await expect(
        playlistService.addPlaylistItem({
          playlist_id: 1,
          media_id: 999,
          order_index: 0,
          image_duration: 5,
        })
      ).rejects.toMatchObject({
        code: ErrorCode.MEDIA_NOT_FOUND,
      });
    });
  });

  describe('addPlaylistItems', () => {
    it('should add multiple items to playlist', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getMediaById.mockResolvedValueOnce(mockVideoFile).mockResolvedValueOnce(mockImageFile);
      mockDb.getPlaylistItems.mockResolvedValue([]);
      mockDb.addPlaylistItem
        .mockResolvedValueOnce(mockPlaylistItems[0])
        .mockResolvedValueOnce(mockPlaylistItems[1]);

      const result = await playlistService.addPlaylistItems(1, [1, 2]);

      expect(result).toHaveLength(2);
      expect(mockDb.addPlaylistItem).toHaveBeenCalledTimes(2);
    });

    it('should set sequential order indices', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getMediaById.mockResolvedValue(mockVideoFile);
      mockDb.getPlaylistItems.mockResolvedValue(mockPlaylistItems); // Start at index 2
      mockDb.addPlaylistItem.mockResolvedValue(mockPlaylistItem1);

      await playlistService.addPlaylistItems(1, [1, 2, 3]);

      expect(mockDb.addPlaylistItem).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ order_index: 2 })
      );
      expect(mockDb.addPlaylistItem).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ order_index: 3 })
      );
      expect(mockDb.addPlaylistItem).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({ order_index: 4 })
      );
    });

    it('should throw error if any media ID is invalid', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getMediaById.mockResolvedValueOnce(mockVideoFile).mockResolvedValueOnce(null);
      mockDb.getPlaylistItems.mockResolvedValue([]);

      await expect(playlistService.addPlaylistItems(1, [1, 999])).rejects.toThrow(AppError);
    });
  });

  describe('approval enforcement', () => {
    const approvedVideo = { ...mockVideoFile, approval_status: 'approved' as const };
    const rejectedVideo = { ...mockVideoFile, approval_status: 'rejected' as const };

    beforeEach(() => {
      config.content.requireMediaApproval = true;
    });

    afterEach(() => {
      config.content.requireMediaApproval = false;
    });

    it('addPlaylistItem rejects pending media when enforcement enabled', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getMediaById.mockResolvedValue(mockVideoFile); // pending

      await expect(
        playlistService.addPlaylistItem({
          playlist_id: 1,
          media_id: 1,
          order_index: 0,
          image_duration: 5,
        })
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST, statusCode: 400 });
      expect(mockDb.addPlaylistItem).not.toHaveBeenCalled();
    });

    it('addPlaylistItem rejects rejected media when enforcement enabled', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getMediaById.mockResolvedValue(rejectedVideo);

      await expect(
        playlistService.addPlaylistItem({
          playlist_id: 1,
          media_id: 1,
          order_index: 0,
          image_duration: 5,
        })
      ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    });

    it('addPlaylistItem allows approved media when enforcement enabled', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getMediaById.mockResolvedValue(approvedVideo);
      mockDb.getPlaylistItems.mockResolvedValue([]);
      mockDb.addPlaylistItem.mockResolvedValue(mockPlaylistItem1);

      const result = await playlistService.addPlaylistItem({
        playlist_id: 1,
        media_id: 1,
        order_index: 0,
        image_duration: 5,
      });

      expect(result).toEqual(mockPlaylistItem1);
    });

    it('addPlaylistItems rejects batch if any media is not approved', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getPlaylistItems.mockResolvedValue([]);
      mockDb.getMediaById
        .mockResolvedValueOnce(approvedVideo)
        .mockResolvedValueOnce(mockImageFile); // pending

      await expect(playlistService.addPlaylistItems(1, [1, 2])).rejects.toMatchObject({
        code: ErrorCode.BAD_REQUEST,
      });
    });

    it('skips enforcement when requireMediaApproval is false', async () => {
      config.content.requireMediaApproval = false;
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getMediaById.mockResolvedValue(mockVideoFile); // pending
      mockDb.getPlaylistItems.mockResolvedValue([]);
      mockDb.addPlaylistItem.mockResolvedValue(mockPlaylistItem1);

      const result = await playlistService.addPlaylistItem({
        playlist_id: 1,
        media_id: 1,
        order_index: 0,
        image_duration: 5,
      });

      expect(result).toEqual(mockPlaylistItem1);
    });
  });

  describe('updatePlaylistItem', () => {
    it('should update playlist item successfully', async () => {
      mockDb.getPlaylistItemById.mockResolvedValue(mockPlaylistItem1);
      mockDb.updatePlaylistItem.mockResolvedValue({
        ...mockPlaylistItem1,
        image_duration: 10,
      });

      const result = await playlistService.updatePlaylistItem(1, { image_duration: 10 });

      expect(result.image_duration).toBe(10);
      expect(mockDb.updatePlaylistItem).toHaveBeenCalledWith(1, { image_duration: 10 });
    });

    it('should throw error when item not found', async () => {
      mockDb.getPlaylistItemById.mockResolvedValue(null);

      await expect(playlistService.updatePlaylistItem(999, { image_duration: 10 })).rejects.toThrow(
        AppError
      );
      await expect(
        playlistService.updatePlaylistItem(999, { image_duration: 10 })
      ).rejects.toMatchObject({
        code: ErrorCode.PLAYLIST_ITEM_NOT_FOUND,
      });
    });
  });

  describe('deletePlaylistItem', () => {
    it('should delete playlist item and reorder remaining items', async () => {
      mockDb.getPlaylistItemById.mockResolvedValue(mockPlaylistItem1);
      mockDb.deletePlaylistItem.mockResolvedValue(undefined);
      mockDb.getPlaylistItems.mockResolvedValue([mockPlaylistItems[1]]); // One remaining
      mockDb.reorderPlaylistItems.mockResolvedValue(undefined);

      await playlistService.deletePlaylistItem(1);

      expect(mockDb.deletePlaylistItem).toHaveBeenCalledWith(1);
      expect(mockDb.reorderPlaylistItems).toHaveBeenCalled();
    });

    it('should not reorder when no items remain', async () => {
      mockDb.getPlaylistItemById.mockResolvedValue(mockPlaylistItem1);
      mockDb.deletePlaylistItem.mockResolvedValue(undefined);
      mockDb.getPlaylistItems.mockResolvedValue([]);

      await playlistService.deletePlaylistItem(1);

      expect(mockDb.deletePlaylistItem).toHaveBeenCalledWith(1);
      expect(mockDb.reorderPlaylistItems).not.toHaveBeenCalled();
    });

    it('should throw error when item not found', async () => {
      mockDb.getPlaylistItemById.mockResolvedValue(null);

      await expect(playlistService.deletePlaylistItem(999)).rejects.toThrow(AppError);
    });
  });

  describe('reorderPlaylistItems', () => {
    it('should reorder playlist items successfully', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getPlaylistItemById.mockResolvedValueOnce(mockPlaylistItems[0]).mockResolvedValueOnce(mockPlaylistItems[1]);
      mockDb.reorderPlaylistItems.mockResolvedValue(undefined);

      await playlistService.reorderPlaylistItems(1, [2, 1]);

      expect(mockDb.reorderPlaylistItems).toHaveBeenCalledWith(1, [2, 1]);
    });

    it('should throw error when playlist not found', async () => {
      mockDb.getPlaylistById.mockResolvedValue(null);

      await expect(playlistService.reorderPlaylistItems(999, [1, 2])).rejects.toThrow(AppError);
    });

    it('should throw error when item not found', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getPlaylistItemById.mockResolvedValue(null);

      await expect(playlistService.reorderPlaylistItems(1, [999])).rejects.toThrow(AppError);
    });

    it('should throw error when item belongs to different playlist', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getPlaylistItemById.mockResolvedValue({ ...mockPlaylistItem1, playlist_id: 2 });

      await expect(playlistService.reorderPlaylistItems(1, [1])).rejects.toThrow(AppError);
      await expect(playlistService.reorderPlaylistItems(1, [1])).rejects.toMatchObject({
        code: ErrorCode.BAD_REQUEST,
      });
    });
  });

  describe('getPlaylistStats', () => {
    it('should calculate playlist statistics correctly', async () => {
      mockDb.getPlaylistWithItems.mockResolvedValue(mockPlaylistWithItems);

      const result = await playlistService.getPlaylistStats(1);

      expect(result).toMatchObject({
        totalItems: 2,
        totalDuration: expect.any(Number),
        videoCount: 1,
        imageCount: 1,
      });
      expect(result.totalDuration).toBeGreaterThan(0);
    });

    it('should return zero stats for empty playlist', async () => {
      mockDb.getPlaylistWithItems.mockResolvedValue(mockEmptyPlaylist);

      const result = await playlistService.getPlaylistStats(1);

      expect(result).toEqual({
        totalItems: 0,
        totalDuration: 0,
        videoCount: 0,
        imageCount: 0,
      });
    });

    it('should throw error when playlist not found', async () => {
      mockDb.getPlaylistWithItems.mockResolvedValue(null);

      await expect(playlistService.getPlaylistStats(999)).rejects.toThrow(AppError);
    });
  });
});
