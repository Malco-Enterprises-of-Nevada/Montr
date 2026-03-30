/**
 * Storage Service
 * Handles file system operations for media files
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config/config';
import { getLogger } from '../utils/logger';
import { AppError, ErrorCode } from '../api/middleware/error-handler';

const logger = getLogger();

export interface StorageFileInfo {
  filename: string;
  filepath: string;
  checksum: string;
  size: number;
}

export class StorageService {
  private storagePath: string;

  constructor() {
    this.storagePath = path.resolve(config.storage.path);
    this.initializeStorage();
  }

  /**
   * Initializes storage directories
   */
  private initializeStorage(): void {
    const directories = [
      this.storagePath,
      path.join(this.storagePath, 'media'),
      path.join(this.storagePath, 'thumbnails'),
      path.join(this.storagePath, 'temp'),
    ];

    directories.forEach((dir) => {
      if (!fsSync.existsSync(dir)) {
        fsSync.mkdirSync(dir, { recursive: true });
        logger.info(`Created storage directory: ${dir}`);
      }
    });
  }

  /**
   * Generates a unique filename based on original name
   */
  generateUniqueFilename(originalFilename: string): string {
    const ext = path.extname(originalFilename);
    const basename = path.basename(originalFilename, ext);
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `${basename}_${timestamp}_${random}${ext}`;
  }

  /**
   * Saves a file to storage
   * @param fileBuffer - File buffer to save
   * @param originalFilename - Original filename
   * @returns Storage file information
   */
  async saveFile(fileBuffer: Buffer, originalFilename: string): Promise<StorageFileInfo> {
    const filename = this.generateUniqueFilename(originalFilename);
    const filepath = path.join('media', filename);
    const fullPath = path.join(this.storagePath, filepath);

    await fs.writeFile(fullPath, fileBuffer);

    const checksum = this.calculateChecksum(fileBuffer);
    const size = fileBuffer.length;

    logger.info(`File saved: ${filepath} (${size} bytes)`);

    return {
      filename,
      filepath,
      checksum,
      size,
    };
  }

  /**
   * Saves an uploaded file (from multer) to storage
   * @param file - Multer file object
   * @returns Storage file information
   */
  async saveUploadedFile(file: Express.Multer.File): Promise<StorageFileInfo> {
    const fileBuffer = await fs.readFile(file.path);
    const result = await this.saveFile(fileBuffer, file.originalname);

    // Clean up temp file
    await fs.unlink(file.path);

    return result;
  }

  /**
   * Deletes a file from storage
   * @param filepath - Relative file path in storage
   */
  async deleteFile(filepath: string): Promise<void> {
    const fullPath = this.getFullPath(filepath);

    try {
      await fs.unlink(fullPath);
      logger.info(`File deleted: ${filepath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      logger.warn(`File not found for deletion: ${filepath}`);
    }
  }

  /**
   * Gets the full path for a file
   * @param filepath - Relative file path in storage
   * @returns Full file system path
   */
  getFullPath(filepath: string): string {
    const fullPath = path.resolve(this.storagePath, filepath);
    const storageDir = path.resolve(this.storagePath);
    if (!fullPath.startsWith(storageDir + path.sep) && fullPath !== storageDir) {
      throw new AppError(ErrorCode.FORBIDDEN, 'Invalid file path: path traversal detected', 403);
    }
    return fullPath;
  }

  /**
   * Checks if a file exists
   * @param filepath - Relative file path in storage
   * @returns True if file exists
   */
  async fileExists(filepath: string): Promise<boolean> {
    const fullPath = this.getFullPath(filepath);
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Calculates SHA-256 checksum of a buffer
   * @param buffer - File buffer
   * @returns Checksum as hex string
   */
  calculateChecksum(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Calculates checksum of a file on disk
   * @param filepath - Relative file path in storage
   * @returns Checksum as hex string
   */
  async calculateFileChecksum(filepath: string): Promise<string> {
    const fullPath = this.getFullPath(filepath);
    const buffer = await fs.readFile(fullPath);
    return this.calculateChecksum(buffer);
  }

  /**
   * Gets file size
   * @param filepath - Relative file path in storage
   * @returns File size in bytes
   */
  async getFileSize(filepath: string): Promise<number> {
    const fullPath = this.getFullPath(filepath);
    const stats = await fs.stat(fullPath);
    return stats.size;
  }

  /**
   * Saves a thumbnail image
   * @param buffer - Thumbnail image buffer
   * @param mediaFilename - Original media filename (used to generate thumbnail name)
   * @returns Thumbnail filepath
   */
  async saveThumbnail(buffer: Buffer, mediaFilename: string): Promise<string> {
    const ext = '.jpg';
    const basename = path.basename(mediaFilename, path.extname(mediaFilename));
    const filename = `${basename}_thumb${ext}`;
    const filepath = path.join('thumbnails', filename);
    const fullPath = path.join(this.storagePath, filepath);

    await fs.writeFile(fullPath, buffer);
    logger.info(`Thumbnail saved: ${filepath}`);

    return filepath;
  }

  /**
   * Gets thumbnail path for a media file
   * @param mediaFilename - Media filename
   * @returns Thumbnail filepath or null if doesn't exist
   */
  async getThumbnailPath(mediaFilename: string): Promise<string | null> {
    const basename = path.basename(mediaFilename, path.extname(mediaFilename));
    const filename = `${basename}_thumb.jpg`;
    const filepath = path.join('thumbnails', filename);

    if (await this.fileExists(filepath)) {
      return filepath;
    }
    return null;
  }

  /**
   * Cleans up temporary files older than specified age
   * @param maxAgeMs - Maximum age in milliseconds (default: 1 hour)
   */
  async cleanupTempFiles(maxAgeMs: number = 3600000): Promise<void> {
    const tempDir = path.join(this.storagePath, 'temp');
    const files = await fs.readdir(tempDir);
    const now = Date.now();

    let cleaned = 0;
    for (const file of files) {
      const filePath = path.join(tempDir, file);
      const stats = await fs.stat(filePath);

      if (now - stats.mtimeMs > maxAgeMs) {
        await fs.unlink(filePath);
        cleaned += 1;
      }
    }

    if (cleaned > 0) {
      logger.info(`Cleaned up ${cleaned} temporary file(s)`);
    }
  }

  /**
   * Gets storage statistics
   * @returns Storage usage information
   */
  async getStorageStats(): Promise<{
    totalFiles: number;
    totalSize: number;
    mediaFiles: number;
    thumbnails: number;
  }> {
    const mediaDir = path.join(this.storagePath, 'media');
    const thumbnailDir = path.join(this.storagePath, 'thumbnails');

    const mediaFiles = await fs.readdir(mediaDir);
    const thumbnails = await fs.readdir(thumbnailDir);

    let totalSize = 0;
    for (const file of mediaFiles) {
      const stats = await fs.stat(path.join(mediaDir, file));
      totalSize += stats.size;
    }

    return {
      totalFiles: mediaFiles.length,
      totalSize,
      mediaFiles: mediaFiles.length,
      thumbnails: thumbnails.length,
    };
  }
}

// Export singleton instance
export const storageService = new StorageService();
