import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { MediaFile } from '../../shared/types';

const stat = promisify(fs.stat);
const readdir = promisify(fs.readdir);
const unlink = promisify(fs.unlink);
const mkdir = promisify(fs.mkdir);

export interface StorageInfo {
  totalFiles: number;
  totalSize: number;
  videoFiles: number;
  imageFiles: number;
  videoSize: number;
  imageSize: number;
}

export interface DirectoryStructure {
  uploadsDir: string;
  videosDir: string;
  imagesDir: string;
  thumbnailsDir: string;
  tempDir: string;
}

export class FileStorageUtil {
  private readonly baseDir: string;
  private readonly structure: DirectoryStructure;

  constructor(baseDir: string = 'uploads') {
    this.baseDir = path.resolve(baseDir);
    this.structure = {
      uploadsDir: this.baseDir,
      videosDir: path.join(this.baseDir, 'videos'),
      imagesDir: path.join(this.baseDir, 'images'),
      thumbnailsDir: path.join(this.baseDir, 'thumbnails'),
      tempDir: path.join(process.cwd(), 'temp')
    };
  }

  /**
   * Get the directory structure
   */
  getDirectoryStructure(): DirectoryStructure {
    return { ...this.structure };
  }

  /**
   * Initialize all required directories
   */
  async initializeDirectories(): Promise<void> {
    const directories = Object.values(this.structure);
    
    for (const dir of directories) {
      try {
        await stat(dir);
      } catch (error) {
        // Directory doesn't exist, create it
        await mkdir(dir, { recursive: true });
        console.log(`Created directory: ${dir}`);
      }
    }
  }

  /**
   * Get storage information and statistics
   */
  async getStorageInfo(): Promise<StorageInfo> {
    const info: StorageInfo = {
      totalFiles: 0,
      totalSize: 0,
      videoFiles: 0,
      imageFiles: 0,
      videoSize: 0,
      imageSize: 0
    };

    try {
      // Check videos directory
      const videoStats = await this.getDirectoryStats(this.structure.videosDir);
      info.videoFiles = videoStats.fileCount;
      info.videoSize = videoStats.totalSize;

      // Check images directory
      const imageStats = await this.getDirectoryStats(this.structure.imagesDir);
      info.imageFiles = imageStats.fileCount;
      info.imageSize = imageStats.totalSize;

      // Calculate totals
      info.totalFiles = info.videoFiles + info.imageFiles;
      info.totalSize = info.videoSize + info.imageSize;

    } catch (error) {
      console.error('Error getting storage info:', error);
    }

    return info;
  }

  /**
   * Get statistics for a specific directory
   */
  private async getDirectoryStats(dirPath: string): Promise<{ fileCount: number; totalSize: number }> {
    try {
      const files = await readdir(dirPath);
      let totalSize = 0;
      let fileCount = 0;

      for (const file of files) {
        const filePath = path.join(dirPath, file);
        try {
          const stats = await stat(filePath);
          if (stats.isFile()) {
            totalSize += stats.size;
            fileCount++;
          }
        } catch (error) {
          console.warn(`Error reading file stats for ${filePath}:`, error);
        }
      }

      return { fileCount, totalSize };
    } catch (error) {
      // Directory might not exist
      return { fileCount: 0, totalSize: 0 };
    }
  }

  /**
   * Clean up temporary files older than specified age
   */
  async cleanupTempFiles(maxAgeHours: number = 24): Promise<number> {
    try {
      const files = await readdir(this.structure.tempDir);
      const cutoffTime = Date.now() - (maxAgeHours * 60 * 60 * 1000);
      let deletedCount = 0;

      for (const file of files) {
        const filePath = path.join(this.structure.tempDir, file);
        try {
          const stats = await stat(filePath);
          if (stats.isFile() && stats.mtime.getTime() < cutoffTime) {
            await unlink(filePath);
            deletedCount++;
          }
        } catch (error) {
          console.warn(`Error cleaning up temp file ${filePath}:`, error);
        }
      }

      return deletedCount;
    } catch (error) {
      console.error('Error cleaning up temp files:', error);
      return 0;
    }
  }

  /**
   * Validate that all required directories exist and are writable
   */
  async validateDirectories(): Promise<{ isValid: boolean; errors: string[] }> {
    const errors: string[] = [];
    
    for (const [name, dirPath] of Object.entries(this.structure)) {
      try {
        const stats = await stat(dirPath);
        if (!stats.isDirectory()) {
          errors.push(`${name} is not a directory: ${dirPath}`);
        }
        
        // Test write access by creating a temporary file
        const testFile = path.join(dirPath, '.write-test');
        try {
          await fs.promises.writeFile(testFile, 'test');
          await unlink(testFile);
        } catch (writeError) {
          errors.push(`No write access to ${name}: ${dirPath}`);
        }
        
      } catch (error) {
        errors.push(`Directory ${name} does not exist or is not accessible: ${dirPath}`);
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Get the appropriate directory for a media file type
   */
  getMediaDirectory(fileType: 'video' | 'image'): string {
    return fileType === 'video' ? this.structure.videosDir : this.structure.imagesDir;
  }

  /**
   * Get full file path for a media file
   */
  getMediaFilePath(mediaFile: MediaFile): string {
    const dir = this.getMediaDirectory(mediaFile.fileType);
    return path.join(dir, mediaFile.filename);
  }

  /**
   * Get thumbnail path for a media file
   */
  getThumbnailPath(thumbnailFilename: string): string {
    return path.join(this.structure.thumbnailsDir, thumbnailFilename);
  }

  /**
   * Check if a file exists
   */
  async fileExists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get file size
   */
  async getFileSize(filePath: string): Promise<number> {
    try {
      const stats = await stat(filePath);
      return stats.size;
    } catch {
      return 0;
    }
  }

  /**
   * Format file size for display
   */
  formatFileSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }
}

// Export singleton instance
export const fileStorage = new FileStorageUtil();