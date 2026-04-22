/**
 * Chunked Upload Service
 * Manages chunked file upload sessions for both local and S3/Spaces backends.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { createReadStream, createWriteStream } from 'fs';
import { config } from '../config/config';
import { storageService } from './storage.service';
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
  folderId: number | null;
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
    totalSize: number,
    folderId: number | null = null
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
      folderId,
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
   * Stream a chunk body directly from the HTTP request to the local chunk
   * file, bypassing the in-memory `Buffer` entirely. Essential for large
   * chunk sizes (e.g. CHUNK_SIZE_MB=200) where buffering the body OOM-kills
   * the container under concurrent uploads. Local backend only — S3 multipart
   * parts still require a buffered `PutPart` with Content-Length.
   */
  async streamChunkFromRequest(
    uploadId: string,
    chunkIndex: number,
    req: Readable
  ): Promise<ChunkUploadResult> {
    const session = this.getSession(uploadId);

    if (chunkIndex < 0 || chunkIndex >= session.totalChunks) {
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        `Invalid chunk index ${chunkIndex}. Must be between 0 and ${session.totalChunks - 1}.`,
        400
      );
    }
    if (!session.localChunkDir) {
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        'Streaming chunk upload is only supported for the local storage backend',
        400
      );
    }

    const chunkPath = path.join(session.localChunkDir, `chunk_${chunkIndex}`);

    try {
      await pipeline(req, createWriteStream(chunkPath));
    } catch (error) {
      // Partial file on disk is useless — unlink so a retry starts clean.
      await fs.unlink(chunkPath).catch(() => undefined);
      throw error;
    }

    const stat = await fs.stat(chunkPath);
    session.receivedChunks.set(chunkIndex, { size: stat.size });
    session.lastActivity = Date.now();

    logger.info(
      `Chunk received (streamed): uploadId=${uploadId}, chunk=${chunkIndex + 1}/${session.totalChunks}, size=${stat.size}`
    );

    return {
      received: session.receivedChunks.size,
      total: session.totalChunks,
    };
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
   * Finalises an upload session's storage (S3 multipart complete OR local
   * chunk concatenation) and returns the handle the completion-queue job
   * needs to carry on. Intentionally does NOT compute checksum, run ffprobe,
   * or create the media row — all slow work moved to the upload-completion
   * queue so this stays well under Cloudflare's 100 s origin timeout even
   * for 100 GB uploads.
   */
  async completeUpload(uploadId: string): Promise<{
    storageBackend: 'spaces' | 'local';
    storageKey: string;
    filename: string;
    totalSize: number;
    originalFilename: string;
    mimeType: string;
    folderId: number | null;
  }> {
    const session = this.getSession(uploadId);
    const backend = config.storage.backend;

    if (session.receivedChunks.size !== session.totalChunks) {
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        `Upload incomplete: received ${session.receivedChunks.size} of ${session.totalChunks} chunks.`,
        400
      );
    }

    const storage =
      backend === 'spaces'
        ? await this.finalizeSpacesUpload(session)
        : await this.finalizeLocalUpload(session);

    this.sessions.delete(uploadId);

    logger.info(
      `Chunked upload finalised: uploadId=${uploadId}, filename=${storage.filename}, ` +
        `size=${storage.totalSize}`
    );

    return {
      storageBackend: backend,
      storageKey: storage.storageKey,
      filename: storage.filename,
      totalSize: storage.totalSize,
      originalFilename: session.originalFilename,
      mimeType: session.mimeType,
      folderId: session.folderId,
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
   * Remove `temp/chunks_*` directories left over from previous server
   * lifecycles. Age-gated — only wipes dirs whose mtime is older than
   * `minAgeMs` so that a crash-loop restart can't delete chunk data
   * the user is still actively streaming in. A fresh restart reclaiming
   * genuine orphans on the next pass is fine.
   */
  async cleanupOrphanedChunks(minAgeMs: number = 60 * 60 * 1000): Promise<void> {
    const tempDir = path.join(path.resolve(config.storage.path), 'temp');
    let entries: string[];
    try {
      entries = await fs.readdir(tempDir);
    } catch {
      return;
    }
    const cutoff = Date.now() - minAgeMs;
    let removed = 0;
    let skipped = 0;
    for (const entry of entries) {
      if (!entry.startsWith('chunks_')) continue;
      const full = path.join(tempDir, entry);
      try {
        const stat = await fs.stat(full);
        if (stat.mtimeMs > cutoff) {
          skipped += 1;
          continue;
        }
        await fs.rm(full, { recursive: true, force: true });
        removed += 1;
      } catch (error) {
        logger.warn(`Failed to clean orphaned chunk dir ${full}: ${String(error)}`);
      }
    }
    if (removed > 0 || skipped > 0) {
      logger.info(
        `Orphan chunk cleanup: removed ${removed}, preserved ${skipped} (younger than ${minAgeMs}ms)`
      );
    }
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
   * Finish the S3 multipart upload. Just CompleteMultipartUpload — no
   * checksum download. Typically <10 s even for 2000 parts.
   */
  private async finalizeSpacesUpload(
    session: UploadSession
  ): Promise<{ storageKey: string; filename: string; totalSize: number }> {
    const parts: Array<{ PartNumber: number; ETag: string }> = [];
    for (const [chunkIndex, chunkInfo] of session.receivedChunks) {
      parts.push({ PartNumber: chunkIndex + 1, ETag: chunkInfo.etag! });
    }
    parts.sort((a, b) => a.PartNumber - b.PartNumber);

    await storageService.completeMultipartUpload(session.s3Key!, session.s3UploadId!, parts);

    const totalSize = Array.from(session.receivedChunks.values()).reduce(
      (sum, chunk) => sum + chunk.size,
      0
    );
    return {
      storageKey: session.s3Key!,
      filename: path.basename(session.s3Key!),
      totalSize,
    };
  }

  /**
   * Stream-concat chunks into the final local file. Also deletes the
   * chunk directory. No checksum here — the queue worker handles that.
   */
  private async finalizeLocalUpload(
    session: UploadSession
  ): Promise<{ storageKey: string; filename: string; totalSize: number }> {
    const uniqueFilename = storageService.generateUniqueFilename(session.originalFilename);
    const relativeFilepath = path.join('media', uniqueFilename);
    const fullPath = path.join(path.resolve(config.storage.path), relativeFilepath);

    const writeStream = createWriteStream(fullPath);
    try {
      for (let i = 0; i < session.totalChunks; i++) {
        const chunkPath = path.join(session.localChunkDir!, `chunk_${i}`);
        const readStream = createReadStream(chunkPath);
        await pipeline(readStream, writeStream, { end: false });
      }
      writeStream.end();
      await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
    } catch (error) {
      writeStream.destroy();
      await fs.unlink(fullPath).catch(() => {});
      throw error;
    }

    const stats = await fs.stat(fullPath);

    try {
      await fs.rm(session.localChunkDir!, { recursive: true, force: true });
    } catch (error) {
      logger.warn(
        `Failed to clean up chunk directory: ${session.localChunkDir}, error=${String(error)}`
      );
    }

    return {
      storageKey: relativeFilepath,
      filename: uniqueFilename,
      totalSize: stats.size,
    };
  }
}

export const chunkedUploadService = new ChunkedUploadService();
