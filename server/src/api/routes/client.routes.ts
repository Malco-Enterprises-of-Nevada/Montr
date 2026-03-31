/**
 * Client API Routes
 */

import { Router, Request, Response } from 'express';
import { clientService } from '../../services/client.service';
import { asyncHandler, successResponse } from '../middleware/error-handler';
import {
  validateParams,
  validateBody,
  validateQuery,
  uuidParamSchema,
  registerClientSchema,
  updateClientSchema,
  clientStatusSchema,
  listClientsQuerySchema,
  addClientPlaylistSchema,
  updateClientPlaylistPrioritySchema,
  clientPlaylistParamsSchema,
  interruptClientSchema,
} from '../middleware/validation';
import {
  sendPlaylistToClient,
  sendPlaylistInterrupt,
  sendPlaylistResume,
} from '../../websocket/handlers';
import { clientConnectionManager } from '../../websocket/client-manager';

const router = Router();

/**
 * POST /api/clients/register
 * Register a new client
 */
router.post(
  '/register',
  validateBody(registerClientSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const client = await clientService.registerClient(req.body);
    res.status(201).json(successResponse(client));
  })
);

/**
 * GET /api/clients
 * List all clients with optional filters
 */
router.get(
  '/',
  validateQuery(listClientsQuerySchema),
  asyncHandler(async (req: Request, res: Response) => {
    // Use validatedQuery which has properly transformed types
    const { status, assigned_playlist_id } = (req.validatedQuery || req.query) as {
      status?: 'online' | 'offline' | 'error';
      assigned_playlist_id?: number;
    };

    const clients = await clientService.getAllClients({
      status,
      assigned_playlist_id,
    });

    res.json(successResponse(clients));
  })
);

/**
 * GET /api/clients/:id
 * Get client details
 */
router.get(
  '/:id',
  validateParams(uuidParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const client = await clientService.getClientById(id);
    res.json(successResponse(client));
  })
);

/**
 * PUT /api/clients/:id
 * Update client (e.g., assign playlist, change name)
 */
router.put(
  '/:id',
  validateParams(uuidParamSchema),
  validateBody(updateClientSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const client = await clientService.updateClient(id, req.body);
    res.json(successResponse(client));
  })
);

/**
 * DELETE /api/clients/:id
 * Unregister a client
 */
router.delete(
  '/:id',
  validateParams(uuidParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    await clientService.unregisterClient(id);
    res.json(
      successResponse({
        message: 'Client unregistered successfully',
        id,
      })
    );
  })
);

/**
 * GET /api/clients/:id/status
 * Get current status of a client
 */
router.get(
  '/:id/status',
  validateParams(uuidParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const clientWithStatus = await clientService.getClientWithStatus(id);
    res.json(successResponse(clientWithStatus));
  })
);

/**
 * POST /api/clients/:id/status
 * Update client status (used by clients to report their status)
 */
router.post(
  '/:id/status',
  validateParams(uuidParamSchema),
  validateBody(clientStatusSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };

    const status = await clientService.recordClientStatus({
      client_id: id,
      ...req.body,
    });

    res.status(201).json(successResponse(status));
  })
);

/**
 * POST /api/clients/:id/heartbeat
 * Update client heartbeat
 */
router.post(
  '/:id/heartbeat',
  validateParams(uuidParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    await clientService.updateHeartbeat(id);
    res.json(
      successResponse({
        message: 'Heartbeat recorded',
        timestamp: new Date().toISOString(),
      })
    );
  })
);

/**
 * GET /api/clients/:id/playlists
 * Get all playlist assignments for a client
 */
router.get(
  '/:id/playlists',
  validateParams(uuidParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const assignments = await clientService.getPlaylistAssignments(id);
    res.json(successResponse(assignments));
  })
);

/**
 * POST /api/clients/:id/playlists
 * Assign a playlist to a client with priority
 */
router.post(
  '/:id/playlists',
  validateParams(uuidParamSchema),
  validateBody(addClientPlaylistSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const { playlistId, priority } = req.body as { playlistId: number; priority: number };

    const assignment = await clientService.addPlaylistAssignment(id, playlistId, priority);

    // Send the active playlist to the client via WebSocket
    if (clientConnectionManager.isConnected(id)) {
      const client = await clientService.getClientById(id);
      if (client.assigned_playlist_id) {
        await sendPlaylistToClient(id, client.assigned_playlist_id);
      }
    }

    res.status(201).json(successResponse(assignment));
  })
);

/**
 * PUT /api/clients/:id/playlists/:playlistId
 * Update playlist assignment priority
 */
router.put(
  '/:id/playlists/:playlistId',
  validateParams(clientPlaylistParamsSchema),
  validateBody(updateClientPlaylistPrioritySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: string; playlistId: number };
    const { id, playlistId } = params;
    const { priority } = req.body as { priority: number };

    const updated = await clientService.updatePlaylistPriority(id, playlistId, priority);

    // Send updated active playlist via WebSocket
    if (clientConnectionManager.isConnected(id)) {
      const client = await clientService.getClientById(id);
      if (client.assigned_playlist_id) {
        await sendPlaylistToClient(id, client.assigned_playlist_id);
      }
    }

    res.json(successResponse(updated));
  })
);

/**
 * DELETE /api/clients/:id/playlists/:playlistId
 * Remove a playlist assignment from a client
 */
router.delete(
  '/:id/playlists/:playlistId',
  validateParams(clientPlaylistParamsSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: string; playlistId: number };
    const { id, playlistId } = params;

    await clientService.removePlaylistAssignment(id, playlistId);

    // Send updated active playlist via WebSocket
    if (clientConnectionManager.isConnected(id)) {
      const client = await clientService.getClientById(id);
      if (client.assigned_playlist_id) {
        await sendPlaylistToClient(id, client.assigned_playlist_id);
      }
    }

    res.json(
      successResponse({ message: 'Playlist removed from client', clientId: id, playlistId })
    );
  })
);

/**
 * POST /api/clients/:id/interrupt
 * Interrupt a client with a high-priority playlist
 */
router.post(
  '/:id/interrupt',
  validateParams(uuidParamSchema),
  validateBody(interruptClientSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const { playlistId } = req.body as { playlistId: number };

    const client = await clientService.interruptWithPlaylist(id, playlistId);

    // Send interrupt message via WebSocket
    if (clientConnectionManager.isConnected(id)) {
      await sendPlaylistInterrupt(id, playlistId, client.interrupted_from_playlist_id);
    }

    res.json(
      successResponse({
        message: `Client interrupted with playlist ${playlistId}`,
        client,
      })
    );
  })
);

/**
 * POST /api/clients/:id/resume
 * Resume previous playlist after interruption
 */
router.post(
  '/:id/resume',
  validateParams(uuidParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };

    const previousClient = await clientService.getClientById(id);
    const resumePlaylistId = previousClient.interrupted_from_playlist_id;

    const client = await clientService.resumeFromInterrupt(id);

    // Send resume message via WebSocket
    if (clientConnectionManager.isConnected(id)) {
      await sendPlaylistResume(id, resumePlaylistId);
    }

    res.json(
      successResponse({
        message: `Client resumed to playlist ${resumePlaylistId}`,
        client,
      })
    );
  })
);

export default router;
