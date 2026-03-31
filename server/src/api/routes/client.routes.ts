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
} from '../middleware/validation';

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

export default router;
