import request from 'supertest';
import express from 'express';
import playlistRoutes from '../playlistRoutes';
import { PlaylistModel } from '../../models/PlaylistModel';
import { PlaylistItemModel } from '../../models/PlaylistItemModel';
import { SystemStateModel } from '../../models/SystemStateModel';
import { errorHandler } from '../../middleware/errorMiddleware';

// Mock the models
jest.mock('../../models/PlaylistModel');
jest.mock('../../models/PlaylistItemModel');
jest.mock('../../models/SystemStateModel');

const MockedPlaylistModel = PlaylistModel as jest.Mocked<typeof PlaylistModel>;
const MockedPlaylistItemModel = PlaylistItemModel as jest.Mocked<typeof PlaylistItemModel>;
const MockedSystemStateModel = SystemStateModel as jest.Mocked<typeof SystemStateModel>;

// Create test app
const app = express();
app.use(express.json());
app.use('/api/playlists', playlistRoutes);
app.use(errorHandler);

describe('Playlist Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/playlists', () => {
    it('should return all playlists', async () => {
      const mockPlaylists = [
        {
          id: '1',
          name: 'Test Playlist',
          description: 'Test Description',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      ];

      MockedPlaylistModel.findAll.mockResolvedValue(mockPlaylists as any);

      const response = await request(app)
        .get('/api/playlists')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(mockPlaylists);
      expect(MockedPlaylistModel.findAll).toHaveBeenCalledWith(false);
    });

    it('should return playlists with items when includeItems=true', async () => {
      const mockPlaylists = [
        {
          id: '1',
          name: 'Test Playlist',
          items: []
        }
      ];

      MockedPlaylistModel.findAll.mockResolvedValue(mockPlaylists as any);

      await request(app)
        .get('/api/playlists?includeItems=true')
        .expect(200);

      expect(MockedPlaylistModel.findAll).toHaveBeenCalledWith(true);
    });

    it('should handle database errors', async () => {
      MockedPlaylistModel.findAll.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .get('/api/playlists')
        .expect(500);

      expect(response.body.error.code).toBe('FETCH_ERROR');
    });
  });

  describe('GET /api/playlists/:id', () => {
    it('should return a specific playlist', async () => {
      const mockPlaylist = {
        id: '1',
        name: 'Test Playlist',
        description: 'Test Description'
      };

      MockedPlaylistModel.findById.mockResolvedValue(mockPlaylist as any);

      const response = await request(app)
        .get('/api/playlists/1')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(mockPlaylist);
      expect(MockedPlaylistModel.findById).toHaveBeenCalledWith('1', false);
    });

    it('should return 404 for non-existent playlist', async () => {
      MockedPlaylistModel.findById.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/playlists/nonexistent')
        .expect(404);

      expect(response.body.error.code).toBe('PLAYLIST_NOT_FOUND');
    });
  });

  describe('POST /api/playlists', () => {
    it('should create a new playlist', async () => {
      const newPlaylist = {
        id: '1',
        name: 'New Playlist',
        description: 'New Description',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      MockedPlaylistModel.create.mockResolvedValue(newPlaylist as any);

      const response = await request(app)
        .post('/api/playlists')
        .send({
          name: 'New Playlist',
          description: 'New Description'
        })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(newPlaylist);
      expect(MockedPlaylistModel.create).toHaveBeenCalledWith({
        name: 'New Playlist',
        description: 'New Description'
      });
    });

    it('should validate required name field', async () => {
      const response = await request(app)
        .post('/api/playlists')
        .send({})
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.message).toContain('name is required');
    });

    it('should validate name is not empty string', async () => {
      const response = await request(app)
        .post('/api/playlists')
        .send({ name: '   ' })
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should trim whitespace from name and description', async () => {
      const newPlaylist = {
        id: '1',
        name: 'Trimmed Name',
        description: 'Trimmed Description'
      };

      MockedPlaylistModel.create.mockResolvedValue(newPlaylist as any);

      await request(app)
        .post('/api/playlists')
        .send({
          name: '  Trimmed Name  ',
          description: '  Trimmed Description  '
        })
        .expect(201);

      expect(MockedPlaylistModel.create).toHaveBeenCalledWith({
        name: 'Trimmed Name',
        description: 'Trimmed Description'
      });
    });
  });

  describe('PUT /api/playlists/:id', () => {
    it('should update an existing playlist', async () => {
      const updatedPlaylist = {
        id: '1',
        name: 'Updated Playlist',
        description: 'Updated Description'
      };

      MockedPlaylistModel.exists.mockResolvedValue(true);
      MockedPlaylistModel.update.mockResolvedValue(updatedPlaylist as any);

      const response = await request(app)
        .put('/api/playlists/1')
        .send({
          name: 'Updated Playlist',
          description: 'Updated Description'
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(updatedPlaylist);
    });

    it('should return 404 for non-existent playlist', async () => {
      MockedPlaylistModel.exists.mockResolvedValue(false);

      const response = await request(app)
        .put('/api/playlists/nonexistent')
        .send({ name: 'Updated Name' })
        .expect(404);

      expect(response.body.error.code).toBe('PLAYLIST_NOT_FOUND');
    });

    it('should validate name when provided', async () => {
      MockedPlaylistModel.exists.mockResolvedValue(true);

      const response = await request(app)
        .put('/api/playlists/1')
        .send({ name: '' })
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('DELETE /api/playlists/:id', () => {
    it('should delete an existing playlist', async () => {
      MockedPlaylistModel.exists.mockResolvedValue(true);
      MockedPlaylistModel.delete.mockResolvedValue(true);
      MockedSystemStateModel.getActivePlaylistId.mockResolvedValue(null);

      const response = await request(app)
        .delete('/api/playlists/1')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.deletedId).toBe('1');
    });

    it('should clear active playlist if deleting active playlist', async () => {
      MockedPlaylistModel.exists.mockResolvedValue(true);
      MockedPlaylistModel.delete.mockResolvedValue(true);
      MockedSystemStateModel.getActivePlaylistId.mockResolvedValue('1');

      await request(app)
        .delete('/api/playlists/1')
        .expect(200);

      expect(MockedSystemStateModel.clearActivePlaylist).toHaveBeenCalled();
    });

    it('should return 404 for non-existent playlist', async () => {
      MockedPlaylistModel.exists.mockResolvedValue(false);

      const response = await request(app)
        .delete('/api/playlists/nonexistent')
        .expect(404);

      expect(response.body.error.code).toBe('PLAYLIST_NOT_FOUND');
    });
  });

  describe('POST /api/playlists/:id/activate', () => {
    it('should activate a playlist', async () => {
      const mockPlaylist = {
        id: '1',
        name: 'Test Playlist'
      };

      MockedPlaylistModel.findById.mockResolvedValue(mockPlaylist as any);

      const response = await request(app)
        .post('/api/playlists/1/activate')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.activePlaylistId).toBe('1');
      expect(MockedSystemStateModel.setActivePlaylistId).toHaveBeenCalledWith('1');
    });

    it('should return 404 for non-existent playlist', async () => {
      MockedPlaylistModel.findById.mockResolvedValue(null);

      const response = await request(app)
        .post('/api/playlists/nonexistent/activate')
        .expect(404);

      expect(response.body.error.code).toBe('PLAYLIST_NOT_FOUND');
    });
  });

  describe('GET /api/playlists/active/current', () => {
    it('should return active playlist', async () => {
      const mockPlaylist = {
        id: '1',
        name: 'Active Playlist'
      };

      MockedSystemStateModel.getActivePlaylistId.mockResolvedValue('1');
      MockedPlaylistModel.findById.mockResolvedValue(mockPlaylist as any);

      const response = await request(app)
        .get('/api/playlists/active/current')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(mockPlaylist);
    });

    it('should return null when no active playlist', async () => {
      MockedSystemStateModel.getActivePlaylistId.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/playlists/active/current')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toBeNull();
    });

    it('should clear invalid active playlist reference', async () => {
      MockedSystemStateModel.getActivePlaylistId.mockResolvedValue('invalid-id');
      MockedPlaylistModel.findById.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/playlists/active/current')
        .expect(200);

      expect(response.body.data).toBeNull();
      expect(MockedSystemStateModel.clearActivePlaylist).toHaveBeenCalled();
    });
  });

  describe('POST /api/playlists/:id/items', () => {
    it('should add item to playlist', async () => {
      const mockPlaylistItem = {
        id: '1',
        playlist_id: '1',
        media_file_id: 'media-1',
        order_index: 0
      };

      MockedPlaylistModel.exists.mockResolvedValue(true);
      MockedPlaylistItemModel.create.mockResolvedValue(mockPlaylistItem as any);

      const response = await request(app)
        .post('/api/playlists/1/items')
        .send({
          mediaFileId: 'media-1',
          orderIndex: 0
        })
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(mockPlaylistItem);
    });

    it('should validate required mediaFileId', async () => {
      MockedPlaylistModel.exists.mockResolvedValue(true);

      const response = await request(app)
        .post('/api/playlists/1/items')
        .send({})
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.message).toContain('mediaFileId is required');
    });

    it('should return 404 for non-existent playlist', async () => {
      MockedPlaylistModel.exists.mockResolvedValue(false);

      const response = await request(app)
        .post('/api/playlists/nonexistent/items')
        .send({ mediaFileId: 'media-1' })
        .expect(404);

      expect(response.body.error.code).toBe('PLAYLIST_NOT_FOUND');
    });
  });
});