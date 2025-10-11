/**
 * Integration tests for Playlist Routes
 */

import request from 'supertest';
import { Application } from 'express';
import MontrServer from '../../../src/index';
import { getDatabase } from '../../../src/database/connection';
import { createMockDatabase } from '../../utils/database.mock';
import { expectSuccessResponse, expectErrorResponse, expectValidationError } from '../../utils/test-helpers';
import {
  mockPlaylist,
  mockPlaylists,
  mockPlaylistWithItems,
  mockPlaylistItems,
  mockCreatePlaylistInput,
  mockUpdatePlaylistInput,
} from '../../fixtures/playlist.fixtures';
import { mockVideoFile, mockImageFile } from '../../fixtures/media.fixtures';

// Mock dependencies
jest.mock('../../../src/database/connection');

describe('Playlist Routes Integration Tests', () => {
  let app: Application;
  let mockDb: ReturnType<typeof createMockDatabase>;

  beforeAll(() => {
    const server = new MontrServer();
    app = server.getApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = createMockDatabase();
    (getDatabase as jest.Mock).mockResolvedValue(mockDb);
  });

  describe('POST /api/playlists', () => {
    it('should create a new playlist successfully', async () => {
      mockDb.createPlaylist.mockResolvedValue({ ...mockPlaylist, ...mockCreatePlaylistInput });

      const response = await request(app)
        .post('/api/playlists')
        .send(mockCreatePlaylistInput);

      const data = expectSuccessResponse(response, 201);
      expect(data).toMatchObject({
        id: mockPlaylist.id,
        name: mockCreatePlaylistInput.name,
        description: mockCreatePlaylistInput.description,
      });
      expect(mockDb.createPlaylist).toHaveBeenCalledWith(mockCreatePlaylistInput);
    });

    it('should create playlist without optional description', async () => {
      const inputWithoutDesc = { name: 'Test Playlist' };
      mockDb.createPlaylist.mockResolvedValue({ ...mockPlaylist, description: null });

      const response = await request(app)
        .post('/api/playlists')
        .send(inputWithoutDesc);

      const data = expectSuccessResponse(response, 201);
      expect(data.description).toBeNull();
    });

    it('should validate required fields', async () => {
      const response = await request(app)
        .post('/api/playlists')
        .send({});

      expectValidationError(response, ['name']);
    });

    it('should validate name length', async () => {
      const response = await request(app)
        .post('/api/playlists')
        .send({ name: '' });

      expectValidationError(response);
    });

    it('should validate description length', async () => {
      const response = await request(app)
        .post('/api/playlists')
        .send({
          name: 'Test',
          description: 'a'.repeat(1001) // Exceeds max length
        });

      expectValidationError(response);
    });
  });

  describe('GET /api/playlists', () => {
    it('should return all playlists', async () => {
      mockDb.getAllPlaylists.mockResolvedValue(mockPlaylists);

      const response = await request(app).get('/api/playlists');

      const data = expectSuccessResponse(response);
      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(2);
      expect(data[0]).toHaveProperty('id');
      expect(data[0]).toHaveProperty('name');
    });

    it('should return empty array when no playlists exist', async () => {
      mockDb.getAllPlaylists.mockResolvedValue([]);

      const response = await request(app).get('/api/playlists');

      const data = expectSuccessResponse(response);
      expect(data).toEqual([]);
    });
  });

  describe('GET /api/playlists/:id', () => {
    it('should return playlist with all items', async () => {
      mockDb.getPlaylistWithItems.mockResolvedValue(mockPlaylistWithItems);

      const response = await request(app).get('/api/playlists/1');

      const data = expectSuccessResponse(response);
      expect(data).toHaveProperty('id', 1);
      expect(data).toHaveProperty('items');
      expect(Array.isArray(data.items)).toBe(true);
      expect(data.items).toHaveLength(2);
      expect(data.items[0]).toHaveProperty('media');
    });

    it('should return 404 when playlist not found', async () => {
      mockDb.getPlaylistWithItems.mockResolvedValue(null);

      const response = await request(app).get('/api/playlists/999');

      expectErrorResponse(response, 404, 'PLAYLIST_NOT_FOUND');
    });

    it('should validate invalid ID parameter', async () => {
      const response = await request(app).get('/api/playlists/invalid');

      expectValidationError(response);
    });
  });

  describe('PUT /api/playlists/:id', () => {
    it('should update playlist successfully', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.updatePlaylist.mockResolvedValue({ ...mockPlaylist, ...mockUpdatePlaylistInput });

      const response = await request(app)
        .put('/api/playlists/1')
        .send(mockUpdatePlaylistInput);

      const data = expectSuccessResponse(response);
      expect(data.name).toBe(mockUpdatePlaylistInput.name);
      expect(data.description).toBe(mockUpdatePlaylistInput.description);
    });

    it('should update only specified fields', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.updatePlaylist.mockResolvedValue({ ...mockPlaylist, name: 'New Name' });

      const response = await request(app)
        .put('/api/playlists/1')
        .send({ name: 'New Name' });

      const data = expectSuccessResponse(response);
      expect(data.name).toBe('New Name');
    });

    it('should return 404 when updating non-existent playlist', async () => {
      mockDb.getPlaylistById.mockResolvedValue(null);

      const response = await request(app)
        .put('/api/playlists/999')
        .send(mockUpdatePlaylistInput);

      expectErrorResponse(response, 404, 'PLAYLIST_NOT_FOUND');
    });

    it('should validate invalid ID parameter', async () => {
      const response = await request(app)
        .put('/api/playlists/invalid')
        .send(mockUpdatePlaylistInput);

      expectValidationError(response);
    });

    it('should validate update data', async () => {
      const response = await request(app)
        .put('/api/playlists/1')
        .send({ name: '', description: 'a'.repeat(1001) });

      expectValidationError(response);
    });
  });

  describe('DELETE /api/playlists/:id', () => {
    it('should delete playlist successfully', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.deletePlaylist.mockResolvedValue(undefined);

      const response = await request(app).delete('/api/playlists/1');

      const data = expectSuccessResponse(response);
      expect(data).toHaveProperty('message');
      expect(data.id).toBe(1);
      expect(mockDb.deletePlaylist).toHaveBeenCalledWith(1);
    });

    it('should return 404 when deleting non-existent playlist', async () => {
      mockDb.getPlaylistById.mockResolvedValue(null);

      const response = await request(app).delete('/api/playlists/999');

      expectErrorResponse(response, 404, 'PLAYLIST_NOT_FOUND');
    });

    it('should validate invalid ID parameter', async () => {
      const response = await request(app).delete('/api/playlists/invalid');

      expectValidationError(response);
    });
  });

  describe('POST /api/playlists/:id/items', () => {
    it('should add items to playlist successfully', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getMediaById.mockResolvedValueOnce(mockVideoFile).mockResolvedValueOnce(mockImageFile);
      mockDb.getPlaylistItems.mockResolvedValue([]);
      mockDb.addPlaylistItem
        .mockResolvedValueOnce(mockPlaylistItems[0])
        .mockResolvedValueOnce(mockPlaylistItems[1]);

      const response = await request(app)
        .post('/api/playlists/1/items')
        .send({ mediaIds: [1, 2] });

      const data = expectSuccessResponse(response, 201);
      expect(data).toHaveProperty('items');
      expect(data.items).toHaveLength(2);
      expect(data.count).toBe(2);
    });

    it('should return 404 when playlist not found', async () => {
      mockDb.getPlaylistById.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/playlists/999/items')
        .send({ mediaIds: [1] });

      expectErrorResponse(response, 404, 'PLAYLIST_NOT_FOUND');
    });

    it('should return 404 when media not found', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getMediaById.mockResolvedValue(null);
      mockDb.getPlaylistItems.mockResolvedValue([]);

      const response = await request(app)
        .post('/api/playlists/1/items')
        .send({ mediaIds: [999] });

      expectErrorResponse(response, 404, 'MEDIA_NOT_FOUND');
    });

    it('should validate mediaIds array', async () => {
      const response = await request(app)
        .post('/api/playlists/1/items')
        .send({ mediaIds: [] });

      expectValidationError(response);
    });

    it('should validate mediaIds are positive integers', async () => {
      const response = await request(app)
        .post('/api/playlists/1/items')
        .send({ mediaIds: [-1, 0, 'invalid'] });

      expectValidationError(response);
    });
  });

  describe('PUT /api/playlists/:id/items/:itemId', () => {
    it('should update playlist item successfully', async () => {
      mockDb.getPlaylistItemById.mockResolvedValue(mockPlaylistItems[0]);
      mockDb.updatePlaylistItem.mockResolvedValue({
        ...mockPlaylistItems[0],
        image_duration: 10,
      });

      const response = await request(app)
        .put('/api/playlists/1/items/1')
        .send({ image_duration: 10 });

      const data = expectSuccessResponse(response);
      expect(data.image_duration).toBe(10);
    });

    it('should return 404 when item not found', async () => {
      mockDb.getPlaylistItemById.mockResolvedValue(null);

      const response = await request(app)
        .put('/api/playlists/1/items/999')
        .send({ image_duration: 10 });

      expectErrorResponse(response, 404, 'PLAYLIST_ITEM_NOT_FOUND');
    });

    it('should validate image_duration range', async () => {
      const response = await request(app)
        .put('/api/playlists/1/items/1')
        .send({ image_duration: 0 });

      expectValidationError(response);
    });

    it('should validate order_index is non-negative', async () => {
      const response = await request(app)
        .put('/api/playlists/1/items/1')
        .send({ order_index: -1 });

      expectValidationError(response);
    });
  });

  describe('DELETE /api/playlists/:id/items/:itemId', () => {
    it('should remove item from playlist successfully', async () => {
      mockDb.getPlaylistItemById.mockResolvedValue(mockPlaylistItems[0]);
      mockDb.deletePlaylistItem.mockResolvedValue(undefined);
      mockDb.getPlaylistItems.mockResolvedValue([mockPlaylistItems[1]]);
      mockDb.reorderPlaylistItems.mockResolvedValue(undefined);

      const response = await request(app).delete('/api/playlists/1/items/1');

      const data = expectSuccessResponse(response);
      expect(data).toHaveProperty('message');
      expect(data.itemId).toBe(1);
      expect(mockDb.deletePlaylistItem).toHaveBeenCalledWith(1);
    });

    it('should return 404 when item not found', async () => {
      mockDb.getPlaylistItemById.mockResolvedValue(null);

      const response = await request(app).delete('/api/playlists/1/items/999');

      expectErrorResponse(response, 404, 'PLAYLIST_ITEM_NOT_FOUND');
    });

    it('should validate invalid item ID parameter', async () => {
      const response = await request(app).delete('/api/playlists/1/items/invalid');

      expectValidationError(response);
    });
  });

  describe('POST /api/playlists/:id/reorder', () => {
    it('should reorder playlist items successfully', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getPlaylistItemById
        .mockResolvedValueOnce(mockPlaylistItems[0])
        .mockResolvedValueOnce(mockPlaylistItems[1]);
      mockDb.reorderPlaylistItems.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/playlists/1/reorder')
        .send({ itemIds: [2, 1] });

      const data = expectSuccessResponse(response);
      expect(data).toHaveProperty('message');
      expect(data.playlistId).toBe(1);
      expect(mockDb.reorderPlaylistItems).toHaveBeenCalledWith(1, [2, 1]);
    });

    it('should return 404 when playlist not found', async () => {
      mockDb.getPlaylistById.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/playlists/999/reorder')
        .send({ itemIds: [1, 2] });

      expectErrorResponse(response, 404, 'PLAYLIST_NOT_FOUND');
    });

    it('should return 404 when item not found', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getPlaylistItemById.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/playlists/1/reorder')
        .send({ itemIds: [999] });

      expectErrorResponse(response, 404, 'PLAYLIST_ITEM_NOT_FOUND');
    });

    it('should return 400 when item belongs to different playlist', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getPlaylistItemById.mockResolvedValue({ ...mockPlaylistItems[0], playlist_id: 2 });

      const response = await request(app)
        .post('/api/playlists/1/reorder')
        .send({ itemIds: [1] });

      expectErrorResponse(response, 400, 'BAD_REQUEST');
    });

    it('should validate itemIds array is not empty', async () => {
      const response = await request(app)
        .post('/api/playlists/1/reorder')
        .send({ itemIds: [] });

      expectValidationError(response);
    });

    it('should validate itemIds are positive integers', async () => {
      const response = await request(app)
        .post('/api/playlists/1/reorder')
        .send({ itemIds: [0, -1, 'invalid'] });

      expectValidationError(response);
    });
  });

  describe('GET /api/playlists/:id/stats', () => {
    it('should return playlist statistics', async () => {
      mockDb.getPlaylistWithItems.mockResolvedValue(mockPlaylistWithItems);

      const response = await request(app).get('/api/playlists/1/stats');

      const data = expectSuccessResponse(response);
      expect(data).toHaveProperty('totalItems');
      expect(data).toHaveProperty('totalDuration');
      expect(data).toHaveProperty('videoCount');
      expect(data).toHaveProperty('imageCount');
      expect(data.totalItems).toBeGreaterThan(0);
    });

    it('should return 404 when playlist not found', async () => {
      mockDb.getPlaylistWithItems.mockResolvedValue(null);

      const response = await request(app).get('/api/playlists/999/stats');

      expectErrorResponse(response, 404, 'PLAYLIST_NOT_FOUND');
    });

    it('should validate invalid ID parameter', async () => {
      const response = await request(app).get('/api/playlists/invalid/stats');

      expectValidationError(response);
    });
  });
});
