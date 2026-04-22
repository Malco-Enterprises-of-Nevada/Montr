/**
 * Media API Routes
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { mediaService } from '../../services/media.service';
import { subtitleService } from '../../services/subtitle.service';
import { config } from '../../config/config';
import { storageService } from '../../services/storage.service';
import { chunkedUploadService } from '../../services/chunked-upload.service';
import { getDatabase } from '../../database/connection';
import { asyncHandler, successResponse, AppError, ErrorCode } from '../middleware/error-handler';
import {
  validateParams,
  validateQuery,
  validateBody,
  idParamSchema,
  listMediaQuerySchema,
  bulkMoveMediaSchema,
  bulkDeleteMediaSchema,
} from '../middleware/validation';
import { requireRole } from '../middleware/jwt-auth';
import { z } from 'zod';

const router = Router();

const ALLOWED_MIME_TYPES = [
  'video/mp4',
  'video/mpeg',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
];

// Configure multer for file uploads
const upload = multer({
  dest: path.join(config.storage.path, 'temp'),
  limits: {
    fileSize: config.storage.maxUploadSizeMB * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new AppError(
          ErrorCode.INVALID_MEDIA_TYPE,
          `Unsupported file type: ${file.mimetype}. Allowed types: video/*, image/*`,
          400
        )
      );
    }
  },
});

/**
 * Multer config for subtitle uploads: gate by extension (not MIME) since
 * browsers routinely send SRT files as application/octet-stream. Content
 * sniffing happens in subtitleService.attachExternal().
 */
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt']);
const subtitleUpload = multer({
  dest: path.join(config.storage.path, 'temp'),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB cap for subtitle files
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (SUBTITLE_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(
        new AppError(
          ErrorCode.INVALID_MEDIA_TYPE,
          `Unsupported subtitle extension: ${ext}. Allowed: .srt, .vtt`,
          400
        )
      );
    }
  },
});

/**
 * POST /api/media/upload
 * Upload one or more media files. Optional folder_id field assigns them
 * to a folder on creation (null/omitted = root).
 */
router.post(
  '/upload',
  requireRole('admin', 'editor'),
  upload.array('files', 10), // Accept up to 10 files
  asyncHandler(async (req: Request, res: Response) => {
    const files = req.files as Express.Multer.File[];

    if (!files || files.length === 0) {
      throw new AppError(ErrorCode.BAD_REQUEST, 'No files provided', 400);
    }

    const folderIdRaw = (req.body as Record<string, unknown>)?.folder_id;
    let folderId: number | null = null;
    if (folderIdRaw !== undefined && folderIdRaw !== '' && folderIdRaw !== null) {
      const parsed = Number(folderIdRaw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new AppError(ErrorCode.BAD_REQUEST, 'folder_id must be a positive integer', 400);
      }
      folderId = parsed;
    }

    // Process each file
    const uploadedMedia = [];
    const errors = [];

    for (const file of files) {
      try {
        const media = await mediaService.createMedia(file, { folderId });
        uploadedMedia.push(media);
      } catch (error) {
        errors.push({
          filename: file.originalname,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    res.status(201).json(
      successResponse({
        uploaded: uploadedMedia,
        errors: errors.length > 0 ? errors : undefined,
        count: uploadedMedia.length,
      })
    );
  })
);

/**
 * POST /api/media/upload/init
 * Initialize a chunked upload session
 */
router.post(
  '/upload/init',
  requireRole('admin', 'editor'),
  asyncHandler(async (req: Request, res: Response) => {
    const { filename, mimeType, totalSize, folder_id } = req.body as {
      filename: string;
      mimeType: string;
      totalSize: number;
      folder_id?: number | null;
    };

    if (!filename || !mimeType || !totalSize) {
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        'filename, mimeType, and totalSize are required',
        400
      );
    }

    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      throw new AppError(ErrorCode.INVALID_MEDIA_TYPE, `Unsupported file type: ${mimeType}`, 400);
    }

    const maxBytes = config.storage.maxUploadSizeMB * 1024 * 1024;
    if (totalSize > maxBytes) {
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        `File too large. Maximum: ${config.storage.maxUploadSizeMB}MB`,
        400
      );
    }

    let folderId: number | null = null;
    if (folder_id !== undefined && folder_id !== null) {
      if (!Number.isInteger(folder_id) || folder_id <= 0) {
        throw new AppError(ErrorCode.BAD_REQUEST, 'folder_id must be a positive integer', 400);
      }
      folderId = folder_id;
    }

    const session = await chunkedUploadService.initUpload(filename, mimeType, totalSize, folderId);
    res.json(successResponse(session));
  })
);

/**
 * POST /api/media/upload/:uploadId/chunk/:chunkIndex
 * Upload a single chunk.
 *
 * Local backend streams the request body straight to disk so a 200MB
 * chunk doesn't have to live in the V8 heap — two concurrent buffered
 * chunks would OOM the container. Spaces backend still buffers because
 * S3 multipart `PutPart` needs a Content-Length-tagged buffer.
 */
router.post(
  '/upload/:uploadId/chunk/:chunkIndex',
  requireRole('admin', 'editor'),
  asyncHandler(async (req: Request, res: Response) => {
    const uploadId = req.params.uploadId as string;
    const chunkIndex = parseInt(req.params.chunkIndex as string, 10);

    if (config.storage.backend === 'spaces') {
      // Collect body into a Buffer ourselves (replacing express.raw()) so the
      // local path above can skip this entirely.
      const maxBytes = (config.storage.chunkSizeMB + 5) * 1024 * 1024;
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const piece of req as AsyncIterable<Buffer>) {
        total += piece.length;
        if (total > maxBytes) {
          throw new AppError(ErrorCode.BAD_REQUEST, 'Chunk exceeds size limit', 413);
        }
        chunks.push(piece);
      }
      if (total === 0) {
        throw new AppError(ErrorCode.BAD_REQUEST, 'Empty chunk', 400);
      }
      const buffer = Buffer.concat(chunks, total);
      const result = await chunkedUploadService.uploadChunk(uploadId, chunkIndex, buffer);
      res.json(successResponse(result));
      return;
    }

    const result = await chunkedUploadService.streamChunkFromRequest(uploadId, chunkIndex, req);
    res.json(successResponse(result));
  })
);

/**
 * POST /api/media/upload/:uploadId/complete
 * Complete a chunked upload and create media entry
 */
router.post(
  '/upload/:uploadId/complete',
  requireRole('admin', 'editor'),
  asyncHandler(async (req: Request, res: Response) => {
    const uploadId = req.params.uploadId as string;

    // Fast: finalise S3 multipart OR concatenate local chunks. No checksum,
    // no ffprobe — that work has moved to the upload-completion queue so a
    // 100 GB upload's /complete request returns in under 10 s and doesn't
    // trip Cloudflare's 100 s origin timeout.
    const finalized = await chunkedUploadService.completeUpload(uploadId);

    // Enqueue the slow work. Idempotent on upload_id — a retried /complete
    // call for the same session returns the same job row.
    const db = await getDatabase();
    let job;
    try {
      job = await db.enqueueUploadCompletionJob({
        uploadId,
        storageBackend: finalized.storageBackend,
        storageKey: finalized.storageKey,
        originalFilename: finalized.originalFilename,
        mimeType: finalized.mimeType,
        totalSize: finalized.totalSize,
        folderId: finalized.folderId,
      });
    } catch (err) {
      // Orphan-cleanup: if persisting the job row failed (disk full, DB
      // lock, etc.) the S3 object still exists. Best-effort delete so we
      // don't leak storage. Surface the original error to the client.
      await storageService.deleteFile(finalized.storageKey).catch(() => {});
      throw err;
    }

    res.setHeader('Retry-After', '5');
    res.status(202).json(
      successResponse({
        jobId: job.id,
        uploadId,
        state: 'processing' as const,
      })
    );
  })
);

/**
 * GET /api/media/upload/:uploadId/status
 *
 * Polling endpoint for the async /complete flow. Client calls every few
 * seconds until the state is terminal (done, duplicate, or failed). The
 * `uploadId` is a random v4 UUID from initUpload — unguessable — so the
 * endpoint needs no additional auth beyond what the chunk endpoints use.
 */
router.get(
  '/upload/:uploadId/status',
  requireRole('admin', 'editor'),
  asyncHandler(async (req: Request, res: Response) => {
    const uploadId = req.params.uploadId as string;
    const db = await getDatabase();
    const job = await db.getUploadCompletionJobByUploadId(uploadId);
    if (!job) {
      throw new AppError(ErrorCode.NOT_FOUND, `Unknown upload: ${uploadId}`, 404);
    }

    switch (job.state) {
      case 'queued':
      case 'running':
        res.setHeader('Retry-After', '5');
        res.status(202).json(
          successResponse({ state: 'processing' as const, attempts: job.attempts })
        );
        return;
      case 'done': {
        const media = job.media_id != null ? await db.getMediaById(job.media_id) : null;
        res.json(successResponse({ state: 'done' as const, media }));
        return;
      }
      case 'duplicate':
        res.json(
          successResponse({
            state: 'duplicate' as const,
            existingMediaId: job.existing_media_id,
          })
        );
        return;
      case 'failed':
        res.json(
          successResponse({
            state: 'failed' as const,
            error: job.last_error ?? 'Upload processing failed',
          })
        );
        return;
    }
  })
);

/**
 * DELETE /api/media/upload/:uploadId
 * Abort a chunked upload
 */
router.delete(
  '/upload/:uploadId',
  requireRole('admin', 'editor'),
  asyncHandler(async (req: Request, res: Response) => {
    const uploadId = req.params.uploadId as string;
    await chunkedUploadService.abortUpload(uploadId);
    res.json(successResponse({ message: 'Upload aborted' }));
  })
);

/**
 * GET /api/media
 * List all media files with pagination and filters
 */
router.get(
  '/',
  validateQuery(listMediaQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    // Use validatedQuery which has properly transformed types and defaults
    const query = (req.validatedQuery || req.query) as {
      page: number;
      limit: number;
      type?: 'video' | 'image';
      search?: string;
      folder_id?: number | 'root';
    };
    const { page, limit, type, search, folder_id } = query;

    const result = await mediaService.getAllMedia({ page, limit }, { type, search, folder_id });

    res.json(successResponse(result));
  })
);

/**
 * GET /api/media/pending
 * Get all media files pending approval (must be before /:id)
 */
router.get(
  '/pending',
  asyncHandler(async (_req: Request, res: Response) => {
    const { getDatabase } = await import('../../database/connection');
    const db = await getDatabase();
    const pending = await db.getPendingMedia();
    res.json(successResponse(pending));
  })
);

/**
 * GET /api/media/subtitle-counts
 * Bulk per-media subtitle count map. Used by the web UI to decorate video
 * cards with a "CC" badge without fetching subtitles for each item.
 * Must be declared before /:id so Express doesn't swallow the path.
 */
router.get(
  '/subtitle-counts',
  asyncHandler(async (_req: Request, res: Response) => {
    const { getDatabase } = await import('../../database/connection');
    const db = await getDatabase();
    const counts = await db.getSubtitleCountsByMedia();
    res.json(successResponse(counts));
  })
);

/**
 * POST /api/media/bulk/move
 * Move multiple media files to a folder (null = root).
 */
router.post(
  '/bulk/move',
  requireRole('admin', 'editor'),
  validateBody(bulkMoveMediaSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { media_ids, folder_id } = req.body as {
      media_ids: number[];
      folder_id: number | null;
    };
    const { getDatabase } = await import('../../database/connection');
    const db = await getDatabase();
    if (folder_id !== null) {
      const folder = await db.getMediaFolderById(folder_id);
      if (!folder) {
        throw new AppError(
          ErrorCode.FOLDER_NOT_FOUND,
          `Folder with ID ${folder_id} not found`,
          404
        );
      }
    }
    const moved = await db.moveMediaToFolder(media_ids, folder_id);
    res.json(
      successResponse({
        moved,
        requested: media_ids.length,
        folder_id,
      })
    );
  })
);

/**
 * POST /api/media/bulk/delete
 * Delete multiple media files. Errors on individual files are reported
 * per-id; the overall request succeeds as long as it was well-formed.
 */
router.post(
  '/bulk/delete',
  requireRole('admin', 'editor'),
  validateBody(bulkDeleteMediaSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { media_ids } = req.body as { media_ids: number[] };
    const deleted: number[] = [];
    const errors: Array<{ id: number; error: string }> = [];
    for (const id of media_ids) {
      try {
        await mediaService.deleteMedia(id);
        deleted.push(id);
      } catch (err) {
        errors.push({
          id,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }
    res.json(
      successResponse({
        deleted: deleted.length,
        ids: deleted,
        errors: errors.length > 0 ? errors : undefined,
      })
    );
  })
);

/**
 * GET /api/media/:id
 * Get media file details
 */
router.get(
  '/:id',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    const media = await mediaService.getMediaById(id);
    res.json(successResponse(media));
  })
);

/**
 * DELETE /api/media/:id
 * Delete a media file
 */
router.delete(
  '/:id',
  requireRole('admin', 'editor'),
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    await mediaService.deleteMedia(id);
    res.json(
      successResponse({
        message: 'Media file deleted successfully',
        id,
      })
    );
  })
);

const updateMediaSchema = z
  .object({
    original_filename: z.string().min(1).max(255).trim().optional(),
    folder_id: z.number().int().positive().nullable().optional(),
  })
  .refine((data) => data.original_filename !== undefined || data.folder_id !== undefined, {
    message: 'At least one field (original_filename, folder_id) must be provided',
  });

/**
 * PATCH /api/media/:id
 * Update media metadata (rename, move between folders).
 */
router.patch(
  '/:id',
  requireRole('admin', 'editor'),
  validateParams(idParamSchema),
  validateBody(updateMediaSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const body = req.body as { original_filename?: string; folder_id?: number | null };
    const { getDatabase } = await import('../../database/connection');
    const db = await getDatabase();

    const existing = await db.getMediaById(id);
    if (!existing) {
      throw new AppError(ErrorCode.MEDIA_NOT_FOUND, `Media with ID ${id} not found`, 404);
    }
    if (body.folder_id != null) {
      const folder = await db.getMediaFolderById(body.folder_id);
      if (!folder) {
        throw new AppError(
          ErrorCode.FOLDER_NOT_FOUND,
          `Folder with ID ${body.folder_id} not found`,
          404
        );
      }
    }

    const updated = await db.updateMedia(id, body);
    res.json(successResponse(updated));
  })
);

/**
 * GET /api/media/:id/download
 * Download a media file
 */
router.get(
  '/:id/download',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    const media = await mediaService.getMediaById(id);

    if (config.storage.backend === 'spaces') {
      // Proxy through server to avoid CSP blocking CDN redirects
      const tempPath = await storageService.downloadToTemp(media.filepath);
      res.download(tempPath, media.original_filename);
    } else {
      const filePath = await mediaService.getMediaFilePath(id);
      res.download(filePath, media.original_filename);
    }
  })
);

/**
 * GET /api/media/:id/stream
 * Stream a media file for in-browser playback (no Content-Disposition: attachment)
 */
router.get(
  '/:id/stream',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    const media = await mediaService.getMediaById(id);

    if (config.storage.backend === 'spaces') {
      // Proxy through server to avoid CSP blocking CDN redirects
      const tempPath = await storageService.downloadToTemp(media.filepath);
      res.setHeader('Content-Type', media.mime_type || 'application/octet-stream');
      res.sendFile(tempPath);
    } else {
      const filePath = await mediaService.getMediaFilePath(id);
      res.setHeader('Content-Type', media.mime_type || 'application/octet-stream');
      res.sendFile(filePath);
    }
  })
);

/**
 * GET /api/media/:id/thumbnail
 * Get thumbnail for a media file
 */
router.get(
  '/:id/thumbnail',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;

    const result = await mediaService.getMediaThumbnail(id);

    if (result.kind === 'pending') {
      // Non-blocking: job is queued and will be picked up by the
      // thumbnail queue poller. Client should retry in a few seconds.
      // The old behavior held the socket for 30-60s while ffmpeg ran.
      res.setHeader('Retry-After', '5');
      res.status(202).json({
        status: 'pending',
        message: 'Thumbnail generation in progress, retry shortly',
      });
      return;
    }

    if (result.kind === 'failed') {
      res.status(404).json({
        status: 'failed',
        message: 'Thumbnail generation previously failed; use retry to regenerate',
      });
      return;
    }

    if (config.storage.backend === 'spaces') {
      // Proxy thumbnail content to avoid CORS issues with CDN redirects
      const tempPath = await storageService.downloadToTemp(result.path);
      res.setHeader('Content-Type', 'image/jpeg');
      res.sendFile(tempPath);
    } else {
      res.sendFile(result.path);
    }
  })
);

/**
 * POST /api/media/:id/thumbnail/retry
 * Retry failed thumbnail generation
 */
router.post(
  '/:id/thumbnail/retry',
  requireRole('admin', 'editor'),
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    const media = await mediaService.retryThumbnail(id);
    res.json(successResponse(media));
  })
);

/**
 * GET /api/media/:id/subtitles
 * List all subtitle tracks (external + embedded) attached to a media file.
 */
router.get(
  '/:id/subtitles',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const tracks = await subtitleService.list(id);
    res.json(successResponse(tracks));
  })
);

/**
 * POST /api/media/:id/subtitles
 * Attach an external subtitle file (.srt or .vtt) to a video.
 * Body: multipart/form-data with field `subtitle` (file) and optional
 * `language`, `label`, `is_default`, `is_forced`.
 */
router.post(
  '/:id/subtitles',
  requireRole('admin', 'editor'),
  validateParams(idParamSchema),
  subtitleUpload.single('subtitle'),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const file = req.file;
    if (!file) {
      throw new AppError(ErrorCode.BAD_REQUEST, 'No subtitle file provided', 400);
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const parseBool = (v: unknown): boolean => v === true || v === 'true' || v === '1';
    const trimOrNull = (v: unknown): string | null => {
      if (typeof v !== 'string') return null;
      const trimmed = v.trim();
      return trimmed.length === 0 ? null : trimmed;
    };

    try {
      const buffer = await fs.readFile(file.path);
      const track = await subtitleService.attachExternal({
        mediaFileId: id,
        originalFilename: file.originalname,
        buffer,
        language: trimOrNull(body.language),
        label: trimOrNull(body.label),
        isDefault: parseBool(body.is_default),
        isForced: parseBool(body.is_forced),
      });
      res.status(201).json(successResponse(track));
    } finally {
      await fs.unlink(file.path).catch(() => undefined);
    }
  })
);

/**
 * POST /api/media/:id/approve
 * Approve a media file for use in playlists
 */
router.post(
  '/:id/approve',
  requireRole('admin'),
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    const { getDatabase } = await import('../../database/connection');
    const db = await getDatabase();
    const media = await db.updateMediaApproval(id, 'approved');
    await db.createApprovalLog(id, 'approved');
    res.json(successResponse(media));
  })
);

/**
 * POST /api/media/:id/reject
 * Reject a media file
 */
router.post(
  '/:id/reject',
  requireRole('admin'),
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    const comment = (req.body as { comment?: string })?.comment;
    const { getDatabase } = await import('../../database/connection');
    const db = await getDatabase();
    const media = await db.updateMediaApproval(id, 'rejected');
    await db.createApprovalLog(id, 'rejected', comment);
    res.json(successResponse(media));
  })
);

/**
 * GET /api/media/:id/approval-logs
 * Get approval history for a media file
 */
router.get(
  '/:id/approval-logs',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { getDatabase } = await import('../../database/connection');
    const db = await getDatabase();
    const logs = await db.getApprovalLogs(params.id);
    res.json(successResponse(logs));
  })
);

export default router;
