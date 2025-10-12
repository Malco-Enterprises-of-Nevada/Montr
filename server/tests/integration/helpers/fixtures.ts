import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Test fixture data and file generation utilities.
 */

export interface TestMediaFile {
  filename: string;
  path: string;
  type: 'video' | 'image';
  size: number;
}

/**
 * Create a small test video file (MP4).
 * Creates a minimal valid MP4 file for testing uploads.
 *
 * @param filename - Name of the file to create
 * @param targetDir - Directory to create file in
 * @returns Information about the created file
 */
export function createTestVideoFile(
  filename = 'test-video.mp4',
  targetDir = join(__dirname, '../../fixtures')
): TestMediaFile {
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const filePath = join(targetDir, filename);

  // Minimal valid MP4 file structure (ftyp + mdat boxes)
  // This is a tiny but valid MP4 that can be uploaded
  const mp4Header = Buffer.from([
    // ftyp box
    0x00, 0x00, 0x00, 0x20, // box size (32 bytes)
    0x66, 0x74, 0x79, 0x70, // 'ftyp'
    0x69, 0x73, 0x6f, 0x6d, // 'isom'
    0x00, 0x00, 0x02, 0x00, // minor version
    0x69, 0x73, 0x6f, 0x6d, // compatible brand
    0x69, 0x73, 0x6f, 0x32, // compatible brand
    0x6d, 0x70, 0x34, 0x31, // compatible brand
    0x00, 0x00, 0x00, 0x08, // compatible brand
    // mdat box (minimal)
    0x00, 0x00, 0x00, 0x08, // box size (8 bytes)
    0x6d, 0x64, 0x61, 0x74, // 'mdat'
  ]);

  writeFileSync(filePath, mp4Header);

  return {
    filename,
    path: filePath,
    type: 'video',
    size: mp4Header.length,
  };
}

/**
 * Create a small test image file (PNG).
 * Creates a 1x1 transparent PNG for testing.
 *
 * @param filename - Name of the file to create
 * @param targetDir - Directory to create file in
 * @returns Information about the created file
 */
export function createTestImageFile(
  filename = 'test-image.png',
  targetDir = join(__dirname, '../../fixtures')
): TestMediaFile {
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const filePath = join(targetDir, filename);

  // Minimal 1x1 transparent PNG
  const pngData = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 dimensions
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, // bit depth, color type, etc.
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, // IDAT chunk
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, // compressed data
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, // IEND chunk
    0x42, 0x60, 0x82,
  ]);

  writeFileSync(filePath, pngData);

  return {
    filename,
    path: filePath,
    type: 'image',
    size: pngData.length,
  };
}

/**
 * Create multiple test media files.
 *
 * @param count - Number of files to create (alternates between video and image)
 * @param targetDir - Directory to create files in
 * @returns Array of created file information
 */
export function createTestMediaFiles(
  count = 3,
  targetDir = join(__dirname, '../../fixtures')
): TestMediaFile[] {
  const files: TestMediaFile[] = [];

  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      files.push(createTestVideoFile(`test-video-${i + 1}.mp4`, targetDir));
    } else {
      files.push(createTestImageFile(`test-image-${i + 1}.png`, targetDir));
    }
  }

  return files;
}

/**
 * Sample client registration data.
 */
export const mockClientData = {
  id: 'test-client-e2e-001',
  name: 'E2E Test Client',
  version: '1.0.0',
  platform: 'linux',
  capabilities: {
    video: true,
    image: true,
  },
};

/**
 * Sample playlist data.
 */
export const mockPlaylistData = {
  name: 'E2E Test Playlist',
  description: 'Playlist created during E2E integration tests',
};

/**
 * Sample status update data.
 */
export const mockStatusUpdate = {
  currentMediaId: 1,
  position: 10.5,
  isPlaying: true,
  volume: 80,
  errorMessage: null,
};

/**
 * Clean up test fixture files.
 *
 * @param files - Array of test media files to remove
 */
export function cleanupTestFiles(files: TestMediaFile[]): void {
  const fs = require('fs');
  files.forEach((file) => {
    try {
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });
}
