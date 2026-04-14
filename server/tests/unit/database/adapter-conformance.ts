/**
 * Adapter Conformance Test Suite
 * Shared behavioral tests that validate all 28 DatabaseAdapter methods.
 * Each adapter test file calls this with its own setup/teardown.
 */

import { DatabaseAdapter } from '../../../src/database/adapters/base.adapter';
import {
  CreateMediaInput,
  CreatePlaylistInput,
  AddPlaylistItemInput,
  CreateClientInput,
  CreateClientStatusInput,
  CreateClientTelemetryInput,
} from '../../../src/database/types';

const sampleMedia: CreateMediaInput = {
  filename: 'test_abc123.mp4',
  original_filename: 'my_video.mp4',
  filepath: 'media/test_abc123.mp4',
  type: 'video',
  mime_type: 'video/mp4',
  file_size: 1024000,
  duration: 60.5,
  width: 1920,
  height: 1080,
  checksum: 'sha256_aabbccdd',
};

const sampleImage: CreateMediaInput = {
  filename: 'test_img456.jpg',
  original_filename: 'photo.jpg',
  filepath: 'media/test_img456.jpg',
  type: 'image',
  mime_type: 'image/jpeg',
  file_size: 512000,
  width: 3840,
  height: 2160,
};

const samplePlaylist: CreatePlaylistInput = {
  name: 'Test Playlist',
  description: 'A test playlist',
};

const sampleClient: CreateClientInput = {
  id: 'test-client-001',
  name: 'Test Client',
  version: '1.0.0',
  capabilities: '{"video":true,"image":true}',
};

export function runAdapterConformanceTests(
  name: string,
  createAdapter: () => Promise<DatabaseAdapter>,
  cleanupAdapter: (adapter: DatabaseAdapter) => Promise<void>,
) {
  describe(`DatabaseAdapter conformance: ${name}`, () => {
    let adapter: DatabaseAdapter;

    beforeEach(async () => {
      adapter = await createAdapter();
    });

    afterEach(async () => {
      await cleanupAdapter(adapter);
    });

    // ── Connection ───────────────────────────────────────────────────────

    describe('Connection', () => {
      it('should report connected after connect()', () => {
        expect(adapter.isConnected()).toBe(true);
      });

      it('should report disconnected after disconnect()', async () => {
        await adapter.disconnect();
        expect(adapter.isConnected()).toBe(false);
        // Reconnect for cleanup
        adapter = await createAdapter();
      });
    });

    // ── Media CRUD ───────────────────────────────────────────────────────

    describe('Media operations', () => {
      it('should create and retrieve media', async () => {
        const media = await adapter.createMedia(sampleMedia);
        expect(media.id).toBeDefined();
        expect(media.filename).toBe(sampleMedia.filename);
        expect(media.type).toBe('video');

        const fetched = await adapter.getMediaById(media.id);
        expect(fetched).not.toBeNull();
        expect(fetched!.filename).toBe(sampleMedia.filename);
      });

      it('should return null for non-existent media', async () => {
        const result = await adapter.getMediaById(99999);
        expect(result).toBeNull();
      });

      it('should find media by checksum', async () => {
        await adapter.createMedia(sampleMedia);
        const found = await adapter.getMediaByChecksum('sha256_aabbccdd');
        expect(found).not.toBeNull();
        expect(found!.original_filename).toBe('my_video.mp4');

        const notFound = await adapter.getMediaByChecksum('nonexistent');
        expect(notFound).toBeNull();
      });

      it('should paginate media', async () => {
        await adapter.createMedia(sampleMedia);
        await adapter.createMedia({ ...sampleImage, checksum: 'img_checksum' });

        const result = await adapter.getAllMedia({ page: 1, limit: 1 });
        expect(result.data).toHaveLength(1);
        expect(result.pagination.total).toBe(2);
        expect(result.pagination.totalPages).toBe(2);
      });

      it('should filter media by type', async () => {
        await adapter.createMedia(sampleMedia);
        await adapter.createMedia({ ...sampleImage, checksum: 'img_checksum' });

        const videos = await adapter.getAllMedia({ page: 1, limit: 10 }, { type: 'video' });
        expect(videos.data).toHaveLength(1);
        expect(videos.data[0].type).toBe('video');
      });

      it('should filter media by search term', async () => {
        await adapter.createMedia(sampleMedia);
        await adapter.createMedia({ ...sampleImage, checksum: 'img_checksum' });

        const result = await adapter.getAllMedia({ page: 1, limit: 10 }, { search: 'photo' });
        expect(result.data).toHaveLength(1);
        expect(result.data[0].original_filename).toBe('photo.jpg');
      });

      it('should update media', async () => {
        const media = await adapter.createMedia(sampleMedia);
        const updated = await adapter.updateMedia(media.id, { width: 1280 });
        expect(updated.width).toBe(1280);
      });

      it('should reject invalid field names in updateMedia', async () => {
        const media = await adapter.createMedia(sampleMedia);
        await expect(
          adapter.updateMedia(media.id, { invalid_field: 'bad' } as Record<string, unknown> as Partial<CreateMediaInput>),
        ).rejects.toThrow('Invalid field name');
      });

      it('should delete media', async () => {
        const media = await adapter.createMedia(sampleMedia);
        await adapter.deleteMedia(media.id);
        const result = await adapter.getMediaById(media.id);
        expect(result).toBeNull();
      });
    });

    // ── Playlist CRUD ────────────────────────────────────────────────────

    describe('Playlist operations', () => {
      it('should create and retrieve playlist', async () => {
        const playlist = await adapter.createPlaylist(samplePlaylist);
        expect(playlist.id).toBeDefined();
        expect(playlist.name).toBe('Test Playlist');

        const fetched = await adapter.getPlaylistById(playlist.id);
        expect(fetched).not.toBeNull();
        expect(fetched!.name).toBe('Test Playlist');
      });

      it('should list all playlists', async () => {
        await adapter.createPlaylist({ name: 'Playlist A' });
        await adapter.createPlaylist({ name: 'Playlist B' });

        const all = await adapter.getAllPlaylists();
        expect(all.length).toBeGreaterThanOrEqual(2);
      });

      it('should update playlist', async () => {
        const playlist = await adapter.createPlaylist(samplePlaylist);
        const updated = await adapter.updatePlaylist(playlist.id, { name: 'Updated Name' });
        expect(updated.name).toBe('Updated Name');
      });

      it('should delete playlist', async () => {
        const playlist = await adapter.createPlaylist(samplePlaylist);
        await adapter.deletePlaylist(playlist.id);
        const result = await adapter.getPlaylistById(playlist.id);
        expect(result).toBeNull();
      });

      it('should get playlist with items', async () => {
        const media = await adapter.createMedia(sampleMedia);
        const playlist = await adapter.createPlaylist(samplePlaylist);
        await adapter.addPlaylistItem({
          playlist_id: playlist.id,
          media_id: media.id,
          order_index: 0,
        });

        const withItems = await adapter.getPlaylistWithItems(playlist.id);
        expect(withItems).not.toBeNull();
        expect(withItems!.items).toHaveLength(1);
        expect(withItems!.items[0].media.filename).toBe(sampleMedia.filename);
      });

      it('should return null for non-existent playlist with items', async () => {
        const result = await adapter.getPlaylistWithItems(99999);
        expect(result).toBeNull();
      });
    });

    // ── Playlist Item CRUD ───────────────────────────────────────────────

    describe('Playlist item operations', () => {
      let playlistId: number;
      let mediaId: number;

      beforeEach(async () => {
        const media = await adapter.createMedia({
          ...sampleMedia,
          checksum: `checksum_${Date.now()}_${Math.random()}`,
        });
        mediaId = media.id;
        const playlist = await adapter.createPlaylist(samplePlaylist);
        playlistId = playlist.id;
      });

      it('should add and get playlist items', async () => {
        const item = await adapter.addPlaylistItem({
          playlist_id: playlistId,
          media_id: mediaId,
          order_index: 0,
        });
        expect(item.id).toBeDefined();
        expect(item.playlist_id).toBe(playlistId);

        const items = await adapter.getPlaylistItems(playlistId);
        expect(items).toHaveLength(1);
      });

      it('should get playlist item by id', async () => {
        const item = await adapter.addPlaylistItem({
          playlist_id: playlistId,
          media_id: mediaId,
          order_index: 0,
        });

        const fetched = await adapter.getPlaylistItemById(item.id);
        expect(fetched).not.toBeNull();
        expect(fetched!.media_id).toBe(mediaId);
      });

      it('should update playlist item', async () => {
        const item = await adapter.addPlaylistItem({
          playlist_id: playlistId,
          media_id: mediaId,
          order_index: 0,
          image_duration: 5,
        });

        const updated = await adapter.updatePlaylistItem(item.id, { image_duration: 10 });
        expect(updated.image_duration).toBe(10);
      });

      it('should delete playlist item', async () => {
        const item = await adapter.addPlaylistItem({
          playlist_id: playlistId,
          media_id: mediaId,
          order_index: 0,
        });

        await adapter.deletePlaylistItem(item.id);
        const result = await adapter.getPlaylistItemById(item.id);
        expect(result).toBeNull();
      });

      it('should reorder playlist items', async () => {
        const media2 = await adapter.createMedia({
          ...sampleImage,
          checksum: `img_${Date.now()}_${Math.random()}`,
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

        // Swap order
        await adapter.reorderPlaylistItems(playlistId, [item2.id, item1.id]);

        const items = await adapter.getPlaylistItems(playlistId);
        expect(items[0].id).toBe(item2.id);
        expect(items[0].order_index).toBe(0);
        expect(items[1].id).toBe(item1.id);
        expect(items[1].order_index).toBe(1);
      });
    });

    // ── Client CRUD ──────────────────────────────────────────────────────

    describe('Client operations', () => {
      it('should create and retrieve client', async () => {
        const client = await adapter.createClient(sampleClient);
        expect(client.id).toBe('test-client-001');
        expect(client.name).toBe('Test Client');

        const fetched = await adapter.getClientById('test-client-001');
        expect(fetched).not.toBeNull();
        expect(fetched!.name).toBe('Test Client');
      });

      it('should return null for non-existent client', async () => {
        const result = await adapter.getClientById('nonexistent');
        expect(result).toBeNull();
      });

      it('should list all clients', async () => {
        await adapter.createClient(sampleClient);
        await adapter.createClient({ id: 'test-client-002', name: 'Client 2' });

        const all = await adapter.getAllClients();
        expect(all.length).toBeGreaterThanOrEqual(2);
      });

      it('should filter clients by status', async () => {
        await adapter.createClient(sampleClient);
        await adapter.updateClient('test-client-001', { status: 'online' });

        const online = await adapter.getAllClients({ status: 'online' });
        expect(online).toHaveLength(1);
        expect(online[0].id).toBe('test-client-001');

        const offline = await adapter.getAllClients({ status: 'offline' });
        expect(offline).toHaveLength(0);
      });

      it('should update client', async () => {
        await adapter.createClient(sampleClient);
        const updated = await adapter.updateClient('test-client-001', {
          name: 'Updated Client',
          status: 'online',
        });
        expect(updated.name).toBe('Updated Client');
        expect(updated.status).toBe('online');
      });

      it('should delete client', async () => {
        await adapter.createClient(sampleClient);
        await adapter.deleteClient('test-client-001');
        const result = await adapter.getClientById('test-client-001');
        expect(result).toBeNull();
      });
    });

    // ── Client Status ────────────────────────────────────────────────────

    describe('Client status operations', () => {
      beforeEach(async () => {
        await adapter.createClient(sampleClient);
      });

      it('should create and retrieve client status', async () => {
        const status = await adapter.createClientStatus({
          client_id: 'test-client-001',
          is_playing: true,
          position: 30.5,
        });
        expect(status.id).toBeDefined();
        expect(status.is_playing).toBeTruthy();
      });

      it('should get latest client status', async () => {
        const first = await adapter.createClientStatus({
          client_id: 'test-client-001',
          is_playing: false,
          position: 0,
        });
        const second = await adapter.createClientStatus({
          client_id: 'test-client-001',
          is_playing: true,
          position: 45.0,
        });

        const latest = await adapter.getLatestClientStatus('test-client-001');
        expect(latest).not.toBeNull();
        // Latest should be the second one (higher id)
        expect(latest!.id).toBe(second.id);
      });

      it('should return null for client with no status', async () => {
        const result = await adapter.getLatestClientStatus('test-client-001');
        expect(result).toBeNull();
      });

      it('should get client with status', async () => {
        await adapter.createClientStatus({
          client_id: 'test-client-001',
          is_playing: true,
          position: 10,
        });

        const withStatus = await adapter.getClientWithStatus('test-client-001');
        expect(withStatus).not.toBeNull();
        expect(withStatus!.name).toBe('Test Client');
        expect(withStatus!.current_status).not.toBeNull();
        expect(withStatus!.current_status!.position).toBe(10);
      });

      it('should return null for non-existent client with status', async () => {
        const result = await adapter.getClientWithStatus('nonexistent');
        expect(result).toBeNull();
      });
    });

    // ── Client Telemetry ─────────────────────────────────────────────────

    describe('Client telemetry operations', () => {
      const sampleTelemetry: CreateClientTelemetryInput = {
        client_id: 'test-client-001',
        cpu_pct: 12.5,
        mem_used_mb: 512,
        mem_total_mb: 2048,
        disks: [{ mount: '/', used_bytes: 1000, total_bytes: 10000 }],
        temps: [{ label: 'cpu', celsius: 45 }],
        net: { ws_reconnects: 0, last_rtt_ms: 12, bytes_dl_total: 1024 },
        mpv: { alive: true, dropped_frames: 0, last_decoder_error: null },
        process: { client_uptime_s: 60, mpv_uptime_s: 30, restart_count: 0 },
      };

      beforeEach(async () => {
        await adapter.createClient(sampleClient);
      });

      it('should return rows recorded within the same calendar day for a 1h range', async () => {
        // Regression: SQLite's CURRENT_TIMESTAMP writes "YYYY-MM-DD HH:MM:SS".
        // Filtering with `new Date().toISOString()` (with `T`/`Z`) sorts above
        // same-day stored values lexicographically and returns zero rows.
        await adapter.recordClientTelemetry(sampleTelemetry);

        const now = Date.now();
        const rows = await adapter.getClientTelemetryRange(
          'test-client-001',
          now - 3_600_000,
          now + 60_000,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].cpu_pct).toBe(12.5);
      });
    });
  });
}
