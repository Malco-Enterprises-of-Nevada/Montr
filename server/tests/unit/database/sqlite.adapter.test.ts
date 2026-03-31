/**
 * Comprehensive unit tests for SQLiteAdapter
 * Tests all database operations with real SQLite database
 */

import { SQLiteAdapter } from '../../../src/database/adapters/sqlite.adapter';
import {
  CreateMediaInput,
  CreatePlaylistInput,
  UpdatePlaylistInput,
  AddPlaylistItemInput,
  UpdatePlaylistItemInput,
  CreateClientInput,
  UpdateClientInput,
  CreateClientStatusInput,
  MediaFilter,
  ClientFilter,
} from '../../../src/database/types';
import fs from 'fs';
import path from 'path';

describe('SQLiteAdapter', () => {
  let adapter: SQLiteAdapter;
  let dbPath: string;
  let testDbDir: string;

  beforeEach(async () => {
    // Create unique test database for each test
    testDbDir = path.join('/tmp', `montr-test-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    fs.mkdirSync(testDbDir, { recursive: true });
    dbPath = path.join(testDbDir, 'test.db');

    adapter = new SQLiteAdapter(dbPath);
    await adapter.connect();
  });

  afterEach(async () => {
    // Cleanup
    await adapter.disconnect();
    if (fs.existsSync(testDbDir)) {
      fs.rmSync(testDbDir, { recursive: true, force: true });
    }
  });

  describe('Connection Management', () => {
    it('should connect to database successfully', async () => {
      expect(adapter.isConnected()).toBe(true);
      expect(fs.existsSync(dbPath)).toBe(true);
    });

    it('should create database directory if it does not exist', async () => {
      await adapter.disconnect();
      const newDbPath = path.join(testDbDir, 'subdir', 'nested', 'test.db');
      const newAdapter = new SQLiteAdapter(newDbPath);
      await newAdapter.connect();

      expect(fs.existsSync(newDbPath)).toBe(true);
      await newAdapter.disconnect();
    });

    it('should disconnect from database', async () => {
      await adapter.disconnect();
      expect(adapter.isConnected()).toBe(false);
    });

    it('should initialize schema on connect', async () => {
      // Verify tables were created by attempting an insert
      const media = await adapter.createMedia({
        filename: 'test.mp4',
        original_filename: 'test.mp4',
        filepath: 'media/test.mp4',
        type: 'video',
      });
      expect(media.id).toBeDefined();
    });
  });

  describe('Media Operations', () => {
    describe('createMedia', () => {
      it('should create video media file successfully', async () => {
        const input: CreateMediaInput = {
          filename: 'video_123.mp4',
          original_filename: 'my_video.mp4',
          filepath: 'media/video_123.mp4',
          type: 'video',
          mime_type: 'video/mp4',
          file_size: 10485760,
          duration: 120.5,
          width: 1920,
          height: 1080,
          checksum: 'abc123def456',
        };

        const media = await adapter.createMedia(input);

        expect(media.id).toBeGreaterThan(0);
        expect(media.filename).toBe(input.filename);
        expect(media.original_filename).toBe(input.original_filename);
        expect(media.type).toBe('video');
        expect(media.duration).toBe(120.5);
        expect(media.width).toBe(1920);
        expect(media.height).toBe(1080);
        expect(media.checksum).toBe('abc123def456');
        expect(media.created_at).toBeDefined();
      });

      it('should create image media file successfully', async () => {
        const input: CreateMediaInput = {
          filename: 'image_456.jpg',
          original_filename: 'photo.jpg',
          filepath: 'media/image_456.jpg',
          type: 'image',
          mime_type: 'image/jpeg',
          file_size: 2097152,
          width: 3840,
          height: 2160,
          checksum: 'xyz789',
        };

        const media = await adapter.createMedia(input);

        expect(media.id).toBeGreaterThan(0);
        expect(media.type).toBe('image');
        expect(media.duration).toBeNull();
        expect(media.width).toBe(3840);
      });

      it('should handle optional fields', async () => {
        const input: CreateMediaInput = {
          filename: 'minimal.mp4',
          original_filename: 'minimal.mp4',
          filepath: 'media/minimal.mp4',
          type: 'video',
        };

        const media = await adapter.createMedia(input);

        expect(media.id).toBeGreaterThan(0);
        expect(media.mime_type).toBeNull();
        expect(media.file_size).toBeNull();
        expect(media.duration).toBeNull();
      });

      it('should throw error for duplicate checksum', async () => {
        const input1: CreateMediaInput = {
          filename: 'file1.mp4',
          original_filename: 'file1.mp4',
          filepath: 'media/file1.mp4',
          type: 'video',
          checksum: 'duplicate_checksum',
        };

        const input2: CreateMediaInput = {
          filename: 'file2.mp4',
          original_filename: 'file2.mp4',
          filepath: 'media/file2.mp4',
          type: 'video',
          checksum: 'duplicate_checksum',
        };

        await adapter.createMedia(input1);

        await expect(adapter.createMedia(input2)).rejects.toThrow();
      });
    });

    describe('getMediaById', () => {
      it('should retrieve media by ID', async () => {
        const created = await adapter.createMedia({
          filename: 'test.mp4',
          original_filename: 'test.mp4',
          filepath: 'media/test.mp4',
          type: 'video',
        });

        const media = await adapter.getMediaById(created.id);

        expect(media).toBeDefined();
        expect(media?.id).toBe(created.id);
        expect(media?.filename).toBe('test.mp4');
      });

      it('should return null for non-existent ID', async () => {
        const media = await adapter.getMediaById(99999);
        expect(media).toBeNull();
      });
    });

    describe('getAllMedia', () => {
      beforeEach(async () => {
        // Create test media files
        await adapter.createMedia({
          filename: 'video1.mp4',
          original_filename: 'video1.mp4',
          filepath: 'media/video1.mp4',
          type: 'video',
        });
        await adapter.createMedia({
          filename: 'image1.jpg',
          original_filename: 'image1.jpg',
          filepath: 'media/image1.jpg',
          type: 'image',
        });
        await adapter.createMedia({
          filename: 'video2.mp4',
          original_filename: 'video2.mp4',
          filepath: 'media/video2.mp4',
          type: 'video',
        });
      });

      it('should retrieve all media with pagination', async () => {
        const result = await adapter.getAllMedia({ page: 1, limit: 10 });

        expect(result.data).toHaveLength(3);
        expect(result.pagination.total).toBe(3);
        expect(result.pagination.totalPages).toBe(1);
        expect(result.pagination.page).toBe(1);
        expect(result.pagination.limit).toBe(10);
      });

      it('should paginate results correctly', async () => {
        const page1 = await adapter.getAllMedia({ page: 1, limit: 2 });
        expect(page1.data).toHaveLength(2);
        expect(page1.pagination.totalPages).toBe(2);

        const page2 = await adapter.getAllMedia({ page: 2, limit: 2 });
        expect(page2.data).toHaveLength(1);
      });

      it('should filter by type', async () => {
        const filter: MediaFilter = { type: 'video' };
        const result = await adapter.getAllMedia({ page: 1, limit: 10 }, filter);

        expect(result.data).toHaveLength(2);
        expect(result.data.every(m => m.type === 'video')).toBe(true);
      });

      it('should filter by search term', async () => {
        const filter: MediaFilter = { search: 'image1' };
        const result = await adapter.getAllMedia({ page: 1, limit: 10 }, filter);

        expect(result.data).toHaveLength(1);
        expect(result.data[0].filename).toBe('image1.jpg');
      });

      it('should combine multiple filters', async () => {
        const filter: MediaFilter = { type: 'video', search: 'video2' };
        const result = await adapter.getAllMedia({ page: 1, limit: 10 }, filter);

        expect(result.data).toHaveLength(1);
        expect(result.data[0].filename).toBe('video2.mp4');
      });

      it('should return empty result when no matches', async () => {
        const filter: MediaFilter = { search: 'nonexistent' };
        const result = await adapter.getAllMedia({ page: 1, limit: 10 }, filter);

        expect(result.data).toHaveLength(0);
        expect(result.pagination.total).toBe(0);
      });
    });

    describe('updateMedia', () => {
      it('should update media fields', async () => {
        const created = await adapter.createMedia({
          filename: 'test.mp4',
          original_filename: 'test.mp4',
          filepath: 'media/test.mp4',
          type: 'video',
        });

        const updated = await adapter.updateMedia(created.id, {
          duration: 60.5,
          width: 1280,
          height: 720,
        });

        expect(updated.duration).toBe(60.5);
        expect(updated.width).toBe(1280);
        expect(updated.height).toBe(720);
      });

      it('should return unchanged media when no updates provided', async () => {
        const created = await adapter.createMedia({
          filename: 'test.mp4',
          original_filename: 'test.mp4',
          filepath: 'media/test.mp4',
          type: 'video',
        });

        const unchanged = await adapter.updateMedia(created.id, {});

        expect(unchanged).toEqual(created);
      });

      it('should reject invalid field names', async () => {
        const created = await adapter.createMedia({
          filename: 'test.mp4',
          original_filename: 'test.mp4',
          filepath: 'media/test.mp4',
          type: 'video',
        });

        await expect(adapter.updateMedia(created.id, { 'invalid_field': 'value' } as any))
          .rejects.toThrow('Invalid field name: invalid_field');
      });

      it('should throw error when updating non-existent media', async () => {
        await expect(adapter.updateMedia(99999, { duration: 60 }))
          .rejects.toThrow('Media with ID 99999 not found');
      });
    });

    describe('deleteMedia', () => {
      it('should delete media successfully', async () => {
        const created = await adapter.createMedia({
          filename: 'test.mp4',
          original_filename: 'test.mp4',
          filepath: 'media/test.mp4',
          type: 'video',
        });

        await adapter.deleteMedia(created.id);

        const deleted = await adapter.getMediaById(created.id);
        expect(deleted).toBeNull();
      });

      it('should not throw error when deleting non-existent media', async () => {
        await expect(adapter.deleteMedia(99999)).resolves.not.toThrow();
      });
    });

    describe('getMediaByChecksum', () => {
      it('should find media by checksum', async () => {
        await adapter.createMedia({
          filename: 'test.mp4',
          original_filename: 'test.mp4',
          filepath: 'media/test.mp4',
          type: 'video',
          checksum: 'unique_checksum_123',
        });

        const media = await adapter.getMediaByChecksum('unique_checksum_123');

        expect(media).toBeDefined();
        expect(media?.checksum).toBe('unique_checksum_123');
      });

      it('should return null for non-existent checksum', async () => {
        const media = await adapter.getMediaByChecksum('nonexistent');
        expect(media).toBeNull();
      });
    });
  });

  describe('Playlist Operations', () => {
    describe('createPlaylist', () => {
      it('should create playlist successfully', async () => {
        const input: CreatePlaylistInput = {
          name: 'Test Playlist',
          description: 'A test playlist',
        };

        const playlist = await adapter.createPlaylist(input);

        expect(playlist.id).toBeGreaterThan(0);
        expect(playlist.name).toBe('Test Playlist');
        expect(playlist.description).toBe('A test playlist');
        expect(playlist.created_at).toBeDefined();
      });

      it('should create playlist without description', async () => {
        const input: CreatePlaylistInput = {
          name: 'Minimal Playlist',
        };

        const playlist = await adapter.createPlaylist(input);

        expect(playlist.id).toBeGreaterThan(0);
        expect(playlist.description).toBeNull();
      });
    });

    describe('getPlaylistById', () => {
      it('should retrieve playlist by ID', async () => {
        const created = await adapter.createPlaylist({
          name: 'Test Playlist',
        });

        const playlist = await adapter.getPlaylistById(created.id);

        expect(playlist).toBeDefined();
        expect(playlist?.id).toBe(created.id);
        expect(playlist?.name).toBe('Test Playlist');
      });

      it('should return null for non-existent ID', async () => {
        const playlist = await adapter.getPlaylistById(99999);
        expect(playlist).toBeNull();
      });
    });

    describe('getPlaylistWithItems', () => {
      it('should retrieve playlist with items', async () => {
        const playlist = await adapter.createPlaylist({ name: 'Test' });
        const media = await adapter.createMedia({
          filename: 'test.mp4',
          original_filename: 'test.mp4',
          filepath: 'media/test.mp4',
          type: 'video',
        });

        await adapter.addPlaylistItem({
          playlist_id: playlist.id,
          media_id: media.id,
          order_index: 0,
          image_duration: 5,
        });

        const result = await adapter.getPlaylistWithItems(playlist.id);

        expect(result).toBeDefined();
        expect(result?.items).toHaveLength(1);
        expect(result?.items[0].media.id).toBe(media.id);
      });

      it('should return null for non-existent playlist', async () => {
        const result = await adapter.getPlaylistWithItems(99999);
        expect(result).toBeNull();
      });

      it('should return empty items array for playlist with no items', async () => {
        const playlist = await adapter.createPlaylist({ name: 'Empty' });
        const result = await adapter.getPlaylistWithItems(playlist.id);

        expect(result).toBeDefined();
        expect(result?.items).toEqual([]);
      });
    });

    describe('getAllPlaylists', () => {
      it('should retrieve all playlists', async () => {
        await adapter.createPlaylist({ name: 'Playlist 1' });
        await adapter.createPlaylist({ name: 'Playlist 2' });

        const playlists = await adapter.getAllPlaylists();

        expect(playlists).toHaveLength(2);
        expect(playlists.map(p => p.name)).toContain('Playlist 1');
        expect(playlists.map(p => p.name)).toContain('Playlist 2');
      });

      it('should return empty array when no playlists', async () => {
        const playlists = await adapter.getAllPlaylists();
        expect(playlists).toEqual([]);
      });
    });

    describe('updatePlaylist', () => {
      it('should update playlist name', async () => {
        const created = await adapter.createPlaylist({ name: 'Original' });

        const updated = await adapter.updatePlaylist(created.id, {
          name: 'Updated',
        });

        expect(updated.name).toBe('Updated');
      });

      it('should update playlist description', async () => {
        const created = await adapter.createPlaylist({ name: 'Test' });

        const updated = await adapter.updatePlaylist(created.id, {
          description: 'New description',
        });

        expect(updated.description).toBe('New description');
      });

      it('should update both name and description', async () => {
        const created = await adapter.createPlaylist({ name: 'Test' });

        const updated = await adapter.updatePlaylist(created.id, {
          name: 'New Name',
          description: 'New Description',
        });

        expect(updated.name).toBe('New Name');
        expect(updated.description).toBe('New Description');
      });

      it('should return unchanged when no updates', async () => {
        const created = await adapter.createPlaylist({ name: 'Test' });
        const unchanged = await adapter.updatePlaylist(created.id, {});

        expect(unchanged).toEqual(created);
      });

      it('should throw error for non-existent playlist', async () => {
        await expect(adapter.updatePlaylist(99999, { name: 'Test' }))
          .rejects.toThrow('Playlist with ID 99999 not found');
      });
    });

    describe('deletePlaylist', () => {
      it('should delete playlist successfully', async () => {
        const created = await adapter.createPlaylist({ name: 'Test' });
        await adapter.deletePlaylist(created.id);

        const deleted = await adapter.getPlaylistById(created.id);
        expect(deleted).toBeNull();
      });

      it('should cascade delete playlist items', async () => {
        const playlist = await adapter.createPlaylist({ name: 'Test' });
        const media = await adapter.createMedia({
          filename: 'test.mp4',
          original_filename: 'test.mp4',
          filepath: 'media/test.mp4',
          type: 'video',
        });

        await adapter.addPlaylistItem({
          playlist_id: playlist.id,
          media_id: media.id,
          order_index: 0,
        });

        await adapter.deletePlaylist(playlist.id);

        const items = await adapter.getPlaylistItems(playlist.id);
        expect(items).toEqual([]);
      });
    });
  });

  describe('Playlist Item Operations', () => {
    let playlistId: number;
    let mediaId: number;

    beforeEach(async () => {
      const playlist = await adapter.createPlaylist({ name: 'Test' });
      playlistId = playlist.id;

      const media = await adapter.createMedia({
        filename: 'test.mp4',
        original_filename: 'test.mp4',
        filepath: 'media/test.mp4',
        type: 'video',
      });
      mediaId = media.id;
    });

    describe('addPlaylistItem', () => {
      it('should add playlist item successfully', async () => {
        const input: AddPlaylistItemInput = {
          playlist_id: playlistId,
          media_id: mediaId,
          order_index: 0,
          image_duration: 10,
        };

        const item = await adapter.addPlaylistItem(input);

        expect(item.id).toBeGreaterThan(0);
        expect(item.playlist_id).toBe(playlistId);
        expect(item.media_id).toBe(mediaId);
        expect(item.order_index).toBe(0);
        expect(item.image_duration).toBe(10);
      });

      it('should default image_duration to 5', async () => {
        const item = await adapter.addPlaylistItem({
          playlist_id: playlistId,
          media_id: mediaId,
          order_index: 0,
        });

        expect(item.image_duration).toBe(5);
      });
    });

    describe('getPlaylistItems', () => {
      it('should retrieve items in order', async () => {
        const media2 = await adapter.createMedia({
          filename: 'test2.mp4',
          original_filename: 'test2.mp4',
          filepath: 'media/test2.mp4',
          type: 'video',
        });

        await adapter.addPlaylistItem({
          playlist_id: playlistId,
          media_id: mediaId,
          order_index: 1,
        });

        await adapter.addPlaylistItem({
          playlist_id: playlistId,
          media_id: media2.id,
          order_index: 0,
        });

        const items = await adapter.getPlaylistItems(playlistId);

        expect(items).toHaveLength(2);
        expect(items[0].order_index).toBe(0);
        expect(items[1].order_index).toBe(1);
        expect(items[0].media_id).toBe(media2.id);
      });

      it('should return empty array for playlist with no items', async () => {
        const items = await adapter.getPlaylistItems(playlistId);
        expect(items).toEqual([]);
      });
    });

    describe('getPlaylistItemById', () => {
      it('should retrieve item by ID', async () => {
        const created = await adapter.addPlaylistItem({
          playlist_id: playlistId,
          media_id: mediaId,
          order_index: 0,
        });

        const item = await adapter.getPlaylistItemById(created.id);

        expect(item).toBeDefined();
        expect(item?.id).toBe(created.id);
      });

      it('should return null for non-existent item', async () => {
        const item = await adapter.getPlaylistItemById(99999);
        expect(item).toBeNull();
      });
    });

    describe('updatePlaylistItem', () => {
      it('should update order_index', async () => {
        const created = await adapter.addPlaylistItem({
          playlist_id: playlistId,
          media_id: mediaId,
          order_index: 0,
        });

        const updated = await adapter.updatePlaylistItem(created.id, {
          order_index: 5,
        });

        expect(updated.order_index).toBe(5);
      });

      it('should update image_duration', async () => {
        const created = await adapter.addPlaylistItem({
          playlist_id: playlistId,
          media_id: mediaId,
          order_index: 0,
        });

        const updated = await adapter.updatePlaylistItem(created.id, {
          image_duration: 15,
        });

        expect(updated.image_duration).toBe(15);
      });

      it('should update both fields', async () => {
        const created = await adapter.addPlaylistItem({
          playlist_id: playlistId,
          media_id: mediaId,
          order_index: 0,
        });

        const updated = await adapter.updatePlaylistItem(created.id, {
          order_index: 3,
          image_duration: 20,
        });

        expect(updated.order_index).toBe(3);
        expect(updated.image_duration).toBe(20);
      });

      it('should return unchanged when no updates', async () => {
        const created = await adapter.addPlaylistItem({
          playlist_id: playlistId,
          media_id: mediaId,
          order_index: 0,
        });

        const unchanged = await adapter.updatePlaylistItem(created.id, {});

        expect(unchanged).toEqual(created);
      });

      it('should throw error for non-existent item', async () => {
        await expect(adapter.updatePlaylistItem(99999, { order_index: 1 }))
          .rejects.toThrow('Playlist item with ID 99999 not found');
      });
    });

    describe('deletePlaylistItem', () => {
      it('should delete item successfully', async () => {
        const created = await adapter.addPlaylistItem({
          playlist_id: playlistId,
          media_id: mediaId,
          order_index: 0,
        });

        await adapter.deletePlaylistItem(created.id);

        const deleted = await adapter.getPlaylistItemById(created.id);
        expect(deleted).toBeNull();
      });
    });

    describe('reorderPlaylistItems', () => {
      it('should reorder items correctly', async () => {
        const media2 = await adapter.createMedia({
          filename: 'test2.mp4',
          original_filename: 'test2.mp4',
          filepath: 'media/test2.mp4',
          type: 'video',
        });

        const media3 = await adapter.createMedia({
          filename: 'test3.mp4',
          original_filename: 'test3.mp4',
          filepath: 'media/test3.mp4',
          type: 'video',
        });

        const item1 = await adapter.addPlaylistItem({
          playlist_id: playlistId,
          media_id: mediaId,
          order_index: 0,
        });

        const item2 = await adapter.addPlaylistItem({
          playlist_id: playlistId,
          media_id: media2.id,
          order_index: 1,
        });

        const item3 = await adapter.addPlaylistItem({
          playlist_id: playlistId,
          media_id: media3.id,
          order_index: 2,
        });

        // Reverse order: [item3, item2, item1]
        await adapter.reorderPlaylistItems(playlistId, [item3.id, item2.id, item1.id]);

        const items = await adapter.getPlaylistItems(playlistId);

        expect(items[0].id).toBe(item3.id);
        expect(items[0].order_index).toBe(0);
        expect(items[1].id).toBe(item2.id);
        expect(items[1].order_index).toBe(1);
        expect(items[2].id).toBe(item1.id);
        expect(items[2].order_index).toBe(2);
      });
    });
  });

  describe('Client Operations', () => {
    describe('createClient', () => {
      it('should create client successfully', async () => {
        const input: CreateClientInput = {
          id: 'client-uuid-123',
          name: 'Test Client',
          version: '1.0.0',
          capabilities: '{"formats":["mp4","jpg"]}',
        };

        const client = await adapter.createClient(input);

        expect(client.id).toBe('client-uuid-123');
        expect(client.name).toBe('Test Client');
        expect(client.version).toBe('1.0.0');
        expect(client.capabilities).toBe('{"formats":["mp4","jpg"]}');
        expect(client.status).toBe('offline');
        expect(client.last_seen).toBeDefined();
      });

      it('should handle optional fields', async () => {
        const input: CreateClientInput = {
          id: 'client-uuid-456',
          name: 'Minimal Client',
        };

        const client = await adapter.createClient(input);

        expect(client.id).toBe('client-uuid-456');
        expect(client.version).toBeNull();
        expect(client.capabilities).toBeNull();
      });
    });

    describe('getClientById', () => {
      it('should retrieve client by ID', async () => {
        await adapter.createClient({
          id: 'test-client',
          name: 'Test Client',
        });

        const client = await adapter.getClientById('test-client');

        expect(client).toBeDefined();
        expect(client?.id).toBe('test-client');
        expect(client?.name).toBe('Test Client');
      });

      it('should return null for non-existent client', async () => {
        const client = await adapter.getClientById('nonexistent');
        expect(client).toBeNull();
      });
    });

    describe('getAllClients', () => {
      let assignedPlaylistId: number;

      beforeEach(async () => {
        const playlist = await adapter.createPlaylist({ name: 'Test' });
        assignedPlaylistId = playlist.id;

        await adapter.createClient({
          id: 'client-1',
          name: 'Client 1',
        });

        await adapter.createClient({
          id: 'client-2',
          name: 'Client 2',
        });

        await adapter.updateClient('client-2', {
          status: 'online',
          assigned_playlist_id: playlist.id,
        });
      });

      it('should retrieve all clients', async () => {
        const clients = await adapter.getAllClients();

        expect(clients).toHaveLength(2);
        expect(clients.map(c => c.id)).toContain('client-1');
        expect(clients.map(c => c.id)).toContain('client-2');
      });

      it('should filter by status', async () => {
        const filter: ClientFilter = { status: 'online' };
        const clients = await adapter.getAllClients(filter);

        expect(clients).toHaveLength(1);
        expect(clients[0].id).toBe('client-2');
      });

      it('should filter by assigned_playlist_id', async () => {
        const filter: ClientFilter = { assigned_playlist_id: assignedPlaylistId };
        const clients = await adapter.getAllClients(filter);

        expect(clients).toHaveLength(1);
        expect(clients[0].id).toBe('client-2');
      });

      it('should combine multiple filters', async () => {
        const filter: ClientFilter = {
          status: 'online',
          assigned_playlist_id: assignedPlaylistId,
        };
        const clients = await adapter.getAllClients(filter);

        expect(clients).toHaveLength(1);
        expect(clients[0].id).toBe('client-2');
      });
    });

    describe('updateClient', () => {
      it('should update client name', async () => {
        await adapter.createClient({
          id: 'test-client',
          name: 'Original Name',
        });

        const updated = await adapter.updateClient('test-client', {
          name: 'Updated Name',
        });

        expect(updated.name).toBe('Updated Name');
      });

      it('should update client status', async () => {
        await adapter.createClient({
          id: 'test-client',
          name: 'Test',
        });

        const updated = await adapter.updateClient('test-client', {
          status: 'online',
        });

        expect(updated.status).toBe('online');
      });

      it('should assign playlist to client', async () => {
        const playlist = await adapter.createPlaylist({ name: 'Test' });
        await adapter.createClient({
          id: 'test-client',
          name: 'Test',
        });

        const updated = await adapter.updateClient('test-client', {
          assigned_playlist_id: playlist.id,
        });

        expect(updated.assigned_playlist_id).toBe(playlist.id);
      });

      it('should update multiple fields', async () => {
        await adapter.createClient({
          id: 'test-client',
          name: 'Test',
        });

        const updated = await adapter.updateClient('test-client', {
          name: 'New Name',
          status: 'online',
          version: '2.0.0',
          last_seen: '2023-01-01T00:00:00.000Z',
        });

        expect(updated.name).toBe('New Name');
        expect(updated.status).toBe('online');
        expect(updated.version).toBe('2.0.0');
        expect(updated.last_seen).toBe('2023-01-01T00:00:00.000Z');
      });

      it('should return unchanged when no updates', async () => {
        const created = await adapter.createClient({
          id: 'test-client',
          name: 'Test',
        });

        const unchanged = await adapter.updateClient('test-client', {});

        expect(unchanged.name).toBe(created.name);
      });

      it('should throw error for non-existent client', async () => {
        await expect(adapter.updateClient('nonexistent', { name: 'Test' }))
          .rejects.toThrow('Client with ID nonexistent not found');
      });
    });

    describe('deleteClient', () => {
      it('should delete client successfully', async () => {
        await adapter.createClient({
          id: 'test-client',
          name: 'Test',
        });

        await adapter.deleteClient('test-client');

        const deleted = await adapter.getClientById('test-client');
        expect(deleted).toBeNull();
      });

      it('should cascade delete client status', async () => {
        await adapter.createClient({
          id: 'test-client',
          name: 'Test',
        });

        await adapter.createClientStatus({
          client_id: 'test-client',
          is_playing: false,
        });

        await adapter.deleteClient('test-client');

        const status = await adapter.getLatestClientStatus('test-client');
        expect(status).toBeNull();
      });
    });
  });

  describe('Client Status Operations', () => {
    let clientId: string;

    beforeEach(async () => {
      await adapter.createClient({
        id: 'status-test-client',
        name: 'Test Client',
      });
      clientId = 'status-test-client';
    });

    describe('createClientStatus', () => {
      it('should create status successfully', async () => {
        const media = await adapter.createMedia({
          filename: 'test.mp4',
          original_filename: 'test.mp4',
          filepath: 'media/test.mp4',
          type: 'video',
        });

        const input: CreateClientStatusInput = {
          client_id: clientId,
          current_media_id: media.id,
          position: 45.5,
          is_playing: true,
        };

        const status = await adapter.createClientStatus(input);

        expect(status.id).toBeGreaterThan(0);
        expect(status.client_id).toBe(clientId);
        expect(status.current_media_id).toBe(media.id);
        expect(status.position).toBe(45.5);
        expect(status.is_playing).toBe(1);
        expect(status.timestamp).toBeDefined();
      });

      it('should handle optional fields', async () => {
        const input: CreateClientStatusInput = {
          client_id: clientId,
          is_playing: false,
        };

        const status = await adapter.createClientStatus(input);

        expect(status.current_media_id).toBeNull();
        expect(status.position).toBeNull();
        expect(status.is_playing).toBe(0);
      });

      it('should store error message', async () => {
        const input: CreateClientStatusInput = {
          client_id: clientId,
          is_playing: false,
          error_message: 'Playback failed',
        };

        const status = await adapter.createClientStatus(input);

        expect(status.error_message).toBe('Playback failed');
      });
    });

    describe('getLatestClientStatus', () => {
      it('should retrieve latest status', async () => {
        await adapter.createClientStatus({
          client_id: clientId,
          is_playing: false,
          position: 10,
        });

        // Wait a bit to ensure different timestamps
        await new Promise(resolve => setTimeout(resolve, 10));

        await adapter.createClientStatus({
          client_id: clientId,
          is_playing: true,
          position: 20,
        });

        const status = await adapter.getLatestClientStatus(clientId);

        expect(status).toBeDefined();
        expect(status?.position).toBe(20);
        expect(status?.is_playing).toBe(1);
      });

      it('should return null when no status exists', async () => {
        const status = await adapter.getLatestClientStatus('nonexistent');
        expect(status).toBeNull();
      });
    });

    describe('getClientWithStatus', () => {
      it('should retrieve client with status', async () => {
        await adapter.createClientStatus({
          client_id: clientId,
          is_playing: true,
          position: 30,
        });

        const result = await adapter.getClientWithStatus(clientId);

        expect(result).toBeDefined();
        expect(result?.id).toBe(clientId);
        expect(result?.current_status).toBeDefined();
        expect(result?.current_status?.position).toBe(30);
      });

      it('should return null for non-existent client', async () => {
        const result = await adapter.getClientWithStatus('nonexistent');
        expect(result).toBeNull();
      });

      it('should include null status if no status exists', async () => {
        const result = await adapter.getClientWithStatus(clientId);

        expect(result).toBeDefined();
        expect(result?.current_status).toBeNull();
      });
    });
  });

  describe('Error Handling', () => {
    it('should throw error when operating on disconnected database', async () => {
      await adapter.disconnect();

      await expect(adapter.createMedia({
        filename: 'test.mp4',
        original_filename: 'test.mp4',
        filepath: 'media/test.mp4',
        type: 'video',
      })).rejects.toThrow('Database not connected');
    });

    it('should handle foreign key constraint violations', async () => {
      // Try to add playlist item with non-existent media
      await expect(adapter.addPlaylistItem({
        playlist_id: 1,
        media_id: 99999,
        order_index: 0,
      })).rejects.toThrow();
    });
  });
});
