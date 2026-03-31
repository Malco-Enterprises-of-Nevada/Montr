import axios, { type AxiosInstance } from 'axios';
import FormData = require('form-data');
import { createReadStream } from 'fs';

/**
 * Wrapper around axios for simplified API calls to the Montr server.
 * Provides typed methods for all API endpoints.
 */
export class MontrApiClient {
  private client: AxiosInstance;
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    this.client = axios.create({
      baseURL: baseUrl,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  // ===== MEDIA ENDPOINTS =====

  /**
   * Upload one or more media files.
   *
   * @param filePaths - Array of file paths to upload
   * @returns Upload response with created media records
   */
  async uploadMedia(filePaths: string[]): Promise<any> {
    const form = new FormData();

    filePaths.forEach((filePath) => {
      form.append('files', createReadStream(filePath));
    });

    const response = await this.client.post('/api/media/upload', form, {
      headers: {
        ...form.getHeaders(),
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });

    return response.data;
  }

  /**
   * List all media files.
   *
   * @param params - Query parameters (type, search, page, limit)
   * @returns List of media files
   */
  async listMedia(params?: {
    type?: 'video' | 'image';
    search?: string;
    page?: number;
    limit?: number;
  }): Promise<any> {
    const response = await this.client.get('/api/media', { params });
    return response.data;
  }

  /**
   * Get a specific media file by ID.
   *
   * @param mediaId - Media file ID
   * @returns Media file details
   */
  async getMedia(mediaId: number): Promise<any> {
    const response = await this.client.get(`/api/media/${mediaId}`);
    return response.data;
  }

  /**
   * Delete a media file.
   *
   * @param mediaId - Media file ID
   * @returns Deletion confirmation
   */
  async deleteMedia(mediaId: number): Promise<any> {
    const response = await this.client.delete(`/api/media/${mediaId}`);
    return response.data;
  }

  /**
   * Download a media file.
   *
   * @param mediaId - Media file ID
   * @returns File data
   */
  async downloadMedia(mediaId: number): Promise<Buffer> {
    const response = await this.client.get(`/api/media/${mediaId}/download`, {
      responseType: 'arraybuffer',
    });
    return Buffer.from(response.data);
  }

  /**
   * Get media thumbnail.
   *
   * @param mediaId - Media file ID
   * @returns Thumbnail image data
   */
  async getMediaThumbnail(mediaId: number): Promise<Buffer> {
    const response = await this.client.get(`/api/media/${mediaId}/thumbnail`, {
      responseType: 'arraybuffer',
    });
    return Buffer.from(response.data);
  }

  // ===== PLAYLIST ENDPOINTS =====

  /**
   * Create a new playlist.
   *
   * @param data - Playlist name and description
   * @returns Created playlist
   */
  async createPlaylist(data: { name: string; description?: string }): Promise<any> {
    const response = await this.client.post('/api/playlists', data);
    return response.data;
  }

  /**
   * List all playlists.
   *
   * @returns List of playlists
   */
  async listPlaylists(): Promise<any> {
    const response = await this.client.get('/api/playlists');
    return response.data;
  }

  /**
   * Get a specific playlist by ID.
   *
   * @param playlistId - Playlist ID
   * @returns Playlist with items
   */
  async getPlaylist(playlistId: number): Promise<any> {
    const response = await this.client.get(`/api/playlists/${playlistId}`);
    return response.data;
  }

  /**
   * Update a playlist.
   *
   * @param playlistId - Playlist ID
   * @param data - Updated name and/or description
   * @returns Updated playlist
   */
  async updatePlaylist(
    playlistId: number,
    data: { name?: string; description?: string }
  ): Promise<any> {
    const response = await this.client.put(`/api/playlists/${playlistId}`, data);
    return response.data;
  }

  /**
   * Delete a playlist.
   *
   * @param playlistId - Playlist ID
   * @returns Deletion confirmation
   */
  async deletePlaylist(playlistId: number): Promise<any> {
    const response = await this.client.delete(`/api/playlists/${playlistId}`);
    return response.data;
  }

  /**
   * Add media items to a playlist.
   *
   * @param playlistId - Playlist ID
   * @param mediaIds - Array of media IDs to add
   * @param imageDuration - Optional duration for images (seconds)
   * @returns Added playlist items
   */
  async addToPlaylist(
    playlistId: number,
    mediaIds: number[],
    imageDuration?: number
  ): Promise<any> {
    const payload: any = { mediaIds };
    if (imageDuration !== undefined) {
      payload.image_duration = imageDuration;
    }
    const response = await this.client.post(`/api/playlists/${playlistId}/items`, payload);
    return response.data;
  }

  /**
   * Update a playlist item.
   *
   * @param playlistId - Playlist ID
   * @param itemId - Playlist item ID
   * @param data - Updated order index or image duration
   * @returns Updated playlist item
   */
  async updatePlaylistItem(
    playlistId: number,
    itemId: number,
    data: { orderIndex?: number; imageDuration?: number }
  ): Promise<any> {
    const response = await this.client.put(`/api/playlists/${playlistId}/items/${itemId}`, data);
    return response.data;
  }

  /**
   * Remove a playlist item.
   *
   * @param playlistId - Playlist ID
   * @param itemId - Playlist item ID
   * @returns Deletion confirmation
   */
  async removeFromPlaylist(playlistId: number, itemId: number): Promise<any> {
    const response = await this.client.delete(`/api/playlists/${playlistId}/items/${itemId}`);
    return response.data;
  }

  /**
   * Reorder playlist items.
   *
   * @param playlistId - Playlist ID
   * @param itemIds - Array of item IDs in new order
   * @returns Reordered playlist items
   */
  async reorderPlaylist(playlistId: number, itemIds: number[]): Promise<any> {
    const response = await this.client.post(`/api/playlists/${playlistId}/reorder`, {
      itemIds,
    });
    return response.data;
  }

  /**
   * Get playlist statistics.
   *
   * @param playlistId - Playlist ID
   * @returns Playlist statistics
   */
  async getPlaylistStats(playlistId: number): Promise<any> {
    const response = await this.client.get(`/api/playlists/${playlistId}/stats`);
    return response.data;
  }

  // ===== CLIENT ENDPOINTS =====

  /**
   * Register a new client.
   *
   * @param data - Client registration data
   * @returns Registered client
   */
  async registerClient(data: {
    id: string;
    name?: string;
    version?: string;
    platform?: string;
    capabilities?: { video: boolean; image: boolean };
  }): Promise<any> {
    const response = await this.client.post('/api/clients/register', data);
    return response.data;
  }

  /**
   * List all clients.
   *
   * @param params - Filter parameters
   * @returns List of clients
   */
  async listClients(params?: { status?: 'online' | 'offline' }): Promise<any> {
    const response = await this.client.get('/api/clients', { params });
    return response.data;
  }

  /**
   * Get a specific client by ID.
   *
   * @param clientId - Client ID (UUID)
   * @returns Client details
   */
  async getClient(clientId: string): Promise<any> {
    const response = await this.client.get(`/api/clients/${clientId}`);
    return response.data;
  }

  /**
   * Update a client (e.g., assign playlist).
   *
   * @param clientId - Client ID
   * @param data - Updated fields
   * @returns Updated client
   */
  async updateClient(
    clientId: string,
    data: { name?: string; assigned_playlist_id?: number | null }
  ): Promise<any> {
    const response = await this.client.put(`/api/clients/${clientId}`, data);
    return response.data;
  }

  /**
   * Assign a playlist to a client.
   *
   * @param clientId - Client ID
   * @param playlistId - Playlist ID (or null to unassign)
   * @returns Updated client
   */
  async assignPlaylist(clientId: string, playlistId: number | null): Promise<any> {
    return this.updateClient(clientId, { assigned_playlist_id: playlistId });
  }

  /**
   * Unregister a client.
   *
   * @param clientId - Client ID
   * @returns Deletion confirmation
   */
  async deleteClient(clientId: string): Promise<any> {
    const response = await this.client.delete(`/api/clients/${clientId}`);
    return response.data;
  }

  /**
   * Get client status.
   *
   * @param clientId - Client ID
   * @returns Current client status
   */
  async getClientStatus(clientId: string): Promise<any> {
    const response = await this.client.get(`/api/clients/${clientId}/status`);
    return response.data;
  }

  /**
   * Update client status.
   *
   * @param clientId - Client ID
   * @param status - Status update data
   * @returns Updated status
   */
  async updateClientStatus(
    clientId: string,
    status: {
      currentMediaId?: number | null;
      position?: number;
      isPlaying?: boolean;
      errorMessage?: string | null;
    }
  ): Promise<any> {
    // Map camelCase to snake_case for the API
    const payload: any = {
      is_playing: status.isPlaying ?? false,
    };
    if (status.currentMediaId !== undefined) {
      payload.current_media_id = status.currentMediaId;
    }
    if (status.position !== undefined) {
      payload.position = status.position;
    }
    if (status.errorMessage !== undefined) {
      payload.error_message = status.errorMessage;
    }
    const response = await this.client.post(`/api/clients/${clientId}/status`, payload);
    return response.data;
  }

  /**
   * Send heartbeat for a client.
   *
   * @param clientId - Client ID
   * @returns Heartbeat acknowledgment
   */
  async sendHeartbeat(clientId: string): Promise<any> {
    const response = await this.client.post(`/api/clients/${clientId}/heartbeat`);
    return response.data;
  }

  // ===== UTILITY METHODS =====

  /**
   * Check server health.
   *
   * @returns Health status
   */
  async healthCheck(): Promise<any> {
    const response = await this.client.get('/api/health');
    return response.data;
  }

  /**
   * Get the base URL.
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Get the raw axios instance for custom requests.
   */
  getRawClient(): AxiosInstance {
    return this.client;
  }
}
