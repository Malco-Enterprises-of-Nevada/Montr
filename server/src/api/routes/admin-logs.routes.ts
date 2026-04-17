/**
 * Admin Logs API Routes
 *
 * Exposes the server's own log tail so operators and automated tooling
 * (e.g. scripts/montr-logs.mjs) can diagnose issues without SSH access
 * to the prod host.
 *
 *   GET /api/admin/logs/server   (admin only, plain text tail)
 *
 * Client logs live under /api/telemetry/clients/:id/logs — see telemetry.routes.ts.
 */

import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { config } from '../../config/config';
import { asyncHandler, AppError, ErrorCode } from '../middleware/error-handler';
import { requireRole } from '../middleware/jwt-auth';

const DEFAULT_LINES = 200;
const MAX_LINES = 5000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const VALID_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

const router = Router();

function resolveServerLogPath(): string {
  return path.resolve(config.logging.logFile || './logs/server.log');
}

/**
 * GET /api/admin/logs/server?lines=200&level=warn&since=2026-04-17T00:00:00
 *
 * Returns the tail of the server's Winston log file as text/plain. Lexicographic
 * comparison on the leading "YYYY-MM-DD HH:MM:SS" timestamp works because Winston
 * writes a fixed-width ISO-ish prefix (see utils/logger.ts).
 */
router.get(
  '/server',
  requireRole('admin'),
  asyncHandler(async (req: Request, res: Response) => {
    const requested = req.query.lines ? parseInt(req.query.lines as string, 10) : DEFAULT_LINES;
    if (Number.isNaN(requested) || requested < 1) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'lines must be a positive integer', 400);
    }
    const lines = Math.min(requested, MAX_LINES);

    const level = req.query.level ? String(req.query.level).toLowerCase() : undefined;
    if (level && !VALID_LEVELS.has(level)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `level must be one of: ${[...VALID_LEVELS].join(', ')}`,
        400
      );
    }

    // Accepts either "YYYY-MM-DDTHH:MM:SS" (ISO) or "YYYY-MM-DD HH:MM:SS" (log-native).
    // We normalize to the log's space-separated form for prefix comparison.
    const sinceRaw = req.query.since ? String(req.query.since) : undefined;
    const sincePrefix = sinceRaw ? sinceRaw.replace('T', ' ').slice(0, 19) : undefined;

    const logPath = resolveServerLogPath();

    let stat;
    try {
      stat = await fs.stat(logPath);
    } catch {
      res
        .status(404)
        .type('text/plain')
        .send(
          `server log file not found at ${logPath}\n` +
            `set LOG_FILE in the server env to enable file logging.\n`
        );
      return;
    }

    if (stat.size > MAX_FILE_BYTES) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `log file is ${stat.size} bytes, exceeds ${MAX_FILE_BYTES}; rotate before reading`,
        413
      );
    }

    const contents = await fs.readFile(logPath, 'utf8');
    const allLines = contents.split('\n');
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();

    const filtered: string[] = [];
    const levelTag = level ? `[${level.toUpperCase()}]` : undefined;
    for (const line of allLines) {
      if (sincePrefix && line.slice(0, 19) < sincePrefix) continue;
      if (levelTag && !line.includes(levelTag)) continue;
      filtered.push(line);
    }

    const tail = filtered.slice(-lines).join('\n');
    res.type('text/plain').send(tail + (tail.length > 0 ? '\n' : ''));
  })
);

export default router;
