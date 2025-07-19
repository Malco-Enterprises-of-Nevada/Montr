import { Request, Response, NextFunction } from 'express';
import { 
  errorHandler, 
  notFoundHandler, 
  asyncHandler, 
  createApiError,
  ApiError 
} from '../errorMiddleware';

describe('Error Middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockReq = {
      url: '/test',
      method: 'GET',
      body: {},
      params: {},
      query: {}
    };
    
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    
    mockNext = jest.fn();
    
    // Mock console.error to avoid noise in tests
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('errorHandler', () => {
    it('should handle API errors with status code', () => {
      const error: ApiError = new Error('Test error');
      error.statusCode = 400;
      error.code = 'TEST_ERROR';
      error.details = { test: 'data' };

      errorHandler(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 'TEST_ERROR',
          message: 'Test error',
          details: { test: 'data' },
          timestamp: expect.any(Date)
        }
      });
    });

    it('should use default values for missing error properties', () => {
      const error = new Error('Simple error');

      errorHandler(error as ApiError, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Simple error',
          details: undefined,
          timestamp: expect.any(Date)
        }
      });
    });

    it('should log error details', () => {
      const error = new Error('Test error');
      
      errorHandler(error as ApiError, mockReq as Request, mockRes as Response, mockNext);

      expect(console.error).toHaveBeenCalledWith('API Error:', expect.objectContaining({
        message: 'Test error',
        url: '/test',
        method: 'GET'
      }));
    });
  });

  describe('notFoundHandler', () => {
    it('should return 404 with route information', () => {
      mockReq.method = 'POST';
      (mockReq as any).path = '/api/nonexistent';

      notFoundHandler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 'NOT_FOUND',
          message: 'Route POST /api/nonexistent not found',
          timestamp: expect.any(Date)
        }
      });
    });
  });

  describe('asyncHandler', () => {
    it('should handle successful async functions', async () => {
      const asyncFn = jest.fn().mockResolvedValue('success');
      const wrappedFn = asyncHandler(asyncFn);

      await wrappedFn(mockReq as Request, mockRes as Response, mockNext);

      expect(asyncFn).toHaveBeenCalledWith(mockReq, mockRes, mockNext);
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should catch and forward async errors', async () => {
      const error = new Error('Async error');
      const asyncFn = jest.fn().mockRejectedValue(error);
      const wrappedFn = asyncHandler(asyncFn);

      await wrappedFn(mockReq as Request, mockRes as Response, mockNext);

      expect(asyncFn).toHaveBeenCalledWith(mockReq, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalledWith(error);
    });

    it('should handle non-promise functions', async () => {
      const syncFn = jest.fn().mockReturnValue('success');
      const wrappedFn = asyncHandler(syncFn);

      await wrappedFn(mockReq as Request, mockRes as Response, mockNext);

      expect(syncFn).toHaveBeenCalledWith(mockReq, mockRes, mockNext);
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('createApiError', () => {
    it('should create error with all properties', () => {
      const error = createApiError('Test message', 400, 'TEST_CODE', { test: 'data' });

      expect(error.message).toBe('Test message');
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe('TEST_CODE');
      expect(error.details).toEqual({ test: 'data' });
    });

    it('should use default status code', () => {
      const error = createApiError('Test message');

      expect(error.statusCode).toBe(500);
      expect(error.code).toBeUndefined();
      expect(error.details).toBeUndefined();
    });

    it('should create proper Error instance', () => {
      const error = createApiError('Test message');

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('Error');
      expect(error.stack).toBeDefined();
    });
  });
});