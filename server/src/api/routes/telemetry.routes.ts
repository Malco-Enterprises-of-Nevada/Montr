/**
 * Telemetry API Routes
 *
 * Read endpoints for the dashboard:
 *   GET  /api/telemetry/clients/:id/range
 *   GET  /api/telemetry/clients/:id/latest
 *   GET  /api/telemetry/clients/latest          (batch for client list badges)
 *   GET  /api/telemetry/clients/:id/logs        (admin only)
 *   POST /api/telemetry/clients/:id/logs/fetch  (admin only — triggers WS fetch_logs)
 *
 * The companion client log upload endpoint is mounted under /api/clients/:id/logs/upload
 * (see telemetry-upload.routes.ts) so it groups with other client-facing endpoints.
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { telemetryService } from '../../services/telemetry.service';
import { asyncHandler, successResponse, AppError, ErrorCode } from '../middleware/error-handler';
import { requireRole } from '../middleware/jwt-auth';
import { clientConnectionManager } from '../../websocket/client-manager';
import { ClientLogLevel } from '../../database/types';

/**
 * In-memory map of admin "fetch logs" requests awaiting the client's HTTP upload.
 * Keyed by request_id (uuid). The upload route resolves the entry; the fetch
 * route either awaits the resolution or rejects after a timeout.
 *
 * Lives in module scope so the upload route (mounted on a different router)
 * can reach it via shared imports.
 */
interface PendingFetch {
  resolve: (body: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  clientId: string;
}

export const pendingLogFetches = new Map<string, PendingFetch>();

const FETCH_LOGS_TIMEOUT_MS = 30_000;
const VALID_FETCH_SIZES = new Set([10240, 102400, 1048576, 5242880]);

const router = Router();

/**
 * GET /api/telemetry/clients/latest
 * Returns the latest telemetry sample for every client, keyed by client_id.
 * Used by the dashboard client-list view to render at-a-glance status badges.
 */
router.get(
  '/clients/latest',
  asyncHandler(async (_req: Request, res: Response) => {
    const map = await telemetryService.getAllTelemetryLatest();
    res.json(successResponse(map));
  })
);

/**
 * GET /api/telemetry/clients/:id/latest
 * Returns the most recent telemetry sample for one client.
 */
router.get(
  '/clients/:id/latest',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const row = await telemetryService.getTelemetryLatest(id as string);
    res.json(successResponse(row));
  })
);

/**
 * GET /api/telemetry/clients/:id/range?from=ms&to=ms&limit=N
 * Returns time-series telemetry rows for one client over an interval.
 */
router.get(
  '/clients/:id/range',
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const fromMs = req.query.from ? parseInt(req.query.from as string, 10) : Date.now() - 3_600_000;
    const toMs = req.query.to ? parseInt(req.query.to as string, 10) : Date.now();
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 1000;

    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs > toMs) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Invalid from/to range', 400);
    }
    if (limit < 1 || limit > 5000) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'limit must be 1..5000', 400);
    }

    const rows = await telemetryService.getTelemetryRange(id as string, fromMs, toMs, limit);
    res.json(successResponse(rows));
  })
);

/**
 * GET /api/telemetry/clients/:id/logs?level=&limit=
 * Returns recent auto-pushed log events for one client. Admin only.
 */
router.get(
  '/clients/:id/logs',
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const level = req.query.level as ClientLogLevel | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
    if (level && level !== 'warn' && level !== 'error') {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "level must be 'warn' or 'error'", 400);
    }
    const rows = await telemetryService.getLogEvents(id as string, level, limit);
    res.json(successResponse(rows));
  })
);

/**
 * POST /api/telemetry/clients/:id/logs/fetch
 * Body: { max_bytes: 10240 | 102400 | 1048576 | 5242880 }
 *
 * Admin endpoint: pushes a fetch_logs command to the connected client over WS,
 * then holds the HTTP response open until the client uploads the tail (via
 * POST /api/clients/:id/logs/upload) or until FETCH_LOGS_TIMEOUT_MS elapses.
 */
router.post(
  '/clients/:id/logs/fetch',
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const maxBytes = (req.body && req.body.max_bytes) as number | undefined;
    if (!maxBytes || !VALID_FETCH_SIZES.has(maxBytes)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'max_bytes must be 10240, 102400, 1048576, or 5242880',
        400
      );
    }

    if (!clientConnectionManager.isConnected(id as string)) {
      throw new AppError(ErrorCode.CLIENT_OFFLINE, 'Client is not connected', 503);
    }

    const requestId = randomUUID();

    const tail = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingLogFetches.delete(requestId);
        reject(new AppError(ErrorCode.CLIENT_OFFLINE, 'Client did not upload logs in time', 504));
      }, FETCH_LOGS_TIMEOUT_MS);

      pendingLogFetches.set(requestId, {
        resolve,
        reject,
        timer,
        clientId: id as string,
      });

      const sent = clientConnectionManager.sendToClient(id as string, {
        type: 'command',
        command: 'fetch_logs',
        args: { max_bytes: maxBytes, request_id: requestId },
      });

      if (!sent) {
        clearTimeout(timer);
        pendingLogFetches.delete(requestId);
        reject(
          new AppError(ErrorCode.CLIENT_OFFLINE, 'Failed to dispatch fetch_logs command', 503)
        );
      }
    });

    res.json(successResponse({ request_id: requestId, bytes: tail }));
  })
);

export default router;
