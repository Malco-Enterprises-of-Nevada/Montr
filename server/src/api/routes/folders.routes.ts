/**
 * Folder API Routes
 * CRUD for the media_folders hierarchy.
 */

import { Router, Request, Response } from 'express';
import { folderService } from '../../services/folder.service';
import { getDatabase } from '../../database/connection';
import { asyncHandler, successResponse } from '../middleware/error-handler';
import {
  validateBody,
  validateParams,
  validateQuery,
  idParamSchema,
  createFolderSchema,
  updateFolderSchema,
  deleteFolderQuerySchema,
  paginationSchema,
} from '../middleware/validation';
import { requireRole, JwtPayload } from '../middleware/jwt-auth';

const router = Router();

/**
 * GET /api/folders
 * List every folder (flat list; client builds the tree).
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const folders = await folderService.listFolders();
    res.json(successResponse(folders));
  })
);

/**
 * POST /api/folders
 * Create a new folder (optionally nested under parent_id).
 */
router.post(
  '/',
  requireRole('admin', 'editor'),
  validateBody(createFolderSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { name: string; parent_id?: number | null };
    const user = (req as Request & { user?: JwtPayload }).user;
    const folder = await folderService.createFolder({
      name: body.name,
      parent_id: body.parent_id ?? null,
      created_by: user?.userId ?? null,
    });
    res.status(201).json(successResponse(folder));
  })
);

/**
 * GET /api/folders/:id
 */
router.get(
  '/:id',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const folder = await folderService.getFolderById(id);
    res.json(successResponse(folder));
  })
);

/**
 * PATCH /api/folders/:id
 * Rename and/or re-parent a folder.
 */
router.patch(
  '/:id',
  requireRole('admin', 'editor'),
  validateParams(idParamSchema),
  validateBody(updateFolderSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const folder = await folderService.updateFolder(id, req.body);
    res.json(successResponse(folder));
  })
);

/**
 * DELETE /api/folders/:id?recursive=true|false
 * Non-recursive: 409 if non-empty.
 * Recursive: deletes folder + descendants, detaches their media to root.
 */
router.delete(
  '/:id',
  requireRole('admin', 'editor'),
  validateParams(idParamSchema),
  validateQuery(deleteFolderQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const q = (req.validatedQuery ?? req.query) as { recursive?: boolean };
    await folderService.deleteFolder(id, q.recursive === true);
    res.json(successResponse({ message: 'Folder deleted', id }));
  })
);

/**
 * GET /api/folders/:id/media
 * Paginated list of media directly inside this folder.
 */
router.get(
  '/:id/media',
  validateParams(idParamSchema),
  validateQuery(paginationSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    // Verify folder exists (404 otherwise)
    await folderService.getFolderById(id);
    const q = (req.validatedQuery ?? req.query) as { page: number; limit: number };
    const db = await getDatabase();
    const result = await db.getAllMedia({ page: q.page, limit: q.limit }, { folder_id: id });
    res.json(successResponse(result));
  })
);

export default router;
