/**
 * Schedule Template API Routes
 */

import { Router, Request, Response } from 'express';
import { scheduleTemplateService } from '../../services/schedule-template.service';
import { asyncHandler, successResponse } from '../middleware/error-handler';
import {
  validateParams,
  validateBody,
  idParamSchema,
  createScheduleTemplateSchema,
  instantiateScheduleTemplateSchema,
} from '../middleware/validation';
import { requireRole } from '../middleware/jwt-auth';

const router = Router();

router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const templates = await scheduleTemplateService.getAllTemplates();
    res.json(successResponse(templates));
  })
);

router.get(
  '/:id',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const tpl = await scheduleTemplateService.getTemplateById(params.id);
    res.json(successResponse(tpl));
  })
);

router.post(
  '/',
  requireRole('admin', 'editor'),
  validateBody(createScheduleTemplateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const tpl = await scheduleTemplateService.createTemplate(req.body);
    res.status(201).json(successResponse(tpl));
  })
);

router.delete(
  '/:id',
  requireRole('admin', 'editor'),
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    await scheduleTemplateService.deleteTemplate(params.id);
    res.json(successResponse({ message: 'Template deleted', id: params.id }));
  })
);

router.post(
  '/:id/instantiate',
  requireRole('admin', 'editor'),
  validateParams(idParamSchema),
  validateBody(instantiateScheduleTemplateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const schedule = await scheduleTemplateService.instantiate(params.id, req.body);
    res.status(201).json(successResponse(schedule));
  })
);

export default router;
