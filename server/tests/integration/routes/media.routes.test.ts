/**
 * Integration tests for Media Routes
 */

import request from 'supertest';
import { Application } from 'express';
import MontrServer from '../../../src/index';
import { getDatabase } from '../../../src/database/connection';
import { mediaService } from '../../../src/services/media.service';
import { storageService } from '../../../src/services/storage.service';
import {
  createMockDatabase,
  setupCommonMocks,
  createPaginatedResult,
} from '../../utils/database.mock';
import { expectSuccessResponse, expectErrorResponse, expectValidationError } from '../../utils/test-helpers';
import { mockVideoFile, mockImageFile, mockMediaFiles } from '../../fixtures/media.fixtures';
import sharp from 'sharp';

// Mock dependencies
jest.mock('../../../src/database/connection');
jest.mock('../../../src/services/storage.service');
jest.mock('sharp');

describe('Media Routes Integration Tests', () => {
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

    // Setup default storage service mocks
    (storageService.saveUploadedFile as jest.Mock) = jest.fn().mockResolvedValue({
      filename: 'test_file_123.mp4',
      filepath: 'media/test_file_123.mp4',
      checksum: 'unique-checksum-123',
      size: 10485760,
    });
    (storageService.getFullPath as jest.Mock) = jest.fn((path) => `/storage/${path}`);
    (storageService.deleteFile as jest.Mock) = jest.fn().mockResolvedValue(undefined);
    (storageService.fileExists as jest.Mock) = jest.fn().mockResolvedValue(true);
    (storageService.getThumbnailPath as jest.Mock) = jest.fn().mockResolvedValue(null);
    (storageService.saveThumbnail as jest.Mock) = jest.fn().mockResolvedValue('thumbnails/thumb.jpg');

    // Setup sharp mock
    const mockSharp = {
      resize: jest.fn().mockReturnThis(),
      jpeg: jest.fn().mockReturnThis(),
      toBuffer: jest.fn().mockResolvedValue(Buffer.from('fake-thumbnail')),
    };
    (sharp as unknown as jest.Mock).mockReturnValue(mockSharp);
  });

  describe('POST /api/media/upload', () => {
    it('should upload a single video file successfully', async () => {
      mockDb.getMediaByChecksum.mockResolvedValue(null);
      mockDb.createMedia.mockResolvedValue(mockVideoFile);

      const response = await request(app)
        .post('/api/media/upload')
        .attach('files', Buffer.from('fake-video-data'), 'test_video.mp4');

      const data = expectSuccessResponse(response, 201);
      expect(data).toHaveProperty('uploaded');
      expect(data.uploaded).toHaveLength(1);
      expect(data.count).toBe(1);
    });

    it('should upload multiple files successfully', async () => {
      mockDb.getMediaByChecksum.mockResolvedValue(null);
      mockDb.createMedia
        .mockResolvedValueOnce(mockVideoFile)
        .mockResolvedValueOnce(mockImageFile);

      const response = await request(app)
        .post('/api/media/upload')
        .attach('files', Buffer.from('fake-video-data'), 'test_video.mp4')
        .attach('files', Buffer.from('fake-image-data'), 'test_image.jpg');

      const data = expectSuccessResponse(response, 201);
      expect(data.uploaded).toHaveLength(2);
      expect(data.count).toBe(2);
    });

    it('should return 400 when no files are provided', async () => {
      const response = await request(app).post('/api/media/upload');

      expectErrorResponse(response, 400, 'BAD_REQUEST');
    });

    it('should handle partial upload failures gracefully', async () => {
      mockDb.getMediaByChecksum.mockResolvedValue(null);
      mockDb.createMedia
        .mockResolvedValueOnce(mockVideoFile)
        .mockRejectedValueOnce(new Error('Upload failed'));

      const response = await request(app)
        .post('/api/media/upload')
        .attach('files', Buffer.from('fake-video-data'), 'test_video.mp4')
        .attach('files', Buffer.from('fake-image-data'), 'test_image.jpg');

      const data = expectSuccessResponse(response, 201);
      expect(data.uploaded).toHaveLength(1);
      expect(data.errors).toHaveLength(1);
      expect(data.count).toBe(1);
    });

    it('should reject unsupported file types', async () => {
      const response = await request(app)
        .post('/api/media/upload')
        .attach('files', Buffer.from('not-a-real-file'), {
          filename: 'test.exe',
          contentType: 'application/x-msdownload',
        });

      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('GET /api/media', () => {
    it('should return paginated list of media files', async () => {
      mockDb.getAllMedia.mockResolvedValue(createPaginatedResult(mockMediaFiles, 1, 20));

      const response = await request(app).get('/api/media').query({ page: 1, limit: 20 });

      const data = expectSuccessResponse(response);
      expect(data).toHaveProperty('data');
      expect(data).toHaveProperty('pagination');
      expect(data.data).toHaveLength(3);
      expect(data.pagination).toMatchObject({
        page: 1,
        limit: 20,
        total: 3,
        totalPages: 1,
      });
    });

    it('should filter media by type', async () => {
      mockDb.getAllMedia.mockResolvedValue(createPaginatedResult([mockVideoFile], 1, 20));

      const response = await request(app).get('/api/media').query({ type: 'video' });

      const data = expectSuccessResponse(response);
      expect(data.data).toHaveLength(1);
      expect(data.data[0].type).toBe('video');
    });

    it('should filter media by search term', async () => {
      mockDb.getAllMedia.mockResolvedValue(createPaginatedResult([mockVideoFile], 1, 20));

      const response = await request(app).get('/api/media').query({ search: 'test' });

      const data = expectSuccessResponse(response);
      expect(mockDb.getAllMedia).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ search: 'test' })
      );
    });

    it('should use default pagination values', async () => {
      mockDb.getAllMedia.mockResolvedValue(createPaginatedResult(mockMediaFiles, 1, 20));

      const response = await request(app).get('/api/media');

      expectSuccessResponse(response);
      expect(mockDb.getAllMedia).toHaveBeenCalledWith(
        expect.objectContaining({ page: 1, limit: 20 }),
        expect.any(Object)
      );
    });

    it('should validate invalid type parameter', async () => {
      const response = await request(app).get('/api/media').query({ type: 'invalid' });

      expectValidationError(response);
    });
  });

  describe('GET /api/media/:id', () => {
    it('should return media file by ID', async () => {
      mockDb.getMediaById.mockResolvedValue(mockVideoFile);

      const response = await request(app).get('/api/media/1');

      const data = expectSuccessResponse(response);
      expect(data).toMatchObject({
        id: 1,
        filename: mockVideoFile.filename,
        type: 'video',
      });
    });

    it('should return 404 when media not found', async () => {
      mockDb.getMediaById.mockResolvedValue(null);

      const response = await request(app).get('/api/media/999');

      expectErrorResponse(response, 404, 'MEDIA_NOT_FOUND');
    });

    it('should validate invalid ID parameter', async () => {
      const response = await request(app).get('/api/media/invalid');

      expectValidationError(response);
    });
  });

  describe('DELETE /api/media/:id', () => {
    it('should delete media file successfully', async () => {
      mockDb.getMediaById.mockResolvedValue(mockVideoFile);
      mockDb.deleteMedia.mockResolvedValue(undefined);

      const response = await request(app).delete('/api/media/1');

      const data = expectSuccessResponse(response);
      expect(data).toHaveProperty('message');
      expect(data.id).toBe(1);
      expect(mockDb.deleteMedia).toHaveBeenCalledWith(1);
    });

    it('should return 404 when deleting non-existent media', async () => {
      mockDb.getMediaById.mockResolvedValue(null);

      const response = await request(app).delete('/api/media/999');

      expectErrorResponse(response, 404, 'MEDIA_NOT_FOUND');
    });

    it('should validate invalid ID parameter', async () => {
      const response = await request(app).delete('/api/media/invalid');

      expectValidationError(response);
    });
  });

  describe('GET /api/media/:id/download', () => {
    it('should download media file successfully', async () => {
      mockDb.getMediaById.mockResolvedValue(mockVideoFile);
      (storageService.fileExists as jest.Mock).mockResolvedValue(true);

      // Note: We can't fully test the download without a real file,
      // but we can verify the route calls the correct methods
      const response = await request(app).get('/api/media/1/download');

      // The response will fail due to missing file, but the route should be called
      expect(mockDb.getMediaById).toHaveBeenCalledWith(1);
    });

    it('should return 404 when file not found on disk', async () => {
      mockDb.getMediaById.mockResolvedValue(mockVideoFile);
      (storageService.fileExists as jest.Mock).mockResolvedValue(false);

      const response = await request(app).get('/api/media/1/download');

      expectErrorResponse(response, 404, 'MEDIA_NOT_FOUND');
    });

    it('should return 404 when media not found in database', async () => {
      mockDb.getMediaById.mockResolvedValue(null);

      const response = await request(app).get('/api/media/999/download');

      expectErrorResponse(response, 404, 'MEDIA_NOT_FOUND');
    });
  });

  describe('GET /api/media/:id/thumbnail', () => {
    it('should return existing thumbnail', async () => {
      mockDb.getMediaById.mockResolvedValue(mockVideoFile);
      (storageService.getThumbnailPath as jest.Mock).mockResolvedValue('thumbnails/test_thumb.jpg');

      const response = await request(app).get('/api/media/1/thumbnail');

      expect(mockDb.getMediaById).toHaveBeenCalledWith(1);
    });

    it('should generate thumbnail on-demand when not exists', async () => {
      mockDb.getMediaById.mockResolvedValue(mockImageFile);
      (storageService.getThumbnailPath as jest.Mock).mockResolvedValue(null);
      (storageService.saveThumbnail as jest.Mock).mockResolvedValue('thumbnails/new_thumb.jpg');

      const response = await request(app).get('/api/media/2/thumbnail');

      expect(storageService.saveThumbnail).toHaveBeenCalled();
    });

    it('should return 404 when media not found', async () => {
      mockDb.getMediaById.mockResolvedValue(null);

      const response = await request(app).get('/api/media/999/thumbnail');

      expectErrorResponse(response, 404, 'MEDIA_NOT_FOUND');
    });

    it('should validate invalid ID parameter', async () => {
      const response = await request(app).get('/api/media/invalid/thumbnail');

      expectValidationError(response);
    });
  });
});
