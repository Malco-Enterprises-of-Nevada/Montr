import { FileStorageUtil } from '../fileStorage';
import { MediaFile } from '../../../shared/types';

describe('FileStorageUtil', () => {
  let fileStorage: FileStorageUtil;

  beforeEach(() => {
    fileStorage = new FileStorageUtil('test-uploads');
  });

  describe('getDirectoryStructure', () => {
    it('should return correct directory structure', () => {
      const structure = fileStorage.getDirectoryStructure();
      
      expect(structure.uploadsDir).toContain('test-uploads');
      expect(structure.videosDir).toContain('videos');
      expect(structure.imagesDir).toContain('images');
      expect(structure.thumbnailsDir).toContain('thumbnails');
      expect(structure.tempDir).toContain('temp');
    });
  });

  describe('getMediaDirectory', () => {
    it('should return videos directory for video files', () => {
      const dir = fileStorage.getMediaDirectory('video');
      expect(dir).toContain('videos');
    });

    it('should return images directory for image files', () => {
      const dir = fileStorage.getMediaDirectory('image');
      expect(dir).toContain('images');
    });
  });

  describe('getMediaFilePath', () => {
    it('should return correct path for video media file', () => {
      const mediaFile: MediaFile = {
        id: 'test-id',
        filename: 'test.mp4',
        originalName: 'original.mp4',
        fileType: 'video',
        mimeType: 'video/mp4',
        fileSize: 1000000,
        createdAt: new Date()
      };

      const filePath = fileStorage.getMediaFilePath(mediaFile);
      expect(filePath).toContain('videos');
      expect(filePath).toContain('test.mp4');
    });

    it('should return correct path for image media file', () => {
      const mediaFile: MediaFile = {
        id: 'test-id',
        filename: 'test.jpg',
        originalName: 'original.jpg',
        fileType: 'image',
        mimeType: 'image/jpeg',
        fileSize: 500000,
        createdAt: new Date()
      };

      const filePath = fileStorage.getMediaFilePath(mediaFile);
      expect(filePath).toContain('images');
      expect(filePath).toContain('test.jpg');
    });
  });

  describe('formatFileSize', () => {
    it('should format bytes correctly', () => {
      expect(fileStorage.formatFileSize(1024)).toBe('1.0 KB');
      expect(fileStorage.formatFileSize(1048576)).toBe('1.0 MB');
      expect(fileStorage.formatFileSize(1073741824)).toBe('1.0 GB');
      expect(fileStorage.formatFileSize(500)).toBe('500.0 B');
    });
  });

  describe('getThumbnailPath', () => {
    it('should return correct thumbnail path', () => {
      const thumbnailPath = fileStorage.getThumbnailPath('thumb.jpg');
      expect(thumbnailPath).toContain('thumbnails');
      expect(thumbnailPath).toContain('thumb.jpg');
    });
  });
});