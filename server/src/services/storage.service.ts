/**
 * Storage Service
 * Handles file system operations for media files with pluggable storage backends.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable } from 'stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  PutObjectAclCommand,
} from '@aws-sdk/client-s3';
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

export interface IStorageService {
  generateUniqueFilename(originalFilename: string): string;
  saveFile(fileBuffer: Buffer, originalFilename: string): Promise<StorageFileInfo>;
  saveUploadedFile(file: Express.Multer.File): Promise<StorageFileInfo>;
  deleteFile(filepath: string): Promise<void>;
  getFullPath(filepath: string): string;
  fileExists(filepath: string): Promise<boolean>;
  calculateChecksum(buffer: Buffer): string;
  calculateFileChecksum(filepath: string): Promise<string>;
  getFileSize(filepath: string): Promise<number>;
  saveThumbnail(buffer: Buffer, mediaFilename: string): Promise<string>;
  getThumbnailPath(mediaFilename: string): Promise<string | null>;
  /** Save a subtitle file. Returns storage-relative filepath (e.g. 'subtitles/<uuid>.srt'). */
  saveSubtitle(buffer: Buffer, originalFilename: string, format: 'srt' | 'vtt'): Promise<StorageFileInfo>;
  cleanupTempFiles(maxAgeMs?: number): Promise<void>;
  getStorageStats(): Promise<{
    totalFiles: number;
    totalSize: number;
    mediaFiles: number;
    thumbnails: number;
  }>;
  getDownloadUrl(filepath: string): string;
  downloadToTemp(filepath: string): Promise<string>;
  initMultipartUpload(key: string): Promise<string>;
  uploadPart(key: string, uploadId: string, partNumber: number, body: Buffer): Promise<string>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ PartNumber: number; ETag: string }>
  ): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}

export class LocalStorageService implements IStorageService {
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
      path.join(this.storagePath, 'previews'),
      path.join(this.storagePath, 'subtitles'),
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

  async saveSubtitle(
    buffer: Buffer,
    _originalFilename: string,
    format: 'srt' | 'vtt'
  ): Promise<StorageFileInfo> {
    const uuid = crypto.randomBytes(16).toString('hex');
    const filename = `${uuid}.${format}`;
    const filepath = path.join('subtitles', filename);
    const fullPath = path.join(this.storagePath, filepath);

    await fs.writeFile(fullPath, buffer);

    const checksum = this.calculateChecksum(buffer);
    const size = buffer.length;

    logger.info(`Subtitle saved: ${filepath} (${size} bytes)`);
    return { filename, filepath, checksum, size };
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

  getDownloadUrl(_filepath: string): string {
    return '';
  }

  downloadToTemp(filepath: string): Promise<string> {
    return Promise.resolve(this.getFullPath(filepath));
  }

  initMultipartUpload(_key: string): Promise<string> {
    return Promise.reject(
      new AppError(
        ErrorCode.BAD_REQUEST,
        'Multipart upload is not supported for local storage',
        400
      )
    );
  }

  uploadPart(_key: string, _uploadId: string, _partNumber: number, _body: Buffer): Promise<string> {
    return Promise.reject(
      new AppError(
        ErrorCode.BAD_REQUEST,
        'Multipart upload is not supported for local storage',
        400
      )
    );
  }

  completeMultipartUpload(
    _key: string,
    _uploadId: string,
    _parts: Array<{ PartNumber: number; ETag: string }>
  ): Promise<void> {
    return Promise.reject(
      new AppError(
        ErrorCode.BAD_REQUEST,
        'Multipart upload is not supported for local storage',
        400
      )
    );
  }

  abortMultipartUpload(_key: string, _uploadId: string): Promise<void> {
    return Promise.reject(
      new AppError(
        ErrorCode.BAD_REQUEST,
        'Multipart upload is not supported for local storage',
        400
      )
    );
  }
}

export class SpacesStorageService implements IStorageService {
  private s3Client: S3Client;

  private bucket: string;

  private endpoint: string;

  private cdnEndpoint: string | undefined;

  private localStoragePath: string;

  constructor() {
    const spacesConfig = config.storage.spaces;
    if (!spacesConfig) {
      throw new Error('Spaces configuration is required for SpacesStorageService');
    }

    this.bucket = spacesConfig.bucket;
    this.endpoint = spacesConfig.endpoint;
    this.cdnEndpoint = spacesConfig.cdnEndpoint;
    this.localStoragePath = path.resolve(config.storage.path);

    this.s3Client = new S3Client({
      endpoint: spacesConfig.endpoint,
      region: spacesConfig.region,
      credentials: {
        accessKeyId: spacesConfig.accessKeyId,
        secretAccessKey: spacesConfig.secretAccessKey,
      },
      forcePathStyle: false,
    });

    this.initializeLocalDirs();
    logger.info(`Spaces storage initialized: bucket=${this.bucket}`);
  }

  private initializeLocalDirs(): void {
    const directories = [
      this.localStoragePath,
      path.join(this.localStoragePath, 'temp'),
      path.join(this.localStoragePath, 'previews'),
    ];

    directories.forEach((dir) => {
      if (!fsSync.existsSync(dir)) {
        fsSync.mkdirSync(dir, { recursive: true });
        logger.info(`Created local directory: ${dir}`);
      }
    });
  }

  generateUniqueFilename(originalFilename: string): string {
    const ext = path.extname(originalFilename);
    const basename = path.basename(originalFilename, ext);
    const timestamp = Date.now();
    const random = crypto.randomBytes(4).toString('hex');
    return `${basename}_${timestamp}_${random}${ext}`;
  }

  async saveFile(fileBuffer: Buffer, originalFilename: string): Promise<StorageFileInfo> {
    const filename = this.generateUniqueFilename(originalFilename);
    const key = `media/${filename}`;

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: fileBuffer,
      })
    );

    // DO Spaces ignores ACL on PutObject, so set it separately
    await this.s3Client.send(
      new PutObjectAclCommand({ Bucket: this.bucket, Key: key, ACL: 'public-read' })
    );

    const checksum = this.calculateChecksum(fileBuffer);
    const size = fileBuffer.length;

    logger.info(`File saved to Spaces: ${key} (${size} bytes)`);

    return {
      filename,
      filepath: key,
      checksum,
      size,
    };
  }

  async saveUploadedFile(file: Express.Multer.File): Promise<StorageFileInfo> {
    const fileBuffer = await fs.readFile(file.path);
    const result = await this.saveFile(fileBuffer, file.originalname);

    await fs.unlink(file.path);

    return result;
  }

  async deleteFile(filepath: string): Promise<void> {
    try {
      await this.s3Client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: filepath,
        })
      );
      logger.info(`File deleted from Spaces: ${filepath}`);
    } catch (error) {
      logger.warn(`Failed to delete file from Spaces: ${filepath}`, { error });
    }
  }

  getFullPath(filepath: string): string {
    const tempPath = path.resolve(this.localStoragePath, 'temp', path.basename(filepath));
    const tempDir = path.resolve(this.localStoragePath, 'temp');
    if (!tempPath.startsWith(tempDir + path.sep) && tempPath !== tempDir) {
      throw new AppError(ErrorCode.FORBIDDEN, 'Invalid file path: path traversal detected', 403);
    }
    return tempPath;
  }

  async fileExists(filepath: string): Promise<boolean> {
    try {
      await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: filepath,
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  calculateChecksum(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  async calculateFileChecksum(filepath: string): Promise<string> {
    const tempPath = await this.downloadToTemp(filepath);
    const buffer = await fs.readFile(tempPath);
    return this.calculateChecksum(buffer);
  }

  async getFileSize(filepath: string): Promise<number> {
    const response = await this.s3Client.send(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: filepath,
      })
    );
    return response.ContentLength ?? 0;
  }

  async saveThumbnail(buffer: Buffer, mediaFilename: string): Promise<string> {
    const ext = '.jpg';
    const basename = path.basename(mediaFilename, path.extname(mediaFilename));
    const filename = `${basename}_thumb${ext}`;
    const key = `thumbnails/${filename}`;

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: 'image/jpeg',
      })
    );
    await this.s3Client.send(
      new PutObjectAclCommand({ Bucket: this.bucket, Key: key, ACL: 'public-read' })
    );

    logger.info(`Thumbnail saved to Spaces: ${key}`);
    return key;
  }

  async getThumbnailPath(mediaFilename: string): Promise<string | null> {
    const basename = path.basename(mediaFilename, path.extname(mediaFilename));
    const filename = `${basename}_thumb.jpg`;
    const key = `thumbnails/${filename}`;

    if (await this.fileExists(key)) {
      return key;
    }
    return null;
  }

  async saveSubtitle(
    buffer: Buffer,
    _originalFilename: string,
    format: 'srt' | 'vtt'
  ): Promise<StorageFileInfo> {
    const uuid = crypto.randomBytes(16).toString('hex');
    const filename = `${uuid}.${format}`;
    const key = `subtitles/${filename}`;
    const contentType = format === 'vtt' ? 'text/vtt' : 'application/x-subrip';

    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      })
    );
    await this.s3Client.send(
      new PutObjectAclCommand({ Bucket: this.bucket, Key: key, ACL: 'public-read' })
    );

    const checksum = this.calculateChecksum(buffer);
    logger.info(`Subtitle saved to Spaces: ${key} (${buffer.length} bytes)`);

    return { filename, filepath: key, checksum, size: buffer.length };
  }

  async cleanupTempFiles(maxAgeMs: number = 3600000): Promise<void> {
    const tempDir = path.join(this.localStoragePath, 'temp');
    let files: string[];
    try {
      files = await fs.readdir(tempDir);
    } catch {
      return;
    }
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

  async getStorageStats(): Promise<{
    totalFiles: number;
    totalSize: number;
    mediaFiles: number;
    thumbnails: number;
  }> {
    let mediaCount = 0;
    let thumbnailCount = 0;
    let totalSize = 0;

    let mediaContinuationToken: string | undefined;
    do {
      const mediaResponse = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: 'media/',
          ContinuationToken: mediaContinuationToken,
        })
      );
      const contents = mediaResponse.Contents ?? [];
      mediaCount += contents.length;
      for (const obj of contents) {
        totalSize += obj.Size ?? 0;
      }
      mediaContinuationToken = mediaResponse.IsTruncated
        ? mediaResponse.NextContinuationToken
        : undefined;
    } while (mediaContinuationToken);

    let thumbContinuationToken: string | undefined;
    do {
      const thumbResponse = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: 'thumbnails/',
          ContinuationToken: thumbContinuationToken,
        })
      );
      thumbnailCount += (thumbResponse.Contents ?? []).length;
      thumbContinuationToken = thumbResponse.IsTruncated
        ? thumbResponse.NextContinuationToken
        : undefined;
    } while (thumbContinuationToken);

    return {
      totalFiles: mediaCount,
      totalSize,
      mediaFiles: mediaCount,
      thumbnails: thumbnailCount,
    };
  }

  getDownloadUrl(filepath: string): string {
    if (this.cdnEndpoint) {
      return `${this.cdnEndpoint}/${filepath}`;
    }
    return `${this.endpoint}/${this.bucket}/${filepath}`;
  }

  async downloadToTemp(filepath: string): Promise<string> {
    const tempPath = this.getFullPath(filepath);

    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: filepath,
      })
    );

    if (!response.Body) {
      throw new AppError(ErrorCode.FILE_NOT_FOUND, `File not found in Spaces: ${filepath}`, 404);
    }

    const readable = response.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of readable) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    await fs.writeFile(tempPath, Buffer.concat(chunks));

    return tempPath;
  }

  async initMultipartUpload(key: string): Promise<string> {
    const response = await this.s3Client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );

    if (!response.UploadId) {
      throw new AppError(ErrorCode.STORAGE_ERROR, 'Failed to initiate multipart upload', 500);
    }

    logger.info(`Multipart upload initiated for ${key}: ${response.UploadId}`);
    return response.UploadId;
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer
  ): Promise<string> {
    const response = await this.s3Client.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: body,
      })
    );

    if (!response.ETag) {
      throw new AppError(ErrorCode.STORAGE_ERROR, `Failed to upload part ${partNumber}`, 500);
    }

    return response.ETag;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ PartNumber: number; ETag: string }>
  ): Promise<void> {
    await this.s3Client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts,
        },
      })
    );

    // Set public-read ACL on the completed object
    await this.s3Client.send(
      new PutObjectAclCommand({ Bucket: this.bucket, Key: key, ACL: 'public-read' })
    );

    logger.info(`Multipart upload completed for ${key}`);
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.s3Client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      })
    );

    logger.warn(`Multipart upload aborted for ${key}: ${uploadId}`);
  }
}

export const storageService: IStorageService =
  config.storage.backend === 'spaces' ? new SpacesStorageService() : new LocalStorageService();
