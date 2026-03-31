/**
 * Test fixtures for media files
 */

import { MediaFile, CreateMediaInput } from '../../src/database/types';

export const mockVideoFile: MediaFile = {
  id: 1,
  filename: 'test_video_1234567890_abcd1234.mp4',
  original_filename: 'test_video.mp4',
  filepath: 'media/test_video_1234567890_abcd1234.mp4',
  type: 'video',
  mime_type: 'video/mp4',
  file_size: 10485760, // 10MB
  duration: 120.5,
  width: 1920,
  height: 1080,
  checksum: 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd',
  thumbnail_status: 'pending',
  approval_status: 'pending',
  created_at: '2025-10-10T10:00:00.000Z',
  updated_at: '2025-10-10T10:00:00.000Z',
};

export const mockImageFile: MediaFile = {
  id: 2,
  filename: 'test_image_1234567891_efgh5678.jpg',
  original_filename: 'test_image.jpg',
  filepath: 'media/test_image_1234567891_efgh5678.jpg',
  type: 'image',
  mime_type: 'image/jpeg',
  file_size: 2097152, // 2MB
  duration: null,
  width: 1920,
  height: 1080,
  checksum: 'def456abc123def456abc123def456abc123def456abc123def456abc123efgh',
  thumbnail_status: 'pending',
  approval_status: 'pending',
  created_at: '2025-10-10T10:05:00.000Z',
  updated_at: '2025-10-10T10:05:00.000Z',
};

export const mockMediaFiles: MediaFile[] = [
  mockVideoFile,
  mockImageFile,
  {
    id: 3,
    filename: 'another_video_1234567892_ijkl9012.mp4',
    original_filename: 'another_video.mp4',
    filepath: 'media/another_video_1234567892_ijkl9012.mp4',
    type: 'video',
    mime_type: 'video/mp4',
    file_size: 15728640, // 15MB
    duration: 180.0,
    width: 3840,
    height: 2160,
    checksum: 'ijkl9012mnop3456ijkl9012mnop3456ijkl9012mnop3456ijkl9012mnop',
    thumbnail_status: 'pending',
    approval_status: 'pending',
    created_at: '2025-10-10T10:10:00.000Z',
    updated_at: '2025-10-10T10:10:00.000Z',
  },
];

export const mockCreateMediaInput: CreateMediaInput = {
  filename: 'new_video_1234567893_qrst1234.mp4',
  original_filename: 'new_video.mp4',
  filepath: 'media/new_video_1234567893_qrst1234.mp4',
  type: 'video',
  mime_type: 'video/mp4',
  file_size: 12582912, // 12MB
  duration: 150.0,
  width: 1920,
  height: 1080,
  checksum: 'qrst1234uvwx5678qrst1234uvwx5678qrst1234uvwx5678qrst1234uvwx',
};

// Mock multer file for upload tests
export const createMockMulterFile = (overrides?: Partial<Express.Multer.File>): Express.Multer.File => ({
  fieldname: 'files',
  originalname: 'test_upload.mp4',
  encoding: '7bit',
  mimetype: 'video/mp4',
  size: 10485760,
  destination: '/tmp/montr-test-storage/temp',
  filename: 'upload_1234567890.tmp',
  path: '/tmp/montr-test-storage/temp/upload_1234567890.tmp',
  buffer: Buffer.from('fake-video-data'),
  stream: {} as any,
  ...overrides,
});

// Mock FFprobe output for video metadata
export const mockFFprobeOutput = {
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      duration: '120.500000',
    },
    {
      codec_type: 'audio',
      codec_name: 'aac',
    },
  ],
  format: {
    duration: '120.500000',
    bit_rate: '5000000',
    size: '75312500',
  },
};

// Mock FFprobe output for corrupted video
export const mockFFprobeErrorOutput = {
  streams: [],
  format: {},
};

// Buffer for testing
export const mockFileBuffer = Buffer.from('fake-file-content-for-testing');
export const mockThumbnailBuffer = Buffer.from('fake-thumbnail-content');
