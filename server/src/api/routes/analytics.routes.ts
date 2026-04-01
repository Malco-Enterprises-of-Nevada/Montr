/**
 * Analytics API Routes
 */

import { Router, Request, Response } from 'express';
import { analyticsService } from '../../services/analytics.service';
import { asyncHandler, successResponse } from '../middleware/error-handler';
import { requireRole } from '../middleware/jwt-auth';

const router = Router();

/**
 * POST /api/analytics/playback/start
 * Record a playback start event
 */
router.post(
  '/playback/start',
  asyncHandler(async (req: Request, res: Response) => {
    const { clientId, mediaId } = req.body as { clientId: string; mediaId: number };
    const log = await analyticsService.recordPlaybackStart(clientId, mediaId);
    res.status(201).json(successResponse(log));
  })
);

/**
 * POST /api/analytics/playback/:id/end
 * Record a playback end event
 */
router.post(
  '/playback/:id/end',
  asyncHandler(async (req: Request, res: Response) => {
    const id = parseInt(req.params.id as string, 10);
    const { durationWatched, completed } = req.body as {
      durationWatched: number;
      completed: boolean;
    };
    const log = await analyticsService.recordPlaybackEnd(id, durationWatched, completed);
    res.json(successResponse(log));
  })
);

/**
 * GET /api/analytics/playback
 * Get playback history with optional filters
 */
router.get(
  '/playback',
  asyncHandler(async (req: Request, res: Response) => {
    const { client_id, media_id, from, to, limit } = req.query as Record<string, string>;
    const logs = await analyticsService.getPlaybackHistory({
      client_id,
      media_id: media_id ? parseInt(media_id, 10) : undefined,
      from,
      to,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    res.json(successResponse(logs));
  })
);

/**
 * GET /api/analytics/summary
 * Get playback summary by client
 */
router.get(
  '/summary',
  asyncHandler(async (req: Request, res: Response) => {
    const { from, to } = req.query as Record<string, string>;
    const summary = await analyticsService.getPlaybackSummary(from, to);
    res.json(successResponse(summary));
  })
);

/**
 * GET /api/analytics/media-popularity
 * Get most-played media ranking
 */
router.get(
  '/media-popularity',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const popularity = await analyticsService.getMediaPopularity(limit);
    res.json(successResponse(popularity));
  })
);

/**
 * GET /api/analytics/uptime
 * Get client uptime statistics
 */
router.get(
  '/uptime',
  asyncHandler(async (_req: Request, res: Response) => {
    const stats = await analyticsService.getUptimeStats();
    res.json(successResponse(stats));
  })
);

/**
 * POST /api/analytics/cleanup
 * Clean up old playback logs
 */
router.post(
  '/cleanup',
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const retentionDays = req.body?.retentionDays || 90;
    const deleted = await analyticsService.cleanupOldLogs(retentionDays);
    res.json(successResponse({ deleted, retentionDays }));
  })
);

export default router;
