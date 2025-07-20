import { Request, Response, NextFunction } from 'express';
import logger, { createComponentLogger } from '../utils/logger.js';

const errorLogger = createComponentLogger('error-handler');

export interface ApiError extends Error {
  statusCode?: number;
  code?: string;
  details?: any;
  isOperational?: boolean;
  context?: Record<string, any>;
}

/**
 * Error categories for better handling
 */
export enum ErrorCategory {
  VALIDATION = 'VALIDATION_ERROR',
  AUTHENTICATION = 'AUTHENTICATION_ERROR',
  AUTHORIZATION = 'AUTHORIZATION_ERROR',
  NOT_FOUND = 'NOT_FOUND_ERROR',
  CONFLICT = 'CONFLICT_ERROR',
  RATE_LIMIT = 'RATE_LIMIT_ERROR',
  FILE_UPLOAD = 'FILE_UPLOAD_ERROR',
  DATABASE = 'DATABASE_ERROR',
  WEBSOCKET = 'WEBSOCKET_ERROR',
  MEDIA_PROCESSING = 'MEDIA_PROCESSING_ERROR',
  NETWORK = 'NETWORK_ERROR',
  INTERNAL = 'INTERNAL_ERROR'
}

/**
 * Enhanced global error handling middleware
 */
export const errorHandler = (
  error: ApiError,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Determine if error is operational (expected) or programming error
  const isOperational = error.isOperational !== false;
  
  // Extract error details
  const statusCode = error.statusCode || 500;
  const errorCode = error.code || ErrorCategory.INTERNAL;
  const message = error.message || 'Internal server error';
  
  // Create error context
  const errorContext = {
    url: req.url,
    method: req.method,
    userAgent: req.get('User-Agent'),
    ip: req.ip || req.connection.remoteAddress,
    timestamp: new Date().toISOString(),
    requestId: req.headers['x-request-id'] || 'unknown',
    ...error.context
  };

  // Log error based on severity
  if (statusCode >= 500) {
    errorLogger.error('Server Error', {
      message: error.message,
      stack: error.stack,
      statusCode,
      errorCode,
      context: errorContext,
      isOperational,
      body: req.body,
      params: req.params,
      query: req.query
    });
  } else if (statusCode >= 400) {
    errorLogger.warn('Client Error', {
      message: error.message,
      statusCode,
      errorCode,
      context: errorContext,
      body: req.body,
      params: req.params,
      query: req.query
    });
  }

  // Prepare error response
  const errorResponse: any = {
    error: {
      code: errorCode,
      message: getUserFriendlyMessage(errorCode, message),
      timestamp: new Date(),
      requestId: errorContext.requestId
    }
  };

  // Include details for non-production environments or operational errors
  if (process.env.NODE_ENV !== 'production' || isOperational) {
    errorResponse.error.details = error.details;
  }

  // Include stack trace for development
  if (process.env.NODE_ENV === 'development') {
    errorResponse.error.stack = error.stack;
  }

  res.status(statusCode).json(errorResponse);
};

/**
 * Get user-friendly error messages
 */
function getUserFriendlyMessage(errorCode: string, originalMessage: string): string {
  const friendlyMessages: Record<string, string> = {
    [ErrorCategory.VALIDATION]: 'The provided data is invalid. Please check your input and try again.',
    [ErrorCategory.AUTHENTICATION]: 'Authentication failed. Please check your credentials.',
    [ErrorCategory.AUTHORIZATION]: 'You do not have permission to perform this action.',
    [ErrorCategory.NOT_FOUND]: 'The requested resource was not found.',
    [ErrorCategory.CONFLICT]: 'This action conflicts with the current state. Please refresh and try again.',
    [ErrorCategory.RATE_LIMIT]: 'Too many requests. Please wait a moment before trying again.',
    [ErrorCategory.FILE_UPLOAD]: 'File upload failed. Please check the file format and size.',
    [ErrorCategory.DATABASE]: 'A database error occurred. Please try again later.',
    [ErrorCategory.WEBSOCKET]: 'Real-time connection error. Please refresh the page.',
    [ErrorCategory.MEDIA_PROCESSING]: 'Media processing failed. Please check the file format.',
    [ErrorCategory.NETWORK]: 'Network error occurred. Please check your connection.',
    [ErrorCategory.INTERNAL]: 'An internal server error occurred. Please try again later.'
  };

  return friendlyMessages[errorCode] || originalMessage;
}

/**
 * 404 Not Found handler
 */
export const notFoundHandler = (req: Request, res: Response, next: NextFunction) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`,
      timestamp: new Date()
    }
  });
};

/**
 * Async error wrapper to catch async errors in route handlers
 */
export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

/**
 * Create API error with status code and details
 */
export const createApiError = (
  message: string,
  statusCode: number = 500,
  code?: string,
  details?: any,
  context?: Record<string, any>
): ApiError => {
  const error = new Error(message) as ApiError;
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
  error.context = context;
  error.isOperational = true;
  return error;
};

/**
 * Create specific error types for common scenarios
 */
export const createValidationError = (message: string, details?: any) => {
  return createApiError(message, 400, ErrorCategory.VALIDATION, details);
};

export const createNotFoundError = (resource: string, id?: string) => {
  const message = id ? `${resource} with ID ${id} not found` : `${resource} not found`;
  return createApiError(message, 404, ErrorCategory.NOT_FOUND);
};

export const createConflictError = (message: string, details?: any) => {
  return createApiError(message, 409, ErrorCategory.CONFLICT, details);
};

export const createFileUploadError = (message: string, details?: any) => {
  return createApiError(message, 400, ErrorCategory.FILE_UPLOAD, details);
};

export const createDatabaseError = (message: string, originalError?: Error) => {
  return createApiError(
    message, 
    500, 
    ErrorCategory.DATABASE, 
    { originalError: originalError?.message }
  );
};

export const createMediaProcessingError = (message: string, details?: any) => {
  return createApiError(message, 422, ErrorCategory.MEDIA_PROCESSING, details);
};

export const createWebSocketError = (message: string, details?: any) => {
  return createApiError(message, 500, ErrorCategory.WEBSOCKET, details);
};

/**
 * Request logging middleware
 */
export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();
  const requestId = req.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Add request ID to headers for tracking
  req.headers['x-request-id'] = requestId as string;
  res.setHeader('X-Request-ID', requestId);

  // Log request
  logger.http('Incoming Request', {
    requestId,
    method: req.method,
    url: req.url,
    userAgent: req.get('User-Agent'),
    ip: req.ip || req.connection.remoteAddress,
    contentLength: req.get('Content-Length'),
    timestamp: new Date().toISOString()
  });

  // Log response when finished
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logLevel = res.statusCode >= 400 ? 'warn' : 'http';
    
    logger.log(logLevel, 'Request Completed', {
      requestId,
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      contentLength: res.get('Content-Length'),
      timestamp: new Date().toISOString()
    });
  });

  next();
};

/**
 * Graceful shutdown handler
 */
export const createGracefulShutdown = (server: any, connections: Set<any>) => {
  return (signal: string) => {
    logger.info(`Received ${signal}, starting graceful shutdown`);
    
    server.close(() => {
      logger.info('HTTP server closed');
      
      // Close all active connections
      connections.forEach(connection => {
        connection.destroy();
      });
      
      logger.info('All connections closed, exiting process');
      process.exit(0);
    });

    // Force exit after 30 seconds
    setTimeout(() => {
      logger.error('Graceful shutdown timeout, forcing exit');
      process.exit(1);
    }, 30000);
  };
};