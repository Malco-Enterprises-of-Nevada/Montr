import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import { MediaFile } from '../../shared/types/models';

const stat = promisify(fs.stat);
const mkdir = promisify(fs.mkdir);
const copyFile = promisify(fs.copyFile);
const unlink = promisify(fs.unlink);

export interface MediaProcessingResult {
  mediaFile: MediaFile;
  filePath: string;
}

export interface FileValidationResult {
  isValid: boolean;
  error?: string;
  fileType?: 'video' | 'image';
  mimeType?: string;
}

export class MediaService {
  private readonly uploadsDir: string;
  private readonly videosDir: string;
  private readonly imagesDir: string;
  private readonly thumbnailsDir: string;

  // Supported file formats
  private readonly supportedVideoFormats = [
    'video/mp4',
    'video/avi',
    'video/quicktime', // .mov
    'video/webm'
  ];

  private readonly supportedImageFormats = [
    'image/jpeg',
    'image/jpg', 
    'image/png',
    'image/gif',
    'image/webp'
  ];

  constructor(baseUploadDir: string = 'uploads') {
    this.uploadsDir = path.resolve(baseUploadDir);
    this.videosDir = path.join(this.uploadsDir, 'videos');
    this.imagesDir = path.join(this.uploadsDir, 'images');
    this.thumbnailsDir = path.join(this.uploadsDir, 'thumbnails');
  }

  /**
   * Initialize the media service by creating necessary directories
   */
  async initialize(): Promise<void> {
    const directories = [
      this.uploadsDir,
      this.videosDir,
      this.imagesDir,
      this.thumbnailsDir
    ];

    for (const dir of directories) {
      try {
        await stat(dir);
      } catch (error) {
        // Directory doesn't exist, create it
        await mkdir(dir, { recursive: true });
      }
    }
  }

  /**
   * Validate uploaded file format and type
   */
  validateFile(file: Express.Multer.File): FileValidationResult {
    const mimeType = file.mimetype.toLowerCase();
    
    // Check if it's a supported video format
    if (this.supportedVideoFormats.includes(mimeType)) {
      return {
        isValid: true,
        fileType: 'video',
        mimeType
      };
    }
    
    // Check if it's a supported image format
    if (this.supportedImageFormats.includes(mimeType)) {
      return {
        isValid: true,
        fileType: 'image',
        mimeType
      };
    }

    return {
      isValid: false,
      error: `Unsupported file format: ${mimeType}. Supported formats: ${[...this.supportedVideoFormats, ...this.supportedImageFormats].join(', ')}`
    };
  }

  /**
   * Process uploaded media file
   */
  async processMediaFile(file: Express.Multer.File): Promise<MediaProcessingResult> {
    // Validate file
    const validation = this.validateFile(file);
    if (!validation.isValid) {
      throw new Error(validation.error);
    }

    // Generate unique filename
    const fileId = uuidv4();
    const fileExtension = path.extname(file.originalname);
    const filename = `${fileId}${fileExtension}`;
    
    // Determine target directory based on file type
    const targetDir = validation.fileType === 'video' ? this.videosDir : this.imagesDir;
    const filePath = path.join(targetDir, filename);

    // Move file to appropriate directory
    await copyFile(file.path, filePath);
    
    // Clean up temporary file
    try {
      await unlink(file.path);
    } catch (error) {
      console.warn('Failed to clean up temporary file:', file.path);
    }

    // Extract metadata
    const metadata = await this.extractMetadata(filePath, validation.fileType!);

    // Create MediaFile object
    const mediaFile: MediaFile = {
      id: fileId,
      filename,
      original_name: file.originalname,
      file_type: validation.fileType!,
      mime_type: validation.mimeType!,
      file_size: file.size,
      duration: metadata.duration,
      thumbnail_path: metadata.thumbnailPath,
      created_at: new Date()
    };

    return {
      mediaFile,
      filePath
    };
  }

  /**
   * Extract metadata from media file
   */
  private async extractMetadata(filePath: string, fileType: 'video' | 'image'): Promise<{
    duration?: number;
    thumbnailPath?: string;
  }> {
    const metadata: { duration?: number; thumbnailPath?: string } = {};

    if (fileType === 'video') {
      // For videos, we'll use a simple approach to get basic metadata
      // In a production system, you'd use ffprobe or similar tools
      metadata.duration = await this.getVideoDuration(filePath);
      metadata.thumbnailPath = await this.generateVideoThumbnail(filePath);
    } else if (fileType === 'image') {
      // For images, set a default display duration (can be overridden in playlist)
      metadata.duration = 5; // 5 seconds default display time
    }

    return metadata;
  }

  /**
   * Get video duration (simplified implementation)
   * In production, use ffprobe or similar
   */
  private async getVideoDuration(filePath: string): Promise<number | undefined> {
    // This is a placeholder implementation
    // In a real application, you would use ffprobe or a similar tool
    // For now, return undefined to indicate duration extraction is not implemented
    return undefined;
  }

  /**
   * Generate thumbnail for video (simplified implementation)
   * In production, use ffmpeg
   */
  private async generateVideoThumbnail(filePath: string): Promise<string | undefined> {
    // This is a placeholder implementation
    // In a real application, you would use ffmpeg to generate thumbnails
    // For now, return undefined to indicate thumbnail generation is not implemented
    return undefined;
  }

  /**
   * Get file path for serving
   */
  getFilePath(mediaFile: MediaFile): string {
    const targetDir = mediaFile.file_type === 'video' ? this.videosDir : this.imagesDir;
    return path.join(targetDir, mediaFile.filename);
  }

  /**
   * Get thumbnail path for serving
   */
  getThumbnailPath(mediaFile: MediaFile): string | null {
    if (!mediaFile.thumbnail_path) {
      return null;
    }
    return path.join(this.thumbnailsDir, mediaFile.thumbnail_path);
  }

  /**
   * Delete media file and associated thumbnail
   */
  async deleteMediaFile(mediaFile: MediaFile): Promise<void> {
    const filePath = this.getFilePath(mediaFile);
    
    try {
      await unlink(filePath);
    } catch (error) {
      console.warn(`Failed to delete media file: ${filePath}`, error);
    }

    // Delete thumbnail if it exists
    if (mediaFile.thumbnail_path) {
      const thumbnailPath = this.getThumbnailPath(mediaFile);
      if (thumbnailPath) {
        try {
          await unlink(thumbnailPath);
        } catch (error) {
          console.warn(`Failed to delete thumbnail: ${thumbnailPath}`, error);
        }
      }
    }
  }

  /**
   * Get MIME type for file serving
   */
  getMimeType(mediaFile: MediaFile): string {
    return mediaFile.mime_type;
  }

  /**
   * Check if file exists
   */
  async fileExists(mediaFile: MediaFile): Promise<boolean> {
    const filePath = this.getFilePath(mediaFile);
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

// Export singleton instance
export const mediaService = new MediaService();