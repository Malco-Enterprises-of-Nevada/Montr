import axios, { AxiosResponse } from 'axios';
import FormData from 'form-data';
import { createReadStream, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

/**
 * Create a test video file using ffmpeg
 */
export function createTestVideoFile(outputPath: string, durationSeconds = 5): void {
  // Create directory if it doesn't exist
  const dir = join(outputPath, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  try {
    // Check if ffmpeg is available
    execSync('which ffmpeg', { stdio: 'ignore' });

    // Create a simple test video with color bars
    execSync(
      `ffmpeg -f lavfi -i testsrc=duration=${durationSeconds}:size=1280x720:rate=30 ` +
        `-f lavfi -i sine=frequency=1000:duration=${durationSeconds} ` +
        `-c:v libx264 -preset ultrafast -c:a aac -y "${outputPath}"`,
      { stdio: 'ignore' }
    );
  } catch (err) {
    // Fallback: create a minimal valid MP4 file
    console.warn('ffmpeg not available, creating minimal test file');
    // This is a minimal valid MP4 file (few bytes)
    const minimalMp4 = Buffer.from([
      0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02,
      0x00, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, 0x61, 0x76, 0x63, 0x31, 0x6d, 0x70,
      0x34, 0x31,
    ]);
    writeFileSync(outputPath, minimalMp4);
  }
}

/**
 * Create a test image file
 */
export function createTestImageFile(outputPath: string, width = 1920, height = 1080): void {
  // Create directory if it doesn't exist
  const dir = join(outputPath, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  try {
    // Check if ffmpeg is available
    execSync('which ffmpeg', { stdio: 'ignore' });

    // Create a test image
    execSync(
      `ffmpeg -f lavfi -i color=c=blue:s=${width}x${height}:d=1 ` +
        `-frames:v 1 -y "${outputPath}"`,
      { stdio: 'ignore' }
    );
  } catch (err) {
    // Fallback: create a minimal PNG file
    console.warn('ffmpeg not available, creating minimal test image');
    // Minimal 1x1 PNG
    const minimalPng = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
      0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8,
      0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb4, 0x00, 0x00, 0x00,
      0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    writeFileSync(outputPath, minimalPng);
  }
}

/**
 * Upload media file to server
 */
export async function uploadMedia(
  serverUrl: string,
  filePath: string
): Promise<{ id: number; filename: string }> {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const form = new FormData();
  form.append('files', createReadStream(filePath));

  const response = await axios.post(`${serverUrl}/api/media/upload`, form, {
    headers: form.getHeaders(),
  });

  if (!response.data.success || !response.data.data || response.data.data.length === 0) {
    throw new Error(`Failed to upload media: ${JSON.stringify(response.data)}`);
  }

  const uploadedFile = response.data.data[0];
  return {
    id: uploadedFile.id,
    filename: uploadedFile.filename,
  };
}

/**
 * Upload multiple media files to server
 */
export async function uploadMultipleMedia(
  serverUrl: string,
  filePaths: string[]
): Promise<Array<{ id: number; filename: string }>> {
  const form = new FormData();

  for (const filePath of filePaths) {
    if (!existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    form.append('files', createReadStream(filePath));
  }

  const response = await axios.post(`${serverUrl}/api/media/upload`, form, {
    headers: form.getHeaders(),
  });

  if (!response.data.success || !response.data.data) {
    throw new Error(`Failed to upload media: ${JSON.stringify(response.data)}`);
  }

  return response.data.data.map((file: any) => ({
    id: file.id,
    filename: file.filename,
  }));
}

/**
 * Create a playlist
 */
export async function createPlaylist(
  serverUrl: string,
  name: string,
  description = ''
): Promise<{ id: number; name: string }> {
  const response = await axios.post(`${serverUrl}/api/playlists`, {
    name,
    description,
  });

  if (!response.data.success || !response.data.data) {
    throw new Error(`Failed to create playlist: ${JSON.stringify(response.data)}`);
  }

  return {
    id: response.data.data.id,
    name: response.data.data.name,
  };
}

/**
 * Add media items to playlist
 */
export async function addMediaToPlaylist(
  serverUrl: string,
  playlistId: number,
  mediaIds: number[]
): Promise<void> {
  const response = await axios.post(`${serverUrl}/api/playlists/${playlistId}/items`, {
    mediaIds,
  });

  if (!response.data.success) {
    throw new Error(`Failed to add media to playlist: ${JSON.stringify(response.data)}`);
  }
}

/**
 * Assign playlist to client
 */
export async function assignPlaylist(
  serverUrl: string,
  clientId: string,
  playlistId: number
): Promise<void> {
  const response = await axios.put(`${serverUrl}/api/clients/${clientId}`, {
    assignedPlaylistId: playlistId,
  });

  if (!response.data.success) {
    throw new Error(`Failed to assign playlist: ${JSON.stringify(response.data)}`);
  }
}

/**
 * Get client details
 */
export async function getClient(serverUrl: string, clientId: string): Promise<any> {
  const response = await axios.get(`${serverUrl}/api/clients/${clientId}`);

  if (!response.data.success || !response.data.data) {
    throw new Error(`Failed to get client: ${JSON.stringify(response.data)}`);
  }

  return response.data.data;
}

/**
 * Get playlist details
 */
export async function getPlaylist(serverUrl: string, playlistId: number): Promise<any> {
  const response = await axios.get(`${serverUrl}/api/playlists/${playlistId}`);

  if (!response.data.success || !response.data.data) {
    throw new Error(`Failed to get playlist: ${JSON.stringify(response.data)}`);
  }

  return response.data.data;
}

/**
 * Get all clients
 */
export async function getAllClients(serverUrl: string): Promise<any[]> {
  const response = await axios.get(`${serverUrl}/api/clients`);

  if (!response.data.success || !response.data.data) {
    throw new Error(`Failed to get clients: ${JSON.stringify(response.data)}`);
  }

  return response.data.data;
}

/**
 * Create a complete test setup: upload media, create playlist, add media to playlist
 */
export async function createTestPlaylistWithMedia(
  serverUrl: string,
  playlistName: string,
  mediaFiles: string[]
): Promise<{ playlistId: number; mediaIds: number[] }> {
  // Upload all media files
  const uploadedMedia = await uploadMultipleMedia(serverUrl, mediaFiles);
  const mediaIds = uploadedMedia.map((m) => m.id);

  // Create playlist
  const playlist = await createPlaylist(serverUrl, playlistName, 'Test playlist');

  // Add media to playlist
  await addMediaToPlaylist(serverUrl, playlist.id, mediaIds);

  return {
    playlistId: playlist.id,
    mediaIds,
  };
}

/**
 * Setup fixtures directory for tests
 */
export function setupFixturesDirectory(): string {
  const fixturesDir = join(__dirname, '../fixtures');

  if (!existsSync(fixturesDir)) {
    mkdirSync(fixturesDir, { recursive: true });
  }

  return fixturesDir;
}

/**
 * Create all common test fixtures
 */
export function createCommonTestFixtures(): {
  videoPath: string;
  imagePath: string;
  fixturesDir: string;
} {
  const fixturesDir = setupFixturesDirectory();
  const videoPath = join(fixturesDir, 'test-video.mp4');
  const imagePath = join(fixturesDir, 'test-image.png');

  // Only create if they don't exist
  if (!existsSync(videoPath)) {
    createTestVideoFile(videoPath, 5);
  }

  if (!existsSync(imagePath)) {
    createTestImageFile(imagePath, 1920, 1080);
  }

  return {
    videoPath,
    imagePath,
    fixturesDir,
  };
}
