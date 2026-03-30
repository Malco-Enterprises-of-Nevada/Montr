/**
 * API Key Authentication Middleware
 * Validates X-API-Key header against configured API key when authentication is enabled.
 */

import { Request, Response, NextFunction } from 'express';
import { config } from '../../config/config';
import { ErrorCode, errorResponse } from './error-handler';

/**
 * API key authentication middleware.
 * If config.security.apiKeyRequired is false, passes through.
 * If true, validates X-API-Key header against config.security.apiKey.
 */
export function apiKeyAuth() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!config.security.apiKeyRequired) {
      next();
      return;
    }

    const apiKey = req.header('X-API-Key');

    if (!apiKey) {
      res.status(401).json(
        errorResponse(ErrorCode.UNAUTHORIZED, 'API key is required. Provide X-API-Key header.')
      );
      return;
    }

    if (apiKey !== config.security.apiKey) {
      res.status(401).json(
        errorResponse(ErrorCode.UNAUTHORIZED, 'Invalid API key')
      );
      return;
    }

    next();
  };
}
