/**
 * Media Service
 * Handles media file operations, metadata extraction, and thumbnail generation
 */

import { promisify } from 'util';
import { execFile as execFileCallback } from 'child_process';
import path from 'path';
import sharp from 'sharp';
import { getDatabase } from '../database/connection';
import { config } from '../config/config';
import { storageService, StorageFileInfo } from './storage.service';
import { notificationService } from './notification.service';
import {
  MediaFile,
  CreateMediaInput,
  PaginationParams,
  PaginatedResult,
  MediaFilter,
} from '../database/types';
import { getLogger } from '../utils/logger';
import { AppError, ErrorCode } from '../api/middleware/error-handler';
import { postProcessSemaphore, thumbnailSemaphore } from './processing-limits';

const execFile = promisify(execFileCallback);
const logger = getLogger();

export interface MediaMetadata {
  duration?: number;
  width?: number;
  height?: number;
  codec?: string;
  bitrate?: number;
}

export class MediaService {
  /**
   * Determines media type from MIME type
   */
  private getMediaType(mimeType: string): 'video' | 'image' {
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('image/')) return 'image';
    throw new AppError(ErrorCode.INVALID_MEDIA_TYPE, `Unsupported media type: ${mimeType}`, 400);
  }

  /**
   * Extracts metadata from a video file using ffprobe
   */
  private async extractVideoMetadata(filePath: string): Promise<MediaMetadata> {
    try {
      const { stdout } = await execFile('ffprobe', [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ]);

      const data = JSON.parse(stdout);
      const videoStream = data.streams?.find(
        (s: { codec_type: string }) => s.codec_type === 'video'
      );

      const metadata: MediaMetadata = {
        duration: data.format?.duration ? parseFloat(data.format.duration) : undefined,
        width: videoStream?.width,
        height: videoStream?.height,
        codec: videoStream?.codec_name,
        bitrate: data.format?.bit_rate ? parseInt(data.format.bit_rate, 10) : undefined,
      };

      return metadata;
    } catch (error) {
      logger.error('Failed to extract video metadata:', error);
      return {};
    }
  }

  /**
   * Extracts metadata from an image file using sharp
   */
  private async extractImageMetadata(filePath: string): Promise<MediaMetadata> {
    try {
      const metadata = await sharp(filePath).metadata();
      return {
        width: metadata.width,
        height: metadata.height,
      };
    } catch (error) {
      logger.error('Failed to extract image metadata:', error);
      return {};
    }
  }

  /**
   * Generates a thumbnail for a video file using ffmpeg
   */
  private async generateVideoThumbnail(
    filePath: string,
    mediaFilename: string
  ): Promise<string | null> {
    const tempDir = path.resolve(config.storage.path, 'temp');
    const tempOutput = path.join(tempDir, `thumb_${Date.now()}.jpg`);
    try {
      // Extract frame at 1 second (or 10% of duration)
      await execFile('ffmpeg', [
        '-i',
        filePath,
        '-ss',
        '00:00:01.000',
        '-vframes',
        '1',
        '-vf',
        'scale=320:-1',
        tempOutput,
      ]);

      // Read the generated thumbnail and save it properly
      const sharp_instance = sharp(tempOutput);
      const buffer = await sharp_instance.jpeg({ quality: 80 }).toBuffer();
      const thumbnailPath = await storageService.saveThumbnail(buffer, mediaFilename);

      return thumbnailPath;
    } catch (error) {
      logger.error('Failed to generate video thumbnail:', error);
      return null;
    } finally {
      // Clean up temp ffmpeg output
      const fs = await import('fs/promises');
      await fs.unlink(tempOutput).catch(() => {});
    }
  }

  /**
   * Generates a thumbnail for an image file using sharp
   */
  private async generateImageThumbnail(
    filePath: string,
    mediaFilename: string
  ): Promise<string | null> {
    try {
      const buffer = await sharp(filePath)
        .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();

      const thumbnailPath = await storageService.saveThumbnail(buffer, mediaFilename);
      return thumbnailPath;
    } catch (error) {
      logger.error('Failed to generate image thumbnail:', error);
      return null;
    }
  }

  /**
   * Creates a new media file entry
   */
  async createMedia(
    file: Express.Multer.File,
    options?: { folderId?: number | null }
  ): Promise<MediaFile> {
    try {
      // Save file to storage
      const storageInfo: StorageFileInfo = await storageService.saveUploadedFile(file);

      // Determine media type
      const mediaType = this.getMediaType(file.mimetype);

      // Get full path for metadata extraction
      const fullPath = storageService.getFullPath(storageInfo.filepath);

      // Extract metadata based on type
      let metadata: MediaMetadata = {};
      if (mediaType === 'video') {
        metadata = await this.extractVideoMetadata(fullPath);
      } else if (mediaType === 'image') {
        metadata = await this.extractImageMetadata(fullPath);
      }

      // Check for duplicate by checksum
      const db = await getDatabase();
      const existingMedia = await db.getMediaByChecksum(storageInfo.checksum);
      if (existingMedia) {
        // Delete the newly uploaded file since it's a duplicate
        await storageService.deleteFile(storageInfo.filepath);
        throw new AppError(
          ErrorCode.RESOURCE_ALREADY_EXISTS,
          'A media file with the same content already exists',
          409,
          true,
          { existingMediaId: existingMedia.id }
        );
      }

      // If a folder was requested, make sure it exists. Bad folder_id = 400
      // rather than relying on the FK to throw a cryptic error later.
      if (options?.folderId != null) {
        const folder = await db.getMediaFolderById(options.folderId);
        if (!folder) {
          await storageService.deleteFile(storageInfo.filepath);
          throw new AppError(
            ErrorCode.FOLDER_NOT_FOUND,
            `Folder with ID ${options.folderId} not found`,
            404
          );
        }
      }

      // Create media entry in database
      const input: CreateMediaInput = {
        filename: storageInfo.filename,
        original_filename: file.originalname,
        filepath: storageInfo.filepath,
        type: mediaType,
        mime_type: file.mimetype,
        file_size: storageInfo.size,
        duration: metadata.duration,
        width: metadata.width,
        height: metadata.height,
        checksum: storageInfo.checksum,
        folder_id: options?.folderId ?? null,
      };

      const media = await db.createMedia(input);

      // Generate thumbnail asynchronously (don't wait for it)
      this.generateThumbnailAsync(media.id, fullPath, storageInfo.filename, mediaType);

      this.fireApprovalNeededIfPending(media);

      logger.info(`Media created: ${media.id} - ${media.filename}`);
      return media;
    } catch (error) {
      // If error occurs after file save, clean up the file
      if (error instanceof AppError && error.code !== ErrorCode.RESOURCE_ALREADY_EXISTS) {
        // File cleanup already handled in duplicate case
      }
      throw error;
    }
  }

  /**
   * Creates a media entry from pre-stored file info (used by chunked uploads)
   */
  async createMediaFromStorageInfo(
    storageInfo: StorageFileInfo,
    originalFilename: string,
    mimeType: string,
    options?: { folderId?: number | null }
  ): Promise<MediaFile> {
    const mediaType = this.getMediaType(mimeType);

    // Extract metadata — skip temp download for large files (>500MB) to avoid timeout.
    // Gated by a global semaphore: three concurrent downloads of 500MB Spaces
    // files + ffprobe each OOM-killed the container.
    let metadata: MediaMetadata = {};
    let localPath: string | null = null;
    const MAX_METADATA_SIZE = 500 * 1024 * 1024;
    if (storageInfo.size <= MAX_METADATA_SIZE) {
      await postProcessSemaphore.run(async () => {
        try {
          localPath = await storageService.downloadToTemp(storageInfo.filepath);
          if (mediaType === 'video') {
            metadata = await this.extractVideoMetadata(localPath);
          } else if (mediaType === 'image') {
            metadata = await this.extractImageMetadata(localPath);
          }
          // Clean up temp file for Spaces backend
          if (config.storage.backend === 'spaces') {
            const fs = await import('fs/promises');
            await fs.unlink(localPath).catch(() => {});
            localPath = null;
          }
        } catch (error) {
          logger.warn(`Failed to extract metadata for ${originalFilename}:`, error);
        }
      });
    } else {
      logger.info(
        `Skipping metadata extraction for large file (${Math.round(storageInfo.size / 1024 / 1024)}MB): ${originalFilename}`
      );
    }

    // Check for duplicate by checksum
    const db = await getDatabase();
    const existingMedia = await db.getMediaByChecksum(storageInfo.checksum);
    if (existingMedia) {
      await storageService.deleteFile(storageInfo.filepath);
      throw new AppError(
        ErrorCode.RESOURCE_ALREADY_EXISTS,
        'A media file with the same content already exists',
        409,
        true,
        { existingMediaId: existingMedia.id }
      );
    }

    if (options?.folderId != null) {
      const folder = await db.getMediaFolderById(options.folderId);
      if (!folder) {
        await storageService.deleteFile(storageInfo.filepath);
        throw new AppError(
          ErrorCode.FOLDER_NOT_FOUND,
          `Folder with ID ${options.folderId} not found`,
          404
        );
      }
    }

    const input: CreateMediaInput = {
      filename: storageInfo.filename,
      original_filename: originalFilename,
      filepath: storageInfo.filepath,
      type: mediaType,
      mime_type: mimeType,
      file_size: storageInfo.size,
      duration: metadata.duration,
      width: metadata.width,
      height: metadata.height,
      checksum: storageInfo.checksum,
      folder_id: options?.folderId ?? null,
    };

    const media = await db.createMedia(input);

    if (localPath) {
      this.generateThumbnailAsync(media.id, localPath, storageInfo.filename, mediaType);
    }

    this.fireApprovalNeededIfPending(media);

    logger.info(`Media created from chunked upload: ${media.id} - ${media.filename}`);
    return media;
  }

  private fireApprovalNeededIfPending(media: MediaFile): void {
    if (media.approval_status !== 'pending') return;
    notificationService
      .fireEvent('media_approval_needed', {
        media_id: media.id,
        filename: media.original_filename || media.filename,
        type: media.type,
        file_size: media.file_size,
      })
      .catch((err) => {
        logger.warn(
          `Failed to fire media_approval_needed for media ${media.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  }

  /**
   * Generates thumbnail asynchronously and persists status to the database.
   */
  private generateThumbnailAsync(
    mediaId: number,
    filePath: string,
    filename: string,
    type: 'video' | 'image'
  ): void {
    // Fire-and-forget: the returned promise MUST have a terminal .catch so
    // any unexpected throw (e.g. dynamic import failure in finally) can't
    // reach process.on('unhandledRejection').
    //
    // Serialised by thumbnailSemaphore (default 1) to keep ffmpeg/ffprobe
    // off the OOM killer's radar when multiple uploads finish back-to-back.
    void thumbnailSemaphore
      .run(async () => {
        let sourcePath = filePath;
        let needsCleanup = false;
        try {
          // Mark as generating
          const db = await getDatabase();
          await db.updateMedia(mediaId, {
            thumbnail_status: 'generating',
          } as Partial<CreateMediaInput>);

          // For Spaces, download source file from S3 (filePath may not exist locally)
          if (config.storage.backend === 'spaces') {
            const media = await db.getMediaById(mediaId);
            if (!media) throw new Error(`Media ${mediaId} not found`);
            sourcePath = await storageService.downloadToTemp(media.filepath);
            needsCleanup = true;
          }

          let thumbnailPath: string | null = null;
          if (type === 'video') {
            thumbnailPath = await this.generateVideoThumbnail(sourcePath, filename);
          } else if (type === 'image') {
            thumbnailPath = await this.generateImageThumbnail(sourcePath, filename);
          }

          if (thumbnailPath) {
            await db.updateMedia(mediaId, {
              thumbnail_status: 'generated',
            } as Partial<CreateMediaInput>);
            logger.info(`Thumbnail generated for media ${mediaId}: ${thumbnailPath}`);
          } else {
            await db.updateMedia(mediaId, {
              thumbnail_status: 'failed',
            } as Partial<CreateMediaInput>);
          }
        } catch (error) {
          logger.error(`Failed to generate thumbnail for media ${mediaId}:`, error);
          try {
            const db = await getDatabase();
            await db.updateMedia(mediaId, {
              thumbnail_status: 'failed',
            } as Partial<CreateMediaInput>);
          } catch (updateError) {
            logger.error(
              `Failed to update thumbnail_status to failed for media ${mediaId}:`,
              updateError
            );
          }
        } finally {
          if (needsCleanup) {
            try {
              const fs = await import('fs/promises');
              await fs.unlink(sourcePath).catch(() => {});
            } catch (cleanupError) {
              logger.warn(`Thumbnail temp cleanup failed for media ${mediaId}:`, cleanupError);
            }
          }
        }
      })
      .catch((err) => {
        logger.error(`Unhandled error in generateThumbnailAsync for media ${mediaId}:`, err);
      });
  }

  /**
   * Retries thumbnail generation for a failed media file.
   */
  async retryThumbnail(id: number): Promise<MediaFile> {
    const media = await this.getMediaById(id);

    if (media.thumbnail_status !== 'failed') {
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        `Cannot retry thumbnail: current status is '${media.thumbnail_status}'`,
        400
      );
    }

    const db = await getDatabase();
    await db.updateMedia(id, { thumbnail_status: 'pending' } as Partial<CreateMediaInput>);

    const fullPath = storageService.getFullPath(media.filepath);
    this.generateThumbnailAsync(id, fullPath, media.filename, media.type);

    return this.getMediaById(id);
  }

  /**
   * Gets a media file by ID
   */
  async getMediaById(id: number): Promise<MediaFile> {
    const db = await getDatabase();
    const media = await db.getMediaById(id);

    if (!media) {
      throw new AppError(ErrorCode.MEDIA_NOT_FOUND, `Media file with ID ${id} not found`, 404);
    }

    return media;
  }

  /**
   * Gets all media files with pagination and filters
   */
  async getAllMedia(
    pagination: PaginationParams,
    filter?: MediaFilter
  ): Promise<PaginatedResult<MediaFile>> {
    const db = await getDatabase();
    return db.getAllMedia(pagination, filter);
  }

  /**
   * Deletes a media file
   */
  async deleteMedia(id: number): Promise<void> {
    const media = await this.getMediaById(id);

    const db = await getDatabase();

    // Delete from database first (this will fail if media is in use due to foreign keys)
    await db.deleteMedia(id);

    // Delete file from storage
    await storageService.deleteFile(media.filepath);

    // Try to delete thumbnail if exists
    const thumbnailPath = await storageService.getThumbnailPath(media.filename);
    if (thumbnailPath) {
      await storageService.deleteFile(thumbnailPath);
    }

    logger.info(`Media deleted: ${id} - ${media.filename}`);
  }

  /**
   * Gets the file path for a media file
   */
  async getMediaFilePath(id: number): Promise<string> {
    const media = await this.getMediaById(id);
    const fullPath = storageService.getFullPath(media.filepath);

    // Verify file exists
    if (!(await storageService.fileExists(media.filepath))) {
      throw new AppError(
        ErrorCode.MEDIA_NOT_FOUND,
        `Media file not found on disk: ${media.filename}`,
        404
      );
    }

    return fullPath;
  }

  /**
   * Gets or generates thumbnail for a media file
   */
  async getMediaThumbnail(id: number): Promise<string> {
    const media = await this.getMediaById(id);

    // Check if thumbnail already exists
    let thumbnailPath = await storageService.getThumbnailPath(media.filename);

    if (!thumbnailPath) {
      // Generate thumbnail on-demand. On Spaces this re-downloads the full
      // source (can be 500MB+), so serialise through the thumbnail semaphore —
      // browsers commonly fire 5-10 parallel /thumbnail requests at page load
      // and that burst previously OOM-killed the container.
      thumbnailPath = await thumbnailSemaphore.run(async () => {
        // Re-check inside the semaphore: a prior waiter may have just
        // generated this exact thumbnail while we were queued.
        const already = await storageService.getThumbnailPath(media.filename);
        if (already) return already;

        const sourcePath = await storageService.downloadToTemp(media.filepath);
        let generated: string | null = null;
        try {
          if (media.type === 'video') {
            generated = await this.generateVideoThumbnail(sourcePath, media.filename);
          } else if (media.type === 'image') {
            generated = await this.generateImageThumbnail(sourcePath, media.filename);
          }
        } finally {
          // Clean up downloaded temp file for Spaces
          if (config.storage.backend === 'spaces') {
            const fs = await import('fs/promises');
            await fs.unlink(sourcePath).catch(() => {});
          }
        }
        return generated;
      });

      if (!thumbnailPath) {
        // Mark as failed so the UI can surface the retry button and stop
        // hammering this endpoint on every render.
        try {
          const db = await getDatabase();
          await db.updateMedia(id, {
            thumbnail_status: 'failed',
          } as Partial<CreateMediaInput>);
        } catch (err) {
          logger.warn(`Failed to mark media ${id} thumbnail as failed:`, err);
        }
        throw new AppError(ErrorCode.MEDIA_NOT_FOUND, 'Failed to generate thumbnail', 500);
      }
    }

    // For Spaces, return S3 key (caller will redirect to CDN); for local, return absolute path
    if (config.storage.backend === 'spaces') {
      return thumbnailPath;
    }
    return storageService.getFullPath(thumbnailPath);
  }

  /**
   * Gets media statistics
   */
  async getMediaStats(): Promise<{
    total: number;
    videos: number;
    images: number;
    totalSize: number;
  }> {
    const db = await getDatabase();
    const allMedia = await db.getAllMedia({ page: 1, limit: 10000 });

    const stats = {
      total: allMedia.pagination.total,
      videos: 0,
      images: 0,
      totalSize: 0,
    };

    allMedia.data.forEach((media) => {
      if (media.type === 'video') stats.videos += 1;
      if (media.type === 'image') stats.images += 1;
      stats.totalSize += media.file_size || 0;
    });

    return stats;
  }
}

// Export singleton instance
export const mediaService = new MediaService();
