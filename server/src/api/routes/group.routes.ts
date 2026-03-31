/**
 * Client Group API Routes
 */

import { Router, Request, Response } from 'express';
import { groupService } from '../../services/group.service';
import { asyncHandler, successResponse } from '../middleware/error-handler';
import {
  validateParams,
  validateBody,
  idParamSchema,
  groupMemberParamsSchema,
  createGroupSchema,
  updateGroupSchema,
  addGroupMemberSchema,
  assignGroupPlaylistSchema,
  sendCommandSchema,
} from '../middleware/validation';
import { sendPlaylistToClient, sendCommandToGroup } from '../../websocket/handlers';
import { clientConnectionManager } from '../../websocket/client-manager';
import { CommandType } from '../../websocket/types';

const router = Router();

/**
 * POST /api/groups
 * Create a new client group
 */
router.post(
  '/',
  validateBody(createGroupSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const group = await groupService.createGroup(req.body);
    res.status(201).json(successResponse(group));
  })
);

/**
 * GET /api/groups
 * List all client groups
 */
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const groups = await groupService.getAllGroups();
    res.json(successResponse(groups));
  })
);

/**
 * GET /api/groups/:id
 * Get a group with its members
 */
router.get(
  '/:id',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    const group = await groupService.getGroupWithMembers(id);
    res.json(successResponse(group));
  })
);

/**
 * PUT /api/groups/:id
 * Update a group
 */
router.put(
  '/:id',
  validateParams(idParamSchema),
  validateBody(updateGroupSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    const group = await groupService.updateGroup(id, req.body);
    res.json(successResponse(group));
  })
);

/**
 * DELETE /api/groups/:id
 * Delete a group
 */
router.delete(
  '/:id',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    await groupService.deleteGroup(id);
    res.json(successResponse({ message: 'Group deleted successfully', id }));
  })
);

/**
 * GET /api/groups/:id/members
 * Get all members of a group
 */
router.get(
  '/:id/members',
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    const members = await groupService.getMembers(id);
    res.json(successResponse(members));
  })
);

/**
 * POST /api/groups/:id/members
 * Add a client to a group
 */
router.post(
  '/:id/members',
  validateParams(idParamSchema),
  validateBody(addGroupMemberSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    const { clientId } = req.body as { clientId: string };
    const member = await groupService.addMember(id, clientId);
    res.status(201).json(successResponse(member));
  })
);

/**
 * DELETE /api/groups/:id/members/:clientId
 * Remove a client from a group
 */
router.delete(
  '/:id/members/:clientId',
  validateParams(groupMemberParamsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number; clientId: string };
    const { id, clientId } = params;
    await groupService.removeMember(id, clientId);
    res.json(successResponse({ message: 'Member removed from group', groupId: id, clientId }));
  })
);

/**
 * POST /api/groups/:id/assign
 * Assign a playlist to all members of a group
 */
router.post(
  '/:id/assign',
  validateParams(idParamSchema),
  validateBody(assignGroupPlaylistSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    const { playlistId } = req.body as { playlistId: number };

    const result = await groupService.assignPlaylistToGroup(id, playlistId);

    // Send playlist to all connected group members via WebSocket
    for (const client of result.clients) {
      if (clientConnectionManager.isConnected(client.id)) {
        await sendPlaylistToClient(client.id, playlistId);
      }
    }

    res.json(
      successResponse({
        message: `Playlist assigned to ${result.updated} clients`,
        updated: result.updated,
        playlistId,
        groupId: id,
      })
    );
  })
);

/**
 * POST /api/groups/:id/command
 * Send a command to all members of a group
 */
router.post(
  '/:id/command',
  validateParams(idParamSchema),
  validateBody(sendCommandSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const { id } = params;
    const { command, args } = req.body as { command: CommandType; args?: Record<string, unknown> };

    // Verify group exists
    await groupService.getGroupById(id);

    const sentCount = await sendCommandToGroup(id, command, args);
    res.json(
      successResponse({
        message: `Command '${command}' sent to ${sentCount} clients in group ${id}`,
        sentCount,
        command,
        args,
      })
    );
  })
);

export default router;
