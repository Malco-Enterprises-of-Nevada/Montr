/**
 * Authentication & User Management Routes
 */

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { getDatabase } from '../../database/connection';
import { asyncHandler, successResponse, AppError, ErrorCode } from '../middleware/error-handler';
import { validateBody, validateParams, idParamSchema } from '../middleware/validation';
import { generateToken, requireAuth, requireRole, JwtPayload } from '../middleware/jwt-auth';
import { UserPublic, UserRole } from '../../database/types';
import { z } from 'zod';
import { getLogger } from '../../utils/logger';
import { config } from '../../config/config';

const logger = getLogger();
const router = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

const createUserSchema = z.object({
  username: z.string().min(3).max(100).trim(),
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  role: z.enum(['admin', 'editor', 'viewer']).optional(),
});

const updateUserSchema = z
  .object({
    email: z.string().email().optional(),
    role: z.enum(['admin', 'editor', 'viewer']).optional(),
  })
  .refine((v) => v.email !== undefined || v.role !== undefined, {
    message: 'At least one of email or role must be provided',
  });

const adminResetPasswordSchema = z.object({
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
  adminPassword: z.string().min(1, 'Admin password confirmation required'),
});

function toPublicUser(user: {
  id: number;
  username: string;
  email: string;
  role: UserRole;
  created_at: string;
}): UserPublic {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    created_at: user.created_at,
  };
}

/**
 * POST /api/auth/login
 */
router.post(
  '/login',
  validateBody(loginSchema),
  asyncHandler(async (req: Request, res: Response) => {
    // Break-glass gate: once SSO is verified in prod, AUTH_LOCAL_ENABLED=false
    // disables password login. Fails OPEN until SSO is configured (§D).
    if (!config.auth.localLoginEnabled) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'Local password login is disabled. Sign in with Microsoft.',
        403
      );
    }

    const { username, password } = req.body as { username: string; password: string };

    const db = await getDatabase();
    const user = await db.getUserByUsername(username);

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      throw new AppError(ErrorCode.UNAUTHORIZED, 'Invalid username or password', 401);
    }

    const token = generateToken({ userId: user.id, username: user.username, role: user.role });
    // A local login while SSO is enabled is a break-glass event — emit a fixed
    // event name so the Loki rule / auth dashboard can alert on it (§D).
    if (config.auth.entra.enabled) {
      logger.warn('Break-glass local login used', {
        event: 'BREAK_GLASS_LOGIN',
        username: user.username,
      });
    } else {
      logger.info(`User logged in: ${user.username}`);
    }

    res.json(successResponse({ token, user: toPublicUser(user) }));
  })
);

/**
 * POST /api/auth/setup
 * Create the first admin user (only works when no users exist)
 */
router.post(
  '/setup',
  validateBody(createUserSchema),
  asyncHandler(async (req: Request, res: Response) => {
    // The 0-user bootstrap path also makes requireAuth pass through, so the
    // setup endpoint is the riskiest surface in that state. Keep it disabled
    // unless explicitly enabled for the initial first-admin bootstrap.
    if (process.env.AUTH_SETUP_ENABLED !== 'true') {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'Setup is disabled. Set AUTH_SETUP_ENABLED=true to create the first admin.',
        403
      );
    }

    const db = await getDatabase();
    const userCount = await db.getUserCount();

    if (userCount > 0) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        'Setup already completed. Use admin to create users.',
        403
      );
    }

    const { username, email, password } = req.body as {
      username: string;
      email: string;
      password: string;
    };
    const password_hash = await bcrypt.hash(password, 10);

    const user = await db.createUser({ username, email, password_hash, role: 'admin' });
    const token = generateToken({ userId: user.id, username: user.username, role: user.role });

    logger.info(`Admin user created via setup: ${user.username}`);
    res.status(201).json(successResponse({ token, user: toPublicUser(user) }));
  })
);

/**
 * GET /api/auth/me
 * Get current user info
 */
router.get(
  '/me',
  requireAuth(),
  asyncHandler(async (req: Request, res: Response) => {
    const jwtUser = (req as Request & { user?: JwtPayload }).user;
    if (!jwtUser) {
      res.json(successResponse(null));
      return;
    }

    const db = await getDatabase();
    const user = await db.getUserById(jwtUser.userId);
    if (!user) {
      throw new AppError(ErrorCode.UNAUTHORIZED, 'User not found', 401);
    }

    res.json(successResponse(toPublicUser(user)));
  })
);

/**
 * PUT /api/auth/password
 * Change current user's password
 */
router.put(
  '/password',
  requireAuth(),
  validateBody(changePasswordSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const jwtUser = (req as Request & { user?: JwtPayload }).user;
    if (!jwtUser) {
      throw new AppError(ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
    }

    const { currentPassword, newPassword } = req.body as {
      currentPassword: string;
      newPassword: string;
    };

    const db = await getDatabase();
    const user = await db.getUserById(jwtUser.userId);
    if (!user) {
      throw new AppError(ErrorCode.UNAUTHORIZED, 'User not found', 401);
    }

    if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
      throw new AppError(ErrorCode.UNAUTHORIZED, 'Current password is incorrect', 401);
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await db.updateUserPassword(jwtUser.userId, newHash);

    logger.info(`Password changed for user: ${user.username}`);
    res.json(successResponse({ message: 'Password changed successfully' }));
  })
);

/**
 * GET /api/users
 * List all users (admin only)
 */
router.get(
  '/',
  requireAuth(),
  requireRole('admin'),
  asyncHandler(async (_req: Request, res: Response) => {
    const db = await getDatabase();
    const users = await db.getAllUsers();
    res.json(successResponse(users.map(toPublicUser)));
  })
);

/**
 * POST /api/users
 * Create a user (admin only)
 */
router.post(
  '/',
  requireAuth(),
  requireRole('admin'),
  validateBody(createUserSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { username, email, password, role } = req.body as {
      username: string;
      email: string;
      password: string;
      role?: UserRole;
    };

    const db = await getDatabase();

    // Check for existing username/email
    if (await db.getUserByUsername(username)) {
      throw new AppError(ErrorCode.RESOURCE_ALREADY_EXISTS, 'Username already taken', 409);
    }
    if (await db.getUserByEmail(email)) {
      throw new AppError(ErrorCode.RESOURCE_ALREADY_EXISTS, 'Email already registered', 409);
    }

    const password_hash = await bcrypt.hash(password, 10);
    const user = await db.createUser({ username, email, password_hash, role });

    logger.info(`User created: ${user.username} (${user.role})`);
    res.status(201).json(successResponse(toPublicUser(user)));
  })
);

/**
 * DELETE /api/users/:id
 * Delete a user (admin only)
 */
router.delete(
  '/:id',
  requireAuth(),
  requireRole('admin'),
  validateParams(idParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const jwtUser = (req as Request & { user?: JwtPayload }).user;

    if (jwtUser && jwtUser.userId === params.id) {
      throw new AppError(ErrorCode.BAD_REQUEST, 'Cannot delete your own account', 400);
    }

    const db = await getDatabase();
    const user = await db.getUserById(params.id);
    if (!user) {
      throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, 'User not found', 404);
    }

    await db.deleteUser(params.id);
    logger.info(`User deleted: ${user.username}`);
    res.json(successResponse({ message: 'User deleted', id: params.id }));
  })
);

/**
 * PUT /api/users/:id
 * Update a user's email or role (admin only)
 */
router.put(
  '/:id',
  requireAuth(),
  requireRole('admin'),
  validateParams(idParamSchema),
  validateBody(updateUserSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const jwtUser = (req as Request & { user?: JwtPayload }).user;
    const { email, role } = req.body as { email?: string; role?: UserRole };

    const db = await getDatabase();
    const user = await db.getUserById(params.id);
    if (!user) {
      throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, 'User not found', 404);
    }

    if (jwtUser && jwtUser.userId === params.id && role !== undefined && role !== 'admin') {
      throw new AppError(ErrorCode.BAD_REQUEST, 'Cannot demote your own admin role', 400);
    }

    if (email !== undefined && email !== user.email) {
      const existing = await db.getUserByEmail(email);
      if (existing && existing.id !== params.id) {
        throw new AppError(ErrorCode.RESOURCE_ALREADY_EXISTS, 'Email already registered', 409);
      }
    }

    const updated = await db.updateUser(params.id, { email, role });
    logger.info(`User updated: ${updated.username} (role=${updated.role})`);
    res.json(successResponse(toPublicUser(updated)));
  })
);

/**
 * POST /api/users/:id/reset-password
 * Reset another user's password (admin only). Requires the admin's own password as confirmation.
 */
router.post(
  '/:id/reset-password',
  requireAuth(),
  requireRole('admin'),
  validateParams(idParamSchema),
  validateBody(adminResetPasswordSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const params = req.params as unknown as { id: number };
    const jwtUser = (req as Request & { user?: JwtPayload }).user;
    if (!jwtUser) {
      throw new AppError(ErrorCode.UNAUTHORIZED, 'Authentication required', 401);
    }
    if (jwtUser.userId === params.id) {
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        'Use PUT /api/auth/password to change your own password',
        400
      );
    }

    const { newPassword, adminPassword } = req.body as {
      newPassword: string;
      adminPassword: string;
    };

    const db = await getDatabase();
    const admin = await db.getUserById(jwtUser.userId);
    if (!admin || !(await bcrypt.compare(adminPassword, admin.password_hash))) {
      throw new AppError(ErrorCode.UNAUTHORIZED, 'Admin password is incorrect', 401);
    }

    const target = await db.getUserById(params.id);
    if (!target) {
      throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, 'User not found', 404);
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await db.updateUserPassword(params.id, hash);

    logger.info(`Password reset by admin ${admin.username} for user ${target.username}`);
    res.json(successResponse({ message: 'Password reset', id: params.id }));
  })
);

export default router;
