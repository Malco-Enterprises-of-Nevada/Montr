/**
 * Unit tests for API Key Authentication Middleware
 * Tests the apiKeyAuth factory and its middleware behavior
 * under various configuration and request scenarios.
 */

jest.mock('../../../src/config/config', () => ({
  config: {
    security: {
      apiKeyRequired: false,
      apiKey: 'test-api-key-12345',
    },
  },
}));

import { Request, Response, NextFunction } from 'express';
import { apiKeyAuth } from '../../../src/api/middleware/auth';
import { config } from '../../../src/config/config';
import { ErrorCode } from '../../../src/api/middleware/error-handler';

// Type the mocked config for direct property mutation
const mockedConfig = config as { security: { apiKeyRequired: boolean; apiKey: string | undefined } };

describe('apiKeyAuth middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: jest.Mock<void, []>;
  let jsonFn: jest.Mock;
  let statusFn: jest.Mock;

  beforeEach(() => {
    // Reset config to defaults before each test
    mockedConfig.security.apiKeyRequired = false;
    mockedConfig.security.apiKey = 'test-api-key-12345';

    // Mock req.header
    mockReq = {
      header: jest.fn(),
    };

    // Mock res.status().json() chain
    jsonFn = jest.fn();
    statusFn = jest.fn().mockReturnValue({ json: jsonFn });
    mockRes = {
      status: statusFn,
    };

    mockNext = jest.fn();
  });

  describe('factory function', () => {
    it('should return a middleware function', () => {
      const middleware = apiKeyAuth();

      expect(typeof middleware).toBe('function');
      expect(middleware.length).toBe(3); // (req, res, next)
    });
  });

  describe('when apiKeyRequired is false', () => {
    beforeEach(() => {
      mockedConfig.security.apiKeyRequired = false;
    });

    it('should call next() immediately', () => {
      const middleware = apiKeyAuth();

      middleware(mockReq as Request, mockRes as Response, mockNext as NextFunction);

      expect(mockNext).toHaveBeenCalledTimes(1);
    });

    it('should not check the X-API-Key header', () => {
      const middleware = apiKeyAuth();

      middleware(mockReq as Request, mockRes as Response, mockNext as NextFunction);

      expect(mockReq.header).not.toHaveBeenCalled();
    });

    it('should not send a response', () => {
      const middleware = apiKeyAuth();

      middleware(mockReq as Request, mockRes as Response, mockNext as NextFunction);

      expect(statusFn).not.toHaveBeenCalled();
      expect(jsonFn).not.toHaveBeenCalled();
    });
  });

  describe('when apiKeyRequired is true', () => {
    beforeEach(() => {
      mockedConfig.security.apiKeyRequired = true;
    });

    it('should return 401 with "API key is required" when no header is provided', () => {
      (mockReq.header as jest.Mock).mockReturnValue(undefined);
      const middleware = apiKeyAuth();

      middleware(mockReq as Request, mockRes as Response, mockNext as NextFunction);

      expect(mockReq.header).toHaveBeenCalledWith('X-API-Key');
      expect(statusFn).toHaveBeenCalledWith(401);
      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          data: null,
          error: expect.objectContaining({
            code: ErrorCode.UNAUTHORIZED,
            message: 'API key is required. Provide X-API-Key header.',
          }),
        }),
      );
    });

    it('should return 401 with "Invalid API key" when wrong key is provided', () => {
      (mockReq.header as jest.Mock).mockReturnValue('wrong-key');
      const middleware = apiKeyAuth();

      middleware(mockReq as Request, mockRes as Response, mockNext as NextFunction);

      expect(statusFn).toHaveBeenCalledWith(401);
      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          data: null,
          error: expect.objectContaining({
            code: ErrorCode.UNAUTHORIZED,
            message: 'Invalid API key',
          }),
        }),
      );
    });

    it('should call next() when the correct API key is provided', () => {
      (mockReq.header as jest.Mock).mockReturnValue('test-api-key-12345');
      const middleware = apiKeyAuth();

      middleware(mockReq as Request, mockRes as Response, mockNext as NextFunction);

      expect(mockNext).toHaveBeenCalledTimes(1);
      expect(statusFn).not.toHaveBeenCalled();
      expect(jsonFn).not.toHaveBeenCalled();
    });

    it('should return 401 when an empty string API key is provided', () => {
      (mockReq.header as jest.Mock).mockReturnValue('');
      const middleware = apiKeyAuth();

      middleware(mockReq as Request, mockRes as Response, mockNext as NextFunction);

      // Empty string is falsy, so it hits the "no apiKey" branch
      expect(statusFn).toHaveBeenCalledWith(401);
      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          data: null,
          error: expect.objectContaining({
            code: ErrorCode.UNAUTHORIZED,
            message: 'API key is required. Provide X-API-Key header.',
          }),
        }),
      );
    });

    it('should return 401 when config apiKey is undefined and any key is sent', () => {
      mockedConfig.security.apiKey = undefined;
      (mockReq.header as jest.Mock).mockReturnValue('some-key');
      const middleware = apiKeyAuth();

      middleware(mockReq as Request, mockRes as Response, mockNext as NextFunction);

      expect(statusFn).toHaveBeenCalledWith(401);
      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          data: null,
          error: expect.objectContaining({
            code: ErrorCode.UNAUTHORIZED,
            message: 'Invalid API key',
          }),
        }),
      );
    });

    it('should not call next() on authentication failure', () => {
      (mockReq.header as jest.Mock).mockReturnValue('wrong-key');
      const middleware = apiKeyAuth();

      middleware(mockReq as Request, mockRes as Response, mockNext as NextFunction);

      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should produce a response matching the standard errorResponse shape', () => {
      (mockReq.header as jest.Mock).mockReturnValue(undefined);
      const middleware = apiKeyAuth();

      middleware(mockReq as Request, mockRes as Response, mockNext as NextFunction);

      const responseBody = jsonFn.mock.calls[0][0];
      expect(responseBody).toEqual({
        success: false,
        data: null,
        error: {
          code: ErrorCode.UNAUTHORIZED,
          message: 'API key is required. Provide X-API-Key header.',
        },
      });
    });
  });
});
