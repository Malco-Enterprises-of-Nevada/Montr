/**
 * Client API Routes
 */

import express, { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { clientService } from '../../services/client.service';
import { config } from '../../config/config';
import { asyncHandler, successResponse, AppError, ErrorCode } from '../middleware/error-handler';
import { pendingLogFetches } from './telemetry.routes';
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
  sendCommandSchema,
} from '../middleware/validation';
import { requireRole } from '../middleware/jwt-auth';
import {
  sendPlaylistToClient,
  sendPlaylistInterrupt,
  sendPlaylistResume,
  sendCommandToClient,
} from '../../websocket/handlers';
import { CommandType } from '../../websocket/types';
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
  requireRole('admin', 'editor'),
  validateParams(uuidParamSchema),
  validateBody(updateClientSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const client = await clientService.updateClient(id, req.body);

    // If playlist assignment changed, push via WebSocket
    if (
      req.body.assigned_playlist_id &&
      client.assigned_playlist_id &&
      clientConnectionManager.isConnected(id)
    ) {
      await sendPlaylistToClient(id, client.assigned_playlist_id);
    }

    res.json(successResponse(client));
  })
);

/**
 * DELETE /api/clients/:id
 * Unregister a client
 */
router.delete(
  '/:id',
  requireRole('admin', 'editor'),
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
  requireRole('admin', 'editor'),
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
  requireRole('admin', 'editor'),
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
  requireRole('admin', 'editor'),
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
  requireRole('admin', 'editor'),
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
  requireRole('admin', 'editor'),
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

/**
 * POST /api/clients/:id/command
 * Send a command to a client (pause, resume, skip, previous, volume, seek)
 */
router.post(
  '/:id/command',
  requireRole('admin', 'editor'),
  validateParams(uuidParamSchema),
  validateBody(sendCommandSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    const { command, args } = req.body as { command: CommandType; args?: Record<string, unknown> };

    // Verify client exists
    await clientService.getClientById(id);

    if (!clientConnectionManager.isConnected(id)) {
      res.status(400).json(
        successResponse({
          message: `Client ${id} is not connected`,
          delivered: false,
        })
      );
      return;
    }

    const delivered = sendCommandToClient(id, command, args);
    res.json(
      successResponse({
        message: `Command '${command}' ${delivered ? 'sent' : 'failed'}`,
        delivered,
        command,
        args,
      })
    );
  })
);

// Configure multer for preview uploads
const previewUpload = multer({
  dest: path.join(config.storage.path, 'temp'),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max for screenshots
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') {
      cb(null, true);
    } else {
      cb(new AppError(ErrorCode.INVALID_MEDIA_TYPE, 'Preview must be JPEG or PNG', 400));
    }
  },
});

/**
 * POST /api/clients/:id/preview
 * Upload a screenshot preview from a client
 */
router.post(
  '/:id/preview',
  validateParams(uuidParamSchema),
  previewUpload.single('preview'),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    await clientService.getClientById(id);

    const file = req.file;
    if (!file) {
      throw new AppError(ErrorCode.BAD_REQUEST, 'No preview file provided', 400);
    }

    // Move to previews directory, overwriting previous
    const previewDir = path.resolve(config.storage.path, 'previews');
    const ext = file.mimetype === 'image/png' ? '.png' : '.jpg';
    const previewPath = path.join(previewDir, `${id}${ext}`);

    // Remove any existing preview (could be different extension)
    for (const existingExt of ['.jpg', '.png']) {
      const existing = path.join(previewDir, `${id}${existingExt}`);
      if (fs.existsSync(existing)) fs.unlinkSync(existing);
    }

    fs.renameSync(file.path, previewPath);

    res.json(successResponse({ message: 'Preview uploaded', clientId: id }));
  })
);

/**
 * GET /api/clients/:id/preview
 * Get the latest screenshot preview for a client
 */
router.get(
  '/:id/preview',
  validateParams(uuidParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    await clientService.getClientById(id);

    const previewDir = path.resolve(config.storage.path, 'previews');

    // Check for jpg or png
    for (const ext of ['.jpg', '.png']) {
      const previewPath = path.join(previewDir, `${id}${ext}`);
      if (fs.existsSync(previewPath)) {
        res.sendFile(previewPath);
        return;
      }
    }

    // Return a placeholder SVG instead of 404
    res
      .type('image/svg+xml')
      .send(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180">' +
          '<rect fill="#1a1a2e" width="320" height="180"/>' +
          '<text fill="#555" x="50%" y="45%" text-anchor="middle" font-family="system-ui,sans-serif" font-size="16">No Preview</text>' +
          '<text fill="#444" x="50%" y="60%" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11">Client not streaming</text>' +
          '</svg>'
      );
  })
);

/**
 * POST /api/clients/:id/logs/upload
 *
 * Client-only endpoint: receives the log tail uploaded by a client in response
 * to a fetch_logs WS command. The X-Request-Id header matches the upload back
 * to the pending HTTP request that originated it (held open in telemetry.routes).
 *
 * Body is raw text/plain (the log file tail). Auth is the standard requireAuth()
 * which falls through to API key for client → server traffic.
 */
router.post(
  '/:id/logs/upload',
  express.text({ type: 'text/plain', limit: '10mb' }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const requestId = req.header('X-Request-Id');

    if (!requestId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'X-Request-Id header is required', 400);
    }

    const pending = pendingLogFetches.get(requestId);
    if (!pending) {
      // Request is already resolved, timed out, or never existed.
      // Acknowledge but log a warning.
      res.status(204).end();
      return;
    }

    if (pending.clientId !== id) {
      throw new AppError(ErrorCode.FORBIDDEN, 'Client ID mismatch on log upload request', 403);
    }

    clearTimeout(pending.timer);
    pendingLogFetches.delete(requestId);

    const body = typeof req.body === 'string' ? req.body : '';
    pending.resolve(body);

    res.status(204).end();
  })
);

export default router;
