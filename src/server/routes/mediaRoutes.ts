import { Router, Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { mediaService, MediaProcessingResult } from '../services/mediaService';
import { 
  uploadSingle, 
  uploadMultiple, 
  handleUploadError, 
  requireFile, 
  validateUploadedFile 
} from '../middleware/uploadMiddleware';
import { MediaFileModel } from '../models/MediaFileModel';
import { CreateMediaFileInput, MediaFile } from '../../shared/types/models';

const stat = promisify(fs.stat);
const router = Router();

// Initialize media service
mediaService.initialize().catch(console.error);

/**
 * POST /api/media/upload - Upload single media file
 */
router.post('/upload', 
  uploadSingle,
  handleUploadError,
  requireFile,
  validateUploadedFile,
  async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: {
            code: 'NO_FILE_UPLOADED',
            message: 'No file was uploaded',
            timestamp: new Date()
          }
        });
      }

      // Process the uploaded file
      const result: MediaProcessingResult = await mediaService.processMediaFile(req.file);

      // Save media file to database
      const mediaFileInput: CreateMediaFileInput = {
        filename: result.mediaFile.filename,
        original_name: result.mediaFile.original_name,
        file_type: result.mediaFile.file_type,
        mime_type: result.mediaFile.mime_type,
        file_size: result.mediaFile.file_size,
        duration: result.mediaFile.duration,
        thumbnail_path: result.mediaFile.thumbnail_path
      };

      const savedMediaFile = await MediaFileModel.create(mediaFileInput);
      
      res.status(201).json({
        success: true,
        data: {
          mediaFile: savedMediaFile,
          message: 'File uploaded successfully'
        }
      });

    } catch (error) {
      console.error('Upload processing error:', error);
      res.status(500).json({
        error: {
          code: 'PROCESSING_ERROR',
          message: error instanceof Error ? error.message : 'Failed to process uploaded file',
          timestamp: new Date()
        }
      });
    }
  }
);

/**
 * POST /api/media/upload/multiple - Upload multiple media files
 */
router.post('/upload/multiple',
  uploadMultiple,
  handleUploadError,
  requireFile,
  validateUploadedFile,
  async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    try {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({
          error: {
            code: 'NO_FILES_UPLOADED',
            message: 'No files were uploaded',
            timestamp: new Date()
          }
        });
      }

      const results: MediaProcessingResult[] = [];
      const savedFiles: MediaFile[] = [];
      const errors: Array<{ filename: string; error: string }> = [];

      // Process each file
      for (const file of files) {
        try {
          const result = await mediaService.processMediaFile(file);
          results.push(result);

          // Save to database
          const mediaFileInput: CreateMediaFileInput = {
            filename: result.mediaFile.filename,
            original_name: result.mediaFile.original_name,
            file_type: result.mediaFile.file_type,
            mime_type: result.mediaFile.mime_type,
            file_size: result.mediaFile.file_size,
            duration: result.mediaFile.duration,
            thumbnail_path: result.mediaFile.thumbnail_path
          };

          const savedMediaFile = await MediaFileModel.create(mediaFileInput);
          savedFiles.push(savedMediaFile);
        } catch (error) {
          errors.push({
            filename: file.originalname,
            error: error instanceof Error ? error.message : 'Processing failed'
          });
        }
      }

      res.status(201).json({
        success: true,
        data: {
          processed: savedFiles,
          errors: errors,
          message: `Successfully processed ${savedFiles.length} files${errors.length > 0 ? `, ${errors.length} failed` : ''}`
        }
      });

    } catch (error) {
      console.error('Multiple upload processing error:', error);
      res.status(500).json({
        error: {
          code: 'PROCESSING_ERROR',
          message: 'Failed to process uploaded files',
          timestamp: new Date()
        }
      });
    }
  }
);

/**
 * GET /api/media/:id - Serve media file
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const { id } = req.params;

    const mediaFile = await MediaFileModel.findById(id);
    if (!mediaFile) {
      return res.status(404).json({
        error: {
          code: 'MEDIA_NOT_FOUND',
          message: 'Media file not found',
          details: { mediaId: id },
          timestamp: new Date()
        }
      });
    }

    const filePath = mediaService.getFilePath(mediaFile);
    const fileExists = await mediaService.fileExists(mediaFile);
    
    if (!fileExists) {
      return res.status(404).json({
        error: {
          code: 'FILE_NOT_FOUND',
          message: 'Media file not found on disk',
          details: { mediaId: id, filePath },
          timestamp: new Date()
        }
      });
    }

    // Set appropriate headers
    res.setHeader('Content-Type', mediaFile.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${mediaFile.original_name}"`);
    
    // Add cache headers for better performance
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year
    res.setHeader('ETag', mediaFile.id);
    
    // Check if client has cached version
    if (req.headers['if-none-match'] === mediaFile.id) {
      return res.status(304).end();
    }
    
    // Stream the file
    const fileStream = fs.createReadStream(filePath);
    fileStream.on('error', (error) => {
      console.error('File stream error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            code: 'STREAM_ERROR',
            message: 'Error streaming file',
            timestamp: new Date()
          }
        });
      }
    });
    
    fileStream.pipe(res);

  } catch (error) {
    console.error('Media serving error:', error);
    res.status(500).json({
      error: {
        code: 'SERVING_ERROR',
        message: 'Failed to serve media file',
        timestamp: new Date()
      }
    });
  }
});

/**
 * GET /api/media/:id/thumbnail - Serve media thumbnail
 */
router.get('/:id/thumbnail', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const { id } = req.params;

    const mediaFile = await MediaFileModel.findById(id);
    if (!mediaFile) {
      return res.status(404).json({
        error: {
          code: 'MEDIA_NOT_FOUND',
          message: 'Media file not found',
          details: { mediaId: id },
          timestamp: new Date()
        }
      });
    }

    if (!mediaFile.thumbnail_path) {
      return res.status(404).json({
        error: {
          code: 'THUMBNAIL_NOT_FOUND',
          message: 'No thumbnail available for this media file',
          details: { mediaId: id },
          timestamp: new Date()
        }
      });
    }

    const thumbnailPath = path.resolve(mediaFile.thumbnail_path);
    
    try {
      await stat(thumbnailPath);
    } catch (error) {
      return res.status(404).json({
        error: {
          code: 'THUMBNAIL_FILE_NOT_FOUND',
          message: 'Thumbnail file not found on disk',
          details: { mediaId: id, thumbnailPath },
          timestamp: new Date()
        }
      });
    }

    // Set appropriate headers for thumbnail
    res.setHeader('Content-Type', 'image/jpeg'); // Thumbnails are typically JPEG
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // 1 year
    res.setHeader('ETag', `${mediaFile.id}-thumb`);
    
    // Check if client has cached version
    if (req.headers['if-none-match'] === `${mediaFile.id}-thumb`) {
      return res.status(304).end();
    }
    
    // Stream the thumbnail
    const thumbnailStream = fs.createReadStream(thumbnailPath);
    thumbnailStream.on('error', (error) => {
      console.error('Thumbnail stream error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            code: 'STREAM_ERROR',
            message: 'Error streaming thumbnail',
            timestamp: new Date()
          }
        });
      }
    });
    
    thumbnailStream.pipe(res);

  } catch (error) {
    console.error('Thumbnail serving error:', error);
    res.status(500).json({
      error: {
        code: 'SERVING_ERROR',
        message: 'Failed to serve thumbnail',
        timestamp: new Date()
      }
    });
  }
});

/**
 * DELETE /api/media/:id - Delete media file
 */
router.delete('/:id', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const { id } = req.params;

    const mediaFile = await MediaFileModel.findById(id);
    if (!mediaFile) {
      return res.status(404).json({
        error: {
          code: 'MEDIA_NOT_FOUND',
          message: 'Media file not found',
          details: { mediaId: id },
          timestamp: new Date()
        }
      });
    }

    // Delete from database first
    const success = await MediaFileModel.delete(id);
    if (!success) {
      return res.status(500).json({
        error: {
          code: 'DATABASE_ERROR',
          message: 'Failed to delete media file from database',
          timestamp: new Date()
        }
      });
    }

    // Delete physical files
    try {
      const filePath = mediaService.getFilePath(mediaFile);
      if (await mediaService.fileExists(mediaFile)) {
        await fs.promises.unlink(filePath);
      }

      // Delete thumbnail if it exists
      if (mediaFile.thumbnail_path) {
        try {
          await fs.promises.unlink(mediaFile.thumbnail_path);
        } catch (error) {
          console.warn('Failed to delete thumbnail:', error);
          // Don't fail the whole operation if thumbnail deletion fails
        }
      }
    } catch (error) {
      console.error('Failed to delete physical files:', error);
      // File deletion from database succeeded, but physical file deletion failed
      // This is not a critical error, so we'll log it but still return success
    }

    res.json({
      success: true,
      message: 'Media file deleted successfully',
      data: { deletedId: id }
    });

  } catch (error) {
    console.error('Media deletion error:', error);
    res.status(500).json({
      error: {
        code: 'DELETION_ERROR',
        message: 'Failed to delete media file',
        timestamp: new Date()
      }
    });
  }
});

/**
 * GET /api/media/:id/info - Get media file information
 */
router.get('/:id/info', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const { id } = req.params;

    const mediaFile = await MediaFileModel.findById(id);
    if (!mediaFile) {
      return res.status(404).json({
        error: {
          code: 'MEDIA_NOT_FOUND',
          message: 'Media file not found',
          details: { mediaId: id },
          timestamp: new Date()
        }
      });
    }

    // Check if physical file exists
    const fileExists = await mediaService.fileExists(mediaFile);
    
    res.json({
      success: true,
      data: {
        ...mediaFile,
        fileExists,
        filePath: mediaService.getFilePath(mediaFile)
      }
    });

  } catch (error) {
    console.error('Media info error:', error);
    res.status(500).json({
      error: {
        code: 'INFO_ERROR',
        message: 'Failed to get media file information',
        timestamp: new Date()
      }
    });
  }
});

/**
 * GET /api/media - Get all media files
 */
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const { fileType } = req.query;
    
    // Validate fileType if provided
    if (fileType && fileType !== 'video' && fileType !== 'image') {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'fileType must be either "video" or "image"',
          timestamp: new Date()
        }
      });
    }
    
    const mediaFiles = await MediaFileModel.findAll(fileType as 'video' | 'image' | undefined);
    
    res.json({
      success: true,
      data: mediaFiles
    });

  } catch (error) {
    console.error('Error fetching media files:', error);
    res.status(500).json({
      error: {
        code: 'FETCH_ERROR',
        message: 'Failed to fetch media files',
        timestamp: new Date()
      }
    });
  }
});

/**
 * GET /api/media/stats - Get media file statistics
 */
router.get('/stats/summary', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
  try {
    const stats = await MediaFileModel.getFileStats();
    
    res.json({
      success: true,
      data: stats
    });

  } catch (error) {
    console.error('Error fetching media stats:', error);
    res.status(500).json({
      error: {
        code: 'STATS_ERROR',
        message: 'Failed to fetch media statistics',
        timestamp: new Date()
      }
    });
  }
});

export default router;