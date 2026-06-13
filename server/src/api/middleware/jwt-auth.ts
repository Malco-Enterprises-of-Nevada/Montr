/**
 * JWT Authentication Middleware
 * Validates Bearer tokens and enforces role-based access control.
 * Falls through to API key auth if no users exist (backwards compatible).
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getDatabase } from '../../database/connection';
import { config } from '../../config/config';
import { UserRole } from '../../database/types';
import { errorResponse, ErrorCode } from './error-handler';

// Fail fast in production: never fall back to a shared, publicly-known default
// secret (it would let anyone forge tokens). A dev-only placeholder is allowed
// outside production so local runs/tests don't require configuration.
const JWT_SECRET: string = (() => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is required in production');
  }
  return 'montr-dev-only-insecure-secret';
})();
const JWT_EXPIRY = process.env.JWT_EXPIRY || '24h';

export interface JwtPayload {
  userId: number;
  username: string;
  role: UserRole;
}

/**
 * Generates a JWT token for a user.
 * @param expiresIn optional override (e.g. '1h' for short-lived SSO tokens —
 *   SSO_MASTER_PLAN.md §G); defaults to JWT_EXPIRY (24h) for local logins.
 */
export function generateToken(payload: JwtPayload, expiresIn?: string): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: (expiresIn || JWT_EXPIRY) as string & { __brand: 'StringValue' },
  } as jwt.SignOptions);
}

/**
 * Verifies and decodes a JWT token
 */
export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

/**
 * Middleware: requires authentication (JWT Bearer token).
 * If no users exist in the database, passes through (bootstrapping mode).
 */
export function requireAuth() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Check if any users exist — if not, skip auth (bootstrap mode)
      const db = await getDatabase();
      const userCount = await db.getUserCount();
      if (userCount === 0) {
        next();
        return;
      }

      // Check for API key (machine-to-machine auth for clients)
      const apiKey = req.header('X-API-Key');
      if (apiKey && config.security.apiKey && apiKey === config.security.apiKey) {
        next();
        return;
      }

      const authHeader = req.header('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json(errorResponse(ErrorCode.UNAUTHORIZED, 'Authentication required'));
        return;
      }

      const token = authHeader.substring(7);
      const payload = verifyToken(token);
      (req as Request & { user?: JwtPayload }).user = payload;
      next();
    } catch {
      res.status(401).json(errorResponse(ErrorCode.UNAUTHORIZED, 'Invalid or expired token'));
    }
  };
}

/**
 * Middleware: requires a minimum role level.
 * Role hierarchy: admin > editor > viewer
 */
export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as Request & { user?: JwtPayload }).user;

    // If no user attached (bootstrap mode), pass through
    if (!user) {
      next();
      return;
    }

    if (!allowedRoles.includes(user.role)) {
      res.status(403).json(errorResponse(ErrorCode.FORBIDDEN, 'Insufficient permissions'));
      return;
    }

    next();
  };
}
