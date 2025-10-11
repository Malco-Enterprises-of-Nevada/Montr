import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { getLogger } from '../../utils/logger';

const logger = getLogger();

/**
 * Error codes for standardized error responses
 */
export enum ErrorCode {
  // General errors
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
  BAD_REQUEST = 'BAD_REQUEST',
  NOT_FOUND = 'NOT_FOUND',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',

  // Validation errors
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INVALID_INPUT = 'INVALID_INPUT',

  // Resource errors
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  RESOURCE_ALREADY_EXISTS = 'RESOURCE_ALREADY_EXISTS',

  // Media errors
  MEDIA_NOT_FOUND = 'MEDIA_NOT_FOUND',
  MEDIA_UPLOAD_FAILED = 'MEDIA_UPLOAD_FAILED',
  INVALID_MEDIA_TYPE = 'INVALID_MEDIA_TYPE',
  FILE_TOO_LARGE = 'FILE_TOO_LARGE',

  // Playlist errors
  PLAYLIST_NOT_FOUND = 'PLAYLIST_NOT_FOUND',
  PLAYLIST_ITEM_NOT_FOUND = 'PLAYLIST_ITEM_NOT_FOUND',
  PLAYLIST_EMPTY = 'PLAYLIST_EMPTY',
  INVALID_PLAYLIST_ORDER = 'INVALID_PLAYLIST_ORDER',

  // Client errors
  CLIENT_NOT_FOUND = 'CLIENT_NOT_FOUND',
  CLIENT_ALREADY_REGISTERED = 'CLIENT_ALREADY_REGISTERED',
  CLIENT_OFFLINE = 'CLIENT_OFFLINE',
  INVALID_CLIENT_STATUS = 'INVALID_CLIENT_STATUS',

  // Database errors
  DATABASE_ERROR = 'DATABASE_ERROR',
  DATABASE_CONNECTION_FAILED = 'DATABASE_CONNECTION_FAILED',
  DUPLICATE_ENTRY = 'DUPLICATE_ENTRY',

  // Storage errors
  STORAGE_ERROR = 'STORAGE_ERROR',
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  INSUFFICIENT_STORAGE = 'INSUFFICIENT_STORAGE',
}

/**
 * Custom application error class
 */
export class AppError extends Error {
  public code: ErrorCode;

  public statusCode: number;

  public isOperational: boolean;

  public details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number = 500,
    isOperational: boolean = true,
    details?: unknown
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.details = details;

    // Maintain proper stack trace
    Error.captureStackTrace(this, this.constructor);

    // Set the prototype explicitly to fix instanceof checks
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

/**
 * Standard API response interface
 */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T | null;
  error: {
    code: string;
    message: string;
    details?: unknown;
  } | null;
}

/**
 * Creates a success response
 */
export function successResponse<T>(data: T): ApiResponse<T> {
  return {
    success: true,
    data,
    error: null,
  };
}

/**
 * Creates an error response
 */
export function errorResponse(code: string, message: string, details?: unknown): ApiResponse<null> {
  return {
    success: false,
    data: null,
    error: {
      code,
      message,
      details,
    },
  };
}

/**
 * Handles Zod validation errors
 */
function handleZodError(error: ZodError): { statusCode: number; response: ApiResponse<null> } {
  const errors = error.issues.map((err) => ({
    field: err.path.join('.'),
    message: err.message,
  }));

  return {
    statusCode: 400,
    response: errorResponse(ErrorCode.VALIDATION_ERROR, 'Validation failed', errors),
  };
}

/**
 * Handles AppError instances
 */
function handleAppError(error: AppError): { statusCode: number; response: ApiResponse<null> } {
  return {
    statusCode: error.statusCode,
    response: errorResponse(error.code, error.message, error.details),
  };
}

/**
 * Handles unknown errors
 */
function handleUnknownError(error: Error): { statusCode: number; response: ApiResponse<null> } {
  return {
    statusCode: 500,
    response: errorResponse(
      ErrorCode.INTERNAL_SERVER_ERROR,
      'An unexpected error occurred',
      process.env.NODE_ENV === 'development' ? error.message : undefined
    ),
  };
}

/**
 * Express error handling middleware
 * Catches all errors and formats them into standardized API responses
 */
export function errorHandler(error: Error, req: Request, res: Response, _next: NextFunction): void {
  let statusCode: number;
  let response: ApiResponse<null>;

  // Log the error
  logger.error(`Error handling request ${req.method} ${req.path}:`, {
    error: error.message,
    stack: error.stack,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    body: req.body,
    params: req.params,
    query: req.query,
  });

  // Determine error type and create appropriate response
  if (error instanceof ZodError) {
    ({ statusCode, response } = handleZodError(error));
  } else if (error instanceof AppError) {
    ({ statusCode, response } = handleAppError(error));
  } else {
    ({ statusCode, response } = handleUnknownError(error));
  }

  // Send response
  res.status(statusCode).json(response);
}

/**
 * Async handler wrapper to catch errors in async route handlers
 * @param fn - Async route handler function
 * @returns Express middleware function
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 404 Not Found handler middleware
 */
export function notFoundHandler(req: Request, res: Response): void {
  const response = errorResponse(ErrorCode.NOT_FOUND, `Route ${req.method} ${req.path} not found`);
  res.status(404).json(response);
}

// Utility functions for creating common errors

/**
 * Creates a "resource not found" error
 */
export function createNotFoundError(resource: string, id: string | number): AppError {
  return new AppError(
    ErrorCode.RESOURCE_NOT_FOUND,
    `${resource} with ID ${id} not found`,
    404
  );
}

/**
 * Creates a validation error
 */
export function createValidationError(message: string, details?: unknown): AppError {
  return new AppError(ErrorCode.VALIDATION_ERROR, message, 400, true, details);
}

/**
 * Creates a bad request error
 */
export function createBadRequestError(message: string): AppError {
  return new AppError(ErrorCode.BAD_REQUEST, message, 400);
}

/**
 * Creates a database error
 */
export function createDatabaseError(message: string, details?: unknown): AppError {
  return new AppError(ErrorCode.DATABASE_ERROR, message, 500, true, details);
}

/**
 * Creates a storage error
 */
export function createStorageError(message: string, details?: unknown): AppError {
  return new AppError(ErrorCode.STORAGE_ERROR, message, 500, true, details);
}

export default errorHandler;
