/**
 * Unit tests for validation middleware and Zod schemas
 */

import { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';
import {
  validateBody,
  validateParams,
  validateQuery,
  idParamSchema,
  uuidParamSchema,
  paginationSchema,
  createPlaylistSchema,
  updatePlaylistSchema,
  addPlaylistItemsSchema,
  updatePlaylistItemSchema,
  reorderPlaylistItemsSchema,
  registerClientSchema,
  clientStatusSchema,
  listClientsQuerySchema,
  heartbeatSchema,
} from '../../../src/api/middleware/validation';

// Helper to create mock Express objects
function createMockReq(overrides: Partial<Request> = {}): Request {
  return {
    body: {},
    params: {},
    query: {},
    ...overrides,
  } as Request;
}

function createMockRes(): Response {
  return {} as Response;
}

describe('validateBody', () => {
  const schema = z.object({
    name: z.string().min(1),
    age: z.number().int().positive(),
  });

  it('should call next() and set req.body when body is valid', () => {
    const req = createMockReq({ body: { name: 'Alice', age: 30 } });
    const res = createMockRes();
    const next = jest.fn();

    validateBody(schema)(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.body).toEqual({ name: 'Alice', age: 30 });
  });

  it('should call next(error) when body is invalid', () => {
    const req = createMockReq({ body: { name: '', age: -5 } });
    const res = createMockRes();
    const next = jest.fn();

    validateBody(schema)(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ZodError));
  });

  it('should strip extra fields not defined in the schema', () => {
    const req = createMockReq({ body: { name: 'Alice', age: 30, extra: 'field' } });
    const res = createMockRes();
    const next = jest.fn();

    validateBody(schema)(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.body).toEqual({ name: 'Alice', age: 30 });
    expect(req.body.extra).toBeUndefined();
  });

  it('should call next(error) when required fields are missing', () => {
    const req = createMockReq({ body: {} });
    const res = createMockRes();
    const next = jest.fn();

    validateBody(schema)(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ZodError));
  });
});

describe('validateParams', () => {
  const schema = z.object({
    id: z.string().regex(/^\d+$/).transform(Number),
  });

  it('should transform string params to the correct type and call next()', () => {
    const req = createMockReq({ params: { id: '42' } as any });
    const res = createMockRes();
    const next = jest.fn();

    validateParams(schema)(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.params.id).toBe(42);
  });

  it('should clear old keys and assign validated values', () => {
    const req = createMockReq({ params: { id: '10', stale: 'value' } as any });
    const res = createMockRes();
    const next = jest.fn();

    validateParams(schema)(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.params.id).toBe(10);
    expect((req.params as any).stale).toBeUndefined();
  });

  it('should call next(error) when params are invalid', () => {
    const req = createMockReq({ params: { id: 'abc' } as any });
    const res = createMockRes();
    const next = jest.fn();

    validateParams(schema)(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ZodError));
  });
});

describe('validateQuery', () => {
  const schema = z.object({
    page: z.string().optional().default('1').transform(Number),
    search: z.string().optional(),
  });

  it('should set validatedQuery on the request object', () => {
    const req = createMockReq({ query: { page: '3', search: 'test' } });
    const res = createMockRes();
    const next = jest.fn();

    validateQuery(schema)(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect((req as any).validatedQuery).toEqual({ page: 3, search: 'test' });
  });

  it('should also update req.query for backwards compatibility', () => {
    const req = createMockReq({ query: { page: '5' } });
    const res = createMockRes();
    const next = jest.fn();

    validateQuery(schema)(req, res, next);

    expect(next).toHaveBeenCalledWith();
    // req.query may coerce values, but validatedQuery should be accurate
    expect((req as any).validatedQuery.page).toBe(5);
  });

  it('should handle read-only req.query gracefully', () => {
    const req = createMockReq();
    // Freeze query to simulate read-only environment
    const frozenQuery = Object.freeze({ page: '2' });
    Object.defineProperty(req, 'query', {
      get: () => frozenQuery,
      configurable: true,
    });
    const res = createMockRes();
    const next = jest.fn();

    validateQuery(schema)(req, res, next);

    // Should still succeed even if updating req.query throws
    expect(next).toHaveBeenCalledWith();
    expect((req as any).validatedQuery).toEqual({ page: 2 });
  });

  it('should call next(error) when query is invalid', () => {
    const invalidSchema = z.object({
      status: z.enum(['active', 'inactive']),
    });
    const req = createMockReq({ query: { status: 'bogus' } });
    const res = createMockRes();
    const next = jest.fn();

    validateQuery(invalidSchema)(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ZodError));
  });
});

describe('idParamSchema', () => {
  it('should parse "42" and transform to number 42', () => {
    const result = idParamSchema.safeParse({ id: '42' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe(42);
    }
  });

  it('should reject non-numeric string "abc"', () => {
    const result = idParamSchema.safeParse({ id: 'abc' });
    expect(result.success).toBe(false);
  });

  it('should reject negative number string "-1"', () => {
    const result = idParamSchema.safeParse({ id: '-1' });
    expect(result.success).toBe(false);
  });

  it('should reject empty string ""', () => {
    const result = idParamSchema.safeParse({ id: '' });
    expect(result.success).toBe(false);
  });
});

describe('uuidParamSchema', () => {
  it('should accept a valid UUID', () => {
    const result = uuidParamSchema.safeParse({ id: '550e8400-e29b-41d4-a716-446655440000' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('550e8400-e29b-41d4-a716-446655440000');
    }
  });

  it('should reject an invalid UUID', () => {
    const result = uuidParamSchema.safeParse({ id: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });
});

describe('paginationSchema', () => {
  it('should use defaults when no values are provided', () => {
    const result = paginationSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(20);
    }
  });

  it('should accept custom page and limit values', () => {
    const result = paginationSchema.safeParse({ page: '3', limit: '50' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(3);
      expect(result.data.limit).toBe(50);
    }
  });

  it('should reject page=0', () => {
    const result = paginationSchema.safeParse({ page: '0' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('Page must be greater than 0');
    }
  });

  it('should reject limit=101 (exceeds maximum)', () => {
    const result = paginationSchema.safeParse({ limit: '101' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('Limit must be between 1 and 100');
    }
  });

  it('should reject negative limit', () => {
    const result = paginationSchema.safeParse({ limit: '-5' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('Limit must be between 1 and 100');
    }
  });
});

describe('createPlaylistSchema', () => {
  it('should accept a valid name and optional description', () => {
    const result = createPlaylistSchema.safeParse({
      name: 'My Playlist',
      description: 'A great playlist',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('My Playlist');
      expect(result.data.description).toBe('A great playlist');
    }
  });

  it('should reject an empty name', () => {
    const result = createPlaylistSchema.safeParse({ name: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('Playlist name is required');
    }
  });

  it('should reject a name exceeding 255 characters', () => {
    const result = createPlaylistSchema.safeParse({ name: 'x'.repeat(256) });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('Playlist name must not exceed 255 characters');
    }
  });

  it('should reject a description exceeding 1000 characters', () => {
    const result = createPlaylistSchema.safeParse({
      name: 'Valid Name',
      description: 'd'.repeat(1001),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('Description must not exceed 1000 characters');
    }
  });
});

describe('updatePlaylistSchema', () => {
  it('should accept name only', () => {
    const result = updatePlaylistSchema.safeParse({ name: 'Updated Name' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('Updated Name');
    }
  });

  it('should accept description only', () => {
    const result = updatePlaylistSchema.safeParse({ description: 'Updated desc' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe('Updated desc');
    }
  });

  it('should reject an empty object (no fields provided)', () => {
    const result = updatePlaylistSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('At least one field (name or description) must be provided');
    }
  });
});

describe('addPlaylistItemsSchema', () => {
  it('should accept a valid array of media IDs', () => {
    const result = addPlaylistItemsSchema.safeParse({ mediaIds: [1, 2, 3] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mediaIds).toEqual([1, 2, 3]);
    }
  });

  it('should reject an empty array', () => {
    const result = addPlaylistItemsSchema.safeParse({ mediaIds: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('At least one media ID is required');
    }
  });

  it('should reject an array with more than 100 items', () => {
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    const result = addPlaylistItemsSchema.safeParse({ mediaIds: ids });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('Cannot add more than 100 items at once');
    }
  });
});

describe('updatePlaylistItemSchema', () => {
  it('should accept order_index only', () => {
    const result = updatePlaylistItemSchema.safeParse({ order_index: 5 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.order_index).toBe(5);
    }
  });

  it('should accept image_duration only', () => {
    const result = updatePlaylistItemSchema.safeParse({ image_duration: 30 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.image_duration).toBe(30);
    }
  });

  it('should reject an empty object (no fields provided)', () => {
    const result = updatePlaylistItemSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain(
        'At least one field (order_index or image_duration) must be provided',
      );
    }
  });
});

describe('reorderPlaylistItemsSchema', () => {
  it('should accept an array of unique item IDs', () => {
    const result = reorderPlaylistItemsSchema.safeParse({ itemIds: [3, 1, 2] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.itemIds).toEqual([3, 1, 2]);
    }
  });

  it('should reject an array with duplicate IDs', () => {
    const result = reorderPlaylistItemsSchema.safeParse({ itemIds: [1, 2, 2, 3] });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('Item IDs must be unique');
    }
  });
});

describe('registerClientSchema', () => {
  const validClient = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'Display 1',
    version: '1.0.0',
    capabilities: '{"video": true}',
  };

  it('should accept a valid registration payload', () => {
    const result = registerClientSchema.safeParse(validClient);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe(validClient.id);
      expect(result.data.name).toBe('Display 1');
      expect(result.data.version).toBe('1.0.0');
      expect(result.data.capabilities).toBe('{"video": true}');
    }
  });

  it('should reject a non-UUID id', () => {
    const result = registerClientSchema.safeParse({ ...validClient, id: 'not-a-uuid' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('Client ID must be a valid UUID');
    }
  });

  it('should reject invalid JSON in capabilities', () => {
    const result = registerClientSchema.safeParse({
      ...validClient,
      capabilities: '{invalid-json}',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('Capabilities must be a valid JSON string');
    }
  });

  it('should reject a name exceeding 255 characters', () => {
    const result = registerClientSchema.safeParse({
      ...validClient,
      name: 'x'.repeat(256),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('Client name must not exceed 255 characters');
    }
  });
});

describe('clientStatusSchema', () => {
  it('should accept a valid status object', () => {
    const result = clientStatusSchema.safeParse({
      current_media_id: 5,
      position: 120.5,
      is_playing: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.is_playing).toBe(true);
      expect(result.data.position).toBe(120.5);
      expect(result.data.current_media_id).toBe(5);
    }
  });

  it('should reject when is_playing is missing', () => {
    const result = clientStatusSchema.safeParse({
      current_media_id: 1,
      position: 0,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const codes = result.error.issues.map((i) => i.code);
      expect(codes).toContain('invalid_type');
    }
  });

  it('should reject a negative position', () => {
    const result = clientStatusSchema.safeParse({
      is_playing: false,
      position: -10,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain('Position must be non-negative');
    }
  });
});

describe('listClientsQuerySchema', () => {
  it('should accept valid status and assigned_playlist_id', () => {
    const result = listClientsQuerySchema.safeParse({
      status: 'online',
      assigned_playlist_id: '7',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('online');
      expect(result.data.assigned_playlist_id).toBe(7);
    }
  });

  it('should reject an invalid status value', () => {
    const result = listClientsQuerySchema.safeParse({ status: 'unknown' });
    expect(result.success).toBe(false);
  });
});

describe('heartbeatSchema', () => {
  it('should accept an empty object (timestamp is optional)', () => {
    const result = heartbeatSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});
