/**
 * Media API Routes
 */

import { Router, Request, Response } from 'express';
import express from 'express';
import multer from 'multer';
import path from 'path';
import { mediaService } from '../../services/media.service';
import { config } from '../../config/config';
import { storageService } from '../../services/storage.service';
import { chunkedUploadService } from '../../services/chunked-upload.service';
import { asyncHandler, successResponse, AppError, ErrorCode } from '../middleware/error-handler';
import {
  validateParams,
  validateQuery,
  idParamSchema,
  listMediaQuerySchema,
} from '../middleware/validation';
import { requireRole } from '../middleware/jwt-auth';

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
 * POST /api/media/upload
 * Upload one or more media files
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

    // Process each file
    const uploadedMedia = [];
    const errors = [];

    for (const file of files) {
      try {
        const media = await mediaService.createMedia(file);
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
    const { filename, mimeType, totalSize } = req.body as {
      filename: string;
      mimeType: string;
      totalSize: number;
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

    const session = await chunkedUploadService.initUpload(filename, mimeType, totalSize);
    res.json(successResponse(session));
  })
);

/**
 * POST /api/media/upload/:uploadId/chunk/:chunkIndex
 * Upload a single chunk
 */
router.post(
  '/upload/:uploadId/chunk/:chunkIndex',
  requireRole('admin', 'editor'),
  express.raw({ type: 'application/octet-stream', limit: `${config.storage.chunkSizeMB + 5}mb` }),
  asyncHandler(async (req: Request, res: Response) => {
    const uploadId = req.params.uploadId as string;
    const chunkIndex = req.params.chunkIndex as string;
    const buffer = req.body as Buffer;

    if (!buffer || buffer.length === 0) {
      throw new AppError(ErrorCode.BAD_REQUEST, 'Empty chunk', 400);
    }

    const result = await chunkedUploadService.uploadChunk(
      uploadId,
      parseInt(chunkIndex, 10),
      buffer
    );

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

    const { storageInfo, originalFilename, mimeType } =
      await chunkedUploadService.completeUpload(uploadId);

    const media = await mediaService.createMediaFromStorageInfo(
      storageInfo,
      originalFilename,
      mimeType
    );

    res.status(201).json(
      successResponse({
        uploaded: [media],
        count: 1,
      })
    );
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
    };
    const { page, limit, type, search } = query;

    const result = await mediaService.getAllMedia({ page, limit }, { type, search });

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
      const url = storageService.getDownloadUrl(media.filepath);
      res.redirect(302, url);
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
      const url = storageService.getDownloadUrl(media.filepath);
      res.redirect(302, url);
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
    const thumbnailPath = await mediaService.getMediaThumbnail(id);

    res.sendFile(thumbnailPath);
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
