import { Request, Response, NextFunction } from 'express';
import {
  validateJsonBody,
  validateRequiredFields,
  validateUuid,
  validateStringLength,
  validateNumberRange,
  sanitizeInput,
  rateLimit,
  clearRateLimitData
} from '../validationMiddleware';

describe('Validation Middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockReq = {
      method: 'POST',
      body: {},
      params: {},
      is: jest.fn(),
      ip: '127.0.0.1'
    };
    
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    
    mockNext = jest.fn();
  });

  describe('validateJsonBody', () => {
    it('should pass for GET requests', () => {
      mockReq.method = 'GET';
      
      validateJsonBody(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
    });

    it('should pass for application/json content type', () => {
      (mockReq.is as jest.Mock).mockReturnValue(true);
      
      validateJsonBody(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
    });

    it('should pass for multipart/form-data content type', () => {
      (mockReq.is as jest.Mock)
        .mockReturnValueOnce(false) // not application/json
        .mockReturnValueOnce(true); // is multipart/form-data
      
      validateJsonBody(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject invalid content type for POST', () => {
      (mockReq.is as jest.Mock).mockReturnValue(false);
      
      validateJsonBody(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 'INVALID_CONTENT_TYPE',
          message: 'Content-Type must be application/json for this endpoint',
          timestamp: expect.any(Date)
        }
      });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('validateRequiredFields', () => {
    it('should pass when all required fields are present', () => {
      mockReq.body = { name: 'test', email: 'test@example.com' };
      const middleware = validateRequiredFields(['name', 'email']);
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject when required fields are missing', () => {
      mockReq.body = { name: 'test' };
      const middleware = validateRequiredFields(['name', 'email']);
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 'MISSING_REQUIRED_FIELDS',
          message: 'Missing required fields: email',
          details: { missingFields: ['email'] },
          timestamp: expect.any(Date)
        }
      });
    });

    it('should reject empty string fields', () => {
      mockReq.body = { name: '', email: 'test@example.com' };
      const middleware = validateRequiredFields(['name', 'email']);
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should reject null fields', () => {
      mockReq.body = { name: null, email: 'test@example.com' };
      const middleware = validateRequiredFields(['name', 'email']);
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });

  describe('validateUuid', () => {
    it('should pass for valid UUID', () => {
      mockReq.params = { id: '123e4567-e89b-12d3-a456-426614174000' };
      const middleware = validateUuid('id');
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject invalid UUID format', () => {
      mockReq.params = { id: 'invalid-uuid' };
      const middleware = validateUuid('id');
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 'INVALID_UUID',
          message: 'Invalid UUID format for parameter: id',
          details: { paramName: 'id', value: 'invalid-uuid' },
          timestamp: expect.any(Date)
        }
      });
    });

    it('should reject missing UUID', () => {
      mockReq.params = {};
      const middleware = validateUuid('id');
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });

  describe('validateStringLength', () => {
    it('should pass for valid string length', () => {
      mockReq.body = { name: 'test' };
      const middleware = validateStringLength('name', 1, 10);
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
    });

    it('should trim whitespace', () => {
      mockReq.body = { name: '  test  ' };
      const middleware = validateStringLength('name', 1, 10);
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockReq.body.name).toBe('test');
      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject string too short', () => {
      mockReq.body = { name: 'a' };
      const middleware = validateStringLength('name', 2, 10);
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'name must be at least 2 characters long',
          details: { field: 'name', minLength: 2, actualLength: 1 },
          timestamp: expect.any(Date)
        }
      });
    });

    it('should reject string too long', () => {
      mockReq.body = { name: 'very long string' };
      const middleware = validateStringLength('name', 1, 5);
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should skip validation for undefined fields', () => {
      mockReq.body = {};
      const middleware = validateStringLength('name', 1, 10);
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('validateNumberRange', () => {
    it('should pass for valid number', () => {
      mockReq.body = { age: 25 };
      const middleware = validateNumberRange('age', 0, 100);
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
    });

    it('should convert string numbers', () => {
      mockReq.body = { age: '25' };
      const middleware = validateNumberRange('age', 0, 100);
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockReq.body.age).toBe(25);
      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject non-numeric values', () => {
      mockReq.body = { age: 'not a number' };
      const middleware = validateNumberRange('age', 0, 100);
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'age must be a valid number',
          details: { field: 'age', value: 'not a number' },
          timestamp: expect.any(Date)
        }
      });
    });

    it('should reject number below minimum', () => {
      mockReq.body = { age: -5 };
      const middleware = validateNumberRange('age', 0, 100);
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should reject number above maximum', () => {
      mockReq.body = { age: 150 };
      const middleware = validateNumberRange('age', 0, 100);
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });

  describe('sanitizeInput', () => {
    it('should remove HTML tags', () => {
      mockReq.body = { 
        name: '<script>alert("xss")</script>John',
        description: '<p>Hello <b>world</b></p>'
      };
      const middleware = sanitizeInput(['name', 'description']);
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockReq.body.name).toBe('John');
      expect(mockReq.body.description).toBe('Hello world');
      expect(mockNext).toHaveBeenCalled();
    });

    it('should trim whitespace', () => {
      mockReq.body = { name: '  John  ' };
      const middleware = sanitizeInput(['name']);
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockReq.body.name).toBe('John');
    });

    it('should skip non-string fields', () => {
      mockReq.body = { name: 123, description: 'text' };
      const middleware = sanitizeInput(['name', 'description']);
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockReq.body.name).toBe(123);
      expect(mockReq.body.description).toBe('text');
    });
  });

  describe('rateLimit', () => {
    beforeEach(() => {
      // Clear the rate limit map before each test
      clearRateLimitData();
      jest.clearAllMocks();
    });

    it('should allow requests within limit', () => {
      const middleware = rateLimit(5, 60000); // 5 requests per minute
      
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should block requests exceeding limit', () => {
      const middleware = rateLimit(1, 60000); // 1 request per minute
      
      // First request should pass
      middleware(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalledTimes(1);
      
      // Second request should be blocked
      jest.clearAllMocks();
      middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockRes.status).toHaveBeenCalledWith(429);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests, please try again later',
          details: {
            maxRequests: 1,
            windowMs: 60000,
            retryAfter: expect.any(Number)
          },
          timestamp: expect.any(Date)
        }
      });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });
});