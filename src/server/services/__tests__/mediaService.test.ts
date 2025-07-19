import { MediaService } from '../mediaService';
import * as fs from 'fs';
import * as path from 'path';

// Mock fs module
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

describe('MediaService', () => {
  let mediaService: MediaService;
  const testUploadDir = 'test-uploads';

  beforeEach(() => {
    mediaService = new MediaService(testUploadDir);
    jest.clearAllMocks();
  });

  describe('validateFile', () => {
    it('should validate supported video formats', () => {
      const mockFile = {
        mimetype: 'video/mp4',
        originalname: 'test.mp4',
        size: 1000000
      } as Express.Multer.File;

      const result = mediaService.validateFile(mockFile);

      expect(result.isValid).toBe(true);
      expect(result.fileType).toBe('video');
      expect(result.mimeType).toBe('video/mp4');
    });

    it('should validate supported image formats', () => {
      const mockFile = {
        mimetype: 'image/jpeg',
        originalname: 'test.jpg',
        size: 500000
      } as Express.Multer.File;

      const result = mediaService.validateFile(mockFile);

      expect(result.isValid).toBe(true);
      expect(result.fileType).toBe('image');
      expect(result.mimeType).toBe('image/jpeg');
    });

    it('should reject unsupported formats', () => {
      const mockFile = {
        mimetype: 'application/pdf',
        originalname: 'test.pdf',
        size: 100000
      } as Express.Multer.File;

      const result = mediaService.validateFile(mockFile);

      expect(result.isValid).toBe(false);
      expect(result.error).toContain('Unsupported file format');
    });

    it('should handle case-insensitive MIME types', () => {
      const mockFile = {
        mimetype: 'VIDEO/MP4',
        originalname: 'test.mp4',
        size: 1000000
      } as Express.Multer.File;

      const result = mediaService.validateFile(mockFile);

      expect(result.isValid).toBe(true);
      expect(result.fileType).toBe('video');
    });
  });

  describe('getMimeType', () => {
    it('should return the correct MIME type for media file', () => {
      const mediaFile = {
        id: 'test-id',
        filename: 'test.mp4',
        originalName: 'original.mp4',
        fileType: 'video' as const,
        mimeType: 'video/mp4',
        fileSize: 1000000,
        createdAt: new Date()
      };

      const mimeType = mediaService.getMimeType(mediaFile);
      expect(mimeType).toBe('video/mp4');
    });
  });

  describe('getFilePath', () => {
    it('should return correct path for video files', () => {
      const mediaFile = {
        id: 'test-id',
        filename: 'test.mp4',
        originalName: 'original.mp4',
        fileType: 'video' as const,
        mimeType: 'video/mp4',
        fileSize: 1000000,
        createdAt: new Date()
      };

      const filePath = mediaService.getFilePath(mediaFile);
      expect(filePath).toContain('videos');
      expect(filePath).toContain('test.mp4');
    });

    it('should return correct path for image files', () => {
      const mediaFile = {
        id: 'test-id',
        filename: 'test.jpg',
        originalName: 'original.jpg',
        fileType: 'image' as const,
        mimeType: 'image/jpeg',
        fileSize: 500000,
        createdAt: new Date()
      };

      const filePath = mediaService.getFilePath(mediaFile);
      expect(filePath).toContain('images');
      expect(filePath).toContain('test.jpg');
    });
  });
});