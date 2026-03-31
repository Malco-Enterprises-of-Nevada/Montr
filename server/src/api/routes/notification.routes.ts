/**
 * Notification API Routes
 */

import { Router, Request, Response } from 'express';
import { notificationService } from '../../services/notification.service';
import { asyncHandler, successResponse } from '../middleware/error-handler';
import { validateParams, validateBody, idParamSchema } from '../middleware/validation';
import { z } from 'zod';

const router = Router();

const createRuleSchema = z.object({
  name: z.string().min(1).max(255).trim(),
  event_type: z.enum(['client_offline', 'client_error', 'playlist_empty', 'storage_full']),
  channel: z.enum(['email', 'webhook']),
  destination: z.string().min(1, 'Destination is required').trim(),
  enabled: z.boolean().optional(),
});

/**
 * POST /api/notifications/rules
 * Create a notification rule
 */
router.post(
  '/rules',
  validateBody(createRuleSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const rule = await notificationService.createRule(req.body);
    res.status(201).json(successResponse(rule));
  })
);

/**
 * GET /api/notifications/rules
 * List all notification rules
 */
router.get(
  '/rules',
  asyncHandler(async (_req: Request, res: Response) => {
    const rules = await notificationService.getAllRules();
    res.json(successResponse(rules));
  })
);

/**
 * GET /api/notifications/rules/:id
 * Get a notification rule
 */
router.get(
  '/rules/:id',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const rule = await notificationService.getRuleById(params.id);
    res.json(successResponse(rule));
  })
);

/**
 * DELETE /api/notifications/rules/:id
 * Delete a notification rule
 */
router.delete(
  '/rules/:id',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    await notificationService.deleteRule(params.id);
    res.json(successResponse({ message: 'Rule deleted', id: params.id }));
  })
);

/**
 * GET /api/notifications/history
 * Get recent notification history
 */
router.get(
  '/history',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const history = await notificationService.getHistory(limit);
    res.json(successResponse(history));
  })
);

/**
 * POST /api/notifications/test
 * Fire a test notification event
 */
router.post(
  '/test',
  asyncHandler(async (req: Request, res: Response) => {
    const { event_type } = req.body as { event_type: string };
    const count = await notificationService.fireEvent(
      (event_type || 'client_offline') as import('../../database/types').NotificationEventType,
      { test: true, message: 'Test notification from Montr' }
    );
    res.json(successResponse({ message: `Test event fired, ${count} notifications sent` }));
  })
);

export default router;
