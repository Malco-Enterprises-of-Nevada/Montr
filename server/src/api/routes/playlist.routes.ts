/**
 * Playlist API Routes
 */

import { Router, Request, Response } from 'express';
import { playlistService } from '../../services/playlist.service';
import { asyncHandler, successResponse } from '../middleware/error-handler';
import {
  validateParams,
  validateBody,
  idParamSchema,
  playlistItemParamsSchema,
  createPlaylistSchema,
  updatePlaylistSchema,
  addPlaylistItemsSchema,
  updatePlaylistItemSchema,
  reorderPlaylistItemsSchema,
} from '../middleware/validation';

const router = Router();

/**
 * POST /api/playlists
 * Create a new playlist
 */
router.post(
  '/',
  validateBody(createPlaylistSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const playlist = await playlistService.createPlaylist(req.body);
    res.status(201).json(successResponse(playlist));
  })
);

/**
 * GET /api/playlists
 * List all playlists
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const playlists = await playlistService.getAllPlaylists();
    res.json(successResponse(playlists));
  })
);

/**
 * GET /api/playlists/:id
 * Get a playlist with all its items
 */
router.get(
  '/:id',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    const playlist = await playlistService.getPlaylistWithItems(id);
    res.json(successResponse(playlist));
  })
);

/**
 * PUT /api/playlists/:id
 * Update a playlist
 */
router.put(
  '/:id',
  validateParams(idParamSchema),
  validateBody(updatePlaylistSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    const playlist = await playlistService.updatePlaylist(id, req.body);
    res.json(successResponse(playlist));
  })
);

/**
 * DELETE /api/playlists/:id
 * Delete a playlist
 */
router.delete(
  '/:id',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    await playlistService.deletePlaylist(id);
    res.json(
      successResponse({
        message: 'Playlist deleted successfully',
        id,
      })
    );
  })
);

/**
 * POST /api/playlists/:id/items
 * Add items to a playlist
 */
router.post(
  '/:id/items',
  validateParams(idParamSchema),
  validateBody(addPlaylistItemsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    const { mediaIds } = req.body as { mediaIds: number[] };

    const items = await playlistService.addPlaylistItems(id, mediaIds);
    res.status(201).json(
      successResponse({
        items,
        count: items.length,
      })
    );
  })
);

/**
 * PUT /api/playlists/:id/items/:itemId
 * Update a playlist item (order or duration)
 */
router.put(
  '/:id/items/:itemId',
  validateParams(playlistItemParamsSchema),
  validateBody(updatePlaylistItemSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number; itemId: number };
    const { itemId } = params;
    const item = await playlistService.updatePlaylistItem(itemId, req.body);
    res.json(successResponse(item));
  })
);

/**
 * DELETE /api/playlists/:id/items/:itemId
 * Remove an item from a playlist
 */
router.delete(
  '/:id/items/:itemId',
  validateParams(playlistItemParamsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number; itemId: number };
    const { itemId } = params;
    await playlistService.deletePlaylistItem(itemId);
    res.json(
      successResponse({
        message: 'Playlist item removed successfully',
        itemId,
      })
    );
  })
);

/**
 * POST /api/playlists/:id/reorder
 * Reorder playlist items
 */
router.post(
  '/:id/reorder',
  validateParams(idParamSchema),
  validateBody(reorderPlaylistItemsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    const { itemIds } = req.body as { itemIds: number[] };

    await playlistService.reorderPlaylistItems(id, itemIds);
    res.json(
      successResponse({
        message: 'Playlist items reordered successfully',
        playlistId: id,
      })
    );
  })
);

/**
 * GET /api/playlists/:id/stats
 * Get playlist statistics
 */
router.get(
  '/:id/stats',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    const stats = await playlistService.getPlaylistStats(id);
    res.json(successResponse(stats));
  })
);

export default router;
