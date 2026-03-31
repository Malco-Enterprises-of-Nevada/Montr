/**
 * Media API Routes
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { mediaService } from '../../services/media.service';
import { config } from '../../config/config';
import { asyncHandler, successResponse, AppError, ErrorCode } from '../middleware/error-handler';
import {
  validateParams,
  validateQuery,
  idParamSchema,
  listMediaQuerySchema,
} from '../middleware/validation';

const router = Router();

// Configure multer for file uploads
const upload = multer({
  dest: path.join(config.storage.path, 'temp'),
  limits: {
    fileSize: config.storage.maxUploadSizeMB * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    // Accept only video and image files
    const allowedMimeTypes = [
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

    if (allowedMimeTypes.includes(file.mimetype)) {
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
    const filePath = await mediaService.getMediaFilePath(id);

    res.download(filePath, media.original_filename);
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
