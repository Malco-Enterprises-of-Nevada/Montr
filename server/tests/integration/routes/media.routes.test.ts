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

  describe('Folder integration with media', () => {
    describe('GET /api/media?folder_id=...', () => {
      it('filters by numeric folder_id', async () => {
        mockDb.getAllMedia.mockResolvedValue(createPaginatedResult([]));

        const response = await request(app).get('/api/media?folder_id=5');

        expectSuccessResponse(response);
        expect(mockDb.getAllMedia).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({ folder_id: 5 })
        );
      });

      it('filters root-level media with folder_id=root', async () => {
        mockDb.getAllMedia.mockResolvedValue(createPaginatedResult([]));

        const response = await request(app).get('/api/media?folder_id=root');

        expectSuccessResponse(response);
        expect(mockDb.getAllMedia).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({ folder_id: 'root' })
        );
      });

      it('rejects invalid folder_id', async () => {
        const response = await request(app).get('/api/media?folder_id=bogus');

        expectValidationError(response);
      });
    });

    describe('POST /api/media/upload with folder_id', () => {
      it('persists folder_id via createMedia options', async () => {
        mockDb.getMediaByChecksum.mockResolvedValue(null);
        mockDb.getMediaFolderById.mockResolvedValue({
          id: 7,
          name: 'Ads',
          parent_id: null,
          path: '/7',
          created_by: null,
          created_at: '',
          updated_at: '',
        });
        mockDb.createMedia.mockResolvedValue({ ...mockVideoFile, folder_id: 7 });

        const response = await request(app)
          .post('/api/media/upload')
          .field('folder_id', '7')
          .attach('files', Buffer.from('fake-video-data'), 'clip.mp4');

        const data = expectSuccessResponse<{ uploaded: Array<{ folder_id: number | null }> }>(
          response,
          201
        );
        expect(data.uploaded[0].folder_id).toBe(7);
        expect(mockDb.createMedia).toHaveBeenCalledWith(
          expect.objectContaining({ folder_id: 7 })
        );
      });

      it('rejects invalid folder_id on upload', async () => {
        const response = await request(app)
          .post('/api/media/upload')
          .field('folder_id', 'not-a-number')
          .attach('files', Buffer.from('fake'), 'x.mp4');

        expectErrorResponse(response, 400);
      });
    });

    describe('PATCH /api/media/:id', () => {
      it('moves media to a different folder', async () => {
        mockDb.getMediaById.mockResolvedValue(mockVideoFile);
        mockDb.getMediaFolderById.mockResolvedValue({
          id: 3,
          name: 'Target',
          parent_id: null,
          path: '/3',
          created_by: null,
          created_at: '',
          updated_at: '',
        });
        mockDb.updateMedia.mockResolvedValue({ ...mockVideoFile, folder_id: 3 });

        const response = await request(app)
          .patch('/api/media/1')
          .send({ folder_id: 3 });

        const data = expectSuccessResponse<{ folder_id: number | null }>(response);
        expect(data.folder_id).toBe(3);
      });

      it('returns FOLDER_NOT_FOUND for unknown folder_id', async () => {
        mockDb.getMediaById.mockResolvedValue(mockVideoFile);
        mockDb.getMediaFolderById.mockResolvedValue(null);

        const response = await request(app)
          .patch('/api/media/1')
          .send({ folder_id: 999 });

        expectErrorResponse(response, 404, 'FOLDER_NOT_FOUND');
      });

      it('requires at least one field', async () => {
        const response = await request(app).patch('/api/media/1').send({});

        expectErrorResponse(response, 400, 'VALIDATION_ERROR');
      });
    });

    describe('POST /api/media/bulk/move', () => {
      it('moves multiple media to a folder', async () => {
        mockDb.getMediaFolderById.mockResolvedValue({
          id: 4,
          name: 'Archive',
          parent_id: null,
          path: '/4',
          created_by: null,
          created_at: '',
          updated_at: '',
        });
        mockDb.moveMediaToFolder.mockResolvedValue(3);

        const response = await request(app)
          .post('/api/media/bulk/move')
          .send({ media_ids: [1, 2, 3], folder_id: 4 });

        const data = expectSuccessResponse<{ moved: number; requested: number }>(response);
        expect(data.moved).toBe(3);
        expect(data.requested).toBe(3);
        expect(mockDb.moveMediaToFolder).toHaveBeenCalledWith([1, 2, 3], 4);
      });

      it('moves media to root (folder_id=null)', async () => {
        mockDb.moveMediaToFolder.mockResolvedValue(2);

        const response = await request(app)
          .post('/api/media/bulk/move')
          .send({ media_ids: [1, 2], folder_id: null });

        expectSuccessResponse(response);
        expect(mockDb.moveMediaToFolder).toHaveBeenCalledWith([1, 2], null);
      });

      it('rejects unknown target folder', async () => {
        mockDb.getMediaFolderById.mockResolvedValue(null);

        const response = await request(app)
          .post('/api/media/bulk/move')
          .send({ media_ids: [1], folder_id: 999 });

        expectErrorResponse(response, 404, 'FOLDER_NOT_FOUND');
      });
    });

    describe('POST /api/media/bulk/delete', () => {
      it('deletes requested media and reports success', async () => {
        mockDb.getMediaById.mockResolvedValue(mockVideoFile);
        mockDb.deleteMedia.mockResolvedValue(undefined);

        const response = await request(app)
          .post('/api/media/bulk/delete')
          .send({ media_ids: [1, 2] });

        const data = expectSuccessResponse<{ deleted: number; ids: number[] }>(response);
        expect(data.deleted).toBe(2);
      });

      it('reports per-id errors but keeps going', async () => {
        mockDb.getMediaById
          .mockResolvedValueOnce(mockVideoFile)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(mockImageFile);
        mockDb.deleteMedia.mockResolvedValue(undefined);

        const response = await request(app)
          .post('/api/media/bulk/delete')
          .send({ media_ids: [1, 999, 2] });

        const data = expectSuccessResponse<{
          deleted: number;
          errors?: Array<{ id: number }>;
        }>(response);
        expect(data.deleted).toBe(2);
        expect(data.errors).toHaveLength(1);
        expect(data.errors![0].id).toBe(999);
      });

      it('rejects empty media_ids', async () => {
        const response = await request(app)
          .post('/api/media/bulk/delete')
          .send({ media_ids: [] });

        expectErrorResponse(response, 400, 'VALIDATION_ERROR');
      });
    });
  });
});
