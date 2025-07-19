import multer from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { Request, Response, NextFunction } from 'express';
import { mediaService } from '../services/mediaService';

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tempDir = path.join(process.cwd(), 'temp');
    
    // Ensure temp directory exists
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    // Generate temporary filename with timestamp
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// File filter function
const fileFilter = (req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  // Validate file using media service
  const validation = mediaService.validateFile(file);
  
  if (validation.isValid) {
    cb(null, true);
  } else {
    cb(new Error(validation.error || 'Invalid file format'));
  }
};

// Configure multer with options
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
    files: 10 // Maximum 10 files per request
  }
});

// Middleware for single file upload
export const uploadSingle = upload.single('media');

// Middleware for multiple file upload
export const uploadMultiple = upload.array('media', 10);

// Error handling middleware for multer errors
export const handleUploadError = (error: any, req: Request, res: Response, next: NextFunction): void => {
  if (error instanceof multer.MulterError || (error && error.code)) {
    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        res.status(400).json({
          error: {
            code: 'FILE_TOO_LARGE',
            message: 'File size exceeds the 100MB limit',
            details: { maxSize: '100MB' },
            timestamp: new Date()
          }
        });
        return;
      case 'LIMIT_FILE_COUNT':
        res.status(400).json({
          error: {
            code: 'TOO_MANY_FILES',
            message: 'Too many files uploaded. Maximum 10 files allowed',
            details: { maxFiles: 10 },
            timestamp: new Date()
          }
        });
        return;
      case 'LIMIT_UNEXPECTED_FILE':
        res.status(400).json({
          error: {
            code: 'UNEXPECTED_FILE',
            message: 'Unexpected file field',
            details: { expectedField: 'media' },
            timestamp: new Date()
          }
        });
        return;
      default:
        res.status(400).json({
          error: {
            code: 'UPLOAD_ERROR',
            message: error.message || 'File upload failed',
            timestamp: new Date()
          }
        });
        return;
    }
  }

  // Handle custom validation errors
  if (error.message && error.message.includes('Unsupported file format')) {
    res.status(400).json({
      error: {
        code: 'INVALID_FILE_FORMAT',
        message: error.message,
        timestamp: new Date()
      }
    });
    return;
  }

  // Pass other errors to the next error handler
  next(error);
};

// Validation middleware to ensure file was uploaded
export const requireFile = (req: Request, res: Response, next: NextFunction): void => {
  if (!req.file && !req.files) {
    res.status(400).json({
      error: {
        code: 'NO_FILE_UPLOADED',
        message: 'No file was uploaded',
        timestamp: new Date()
      }
    });
    return;
  }
  next();
};

// Middleware to validate file after upload
export const validateUploadedFile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (req.file) {
      // Validate single file
      const validation = mediaService.validateFile(req.file);
      if (!validation.isValid) {
        res.status(400).json({
          error: {
            code: 'INVALID_FILE',
            message: validation.error,
            timestamp: new Date()
          }
        });
        return;
      }
    } else if (req.files && Array.isArray(req.files)) {
      // Validate multiple files
      for (const file of req.files) {
        const validation = mediaService.validateFile(file);
        if (!validation.isValid) {
          res.status(400).json({
            error: {
              code: 'INVALID_FILE',
              message: `File ${file.originalname}: ${validation.error}`,
              timestamp: new Date()
            }
          });
          return;
        }
      }
    }
    
    next();
  } catch (error) {
    next(error);
  }
};