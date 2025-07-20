import { Request, Response, NextFunction } from 'express';

/**
 * Validate JSON body middleware
 */
export const validateJsonBody = (req: Request, res: Response, next: NextFunction): any => {
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    if (!req.is('application/json') && !req.is('multipart/form-data')) {
      res.status(400).json({
        error: {
          code: 'INVALID_CONTENT_TYPE',
          message: 'Content-Type must be application/json for this endpoint',
          timestamp: new Date()
        }
      });
      return;
    }
  }
  next();
};

/**
 * Validate required fields in request body
 */
export const validateRequiredFields = (fields: string[]) => {
  return (req: Request, res: Response, next: NextFunction): any => {
    const missingFields: string[] = [];
    
    for (const field of fields) {
      if (req.body[field] === undefined || req.body[field] === null || req.body[field] === '') {
        missingFields.push(field);
      }
    }
    
    if (missingFields.length > 0) {
      return res.status(400).json({
        error: {
          code: 'MISSING_REQUIRED_FIELDS',
          message: `Missing required fields: ${missingFields.join(', ')}`,
          details: { missingFields },
          timestamp: new Date()
        }
      });
    }
    
    next();
  };
};

/**
 * Validate UUID format
 */
export const validateUuid = (paramName: string) => {
  return (req: Request, res: Response, next: NextFunction): any => {
    const uuid = req.params[paramName];
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    
    if (!uuid || !uuidRegex.test(uuid)) {
      return res.status(400).json({
        error: {
          code: 'INVALID_UUID',
          message: `Invalid UUID format for parameter: ${paramName}`,
          details: { paramName, value: uuid },
          timestamp: new Date()
        }
      });
    }
    
    next();
  };
};

/**
 * Validate string length
 */
export const validateStringLength = (field: string, minLength: number = 0, maxLength: number = 255) => {
  return (req: Request, res: Response, next: NextFunction): any => {
    const value = req.body[field];
    
    if (value !== undefined && typeof value === 'string') {
      const trimmedValue = value.trim();
      
      if (trimmedValue.length < minLength) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: `${field} must be at least ${minLength} characters long`,
            details: { field, minLength, actualLength: trimmedValue.length },
            timestamp: new Date()
          }
        });
      }
      
      if (trimmedValue.length > maxLength) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: `${field} must be no more than ${maxLength} characters long`,
            details: { field, maxLength, actualLength: trimmedValue.length },
            timestamp: new Date()
          }
        });
      }
      
      // Update the request body with trimmed value
      req.body[field] = trimmedValue;
    }
    
    next();
  };
};

/**
 * Validate number range
 */
export const validateNumberRange = (field: string, min?: number, max?: number) => {
  return (req: Request, res: Response, next: NextFunction): any => {
    const value = req.body[field];
    
    if (value !== undefined) {
      const numValue = Number(value);
      
      if (isNaN(numValue)) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: `${field} must be a valid number`,
            details: { field, value },
            timestamp: new Date()
          }
        });
      }
      
      if (min !== undefined && numValue < min) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: `${field} must be at least ${min}`,
            details: { field, min, value: numValue },
            timestamp: new Date()
          }
        });
      }
      
      if (max !== undefined && numValue > max) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: `${field} must be no more than ${max}`,
            details: { field, max, value: numValue },
            timestamp: new Date()
          }
        });
      }
      
      // Update the request body with parsed number
      req.body[field] = numValue;
    }
    
    next();
  };
};

/**
 * Sanitize input by removing potentially dangerous characters
 */
export const sanitizeInput = (fields: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    for (const field of fields) {
      if (req.body[field] && typeof req.body[field] === 'string') {
        // Remove HTML tags and potentially dangerous characters
        req.body[field] = req.body[field]
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
          .replace(/<[^>]*>/g, '')
          .trim();
      }
    }
    next();
  };
};

/**
 * Rate limiting middleware (basic implementation)
 */
const requestCounts = new Map<string, { count: number; resetTime: number }>();

export const rateLimit = (maxRequests: number = 100, windowMs: number = 15 * 60 * 1000) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const clientId = req.ip || 'unknown';
    const now = Date.now();
    
    const clientData = requestCounts.get(clientId);
    
    if (!clientData || now > clientData.resetTime) {
      // Reset or initialize counter
      requestCounts.set(clientId, {
        count: 1,
        resetTime: now + windowMs
      });
      return next();
    }
    
    if (clientData.count >= maxRequests) {
      return res.status(429).json({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests, please try again later',
          details: {
            maxRequests,
            windowMs,
            retryAfter: Math.ceil((clientData.resetTime - now) / 1000)
          },
          timestamp: new Date()
        }
      });
    }
    
    clientData.count++;
    next();
  };
};

// Export function to clear rate limit data (for testing)
export const clearRateLimitData = () => {
  requestCounts.clear();
};