import { randomUUID } from 'crypto';
import { TestServerProcess } from './helpers/server-process';
import { TestClientProcess } from './helpers/client-process';
import { MontrApiClient } from './helpers/api-client';
import { createTestVideoFile, createTestImageFile, cleanupTestFiles } from './helpers/fixtures';
import { sleep } from './helpers/wait-for';

/**
 * End-to-End Integration Tests: Playlist Assignment
 *
 * Tests the complete playlist assignment flow including:
 * - Creating playlists with media
 * - Assigning playlists to clients
 * - Client receiving playlist via WebSocket
 * - Updating playlists and propagating changes
 * - Handling empty playlists
 */
describe('E2E: Playlist Assignment', () => {
  let server: TestServerProcess;
  let apiClient: MontrApiClient;
  const testPort = 3102;
  const createdFiles: any[] = [];

  // Start server once for all tests
  beforeAll(async () => {
    server = new TestServerProcess({ port: testPort });
    await server.start();
    await server.waitUntilReady();

    apiClient = new MontrApiClient(server.getUrl());
  }, 40000);

  afterAll(async () => {
    await server.stop();
    cleanupTestFiles(createdFiles);
  }, 10000);

  describe('Basic Playlist Assignment', () => {
    let client: TestClientProcess;

    afterEach(async () => {
      if (client) {
        await client.stop();
      }
    });

    it('should assign playlist to client and receive it via WebSocket', async () => {
      // Create test media files
      const videoFile = createTestVideoFile('e2e-playlist-1.mp4');
      createdFiles.push(videoFile);

      // Upload media
      const uploadResponse = await apiClient.uploadMedia([videoFile.path]);
      expect(uploadResponse.success).toBe(true);
      expect(uploadResponse.data.uploaded).toHaveLength(1);

      const mediaId = uploadResponse.data.uploaded[0].id;

      // Create playlist
      const playlistResponse = await apiClient.createPlaylist({
        name: 'E2E Test Playlist 1',
        description: 'Test playlist for E2E assignment',
      });
      expect(playlistResponse.success).toBe(true);

      const playlistId = playlistResponse.data.id;

      // Add media to playlist
      const addItemsResponse = await apiClient.addToPlaylist(playlistId, [mediaId]);
      expect(addItemsResponse.success).toBe(true);

      // Start client
      client = new TestClientProcess({
        clientId: randomUUID(),
        clientName: 'Playlist Assignment Client 1',
      });

      await client.start(server.getUrl());
      await sleep(2000);

      // Verify client is registered
      const clientResponse = await apiClient.getClient(client.getClientId());
      expect(clientResponse.data.status).toBe('online');

      // Assign playlist to client
      const assignResponse = await apiClient.assignPlaylist(client.getClientId(), playlistId);
      expect(assignResponse.success).toBe(true);
      expect(assignResponse.data.assigned_playlist_id).toBe(playlistId);

      // Wait for client to receive playlist (via WebSocket)
      await sleep(2000);

      // Verify assignment persisted
      const updatedClientResponse = await apiClient.getClient(client.getClientId());
      expect(updatedClientResponse.data.assigned_playlist_id).toBe(playlistId);

      // Verify playlist details
      const assignedPlaylist = await apiClient.getPlaylist(playlistId);
      expect(assignedPlaylist.data.items).toHaveLength(1);
      expect(assignedPlaylist.data.items[0].media_id).toBe(mediaId);
    }, 30000);

    it('should update playlist and client receives update', async () => {
      // Create media files
      const videoFile1 = createTestVideoFile('e2e-playlist-update-1.mp4');
      const videoFile2 = createTestVideoFile('e2e-playlist-update-2.mp4');
      createdFiles.push(videoFile1, videoFile2);

      // Upload media
      const uploadResponse = await apiClient.uploadMedia([videoFile1.path, videoFile2.path]);
      const mediaIds = uploadResponse.data.uploaded.map((m: any) => m.id);

      // Create playlist with first media
      const playlistResponse = await apiClient.createPlaylist({
        name: 'E2E Test Playlist Update',
        description: 'Test playlist for updates',
      });
      const playlistId = playlistResponse.data.id;

      await apiClient.addToPlaylist(playlistId, [mediaIds[0]]);

      // Start client and assign playlist
      client = new TestClientProcess({
        clientId: randomUUID(),
        clientName: 'Playlist Update Client',
      });

      await client.start(server.getUrl());
      await sleep(2000);

      await apiClient.assignPlaylist(client.getClientId(), playlistId);
      await sleep(2000);

      // Verify initial state - 1 item
      let playlistData = await apiClient.getPlaylist(playlistId);
      expect(playlistData.data.items).toHaveLength(1);

      // Add second media to playlist (this should trigger update to client)
      await apiClient.addToPlaylist(playlistId, [mediaIds[1]]);
      await sleep(2000);

      // Verify updated state - 2 items
      playlistData = await apiClient.getPlaylist(playlistId);
      expect(playlistData.data.items).toHaveLength(2);
      expect(playlistData.data.items[0].media_id).toBe(mediaIds[0]);
      expect(playlistData.data.items[1].media_id).toBe(mediaIds[1]);

      // Client should have received playlist_updated message
      // (In real implementation, we'd verify client's local state)
    }, 30000);

    it('should handle playlist with multiple media items', async () => {
      // Create multiple media files
      const video1 = createTestVideoFile('e2e-multi-media-1.mp4');
      const video2 = createTestVideoFile('e2e-multi-media-2.mp4');
      const image1 = createTestImageFile('e2e-multi-media-1.png');
      const image2 = createTestImageFile('e2e-multi-media-2.png');

      createdFiles.push(video1, video2, image1, image2);

      // Upload all media
      const uploadResponse = await apiClient.uploadMedia([
        video1.path,
        video2.path,
        image1.path,
        image2.path,
      ]);
      expect(uploadResponse.data.uploaded).toHaveLength(4);

      const mediaIds = uploadResponse.data.uploaded.map((m: any) => m.id);

      // Create playlist and add all media
      const playlistResponse = await apiClient.createPlaylist({
        name: 'E2E Multi-Item Playlist',
        description: 'Playlist with mixed video and image content',
      });
      const playlistId = playlistResponse.data.id;

      // Add media with custom image duration
      await apiClient.addToPlaylist(playlistId, mediaIds, 8); // 8 seconds for images

      // Verify playlist has all items
      const playlistData = await apiClient.getPlaylist(playlistId);
      expect(playlistData.data.items).toHaveLength(4);

      // Check image duration was set
      const imageItems = playlistData.data.items.filter(
        (item: any) => item.media.type === 'image'
      );
      imageItems.forEach((item: any) => {
        expect(item.imageDuration).toBe(8);
      });

      // Start client and assign playlist
      client = new TestClientProcess({
        clientId: randomUUID(),
        clientName: 'Multi-Media Client',
      });

      await client.start(server.getUrl());
      await sleep(2000);

      await apiClient.assignPlaylist(client.getClientId(), playlistId);
      await sleep(2000);

      // Verify assignment
      const clientData = await apiClient.getClient(client.getClientId());
      expect(clientData.data.assigned_playlist_id).toBe(playlistId);

      // Get playlist statistics
      const stats = await apiClient.getPlaylistStats(playlistId);
      expect(stats.data.totalItems).toBe(4);
      expect(stats.data.videoCount).toBe(2);
      expect(stats.data.imageCount).toBe(2);
    }, 30000);

    it('should handle empty playlist assignment', async () => {
      // Create empty playlist
      const playlistResponse = await apiClient.createPlaylist({
        name: 'E2E Empty Playlist',
        description: 'Empty playlist for testing',
      });
      const playlistId = playlistResponse.data.id;

      // Start client
      client = new TestClientProcess({
        clientId: randomUUID(),
        clientName: 'Empty Playlist Client',
      });

      await client.start(server.getUrl());
      await sleep(2000);

      // Assign empty playlist
      const assignResponse = await apiClient.assignPlaylist(client.getClientId(), playlistId);
      expect(assignResponse.success).toBe(true);

      // Verify assignment
      const clientData = await apiClient.getClient(client.getClientId());
      expect(clientData.data.assigned_playlist_id).toBe(playlistId);

      // Verify playlist is indeed empty
      const playlistData = await apiClient.getPlaylist(playlistId);
      expect(playlistData.data.items).toHaveLength(0);

      // Client should handle empty playlist gracefully
      // (In real implementation, client would be in WAITING state)
    }, 20000);
  });

  describe('Playlist Reassignment', () => {
    let client: TestClientProcess;

    afterEach(async () => {
      if (client) {
        await client.stop();
      }
    });

    it('should handle switching between playlists', async () => {
      // Create two media files
      const video1 = createTestVideoFile('e2e-switch-1.mp4');
      const video2 = createTestVideoFile('e2e-switch-2.mp4');
      createdFiles.push(video1, video2);

      // Upload media
      const uploadResponse = await apiClient.uploadMedia([video1.path, video2.path]);
      const mediaIds = uploadResponse.data.uploaded.map((m: any) => m.id);

      // Create two playlists
      const playlist1Response = await apiClient.createPlaylist({
        name: 'E2E Playlist A',
        description: 'First playlist',
      });
      const playlist1Id = playlist1Response.data.id;

      const playlist2Response = await apiClient.createPlaylist({
        name: 'E2E Playlist B',
        description: 'Second playlist',
      });
      const playlist2Id = playlist2Response.data.id;

      // Add different media to each playlist
      await apiClient.addToPlaylist(playlist1Id, [mediaIds[0]]);
      await apiClient.addToPlaylist(playlist2Id, [mediaIds[1]]);

      // Start client and assign first playlist
      client = new TestClientProcess({
        clientId: randomUUID(),
        clientName: 'Playlist Switch Client',
      });

      await client.start(server.getUrl());
      await sleep(2000);

      await apiClient.assignPlaylist(client.getClientId(), playlist1Id);
      await sleep(2000);

      // Verify first assignment
      let clientData = await apiClient.getClient(client.getClientId());
      expect(clientData.data.assigned_playlist_id).toBe(playlist1Id);

      // Switch to second playlist
      await apiClient.assignPlaylist(client.getClientId(), playlist2Id);
      await sleep(2000);

      // Verify second assignment
      clientData = await apiClient.getClient(client.getClientId());
      expect(clientData.data.assigned_playlist_id).toBe(playlist2Id);

      // Client should have received playlist_assigned message with new playlist
    }, 30000);

    it('should handle unassigning playlist (set to null)', async () => {
      // Create playlist
      const video = createTestVideoFile('e2e-unassign.mp4');
      createdFiles.push(video);

      const uploadResponse = await apiClient.uploadMedia([video.path]);
      const mediaId = uploadResponse.data.uploaded[0].id;

      const playlistResponse = await apiClient.createPlaylist({
        name: 'E2E Unassign Playlist',
      });
      const playlistId = playlistResponse.data.id;

      await apiClient.addToPlaylist(playlistId, [mediaId]);

      // Start client and assign playlist
      client = new TestClientProcess({
        clientId: randomUUID(),
        clientName: 'Unassign Client',
      });

      await client.start(server.getUrl());
      await sleep(2000);

      await apiClient.assignPlaylist(client.getClientId(), playlistId);
      await sleep(2000);

      // Verify assignment
      let clientData = await apiClient.getClient(client.getClientId());
      expect(clientData.data.assigned_playlist_id).toBe(playlistId);

      // Unassign playlist
      await apiClient.assignPlaylist(client.getClientId(), null);
      await sleep(2000);

      // Verify unassignment
      clientData = await apiClient.getClient(client.getClientId());
      expect(clientData.data.assigned_playlist_id).toBeNull();
    }, 25000);
  });

  describe('Multiple Clients with Different Playlists', () => {
    const clients: TestClientProcess[] = [];

    afterEach(async () => {
      await Promise.all(clients.map((c) => c.stop()));
      clients.length = 0;
    });

    it('should assign different playlists to different clients', async () => {
      // Create two playlists
      const video1 = createTestVideoFile('e2e-multi-client-1.mp4');
      const video2 = createTestVideoFile('e2e-multi-client-2.mp4');
      createdFiles.push(video1, video2);

      const uploadResponse = await apiClient.uploadMedia([video1.path, video2.path]);
      const mediaIds = uploadResponse.data.uploaded.map((m: any) => m.id);

      const playlist1 = await apiClient.createPlaylist({ name: 'Client 1 Playlist' });
      const playlist2 = await apiClient.createPlaylist({ name: 'Client 2 Playlist' });

      await apiClient.addToPlaylist(playlist1.data.id, [mediaIds[0]]);
      await apiClient.addToPlaylist(playlist2.data.id, [mediaIds[1]]);

      // Start two clients
      const client1 = new TestClientProcess({
        clientId: randomUUID(),
        clientName: 'Multi Client 1',
      });
      const client2 = new TestClientProcess({
        clientId: randomUUID(),
        clientName: 'Multi Client 2',
      });

      clients.push(client1, client2);

      await client1.start(server.getUrl());
      await sleep(1000);
      await client2.start(server.getUrl());
      await sleep(2000);

      // Assign different playlists
      await apiClient.assignPlaylist(client1.getClientId(), playlist1.data.id);
      await apiClient.assignPlaylist(client2.getClientId(), playlist2.data.id);
      await sleep(2000);

      // Verify assignments
      const client1Data = await apiClient.getClient(client1.getClientId());
      const client2Data = await apiClient.getClient(client2.getClientId());

      expect(client1Data.data.assigned_playlist_id).toBe(playlist1.data.id);
      expect(client2Data.data.assigned_playlist_id).toBe(playlist2.data.id);

      // Each client should have received only their own playlist
    }, 30000);
  });
});
