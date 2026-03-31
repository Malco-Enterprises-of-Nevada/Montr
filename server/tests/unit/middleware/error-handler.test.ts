/**
 * Comprehensive unit tests for error handler middleware
 * Tests AppError, response helpers, error handler, async handler,
 * not-found handler, and error factory functions
 */

import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import {
  AppError,
  ErrorCode,
  successResponse,
  errorResponse,
  errorHandler,
  asyncHandler,
  notFoundHandler,
  createNotFoundError,
  createValidationError,
  createBadRequestError,
  createDatabaseError,
  createStorageError,
} from '../../../src/api/middleware/error-handler';

// Mock logger — singleton so the module-level getLogger() and test share the same fns.
// The logger instance is stored as __mockLogger on the mock module for test access.
jest.mock('../../../src/utils/logger', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fns = jest.requireActual('../../../src/utils/logger');
  // We cannot reference outer `mockLoggerFns` due to hoisting; re-create here.
  const logger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  };
  return {
    ...fns,
    getLogger: () => logger,
    __mockLogger: logger,
  };
});

describe('Error Handler Middleware', () => {
  // Mock helpers
  function createMockReq(overrides: Partial<Request> = {}): Request {
    return {
      method: 'GET',
      path: '/api/test',
      body: {},
      params: {},
      query: {},
      ...overrides,
    } as Request;
  }

  function createMockRes(): Response {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    return res;
  }

  function createMockNext(): NextFunction {
    return jest.fn() as NextFunction;
  }

  // ─── AppError class ───────────────────────────────────────────────────

  describe('AppError', () => {
    it('should create an error with all provided arguments', () => {
      const error = new AppError(
        ErrorCode.BAD_REQUEST,
        'Invalid input',
        400,
        true,
        { field: 'name' },
      );

      expect(error.code).toBe(ErrorCode.BAD_REQUEST);
      expect(error.message).toBe('Invalid input');
      expect(error.statusCode).toBe(400);
      expect(error.isOperational).toBe(true);
      expect(error.details).toEqual({ field: 'name' });
    });

    it('should default statusCode to 500 and isOperational to true', () => {
      const error = new AppError(ErrorCode.INTERNAL_SERVER_ERROR, 'Something broke');

      expect(error.statusCode).toBe(500);
      expect(error.isOperational).toBe(true);
    });

    it('should be an instance of Error and AppError', () => {
      const error = new AppError(ErrorCode.NOT_FOUND, 'Not found', 404);

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(AppError);
    });

    it('should capture a stack trace', () => {
      const error = new AppError(ErrorCode.DATABASE_ERROR, 'DB failed', 500);

      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('DB failed');
    });

    it('should have details as undefined when not provided', () => {
      const error = new AppError(ErrorCode.FORBIDDEN, 'Access denied', 403);

      expect(error.details).toBeUndefined();
    });

    it('should allow non-operational errors', () => {
      const error = new AppError(
        ErrorCode.INTERNAL_SERVER_ERROR,
        'Fatal crash',
        500,
        false,
      );

      expect(error.isOperational).toBe(false);
    });
  });

  // ─── successResponse ──────────────────────────────────────────────────

  describe('successResponse', () => {
    it('should wrap object data in a success envelope', () => {
      const data = { id: 1, name: 'Test' };
      const result = successResponse(data);

      expect(result).toEqual({
        success: true,
        data: { id: 1, name: 'Test' },
        error: null,
      });
    });

    it('should wrap array data in a success envelope', () => {
      const data = [1, 2, 3];
      const result = successResponse(data);

      expect(result).toEqual({
        success: true,
        data: [1, 2, 3],
        error: null,
      });
    });
  });

  // ─── errorResponse ───────────────────────────────────────────────────

  describe('errorResponse', () => {
    it('should create an error envelope with code and message', () => {
      const result = errorResponse('BAD_REQUEST', 'Invalid input');

      expect(result).toEqual({
        success: false,
        data: null,
        error: { code: 'BAD_REQUEST', message: 'Invalid input' },
      });
    });

    it('should include details when provided', () => {
      const details = [{ field: 'email', message: 'Required' }];
      const result = errorResponse('VALIDATION_ERROR', 'Validation failed', details);

      expect(result).toEqual({
        success: false,
        data: null,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          details,
        },
      });
    });

    it('should omit details when not provided', () => {
      const result = errorResponse('NOT_FOUND', 'Resource not found');

      expect(result.error!.details).toBeUndefined();
    });
  });

  // ─── errorHandler middleware ──────────────────────────────────────────

  describe('errorHandler', () => {
    it('should handle ZodError with 400 status and validation details', () => {
      const zodError = new ZodError([
        {
          code: 'invalid_type',
          expected: 'string',
          path: ['name'],
          message: 'Expected string, received number',
        },
        {
          code: 'invalid_type',
          expected: 'string',
          path: ['email'],
          message: 'Required',
        },
      ]);

      const req = createMockReq();
      const res = createMockRes();
      const next = createMockNext();

      errorHandler(zodError, req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        data: null,
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: 'Validation failed',
          details: [
            { field: 'name', message: 'Expected string, received number' },
            { field: 'email', message: 'Required' },
          ],
        },
      });
    });

    it('should handle ZodError with nested path fields', () => {
      const zodError = new ZodError([
        {
          code: 'invalid_type',
          expected: 'number',
          path: ['config', 'display', 'width'],
          message: 'Expected number',
        },
      ]);

      const req = createMockReq();
      const res = createMockRes();
      const next = createMockNext();

      errorHandler(zodError, req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            details: [{ field: 'config.display.width', message: 'Expected number' }],
          }),
        }),
      );
    });

    it('should handle AppError with its status code and details', () => {
      const appError = new AppError(
        ErrorCode.MEDIA_NOT_FOUND,
        'Media item not found',
        404,
        true,
        { mediaId: 42 },
      );

      const req = createMockReq();
      const res = createMockRes();
      const next = createMockNext();

      errorHandler(appError, req, res, next);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        data: null,
        error: {
          code: ErrorCode.MEDIA_NOT_FOUND,
          message: 'Media item not found',
          details: { mediaId: 42 },
        },
      });
    });

    it('should handle AppError without details', () => {
      const appError = new AppError(ErrorCode.UNAUTHORIZED, 'Not authorized', 401);

      const req = createMockReq();
      const res = createMockRes();
      const next = createMockNext();

      errorHandler(appError, req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        data: null,
        error: {
          code: ErrorCode.UNAUTHORIZED,
          message: 'Not authorized',
        },
      });
    });

    it('should handle unknown errors with 500 status in production', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      const error = new Error('Unexpected failure');

      const req = createMockReq();
      const res = createMockRes();
      const next = createMockNext();

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        data: null,
        error: {
          code: ErrorCode.INTERNAL_SERVER_ERROR,
          message: 'An unexpected error occurred',
        },
      });

      process.env.NODE_ENV = originalEnv;
    });

    it('should include error message in details for unknown errors in development', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      const error = new Error('Segfault in module X');

      const req = createMockReq();
      const res = createMockRes();
      const next = createMockNext();

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        data: null,
        error: {
          code: ErrorCode.INTERNAL_SERVER_ERROR,
          message: 'An unexpected error occurred',
          details: 'Segfault in module X',
        },
      });

      process.env.NODE_ENV = originalEnv;
    });

    it('should log the error with request context', () => {
      // Access the singleton logger instance from the mock module
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { __mockLogger: loggerMock } = require('../../../src/utils/logger');

      const error = new Error('Something went wrong');
      const req = createMockReq({
        method: 'POST',
        path: '/api/media',
        body: { name: 'test' },
        params: { id: '5' } as any,
        query: { page: '1' } as any,
      });
      const res = createMockRes();
      const next = createMockNext();

      errorHandler(error, req, res, next);

      expect(loggerMock.error).toHaveBeenCalledWith(
        'Error handling request POST /api/media:',
        expect.objectContaining({
          error: 'Something went wrong',
          stack: expect.any(String),
          body: { name: 'test' },
          params: { id: '5' },
          query: { page: '1' },
        }),
      );
    });

    it('should call res.status then res.json (chaining)', () => {
      const error = new AppError(ErrorCode.FORBIDDEN, 'Forbidden', 403);
      const req = createMockReq();
      const res = createMockRes();
      const next = createMockNext();

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledTimes(1);
    });

    it('should not call next', () => {
      const error = new Error('test');
      const req = createMockReq();
      const res = createMockRes();
      const next = createMockNext();

      errorHandler(error, req, res, next);

      expect(next).not.toHaveBeenCalled();
    });

    it('should handle AppError with custom 503 status code', () => {
      const error = new AppError(ErrorCode.DATABASE_CONNECTION_FAILED, 'DB unavailable', 503);

      const req = createMockReq();
      const res = createMockRes();
      const next = createMockNext();

      errorHandler(error, req, res, next);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: ErrorCode.DATABASE_CONNECTION_FAILED,
            message: 'DB unavailable',
          }),
        }),
      );
    });
  });

  // ─── asyncHandler ────────────────────────────────────────────────────

  describe('asyncHandler', () => {
    it('should call the wrapped async function normally on success', async () => {
      const handler = jest.fn().mockResolvedValue(undefined);
      const wrapped = asyncHandler(handler);

      const req = createMockReq();
      const res = createMockRes();
      const next = createMockNext();

      await wrapped(req, res, next);

      expect(handler).toHaveBeenCalledWith(req, res, next);
      expect(next).not.toHaveBeenCalled();
    });

    it('should call next with the error when handler throws', async () => {
      const error = new Error('Handler threw');
      const handler = jest.fn().mockRejectedValue(error);
      const wrapped = asyncHandler(handler);

      const req = createMockReq();
      const res = createMockRes();
      const next = createMockNext();

      await wrapped(req, res, next);

      expect(next).toHaveBeenCalledWith(error);
    });

    it('should call next with the error when handler returns a rejected promise', async () => {
      const error = new AppError(ErrorCode.BAD_REQUEST, 'Bad', 400);
      const handler = jest.fn().mockImplementation(() => Promise.reject(error));
      const wrapped = asyncHandler(handler);

      const req = createMockReq();
      const res = createMockRes();
      const next = createMockNext();

      await wrapped(req, res, next);

      expect(next).toHaveBeenCalledWith(error);
    });
  });

  // ─── notFoundHandler ─────────────────────────────────────────────────

  describe('notFoundHandler', () => {
    it('should respond with 404 status', () => {
      const req = createMockReq({ method: 'GET', path: '/api/unknown' });
      const res = createMockRes();

      notFoundHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should include method and path in the error message', () => {
      const req = createMockReq({ method: 'DELETE', path: '/api/widgets/99' });
      const res = createMockRes();

      notFoundHandler(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: false,
        data: null,
        error: {
          code: ErrorCode.NOT_FOUND,
          message: 'Route DELETE /api/widgets/99 not found',
        },
      });
    });
  });

  // ─── Error factory functions ──────────────────────────────────────────

  describe('Error factory functions', () => {
    it('createNotFoundError should create a 404 RESOURCE_NOT_FOUND error', () => {
      const error = createNotFoundError('Playlist', 42);

      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe(ErrorCode.RESOURCE_NOT_FOUND);
      expect(error.statusCode).toBe(404);
      expect(error.message).toBe('Playlist with ID 42 not found');
    });

    it('createValidationError should create a 400 VALIDATION_ERROR with details', () => {
      const details = { field: 'duration', reason: 'must be positive' };
      const error = createValidationError('Invalid duration', details);

      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(error.statusCode).toBe(400);
      expect(error.message).toBe('Invalid duration');
      expect(error.details).toEqual(details);
    });

    it('createBadRequestError should create a 400 BAD_REQUEST error', () => {
      const error = createBadRequestError('Missing required field');

      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe(ErrorCode.BAD_REQUEST);
      expect(error.statusCode).toBe(400);
      expect(error.message).toBe('Missing required field');
    });

    it('createDatabaseError should create a 500 DATABASE_ERROR with details', () => {
      const details = { query: 'SELECT *', errno: 1045 };
      const error = createDatabaseError('Query failed', details);

      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe(ErrorCode.DATABASE_ERROR);
      expect(error.statusCode).toBe(500);
      expect(error.message).toBe('Query failed');
      expect(error.details).toEqual(details);
    });

    it('createStorageError should create a 500 STORAGE_ERROR with details', () => {
      const details = { path: '/uploads/file.mp4' };
      const error = createStorageError('Write failed', details);

      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe(ErrorCode.STORAGE_ERROR);
      expect(error.statusCode).toBe(500);
      expect(error.message).toBe('Write failed');
      expect(error.details).toEqual(details);
    });
  });

  // ─── ErrorCode enum ──────────────────────────────────────────────────

  describe('ErrorCode', () => {
    it('should have string values matching their key names', () => {
      expect(ErrorCode.INTERNAL_SERVER_ERROR).toBe('INTERNAL_SERVER_ERROR');
      expect(ErrorCode.BAD_REQUEST).toBe('BAD_REQUEST');
      expect(ErrorCode.NOT_FOUND).toBe('NOT_FOUND');
      expect(ErrorCode.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
      expect(ErrorCode.MEDIA_NOT_FOUND).toBe('MEDIA_NOT_FOUND');
      expect(ErrorCode.PLAYLIST_NOT_FOUND).toBe('PLAYLIST_NOT_FOUND');
      expect(ErrorCode.CLIENT_NOT_FOUND).toBe('CLIENT_NOT_FOUND');
      expect(ErrorCode.DATABASE_ERROR).toBe('DATABASE_ERROR');
      expect(ErrorCode.STORAGE_ERROR).toBe('STORAGE_ERROR');
    });

    it('should contain all expected error codes as string values', () => {
      const values = Object.values(ErrorCode);

      expect(values).toContain('UNAUTHORIZED');
      expect(values).toContain('FORBIDDEN');
      expect(values).toContain('RESOURCE_NOT_FOUND');
      expect(values).toContain('RESOURCE_ALREADY_EXISTS');
      expect(values).toContain('MEDIA_UPLOAD_FAILED');
      expect(values).toContain('INVALID_MEDIA_TYPE');
      expect(values).toContain('FILE_TOO_LARGE');
      expect(values).toContain('PLAYLIST_ITEM_NOT_FOUND');
      expect(values).toContain('PLAYLIST_EMPTY');
      expect(values).toContain('INVALID_PLAYLIST_ORDER');
      expect(values).toContain('CLIENT_ALREADY_REGISTERED');
      expect(values).toContain('CLIENT_OFFLINE');
      expect(values).toContain('INVALID_CLIENT_STATUS');
      expect(values).toContain('DATABASE_CONNECTION_FAILED');
      expect(values).toContain('DUPLICATE_ENTRY');
      expect(values).toContain('FILE_NOT_FOUND');
      expect(values).toContain('INSUFFICIENT_STORAGE');
      expect(values).toContain('INVALID_INPUT');

      // All values should be strings
      values.forEach((v) => {
        expect(typeof v).toBe('string');
      });
    });
  });
});
