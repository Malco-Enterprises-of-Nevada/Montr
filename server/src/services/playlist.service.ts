/**
 * Playlist Service
 * Handles playlist operations and item management
 */

import { getDatabase } from '../database/connection';
import {
  Playlist,
  CreatePlaylistInput,
  UpdatePlaylistInput,
  PlaylistWithItems,
  PlaylistItem,
  AddPlaylistItemInput,
  UpdatePlaylistItemInput,
  MediaFile,
} from '../database/types';
import { getLogger } from '../utils/logger';
import { AppError, ErrorCode } from '../api/middleware/error-handler';
import { config } from '../config/config';

const logger = getLogger();

export class PlaylistService {
  private assertMediaApproved(media: MediaFile): void {
    if (!config.content.requireMediaApproval) return;
    if (media.approval_status !== 'approved') {
      throw new AppError(
        ErrorCode.BAD_REQUEST,
        `Media "${media.original_filename || media.filename}" is not approved (status: ${media.approval_status})`,
        400
      );
    }
  }

  /**
   * Creates a new playlist
   */
  async createPlaylist(input: CreatePlaylistInput): Promise<Playlist> {
    const db = await getDatabase();
    const playlist = await db.createPlaylist(input);
    logger.info(`Playlist created: ${playlist.id} - ${playlist.name}`);
    return playlist;
  }

  /**
   * Gets a playlist by ID
   */
  async getPlaylistById(id: number): Promise<Playlist> {
    const db = await getDatabase();
    const playlist = await db.getPlaylistById(id);

    if (!playlist) {
      throw new AppError(ErrorCode.PLAYLIST_NOT_FOUND, `Playlist with ID ${id} not found`, 404);
    }

    return playlist;
  }

  /**
   * Gets a playlist with all its items
   */
  async getPlaylistWithItems(id: number): Promise<PlaylistWithItems> {
    const db = await getDatabase();
    const playlist = await db.getPlaylistWithItems(id);

    if (!playlist) {
      throw new AppError(ErrorCode.PLAYLIST_NOT_FOUND, `Playlist with ID ${id} not found`, 404);
    }

    return playlist;
  }

  /**
   * Gets all playlists
   */
  async getAllPlaylists(): Promise<Playlist[]> {
    const db = await getDatabase();
    return db.getAllPlaylists();
  }

  /**
   * Updates a playlist
   */
  async updatePlaylist(id: number, input: UpdatePlaylistInput): Promise<Playlist> {
    // Verify playlist exists
    await this.getPlaylistById(id);

    const db = await getDatabase();
    const playlist = await db.updatePlaylist(id, input);

    logger.info(`Playlist updated: ${id} - ${playlist.name}`);
    return playlist;
  }

  /**
   * Deletes a playlist
   */
  async deletePlaylist(id: number): Promise<void> {
    // Verify playlist exists
    await this.getPlaylistById(id);

    const db = await getDatabase();
    await db.deletePlaylist(id);

    logger.info(`Playlist deleted: ${id}`);
  }

  /**
   * Adds an item to a playlist
   */
  async addPlaylistItem(input: AddPlaylistItemInput): Promise<PlaylistItem> {
    const db = await getDatabase();

    // Verify playlist exists
    await this.getPlaylistById(input.playlist_id);

    // Verify media exists
    const media = await db.getMediaById(input.media_id);
    if (!media) {
      throw new AppError(
        ErrorCode.MEDIA_NOT_FOUND,
        `Media with ID ${input.media_id} not found`,
        404
      );
    }

    this.assertMediaApproved(media);

    // If order_index not provided, add to end
    let orderIndex = input.order_index;
    if (orderIndex === undefined) {
      const items = await db.getPlaylistItems(input.playlist_id);
      orderIndex = items.length;
    }

    const item = await db.addPlaylistItem({
      ...input,
      order_index: orderIndex,
    });

    logger.info(`Item added to playlist ${input.playlist_id}: media ${input.media_id}`);
    return item;
  }

  /**
   * Adds multiple items to a playlist
   */
  async addPlaylistItems(playlistId: number, mediaIds: number[]): Promise<PlaylistItem[]> {
    const db = await getDatabase();

    // Verify playlist exists
    await this.getPlaylistById(playlistId);

    // Get current items to determine starting order_index
    const existingItems = await db.getPlaylistItems(playlistId);
    let orderIndex = existingItems.length;

    const items: PlaylistItem[] = [];
    for (const mediaId of mediaIds) {
      // Verify media exists
      const media = await db.getMediaById(mediaId);
      if (!media) {
        throw new AppError(ErrorCode.MEDIA_NOT_FOUND, `Media with ID ${mediaId} not found`, 404);
      }

      this.assertMediaApproved(media);

      const item = await db.addPlaylistItem({
        playlist_id: playlistId,
        media_id: mediaId,
        order_index: orderIndex,
        image_duration: 5, // default
      });

      items.push(item);
      orderIndex += 1;
    }

    logger.info(`Added ${items.length} items to playlist ${playlistId}`);
    return items;
  }

  /**
   * Gets a playlist item by ID
   */
  async getPlaylistItemById(itemId: number): Promise<PlaylistItem> {
    const db = await getDatabase();
    const item = await db.getPlaylistItemById(itemId);

    if (!item) {
      throw new AppError(
        ErrorCode.PLAYLIST_ITEM_NOT_FOUND,
        `Playlist item with ID ${itemId} not found`,
        404
      );
    }

    return item;
  }

  /**
   * Updates a playlist item
   */
  async updatePlaylistItem(itemId: number, input: UpdatePlaylistItemInput): Promise<PlaylistItem> {
    // Verify item exists
    await this.getPlaylistItemById(itemId);

    const db = await getDatabase();
    const item = await db.updatePlaylistItem(itemId, input);

    logger.info(`Playlist item updated: ${itemId}`);
    return item;
  }

  /**
   * Removes an item from a playlist
   */
  async deletePlaylistItem(itemId: number): Promise<void> {
    // Verify item exists
    const item = await this.getPlaylistItemById(itemId);

    const db = await getDatabase();
    await db.deletePlaylistItem(itemId);

    // Reorder remaining items
    const remainingItems = await db.getPlaylistItems(item.playlist_id);
    const itemIds = remainingItems.sort((a, b) => a.order_index - b.order_index).map((i) => i.id);

    if (itemIds.length > 0) {
      await db.reorderPlaylistItems(item.playlist_id, itemIds);
    }

    logger.info(`Playlist item deleted: ${itemId}`);
  }

  /**
   * Reorders playlist items
   */
  async reorderPlaylistItems(playlistId: number, itemIds: number[]): Promise<void> {
    // Verify playlist exists
    await this.getPlaylistById(playlistId);

    const db = await getDatabase();

    // Verify all items belong to this playlist
    for (const itemId of itemIds) {
      const item = await db.getPlaylistItemById(itemId);
      if (!item) {
        throw new AppError(
          ErrorCode.PLAYLIST_ITEM_NOT_FOUND,
          `Playlist item with ID ${itemId} not found`,
          404
        );
      }
      if (item.playlist_id !== playlistId) {
        throw new AppError(
          ErrorCode.BAD_REQUEST,
          `Item ${itemId} does not belong to playlist ${playlistId}`,
          400
        );
      }
    }

    await db.reorderPlaylistItems(playlistId, itemIds);
    logger.info(`Playlist ${playlistId} items reordered`);
  }

  /**
   * Gets playlist statistics
   */
  async getPlaylistStats(playlistId: number): Promise<{
    totalItems: number;
    totalDuration: number;
    videoCount: number;
    imageCount: number;
  }> {
    const playlist = await this.getPlaylistWithItems(playlistId);

    const stats = {
      totalItems: playlist.items.length,
      totalDuration: 0,
      videoCount: 0,
      imageCount: 0,
    };

    playlist.items.forEach((item) => {
      if (item.media.type === 'video') {
        stats.videoCount += 1;
        stats.totalDuration += item.media.duration || 0;
      } else if (item.media.type === 'image') {
        stats.imageCount += 1;
        stats.totalDuration += item.image_duration;
      }
    });

    return stats;
  }
}

// Export singleton instance
export const playlistService = new PlaylistService();
