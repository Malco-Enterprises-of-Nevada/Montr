import request from 'supertest';
import express from 'express';
import mediaRoutes from '../mediaRoutes';
import { MediaFileModel } from '../../models/MediaFileModel';
import { mediaService } from '../../services/mediaService';
import { errorHandler } from '../../middleware/errorMiddleware';
import * as fs from 'fs';

// Mock the models and services
jest.mock('../../models/MediaFileModel');
jest.mock('../../services/mediaService');
jest.mock('fs');

const MockedMediaFileModel = MediaFileModel as jest.Mocked<typeof MediaFileModel>;
const MockedMediaService = mediaService as jest.Mocked<typeof mediaService>;
const MockedFs = fs as jest.Mocked<typeof fs>;

// Create test app
const app = express();
app.use(express.json());
app.use('/api/media', mediaRoutes);
app.use(errorHandler);

describe('Media Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/media', () => {
    it('should return all media files', async () => {
      const mockMediaFiles = [
        {
          id: '1',
          filename: 'test.mp4',
          original_name: 'test.mp4',
          file_type: 'video',
          mime_type: 'video/mp4',
          file_size: 1000,
          created_at: new Date()
        }
      ];

      MockedMediaFileModel.findAll.mockResolvedValue(mockMediaFiles as any);

      const response = await request(app)
        .get('/api/media')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(mockMediaFiles);
      expect(MockedMediaFileModel.findAll).toHaveBeenCalledWith(undefined);
    });

    it('should filter by file type', async () => {
      const mockVideoFiles = [
        {
          id: '1',
          file_type: 'video'
        }
      ];

      MockedMediaFileModel.findAll.mockResolvedValue(mockVideoFiles as any);

      await request(app)
        .get('/api/media?fileType=video')
        .expect(200);

      expect(MockedMediaFileModel.findAll).toHaveBeenCalledWith('video');
    });

    it('should validate file type parameter', async () => {
      const response = await request(app)
        .get('/api/media?fileType=invalid')
        .expect(400);

      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.message).toContain('fileType must be either "video" or "image"');
    });

    it('should handle database errors', async () => {
      MockedMediaFileModel.findAll.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .get('/api/media')
        .expect(500);

      expect(response.body.error.code).toBe('FETCH_ERROR');
    });
  });

  describe('GET /api/media/:id', () => {
    it('should serve a media file', async () => {
      const mockMediaFile = {
        id: '1',
        filename: 'test.mp4',
        original_name: 'test.mp4',
        mime_type: 'video/mp4',
        file_size: 1000
      };

      const mockStream = {
        pipe: jest.fn(),
        on: jest.fn()
      };

      MockedMediaFileModel.findById.mockResolvedValue(mockMediaFile as any);
      MockedMediaService.getFilePath.mockReturnValue('/path/to/file.mp4');
      MockedMediaService.fileExists.mockResolvedValue(true);
      (fs.createReadStream as jest.Mock).mockReturnValue(mockStream);

      const response = await request(app)
        .get('/api/media/1');

      expect(MockedMediaFileModel.findById).toHaveBeenCalledWith('1');
      expect(MockedMediaService.fileExists).toHaveBeenCalledWith(mockMediaFile);
      expect(fs.createReadStream).toHaveBeenCalledWith('/path/to/file.mp4');
    });

    it('should return 404 for non-existent media file', async () => {
      MockedMediaFileModel.findById.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/media/nonexistent')
        .expect(404);

      expect(response.body.error.code).toBe('MEDIA_NOT_FOUND');
    });

    it('should return 404 when file does not exist on disk', async () => {
      const mockMediaFile = {
        id: '1',
        filename: 'test.mp4'
      };

      MockedMediaFileModel.findById.mockResolvedValue(mockMediaFile as any);
      MockedMediaService.getFilePath.mockReturnValue('/path/to/file.mp4');
      MockedMediaService.fileExists.mockResolvedValue(false);

      const response = await request(app)
        .get('/api/media/1')
        .expect(404);

      expect(response.body.error.code).toBe('FILE_NOT_FOUND');
    });
  });

  describe('GET /api/media/:id/info', () => {
    it('should return media file information', async () => {
      const mockMediaFile = {
        id: '1',
        filename: 'test.mp4',
        original_name: 'test.mp4',
        file_type: 'video',
        mime_type: 'video/mp4',
        file_size: 1000
      };

      MockedMediaFileModel.findById.mockResolvedValue(mockMediaFile as any);
      MockedMediaService.fileExists.mockResolvedValue(true);
      MockedMediaService.getFilePath.mockReturnValue('/path/to/file.mp4');

      const response = await request(app)
        .get('/api/media/1/info')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toMatchObject({
        ...mockMediaFile,
        fileExists: true,
        filePath: '/path/to/file.mp4'
      });
    });

    it('should return 404 for non-existent media file', async () => {
      MockedMediaFileModel.findById.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/media/nonexistent/info')
        .expect(404);

      expect(response.body.error.code).toBe('MEDIA_NOT_FOUND');
    });
  });

  describe('GET /api/media/:id/thumbnail', () => {
    it('should serve a thumbnail', async () => {
      const mockMediaFile = {
        id: '1',
        thumbnail_path: '/path/to/thumbnail.jpg'
      };

      const mockStream = {
        pipe: jest.fn(),
        on: jest.fn()
      };

      MockedMediaFileModel.findById.mockResolvedValue(mockMediaFile as any);
      (fs.promises.stat as jest.Mock).mockResolvedValue({});
      (fs.createReadStream as jest.Mock).mockReturnValue(mockStream);

      const response = await request(app)
        .get('/api/media/1/thumbnail');

      expect(MockedMediaFileModel.findById).toHaveBeenCalledWith('1');
      expect(fs.createReadStream).toHaveBeenCalledWith(expect.stringContaining('thumbnail.jpg'));
    });

    it('should return 404 when no thumbnail available', async () => {
      const mockMediaFile = {
        id: '1',
        thumbnail_path: null
      };

      MockedMediaFileModel.findById.mockResolvedValue(mockMediaFile as any);

      const response = await request(app)
        .get('/api/media/1/thumbnail')
        .expect(404);

      expect(response.body.error.code).toBe('THUMBNAIL_NOT_FOUND');
    });

    it('should return 404 for non-existent media file', async () => {
      MockedMediaFileModel.findById.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/media/nonexistent/thumbnail')
        .expect(404);

      expect(response.body.error.code).toBe('MEDIA_NOT_FOUND');
    });
  });

  describe('DELETE /api/media/:id', () => {
    it('should delete a media file', async () => {
      const mockMediaFile = {
        id: '1',
        filename: 'test.mp4',
        thumbnail_path: '/path/to/thumbnail.jpg'
      };

      MockedMediaFileModel.findById.mockResolvedValue(mockMediaFile as any);
      MockedMediaFileModel.delete.mockResolvedValue(true);
      MockedMediaService.getFilePath.mockReturnValue('/path/to/file.mp4');
      MockedMediaService.fileExists.mockResolvedValue(true);
      (fs.promises.unlink as jest.Mock).mockResolvedValue(undefined);

      const response = await request(app)
        .delete('/api/media/1')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.deletedId).toBe('1');
      expect(MockedMediaFileModel.delete).toHaveBeenCalledWith('1');
      expect(fs.promises.unlink).toHaveBeenCalledWith('/path/to/file.mp4');
      expect(fs.promises.unlink).toHaveBeenCalledWith('/path/to/thumbnail.jpg');
    });

    it('should return 404 for non-existent media file', async () => {
      MockedMediaFileModel.findById.mockResolvedValue(null);

      const response = await request(app)
        .delete('/api/media/nonexistent')
        .expect(404);

      expect(response.body.error.code).toBe('MEDIA_NOT_FOUND');
    });

    it('should handle database deletion failure', async () => {
      const mockMediaFile = {
        id: '1',
        filename: 'test.mp4'
      };

      MockedMediaFileModel.findById.mockResolvedValue(mockMediaFile as any);
      MockedMediaFileModel.delete.mockResolvedValue(false);

      const response = await request(app)
        .delete('/api/media/1')
        .expect(500);

      expect(response.body.error.code).toBe('DATABASE_ERROR');
    });
  });

  describe('GET /api/media/stats/summary', () => {
    it('should return media file statistics', async () => {
      const mockStats = {
        totalFiles: 10,
        totalSize: 1000000,
        videoCount: 6,
        imageCount: 4
      };

      MockedMediaFileModel.getFileStats.mockResolvedValue(mockStats);

      const response = await request(app)
        .get('/api/media/stats/summary')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toEqual(mockStats);
    });

    it('should handle database errors', async () => {
      MockedMediaFileModel.getFileStats.mockRejectedValue(new Error('Database error'));

      const response = await request(app)
        .get('/api/media/stats/summary')
        .expect(500);

      expect(response.body.error.code).toBe('STATS_ERROR');
    });
  });
});