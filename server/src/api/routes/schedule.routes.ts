/**
 * Schedule API Routes
 */

import { Router, Request, Response } from 'express';
import { scheduleService } from '../../services/schedule.service';
import { asyncHandler, successResponse } from '../middleware/error-handler';
import {
  validateParams,
  validateBody,
  idParamSchema,
  createScheduleSchema,
  updateScheduleSchema,
} from '../middleware/validation';
import { requireRole } from '../middleware/jwt-auth';

const router = Router();

/**
 * POST /api/schedules
 * Create a new schedule
 */
router.post(
  '/',
  requireRole('admin', 'editor'),
  validateBody(createScheduleSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const schedule = await scheduleService.createSchedule(req.body);
    res.status(201).json(successResponse(schedule));
  })
);

/**
 * GET /api/schedules
 * List all schedules
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const schedules = await scheduleService.getAllSchedules();
    res.json(successResponse(schedules));
  })
);

/**
 * GET /api/schedules/:id
 * Get schedule details
 */
router.get(
  '/:id',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    const schedule = await scheduleService.getScheduleById(id);
    res.json(successResponse(schedule));
  })
);

/**
 * PUT /api/schedules/:id
 * Update a schedule
 */
router.put(
  '/:id',
  requireRole('admin', 'editor'),
  validateParams(idParamSchema),
  validateBody(updateScheduleSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    const schedule = await scheduleService.updateSchedule(id, req.body);
    res.json(successResponse(schedule));
  })
);

/**
 * DELETE /api/schedules/:id
 * Delete a schedule
 */
router.delete(
  '/:id',
  requireRole('admin', 'editor'),
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    await scheduleService.deleteSchedule(id);
    res.json(successResponse({ message: 'Schedule deleted successfully', id }));
  })
);

/**
 * POST /api/schedules/evaluate
 * Manually trigger schedule evaluation (for testing)
 */
router.post(
  '/evaluate',
  requireRole('admin'),
  asyncHandler(async (_req: Request, res: Response) => {
    await scheduleService.evaluateSchedules();
    res.json(successResponse({ message: 'Schedule evaluation completed' }));
  })
);

export default router;
