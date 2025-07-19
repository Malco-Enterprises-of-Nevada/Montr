import { Request, Response, NextFunction } from 'express';
import { handleUploadError, requireFile, validateUploadedFile } from '../uploadMiddleware';
import { mediaService } from '../../services/mediaService';

// Mock the media service
jest.mock('../../services/mediaService');
const mockMediaService = mediaService as jest.Mocked<typeof mediaService>;

describe('Upload Middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockReq = {};
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    };
    mockNext = jest.fn();
    jest.clearAllMocks();
  });

  describe('requireFile', () => {
    it('should pass when file is present', () => {
      mockReq.file = {
        originalname: 'test.mp4',
        mimetype: 'video/mp4',
        size: 1000000
      } as Express.Multer.File;

      requireFile(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should return error when no file is uploaded', () => {
      requireFile(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 'NO_FILE_UPLOADED',
          message: 'No file was uploaded',
          timestamp: expect.any(Date)
        }
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should pass when files array is present', () => {
      mockReq.files = [{
        originalname: 'test.mp4',
        mimetype: 'video/mp4',
        size: 1000000
      }] as Express.Multer.File[];

      requireFile(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });
  });

  describe('validateUploadedFile', () => {
    it('should validate single file successfully', async () => {
      const mockFile = {
        originalname: 'test.mp4',
        mimetype: 'video/mp4',
        size: 1000000
      } as Express.Multer.File;

      mockReq.file = mockFile;
      mockMediaService.validateFile.mockReturnValue({
        isValid: true,
        fileType: 'video',
        mimeType: 'video/mp4'
      });

      await validateUploadedFile(mockReq as Request, mockRes as Response, mockNext);

      expect(mockMediaService.validateFile).toHaveBeenCalledWith(mockFile);
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should return error for invalid single file', async () => {
      const mockFile = {
        originalname: 'test.pdf',
        mimetype: 'application/pdf',
        size: 1000000
      } as Express.Multer.File;

      mockReq.file = mockFile;
      mockMediaService.validateFile.mockReturnValue({
        isValid: false,
        error: 'Unsupported file format'
      });

      await validateUploadedFile(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 'INVALID_FILE',
          message: 'Unsupported file format',
          timestamp: expect.any(Date)
        }
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should validate multiple files successfully', async () => {
      const mockFiles = [
        {
          originalname: 'test1.mp4',
          mimetype: 'video/mp4',
          size: 1000000
        },
        {
          originalname: 'test2.jpg',
          mimetype: 'image/jpeg',
          size: 500000
        }
      ] as Express.Multer.File[];

      mockReq.files = mockFiles;
      mockMediaService.validateFile
        .mockReturnValueOnce({
          isValid: true,
          fileType: 'video',
          mimeType: 'video/mp4'
        })
        .mockReturnValueOnce({
          isValid: true,
          fileType: 'image',
          mimeType: 'image/jpeg'
        });

      await validateUploadedFile(mockReq as Request, mockRes as Response, mockNext);

      expect(mockMediaService.validateFile).toHaveBeenCalledTimes(2);
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should return error for invalid file in multiple files', async () => {
      const mockFiles = [
        {
          originalname: 'test1.mp4',
          mimetype: 'video/mp4',
          size: 1000000
        },
        {
          originalname: 'test2.pdf',
          mimetype: 'application/pdf',
          size: 500000
        }
      ] as Express.Multer.File[];

      mockReq.files = mockFiles;
      mockMediaService.validateFile
        .mockReturnValueOnce({
          isValid: true,
          fileType: 'video',
          mimeType: 'video/mp4'
        })
        .mockReturnValueOnce({
          isValid: false,
          error: 'Unsupported file format'
        });

      await validateUploadedFile(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 'INVALID_FILE',
          message: 'File test2.pdf: Unsupported file format',
          timestamp: expect.any(Date)
        }
      });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('handleUploadError', () => {
    it('should handle file size limit error', () => {
      const error = {
        code: 'LIMIT_FILE_SIZE',
        message: 'File too large'
      };

      handleUploadError(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 'FILE_TOO_LARGE',
          message: 'File size exceeds the 100MB limit',
          details: { maxSize: '100MB' },
          timestamp: expect.any(Date)
        }
      });
    });

    it('should handle file count limit error', () => {
      const error = {
        code: 'LIMIT_FILE_COUNT',
        message: 'Too many files'
      };

      handleUploadError(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 'TOO_MANY_FILES',
          message: 'Too many files uploaded. Maximum 10 files allowed',
          details: { maxFiles: 10 },
          timestamp: expect.any(Date)
        }
      });
    });

    it('should handle unexpected file error', () => {
      const error = {
        code: 'LIMIT_UNEXPECTED_FILE',
        message: 'Unexpected field'
      };

      handleUploadError(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 'UNEXPECTED_FILE',
          message: 'Unexpected file field',
          details: { expectedField: 'media' },
          timestamp: expect.any(Date)
        }
      });
    });

    it('should handle custom validation errors', () => {
      const error = new Error('Unsupported file format: application/pdf');

      handleUploadError(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: {
          code: 'INVALID_FILE_FORMAT',
          message: 'Unsupported file format: application/pdf',
          timestamp: expect.any(Date)
        }
      });
    });

    it('should pass through other errors', () => {
      const error = new Error('Some other error');

      handleUploadError(error, mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
      expect(mockRes.status).not.toHaveBeenCalled();
    });
  });
});