/**
 * Subtitle API Routes
 *
 * Exposes top-level subtitle operations (download by id, delete, patch).
 * Per-media listing and upload live under /api/media/:id/subtitles
 * because they are scoped to a parent video.
 */

import { Router, Request, Response } from 'express';
import { config } from '../../config/config';
import { subtitleService } from '../../services/subtitle.service';
import { storageService } from '../../services/storage.service';
import { asyncHandler, successResponse, AppError, ErrorCode } from '../middleware/error-handler';
import { validateParams, validateBody, idParamSchema } from '../middleware/validation';
import { requireRole } from '../middleware/jwt-auth';
import { z } from 'zod';

const router = Router();

/**
 * GET /api/subtitles/:id/download
 * Stream an external subtitle file. Auth is inherited from the router mount
 * (same `requireAuth()` as /api/media/:id/download).
 */
router.get(
  '/:id/download',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const track = await subtitleService.getById(id);
    if (track.kind !== 'external' || !track.storage_filename) {
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        'Embedded subtitle tracks do not have a downloadable file',
        400
      );
    }

    const contentType = track.format === 'vtt' ? 'text/vtt' : 'application/x-subrip';
    const downloadName = track.original_filename || `subtitle-${id}.${track.format ?? 'srt'}`;

    if (config.storage.backend === 'spaces') {
      const tempPath = await storageService.downloadToTemp(track.storage_filename);
      res.setHeader('Content-Type', contentType);
      res.download(tempPath, downloadName);
    } else {
      const fullPath = storageService.getFullPath(track.storage_filename);
      res.setHeader('Content-Type', contentType);
      res.download(fullPath, downloadName);
    }
  })
);

const updateSubtitleSchema = z
  .object({
    language: z.string().max(16).nullable().optional(),
    label: z.string().max(255).nullable().optional(),
    is_default: z.boolean().optional(),
    is_forced: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.language !== undefined ||
      data.label !== undefined ||
      data.is_default !== undefined ||
      data.is_forced !== undefined,
    { message: 'At least one field must be provided' }
  );

/**
 * PATCH /api/subtitles/:id
 * Update metadata (language, label, default/forced flags) on a subtitle track.
 */
router.patch(
  '/:id',
  requireRole('admin', 'editor'),
  validateParams(idParamSchema),
  validateBody(updateSubtitleSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const body = req.body as {
      language?: string | null;
      label?: string | null;
      is_default?: boolean;
      is_forced?: boolean;
    };
    const updated = await subtitleService.update(id, body);
    res.json(successResponse(updated));
  })
);

/**
 * DELETE /api/subtitles/:id
 * Remove an external subtitle file or detach an embedded-stream reference.
 */
router.delete(
  '/:id',
  requireRole('admin'),
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    await subtitleService.delete(id);
    res.json(successResponse({ message: 'Subtitle deleted', id }));
  })
);

export default router;
