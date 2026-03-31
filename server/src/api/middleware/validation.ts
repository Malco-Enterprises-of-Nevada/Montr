/**
 * Validation middleware using Zod schemas
 */

import { Request, Response, NextFunction } from 'express';
import { z, ZodSchema } from 'zod';

/**
 * Validates request body against a Zod schema
 */
export function validateBody<T extends ZodSchema>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Validates request params against a Zod schema
 */
export function validateParams<T extends ZodSchema>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const validated = schema.parse(req.params);
      // Clear existing properties and assign validated ones
      // This ensures transformed values (like string->number) are properly applied
      for (const key in req.params) {
        delete req.params[key];
      }
      Object.assign(req.params, validated);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Validates request query against a Zod schema
 */
export function validateQuery<T extends ZodSchema>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const validated = schema.parse(req.query);
      // Store validated query in a typed custom property since req.query has getters/setters
      // that may coerce types (especially in test environments)
      req.validatedQuery = validated as Record<string, unknown>;
      // Also try to update req.query for backwards compatibility
      // Note: In some environments (like tests), req.query properties may be read-only or have coercion
      try {
        Object.keys(validated as Record<string, unknown>).forEach((key) => {
          (req.query as Record<string, unknown>)[key] = (validated as Record<string, unknown>)[key];
        });
      } catch {
        // If updating req.query fails, that's okay - handlers should use validatedQuery
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

// Common validation schemas

/**
 * Validates ID parameter (must be a positive integer)
 */
export const idParamSchema = z.object({
  id: z.string().regex(/^\d+$/).transform(Number),
});

/**
 * Validates UUID parameter
 */
export const uuidParamSchema = z.object({
  id: z.string().uuid(),
});

/**
 * Validates pagination query parameters
 */
export const paginationSchema = z.object({
  page: z
    .string()
    .optional()
    .default('1')
    .transform(Number)
    .refine((val) => val > 0, {
      message: 'Page must be greater than 0',
    }),
  limit: z
    .string()
    .optional()
    .default('20')
    .transform(Number)
    .refine((val) => val > 0 && val <= 100, {
      message: 'Limit must be between 1 and 100',
    }),
});

// Media validation schemas

/**
 * Query parameters for listing media
 */
export const listMediaQuerySchema = paginationSchema.extend({
  type: z.enum(['video', 'image']).optional(),
  search: z.string().optional(),
});

// Playlist validation schemas

/**
 * Request body for creating a playlist
 */
export const createPlaylistSchema = z.object({
  name: z
    .string()
    .min(1, 'Playlist name is required')
    .max(255, 'Playlist name must not exceed 255 characters')
    .trim(),
  description: z
    .string()
    .max(1000, 'Description must not exceed 1000 characters')
    .trim()
    .optional(),
});

/**
 * Request body for updating a playlist
 */
export const updatePlaylistSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Playlist name cannot be empty')
      .max(255, 'Playlist name must not exceed 255 characters')
      .trim()
      .optional(),
    description: z
      .string()
      .max(1000, 'Description must not exceed 1000 characters')
      .trim()
      .optional(),
  })
  .refine((data) => data.name !== undefined || data.description !== undefined, {
    message: 'At least one field (name or description) must be provided',
  });

/**
 * Request body for adding items to a playlist
 */
export const addPlaylistItemsSchema = z.object({
  mediaIds: z
    .array(z.number().int().positive('Media ID must be a positive integer'))
    .min(1, 'At least one media ID is required')
    .max(100, 'Cannot add more than 100 items at once'),
});

/**
 * Request body for updating a playlist item
 */
export const updatePlaylistItemSchema = z
  .object({
    order_index: z
      .number()
      .int('Order index must be an integer')
      .min(0, 'Order index must be non-negative')
      .optional(),
    image_duration: z
      .number()
      .int('Image duration must be an integer')
      .min(1, 'Image duration must be at least 1 second')
      .max(3600, 'Image duration must not exceed 3600 seconds (1 hour)')
      .optional(),
  })
  .refine((data) => data.order_index !== undefined || data.image_duration !== undefined, {
    message: 'At least one field (order_index or image_duration) must be provided',
  });

/**
 * Request body for reordering playlist items
 */
export const reorderPlaylistItemsSchema = z.object({
  itemIds: z
    .array(z.number().int().positive('Item ID must be a positive integer'))
    .min(1, 'At least one item ID is required')
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'Item IDs must be unique',
    }),
});

/**
 * Validates both playlist ID and item ID parameters
 */
export const playlistItemParamsSchema = z.object({
  id: z.string().regex(/^\d+$/).transform(Number),
  itemId: z.string().regex(/^\d+$/).transform(Number),
});

// Client validation schemas

/**
 * Request body for registering a client
 */
export const registerClientSchema = z.object({
  id: z.string().uuid('Client ID must be a valid UUID'),
  name: z
    .string()
    .min(1, 'Client name is required')
    .max(255, 'Client name must not exceed 255 characters')
    .trim(),
  version: z.string().max(50, 'Version string must not exceed 50 characters').optional(),
  capabilities: z
    .string()
    .optional()
    .refine(
      (val) => {
        if (!val) return true;
        try {
          JSON.parse(val);
          return true;
        } catch {
          return false;
        }
      },
      {
        message: 'Capabilities must be a valid JSON string',
      }
    ),
});

/**
 * Request body for updating a client
 */
export const updateClientSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Client name cannot be empty')
      .max(255, 'Client name must not exceed 255 characters')
      .trim()
      .optional(),
    assigned_playlist_id: z
      .number()
      .int('Playlist ID must be an integer')
      .positive('Playlist ID must be positive')
      .nullable()
      .optional(),
  })
  .refine((data) => data.name !== undefined || data.assigned_playlist_id !== undefined, {
    message: 'At least one field (name or assigned_playlist_id) must be provided',
  });

/**
 * Request body for client status update
 */
export const clientStatusSchema = z.object({
  current_media_id: z
    .number()
    .int('Media ID must be an integer')
    .positive('Media ID must be positive')
    .optional(),
  position: z
    .number()
    .min(0, 'Position must be non-negative')
    .finite('Position must be a finite number')
    .optional(),
  is_playing: z.boolean({
    message: 'is_playing must be a boolean',
  }),
  error_message: z
    .string()
    .max(1000, 'Error message must not exceed 1000 characters')
    .trim()
    .optional(),
});

/**
 * Query parameters for listing clients
 */
export const listClientsQuerySchema = z.object({
  status: z.enum(['online', 'offline', 'error']).optional(),
  assigned_playlist_id: z.string().regex(/^\d+$/).transform(Number).optional(),
});

/**
 * Request body for heartbeat
 */
export const heartbeatSchema = z.object({
  timestamp: z.string().datetime().optional(),
});

// Client group validation schemas

/**
 * Request body for creating a group
 */
export const createGroupSchema = z.object({
  name: z
    .string()
    .min(1, 'Group name is required')
    .max(255, 'Group name must not exceed 255 characters')
    .trim(),
  description: z
    .string()
    .max(1000, 'Description must not exceed 1000 characters')
    .trim()
    .optional(),
});

/**
 * Request body for updating a group
 */
export const updateGroupSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Group name cannot be empty')
      .max(255, 'Group name must not exceed 255 characters')
      .trim()
      .optional(),
    description: z
      .string()
      .max(1000, 'Description must not exceed 1000 characters')
      .trim()
      .optional(),
  })
  .refine((data) => data.name !== undefined || data.description !== undefined, {
    message: 'At least one field (name or description) must be provided',
  });

/**
 * Request body for adding a member to a group
 */
export const addGroupMemberSchema = z.object({
  clientId: z.string().uuid('Client ID must be a valid UUID'),
});

/**
 * Request body for assigning a playlist to a group
 */
export const assignGroupPlaylistSchema = z.object({
  playlistId: z.number().int().positive('Playlist ID must be a positive integer'),
});

/**
 * Validates group ID and client ID params
 */
export const groupMemberParamsSchema = z.object({
  id: z.string().regex(/^\d+$/).transform(Number),
  clientId: z.string().uuid(),
});

// Schedule validation schemas

const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
const daysOfWeekRegex = /^[0-6](,[0-6])*$/;

/**
 * Request body for creating a schedule
 */
export const createScheduleSchema = z.object({
  name: z
    .string()
    .min(1, 'Schedule name is required')
    .max(255, 'Schedule name must not exceed 255 characters')
    .trim(),
  playlist_id: z.number().int().positive('Playlist ID must be a positive integer'),
  client_id: z.string().uuid('Client ID must be a valid UUID').optional(),
  group_id: z.number().int().positive('Group ID must be a positive integer').optional(),
  start_time: z.string().regex(timeRegex, 'Start time must be in HH:MM format'),
  end_time: z.string().regex(timeRegex, 'End time must be in HH:MM format').optional(),
  days_of_week: z
    .string()
    .regex(daysOfWeekRegex, 'Days of week must be comma-separated digits 0-6 (0=Sunday)')
    .optional(),
  priority: z
    .number()
    .int()
    .min(1, 'Priority must be at least 1')
    .max(100, 'Priority must not exceed 100')
    .optional(),
  enabled: z.boolean().optional(),
});

/**
 * Request body for updating a schedule
 */
export const updateScheduleSchema = z
  .object({
    name: z.string().min(1).max(255).trim().optional(),
    playlist_id: z.number().int().positive().optional(),
    client_id: z.string().uuid().nullable().optional(),
    group_id: z.number().int().positive().nullable().optional(),
    start_time: z.string().regex(timeRegex, 'Start time must be in HH:MM format').optional(),
    end_time: z.string().regex(timeRegex, 'End time must be in HH:MM format').nullable().optional(),
    days_of_week: z.string().regex(daysOfWeekRegex).optional(),
    priority: z.number().int().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: 'At least one field must be provided',
  });

// Client playlist assignment schemas

/**
 * Request body for adding a playlist to a client
 */
export const addClientPlaylistSchema = z.object({
  playlistId: z.number().int().positive('Playlist ID must be a positive integer'),
  priority: z
    .number()
    .int()
    .min(1, 'Priority must be at least 1')
    .max(100, 'Priority must not exceed 100')
    .optional()
    .default(50),
});

/**
 * Request body for updating playlist priority
 */
export const updateClientPlaylistPrioritySchema = z.object({
  priority: z
    .number()
    .int()
    .min(1, 'Priority must be at least 1')
    .max(100, 'Priority must not exceed 100'),
});

/**
 * Validates client UUID and playlist ID params
 */
export const clientPlaylistParamsSchema = z.object({
  id: z.string().uuid(),
  playlistId: z.string().regex(/^\d+$/).transform(Number),
});

// Interrupt validation schema

/**
 * Request body for interrupting a client with a playlist
 */
export const interruptClientSchema = z.object({
  playlistId: z.number().int().positive('Playlist ID must be a positive integer'),
});

// Type exports for better TypeScript inference

export type CreatePlaylistInput = z.infer<typeof createPlaylistSchema>;
export type UpdatePlaylistInput = z.infer<typeof updatePlaylistSchema>;
export type AddPlaylistItemsInput = z.infer<typeof addPlaylistItemsSchema>;
export type UpdatePlaylistItemInput = z.infer<typeof updatePlaylistItemSchema>;
export type ReorderPlaylistItemsInput = z.infer<typeof reorderPlaylistItemsSchema>;
export type RegisterClientInput = z.infer<typeof registerClientSchema>;
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
export type ClientStatusInput = z.infer<typeof clientStatusSchema>;
export type ListMediaQuery = z.infer<typeof listMediaQuerySchema>;
export type ListClientsQuery = z.infer<typeof listClientsQuerySchema>;
export type PaginationQuery = z.infer<typeof paginationSchema>;
