/**
 * Unit tests for MediaService
 */

import { MediaService } from '../../../src/services/media.service';
import { storageService } from '../../../src/services/storage.service';
import { notificationService } from '../../../src/services/notification.service';
import { getDatabase } from '../../../src/database/connection';
import { AppError, ErrorCode } from '../../../src/api/middleware/error-handler';
import { createMockDatabase, createPaginatedResult } from '../../utils/database.mock';
import {
  mockVideoFile,
  mockImageFile,
  mockMediaFiles,
  createMockMulterFile,
  mockFFprobeOutput,
} from '../../fixtures/media.fixtures';
import * as childProcess from 'child_process';
import sharp from 'sharp';

// Mock dependencies
jest.mock('../../../src/database/connection');
jest.mock('../../../src/services/storage.service');
jest.mock('../../../src/services/notification.service', () => ({
  notificationService: {
    fireEvent: jest.fn().mockResolvedValue(0),
  },
}));
jest.mock('sharp');

// Mock util.promisify to return a mock exec function
jest.mock('util', () => {
  const actualUtil = jest.requireActual('util');
  const mockExec = jest.fn();
  return {
    ...actualUtil,
    promisify: jest.fn(() => mockExec),
  };
});

// Get reference to the mocked exec function
import { promisify } from 'util';
const mockExecFn = promisify(null as any) as jest.Mock;

describe('MediaService', () => {
  let mediaService: MediaService;
  let mockDb: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = createMockDatabase();
    (getDatabase as jest.Mock).mockResolvedValue(mockDb);
    (notificationService.fireEvent as jest.Mock).mockResolvedValue(0);

    // Setup storage service mocks
    (storageService.saveUploadedFile as jest.Mock) = jest.fn().mockResolvedValue({
      filename: 'test_file_123.mp4',
      filepath: 'media/test_file_123.mp4',
      checksum: 'abc123',
      size: 10485760,
    });
    (storageService.getFullPath as jest.Mock) = jest.fn((path) => `/storage/${path}`);
    (storageService.deleteFile as jest.Mock) = jest.fn().mockResolvedValue(undefined);
    (storageService.fileExists as jest.Mock) = jest.fn().mockResolvedValue(true);
    (storageService.getThumbnailPath as jest.Mock) = jest.fn().mockResolvedValue(null);
    (storageService.saveThumbnail as jest.Mock) = jest
      .fn()
      .mockResolvedValue('thumbnails/test_thumb.jpg');

    // Setup exec mock for ffprobe/ffmpeg to return valid metadata
    mockExecFn.mockResolvedValue({
      stdout: JSON.stringify(mockFFprobeOutput),
      stderr: ''
    });

    // Setup sharp mock
    const mockSharp = {
      resize: jest.fn().mockReturnThis(),
      jpeg: jest.fn().mockReturnThis(),
      toBuffer: jest.fn().mockResolvedValue(Buffer.from('fake-thumbnail')),
      metadata: jest.fn().mockResolvedValue({
        width: 1920,
        height: 1080,
        format: 'jpeg',
      }),
    };
    (sharp as unknown as jest.Mock).mockReturnValue(mockSharp);

    mediaService = new MediaService();
  });

  describe('createMedia', () => {
    it('should create a video media file successfully', async () => {
      const mockFile = createMockMulterFile({ mimetype: 'video/mp4' });
      mockDb.createMedia.mockResolvedValue(mockVideoFile);
      mockDb.getMediaByChecksum.mockResolvedValue(null);

      const result = await mediaService.createMedia(mockFile);

      expect(result).toEqual(mockVideoFile);
      expect(storageService.saveUploadedFile).toHaveBeenCalledWith(mockFile);
      expect(mockDb.getMediaByChecksum).toHaveBeenCalledWith('abc123');
      expect(mockDb.createMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'video',
          mime_type: 'video/mp4',
          duration: expect.any(Number),
        })
      );
    });

    it('should create an image media file successfully', async () => {
      const mockFile = createMockMulterFile({ mimetype: 'image/jpeg', originalname: 'test.jpg' });
      mockDb.createMedia.mockResolvedValue(mockImageFile);
      mockDb.getMediaByChecksum.mockResolvedValue(null);

      const result = await mediaService.createMedia(mockFile);

      expect(result).toEqual(mockImageFile);
      expect(mockDb.createMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'image',
          mime_type: 'image/jpeg',
          width: expect.any(Number),
          height: expect.any(Number),
        })
      );
    });

    it('should reject duplicate files by checksum', async () => {
      const mockFile = createMockMulterFile();
      mockDb.getMediaByChecksum.mockResolvedValue(mockVideoFile);

      await expect(mediaService.createMedia(mockFile)).rejects.toThrow(AppError);
      await expect(mediaService.createMedia(mockFile)).rejects.toMatchObject({
        code: ErrorCode.RESOURCE_ALREADY_EXISTS,
        statusCode: 409,
      });

      expect(storageService.deleteFile).toHaveBeenCalledWith('media/test_file_123.mp4');
    });

    it('should throw error for unsupported media type', async () => {
      const mockFile = createMockMulterFile({ mimetype: 'application/pdf' });

      await expect(mediaService.createMedia(mockFile)).rejects.toThrow(AppError);
      await expect(mediaService.createMedia(mockFile)).rejects.toMatchObject({
        code: ErrorCode.INVALID_MEDIA_TYPE,
      });
    });

    it('should handle metadata extraction errors gracefully', async () => {
      const mockFile = createMockMulterFile();
      mockDb.createMedia.mockResolvedValue(mockVideoFile);
      mockDb.getMediaByChecksum.mockResolvedValue(null);
      mockExecFn.mockRejectedValue(new Error('ffprobe failed'));

      const result = await mediaService.createMedia(mockFile);

      // Should still create media even if metadata extraction fails
      expect(result).toEqual(mockVideoFile);
      expect(mockDb.createMedia).toHaveBeenCalled();
    });

    it('fires media_approval_needed when upload lands as pending', async () => {
      const mockFile = createMockMulterFile({ mimetype: 'video/mp4' });
      mockDb.createMedia.mockResolvedValue(mockVideoFile); // approval_status='pending'
      mockDb.getMediaByChecksum.mockResolvedValue(null);

      await mediaService.createMedia(mockFile);

      expect(notificationService.fireEvent).toHaveBeenCalledWith(
        'media_approval_needed',
        expect.objectContaining({
          media_id: mockVideoFile.id,
          filename: mockVideoFile.original_filename,
          type: mockVideoFile.type,
        })
      );
    });

    it('does not fire media_approval_needed when upload is auto-approved', async () => {
      const mockFile = createMockMulterFile({ mimetype: 'video/mp4' });
      mockDb.createMedia.mockResolvedValue({ ...mockVideoFile, approval_status: 'approved' });
      mockDb.getMediaByChecksum.mockResolvedValue(null);

      await mediaService.createMedia(mockFile);

      expect(notificationService.fireEvent).not.toHaveBeenCalled();
    });

    it('swallows notification dispatch failures', async () => {
      const mockFile = createMockMulterFile({ mimetype: 'video/mp4' });
      mockDb.createMedia.mockResolvedValue(mockVideoFile);
      mockDb.getMediaByChecksum.mockResolvedValue(null);
      (notificationService.fireEvent as jest.Mock).mockRejectedValueOnce(new Error('boom'));

      const result = await mediaService.createMedia(mockFile);

      expect(result).toEqual(mockVideoFile);
    });
  });

  describe('getMediaById', () => {
    it('should return media file by ID', async () => {
      mockDb.getMediaById.mockResolvedValue(mockVideoFile);

      const result = await mediaService.getMediaById(1);

      expect(result).toEqual(mockVideoFile);
      expect(mockDb.getMediaById).toHaveBeenCalledWith(1);
    });

    it('should throw error when media not found', async () => {
      mockDb.getMediaById.mockResolvedValue(null);

      await expect(mediaService.getMediaById(999)).rejects.toThrow(AppError);
      await expect(mediaService.getMediaById(999)).rejects.toMatchObject({
        code: ErrorCode.MEDIA_NOT_FOUND,
        statusCode: 404,
      });
    });
  });

  describe('getAllMedia', () => {
    it('should return paginated media list', async () => {
      const paginatedResult = createPaginatedResult(mockMediaFiles, 1, 20);
      mockDb.getAllMedia.mockResolvedValue(paginatedResult);

      const result = await mediaService.getAllMedia({ page: 1, limit: 20 });

      expect(result).toEqual(paginatedResult);
      expect(mockDb.getAllMedia).toHaveBeenCalledWith({ page: 1, limit: 20 }, undefined);
    });

    it('should filter media by type', async () => {
      const videoOnly = createPaginatedResult([mockVideoFile], 1, 20);
      mockDb.getAllMedia.mockResolvedValue(videoOnly);

      const result = await mediaService.getAllMedia({ page: 1, limit: 20 }, { type: 'video' });

      expect(result.data).toHaveLength(1);
      expect(mockDb.getAllMedia).toHaveBeenCalledWith({ page: 1, limit: 20 }, { type: 'video' });
    });

    it('should filter media by search term', async () => {
      mockDb.getAllMedia.mockResolvedValue(createPaginatedResult([mockVideoFile], 1, 20));

      await mediaService.getAllMedia({ page: 1, limit: 20 }, { search: 'test' });

      expect(mockDb.getAllMedia).toHaveBeenCalledWith({ page: 1, limit: 20 }, { search: 'test' });
    });
  });

  describe('deleteMedia', () => {
    it('should delete media file and associated files', async () => {
      mockDb.getMediaById.mockResolvedValue(mockVideoFile);
      mockDb.deleteMedia.mockResolvedValue(undefined);
      (storageService.getThumbnailPath as jest.Mock).mockResolvedValue('thumbnails/test_thumb.jpg');

      await mediaService.deleteMedia(1);

      expect(mockDb.deleteMedia).toHaveBeenCalledWith(1);
      expect(storageService.deleteFile).toHaveBeenCalledWith(mockVideoFile.filepath);
      expect(storageService.deleteFile).toHaveBeenCalledWith('thumbnails/test_thumb.jpg');
    });

    it('should throw error when deleting non-existent media', async () => {
      mockDb.getMediaById.mockResolvedValue(null);

      await expect(mediaService.deleteMedia(999)).rejects.toThrow(AppError);
      await expect(mediaService.deleteMedia(999)).rejects.toMatchObject({
        code: ErrorCode.MEDIA_NOT_FOUND,
      });
    });

    it('should handle missing thumbnail gracefully', async () => {
      mockDb.getMediaById.mockResolvedValue(mockVideoFile);
      mockDb.deleteMedia.mockResolvedValue(undefined);
      (storageService.getThumbnailPath as jest.Mock).mockResolvedValue(null);

      await mediaService.deleteMedia(1);

      expect(mockDb.deleteMedia).toHaveBeenCalledWith(1);
      expect(storageService.deleteFile).toHaveBeenCalledTimes(1); // Only main file
    });
  });

  describe('getMediaFilePath', () => {
    it('should return full file path for existing media', async () => {
      mockDb.getMediaById.mockResolvedValue(mockVideoFile);
      (storageService.fileExists as jest.Mock).mockResolvedValue(true);

      const result = await mediaService.getMediaFilePath(1);

      expect(result).toBe(`/storage/${mockVideoFile.filepath}`);
      expect(storageService.fileExists).toHaveBeenCalledWith(mockVideoFile.filepath);
    });

    it('should throw error when file does not exist on disk', async () => {
      mockDb.getMediaById.mockResolvedValue(mockVideoFile);
      (storageService.fileExists as jest.Mock).mockResolvedValue(false);

      await expect(mediaService.getMediaFilePath(1)).rejects.toThrow(AppError);
      await expect(mediaService.getMediaFilePath(1)).rejects.toMatchObject({
        code: ErrorCode.MEDIA_NOT_FOUND,
        statusCode: 404,
      });
    });
  });

  describe('getMediaThumbnail', () => {
    it('should return existing thumbnail path', async () => {
      mockDb.getMediaById.mockResolvedValue(mockVideoFile);
      (storageService.getThumbnailPath as jest.Mock).mockResolvedValue('thumbnails/test_thumb.jpg');

      const result = await mediaService.getMediaThumbnail(1);

      expect(result).toEqual({ kind: 'ready', path: '/storage/thumbnails/test_thumb.jpg' });
      expect(storageService.getThumbnailPath).toHaveBeenCalledWith(mockVideoFile.filename);
    });

    it('should enqueue a job and return pending when no thumbnail exists (video)', async () => {
      mockDb.getMediaById.mockResolvedValue(mockVideoFile);
      (storageService.getThumbnailPath as jest.Mock).mockResolvedValue(null);

      const result = await mediaService.getMediaThumbnail(1);

      expect(result).toEqual({ kind: 'pending' });
      expect(mockDb.enqueueThumbnailJob).toHaveBeenCalledWith(mockVideoFile.id);
      // ffmpeg is NOT invoked synchronously anymore — the queue does it.
      expect(mockExecFn).not.toHaveBeenCalled();
    });

    it('should enqueue a job and return pending when no thumbnail exists (image)', async () => {
      mockDb.getMediaById.mockResolvedValue(mockImageFile);
      (storageService.getThumbnailPath as jest.Mock).mockResolvedValue(null);

      const result = await mediaService.getMediaThumbnail(2);

      expect(result).toEqual({ kind: 'pending' });
      expect(mockDb.enqueueThumbnailJob).toHaveBeenCalledWith(mockImageFile.id);
    });

    it('should not enqueue duplicate job when one is already in flight', async () => {
      mockDb.getMediaById.mockResolvedValue(mockVideoFile);
      (storageService.getThumbnailPath as jest.Mock).mockResolvedValue(null);
      mockDb.getLatestThumbnailJobForMedia.mockResolvedValue({
        id: 7,
        media_id: 1,
        state: 'running',
        attempts: 1,
        last_error: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const result = await mediaService.getMediaThumbnail(1);

      expect(result).toEqual({ kind: 'pending' });
      expect(mockDb.enqueueThumbnailJob).not.toHaveBeenCalled();
    });

    it('should return failed kind when media.thumbnail_status is failed', async () => {
      mockDb.getMediaById.mockResolvedValue({ ...mockVideoFile, thumbnail_status: 'failed' });
      (storageService.getThumbnailPath as jest.Mock).mockResolvedValue(null);

      const result = await mediaService.getMediaThumbnail(1);

      expect(result).toEqual({ kind: 'failed' });
      expect(mockDb.enqueueThumbnailJob).not.toHaveBeenCalled();
    });
  });

  describe('getMediaStats', () => {
    it('should return media statistics', async () => {
      const allMedia = createPaginatedResult(mockMediaFiles, 1, 10000);
      mockDb.getAllMedia.mockResolvedValue(allMedia);

      const result = await mediaService.getMediaStats();

      expect(result).toMatchObject({
        total: 3,
        videos: 2,
        images: 1,
        totalSize: expect.any(Number),
      });
    });

    it('should handle empty media library', async () => {
      mockDb.getAllMedia.mockResolvedValue(createPaginatedResult([], 1, 10000));

      const result = await mediaService.getMediaStats();

      expect(result).toEqual({
        total: 0,
        videos: 0,
        images: 0,
        totalSize: 0,
      });
    });
  });
});
