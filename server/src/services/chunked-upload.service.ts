/**
 * Chunked Upload Service
 * Manages chunked file upload sessions for both local and S3/Spaces backends.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';
import { config } from '../config/config';
import { storageService, StorageFileInfo } from './storage.service';
import { getLogger } from '../utils/logger';
import { AppError, ErrorCode } from '../api/middleware/error-handler';

const logger = getLogger();

interface UploadSession {
  uploadId: string;
  s3UploadId?: string;
  s3Key?: string;
  originalFilename: string;
  mimeType: string;
  totalSize: number;
  totalChunks: number;
  chunkSize: number;
  receivedChunks: Map<number, { etag?: string; size: number }>;
  localChunkDir?: string;
  createdAt: number;
  lastActivity: number;
}

interface InitUploadResult {
  uploadId: string;
  chunkSize: number;
  totalChunks: number;
}

interface ChunkUploadResult {
  received: number;
  total: number;
}

class ChunkedUploadService {
  private sessions: Map<string, UploadSession> = new Map();

  /**
   * Initializes a new chunked upload session.
   */
  async initUpload(
    filename: string,
    mimeType: string,
    totalSize: number
  ): Promise<InitUploadResult> {
    const uploadId = crypto.randomUUID();
    const chunkSizeMB = config.storage.chunkSizeMB;
    const chunkSize = chunkSizeMB * 1024 * 1024;
    const totalChunks = Math.ceil(totalSize / chunkSize);
    const backend = config.storage.backend;

    const session: UploadSession = {
      uploadId,
      originalFilename: filename,
      mimeType,
      totalSize,
      totalChunks,
      chunkSize,
      receivedChunks: new Map(),
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    if (backend === 'spaces') {
      const uniqueFilename = storageService.generateUniqueFilename(filename);
      const s3Key = `media/${uniqueFilename}`;
      const s3UploadId = await storageService.initMultipartUpload(s3Key);
      session.s3UploadId = s3UploadId;
      session.s3Key = s3Key;
    } else {
      const chunkDir = path.join(path.resolve(config.storage.path), 'temp', `chunks_${uploadId}`);
      await fs.mkdir(chunkDir, { recursive: true });
      session.localChunkDir = chunkDir;
    }

    this.sessions.set(uploadId, session);

    logger.info(
      `Chunked upload initialized: uploadId=${uploadId}, file=${filename}, ` +
        `totalSize=${totalSize}, totalChunks=${totalChunks}, backend=${backend}`
    );

    return { uploadId, chunkSize, totalChunks };
  }

  /**
   * Receives and stores a single chunk.
   */
  async uploadChunk(
    uploadId: string,
    chunkIndex: number,
    buffer: Buffer
  ): Promise<ChunkUploadResult> {
    const session = this.getSession(uploadId);
    const backend = config.storage.backend;

    if (chunkIndex < 0 || chunkIndex >= session.totalChunks) {
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        `Invalid chunk index ${chunkIndex}. Must be between 0 and ${session.totalChunks - 1}.`,
        400
      );
    }

    if (backend === 'spaces') {
      const partNumber = chunkIndex + 1;
      const etag = await storageService.uploadPart(
        session.s3Key!,
        session.s3UploadId!,
        partNumber,
        buffer
      );
      session.receivedChunks.set(chunkIndex, { etag, size: buffer.length });
    } else {
      const chunkPath = path.join(session.localChunkDir!, `chunk_${chunkIndex}`);
      await fs.writeFile(chunkPath, buffer);
      session.receivedChunks.set(chunkIndex, { size: buffer.length });
    }

    session.lastActivity = Date.now();

    logger.info(
      `Chunk received: uploadId=${uploadId}, chunk=${chunkIndex + 1}/${session.totalChunks}`
    );

    return {
      received: session.receivedChunks.size,
      total: session.totalChunks,
    };
  }

  /**
   * Completes an upload session by assembling all chunks.
   */
  async completeUpload(
    uploadId: string
  ): Promise<{ storageInfo: StorageFileInfo; originalFilename: string; mimeType: string }> {
    const session = this.getSession(uploadId);
    const backend = config.storage.backend;

    if (session.receivedChunks.size !== session.totalChunks) {
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        `Upload incomplete: received ${session.receivedChunks.size} of ${session.totalChunks} chunks.`,
        400
      );
    }

    let storageInfo: StorageFileInfo;

    if (backend === 'spaces') {
      storageInfo = await this.completeSpacesUpload(session);
    } else {
      storageInfo = await this.completeLocalUpload(session);
    }

    this.sessions.delete(uploadId);

    logger.info(
      `Chunked upload completed: uploadId=${uploadId}, filename=${storageInfo.filename}, ` +
        `size=${storageInfo.size}, checksum=${storageInfo.checksum}`
    );

    return {
      storageInfo,
      originalFilename: session.originalFilename,
      mimeType: session.mimeType,
    };
  }

  /**
   * Aborts an upload session and cleans up resources.
   */
  async abortUpload(uploadId: string): Promise<void> {
    const session = this.sessions.get(uploadId);
    if (!session) {
      return;
    }

    const backend = config.storage.backend;

    try {
      if (backend === 'spaces' && session.s3UploadId) {
        await storageService.abortMultipartUpload(session.s3Key!, session.s3UploadId);
      } else if (session.localChunkDir) {
        await fs.rm(session.localChunkDir, { recursive: true, force: true });
      }
    } catch (error) {
      logger.warn(
        `Error during upload abort cleanup: uploadId=${uploadId}, error=${String(error)}`
      );
    }

    this.sessions.delete(uploadId);

    logger.info(`Chunked upload aborted: uploadId=${uploadId}`);
  }

  /**
   * Cleans up stale upload sessions older than maxAgeMs.
   */
  async cleanupStaleSessions(maxAgeMs: number = 3600000): Promise<void> {
    const now = Date.now();
    const staleIds: string[] = [];

    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > maxAgeMs) {
        staleIds.push(id);
      }
    }

    for (const id of staleIds) {
      logger.info(`Cleaning up stale upload session: uploadId=${id}`);
      await this.abortUpload(id);
    }

    if (staleIds.length > 0) {
      logger.info(`Cleaned up ${staleIds.length} stale upload session(s)`);
    }
  }

  /**
   * Retrieves an upload session by ID.
   * @throws AppError if session not found.
   */
  getSession(uploadId: string): UploadSession {
    const session = this.sessions.get(uploadId);
    if (!session) {
      throw new AppError(ErrorCode.NOT_FOUND, `Upload session not found: ${uploadId}`, 404);
    }
    return session;
  }

  /**
   * Completes a Spaces/S3 multipart upload.
   */
  private async completeSpacesUpload(session: UploadSession): Promise<StorageFileInfo> {
    const parts: Array<{ PartNumber: number; ETag: string }> = [];

    for (const [chunkIndex, chunkInfo] of session.receivedChunks) {
      parts.push({
        PartNumber: chunkIndex + 1,
        ETag: chunkInfo.etag!,
      });
    }

    parts.sort((a, b) => a.PartNumber - b.PartNumber);

    await storageService.completeMultipartUpload(session.s3Key!, session.s3UploadId!, parts);

    const totalSize = Array.from(session.receivedChunks.values()).reduce(
      (sum, chunk) => sum + chunk.size,
      0
    );
    const filename = path.basename(session.s3Key!);

    // Compute real checksum by downloading from Spaces (skip for files >500MB)
    const MAX_CHECKSUM_SIZE = 500 * 1024 * 1024;
    let checksum = '';
    if (totalSize <= MAX_CHECKSUM_SIZE) {
      try {
        const tempPath = await storageService.downloadToTemp(session.s3Key!);
        checksum = await this.calculateFileChecksumStream(tempPath);
        await fs.unlink(tempPath).catch(() => {});
        logger.info(`Computed checksum for ${filename}: ${checksum}`);
      } catch (error) {
        logger.warn(`Failed to compute checksum for ${filename}, storing empty: ${error}`);
      }
    } else {
      logger.info(
        `Skipping checksum for large file (${Math.round(totalSize / 1024 / 1024)}MB): ${filename}`
      );
    }

    return {
      filename,
      filepath: session.s3Key!,
      checksum,
      size: totalSize,
    };
  }

  /**
   * Completes a local upload by streaming chunks into a single file,
   * then computing the checksum from the assembled file.
   */
  private async completeLocalUpload(session: UploadSession): Promise<StorageFileInfo> {
    const uniqueFilename = storageService.generateUniqueFilename(session.originalFilename);
    const relativeFilepath = path.join('media', uniqueFilename);
    const fullPath = path.join(path.resolve(config.storage.path), relativeFilepath);

    // Stream each chunk sequentially into the output file
    const writeStream = createWriteStream(fullPath);

    try {
      for (let i = 0; i < session.totalChunks; i++) {
        const chunkPath = path.join(session.localChunkDir!, `chunk_${i}`);
        const readStream = createReadStream(chunkPath);
        await pipeline(readStream, writeStream, { end: false });
      }
      writeStream.end();

      // Wait for the write stream to finish
      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
    } catch (error) {
      writeStream.destroy();
      // Clean up partial output file
      try {
        await fs.unlink(fullPath);
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }

    // Compute checksum by streaming the assembled file
    const checksum = await this.calculateFileChecksumStream(fullPath);

    // Get actual file size
    const stats = await fs.stat(fullPath);

    // Clean up chunk directory
    try {
      await fs.rm(session.localChunkDir!, { recursive: true, force: true });
    } catch (error) {
      logger.warn(
        `Failed to clean up chunk directory: ${session.localChunkDir}, error=${String(error)}`
      );
    }

    return {
      filename: uniqueFilename,
      filepath: relativeFilepath,
      checksum,
      size: stats.size,
    };
  }

  /**
   * Computes SHA-256 checksum of a file using streams (memory-efficient).
   */
  private async calculateFileChecksumStream(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = createReadStream(filePath);

      stream.on('data', (data: string | Buffer) => {
        hash.update(data);
      });

      stream.on('end', () => {
        resolve(hash.digest('hex'));
      });

      stream.on('error', (error) => {
        reject(error);
      });
    });
  }
}

export const chunkedUploadService = new ChunkedUploadService();
