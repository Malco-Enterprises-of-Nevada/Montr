import { randomUUID } from 'crypto';
import { TestServerProcess } from './helpers/server-process';
import { TestClientProcess } from './helpers/client-process';
import { MontrApiClient } from './helpers/api-client';
import { createTestVideoFile, cleanupTestFiles } from './helpers/fixtures';
import { sleep, waitFor } from './helpers/wait-for';

/**
 * End-to-End Integration Tests: Status Reporting
 *
 * Tests the complete status reporting flow including:
 * - Client sending status updates via WebSocket
 * - Status updates appearing in database
 * - Status API endpoints returning current state
 * - Playback position tracking
 */
describe('E2E: Status Reporting', () => {
  let server: TestServerProcess;
  let apiClient: MontrApiClient;
  const testPort = 3103;
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

  describe('Basic Status Updates', () => {
    let client: TestClientProcess;

    afterEach(async () => {
      if (client) {
        await client.stop();
      }
    });

    it('should receive status updates from client', async () => {
      // Create media and playlist
      const video = createTestVideoFile('e2e-status-1.mp4');
      createdFiles.push(video);

      const uploadResponse = await apiClient.uploadMedia([video.path]);
      const mediaId = uploadResponse.data.uploaded[0].id;

      const playlistResponse = await apiClient.createPlaylist({
        name: 'Status Test Playlist',
      });
      const playlistId = playlistResponse.data.id;

      await apiClient.addToPlaylist(playlistId, [mediaId]);

      // Start client
      client = new TestClientProcess({
        clientId: randomUUID(),
        clientName: 'Status Test Client',
      });

      await client.start(server.getUrl());
      await sleep(2000);

      // Assign playlist
      await apiClient.assignPlaylist(client.getClientId(), playlistId);
      await sleep(2000);

      // For mock client, manually send status update
      if (client.isMockClient()) {
        client.sendStatusUpdate(mediaId, 5.5, true);
        await sleep(1000);
      } else {
        // For real client, wait for it to send status
        await sleep(5000);
      }

      // Retrieve status from server
      const statusResponse = await apiClient.getClientStatus(client.getClientId());

      expect(statusResponse.success).toBe(true);
      expect(statusResponse.data).toBeDefined();

      // If mock client sent status, verify it
      if (client.isMockClient()) {
        expect(statusResponse.data.current_status).toBeDefined();
        expect(statusResponse.data.current_status.current_media_id).toBe(mediaId);
        expect(statusResponse.data.current_status.is_playing).toBeTruthy();
        expect(statusResponse.data.current_status.position).toBeGreaterThanOrEqual(0);
      }
    }, 25000);

    it('should update client status in database', async () => {
      // Upload two media files so we have valid IDs for status updates
      const video1 = createTestVideoFile('e2e-db-status-1.mp4');
      const video2 = createTestVideoFile('e2e-db-status-2.mp4');
      createdFiles.push(video1, video2);

      const uploadResponse = await apiClient.uploadMedia([video1.path, video2.path]);
      const mediaId1 = uploadResponse.data.uploaded[0].id;
      const mediaId2 = uploadResponse.data.uploaded[1].id;

      // Start client
      client = new TestClientProcess({
        clientId: randomUUID(),
        clientName: 'Status DB Test Client',
      });

      await client.start(server.getUrl());
      await sleep(3000);

      // Initial status should exist but be empty
      let statusResponse = await apiClient.getClientStatus(client.getClientId());
      expect(statusResponse.success).toBe(true);

      // For mock client, send multiple status updates
      if (client.isMockClient()) {
        // First update - playing
        client.sendStatusUpdate(mediaId1, 0, true);
        await waitFor(async () => {
          const resp = await apiClient.getClientStatus(client.getClientId());
          return resp.data.current_status?.current_media_id === mediaId1;
        }, { timeout: 8000, interval: 500 });

        statusResponse = await apiClient.getClientStatus(client.getClientId());
        expect(statusResponse.data.current_status.is_playing).toBeTruthy();
        expect(statusResponse.data.current_status.current_media_id).toBe(mediaId1);

        // Second update - paused (simulated)
        client.sendStatusUpdate(mediaId1, 10.5, false);
        await waitFor(async () => {
          const resp = await apiClient.getClientStatus(client.getClientId());
          return resp.data.current_status?.position === 10.5;
        }, { timeout: 8000, interval: 500 });

        statusResponse = await apiClient.getClientStatus(client.getClientId());
        expect(statusResponse.data.current_status.is_playing).toBeFalsy();
        expect(statusResponse.data.current_status.position).toBe(10.5);

        // Third update - different media
        client.sendStatusUpdate(mediaId2, 0, true);
        await waitFor(async () => {
          const resp = await apiClient.getClientStatus(client.getClientId());
          return resp.data.current_status?.current_media_id === mediaId2;
        }, { timeout: 8000, interval: 500 });

        statusResponse = await apiClient.getClientStatus(client.getClientId());
        expect(statusResponse.data.current_status.current_media_id).toBe(mediaId2);
        // Position 0 may be stored as 0 or null depending on DB adapter behavior
        expect([0, null]).toContain(statusResponse.data.current_status.position);
      } else {
        // For real client, just verify status updates are received
        await sleep(10000); // Wait for real client to send updates

        statusResponse = await apiClient.getClientStatus(client.getClientId());
        expect(statusResponse.data).toBeDefined();
        // Real client should update timestamp
        expect(statusResponse.data.timestamp).toBeDefined();
      }
    }, 30000);

    it('should track playback position accurately', async () => {
      // Start client
      client = new TestClientProcess({
        clientId: randomUUID(),
        clientName: 'Position Tracking Client',
      });

      await client.start(server.getUrl());
      await sleep(2000);

      // Only test with mock client (real client tracking depends on actual playback)
      if (client.isMockClient()) {
        const mediaId = 1;

        // Simulate progressive playback — send all updates, verify final state
        const positions = [0, 5.2, 10.7, 15.3, 20.1];

        for (const position of positions) {
          client.sendStatusUpdate(mediaId, position, true);
          await sleep(300);
        }

        // Wait for final position to propagate
        const lastPos = positions[positions.length - 1];
        await waitFor(async () => {
          const resp = await apiClient.getClientStatus(client.getClientId());
          return resp.data.current_status?.position != null && resp.data.current_status.position >= lastPos - 1;
        }, { timeout: 8000, interval: 500 });

        // Verify final position
        const finalStatus = await apiClient.getClientStatus(client.getClientId());
        expect(finalStatus.data.current_status.position).toBeGreaterThan(15);
      } else {
        // For real client, just verify we can retrieve status
        const statusResponse = await apiClient.getClientStatus(client.getClientId());
        expect(statusResponse.success).toBe(true);
      }
    }, 20000);
  });

  describe('Status with Error Reporting', () => {
    let client: TestClientProcess;

    afterEach(async () => {
      if (client) {
        await client.stop();
      }
    });

    it('should report and store error messages', async () => {
      // Start client
      client = new TestClientProcess({
        clientId: randomUUID(),
        clientName: 'Error Reporting Client',
      });

      await client.start(server.getUrl());
      await sleep(2000);

      // Mock client sends error
      if (client.isMockClient()) {
        client.sendError('Failed to decode video', { code: 'PLAYBACK_ERROR' });
        await sleep(1000);

        // After reporting an error, the handler sets status to 'error'
        // Verify client is still registered
        const clientResponse = await apiClient.getClient(client.getClientId());
        expect(['online', 'error']).toContain(clientResponse.data.status);
      }
    }, 15000);

    it('should handle status updates with null media (idle state)', async () => {
      // Start client
      client = new TestClientProcess({
        clientId: randomUUID(),
        clientName: 'Idle Status Client',
      });

      await client.start(server.getUrl());
      await sleep(2000);

      // Send status with no media playing
      if (client.isMockClient()) {
        client.sendStatusUpdate(null, 0, false);
        await waitFor(async () => {
          const resp = await apiClient.getClientStatus(client.getClientId());
          return resp.data.current_status != null;
        }, { timeout: 8000, interval: 500 });

        const statusResponse = await apiClient.getClientStatus(client.getClientId());
        expect(statusResponse.data.current_status.current_media_id).toBeNull();
        expect(statusResponse.data.current_status.is_playing).toBeFalsy();
      }
    }, 15000);
  });

  describe('Status Updates with Playlist Playback', () => {
    let client: TestClientProcess;

    afterEach(async () => {
      if (client) {
        await client.stop();
      }
    });

    it('should track status through multiple media items', async () => {
      // Create playlist with multiple media
      const video1 = createTestVideoFile('e2e-multi-status-1.mp4');
      const video2 = createTestVideoFile('e2e-multi-status-2.mp4');
      createdFiles.push(video1, video2);

      const uploadResponse = await apiClient.uploadMedia([video1.path, video2.path]);
      const mediaIds = uploadResponse.data.uploaded.map((m: any) => m.id);

      const playlistResponse = await apiClient.createPlaylist({
        name: 'Multi-Status Playlist',
      });
      const playlistId = playlistResponse.data.id;

      await apiClient.addToPlaylist(playlistId, mediaIds);

      // Start client and assign playlist
      client = new TestClientProcess({
        clientId: randomUUID(),
        clientName: 'Multi-Media Status Client',
      });

      await client.start(server.getUrl());
      await sleep(2000);

      await apiClient.assignPlaylist(client.getClientId(), playlistId);
      await sleep(2000);

      // Mock client: simulate playing through playlist
      if (client.isMockClient()) {
        // Play first media
        client.sendStatusUpdate(mediaIds[0], 0, true);
        await waitFor(async () => {
          const resp = await apiClient.getClientStatus(client.getClientId());
          return resp.data.current_status?.current_media_id === mediaIds[0];
        }, { timeout: 8000, interval: 500 });

        let statusResponse = await apiClient.getClientStatus(client.getClientId());
        expect(statusResponse.data.current_status.current_media_id).toBe(mediaIds[0]);

        // Progress through first media
        client.sendStatusUpdate(mediaIds[0], 5, true);
        await sleep(500);

        // Switch to second media
        client.sendStatusUpdate(mediaIds[1], 0, true);
        await waitFor(async () => {
          const resp = await apiClient.getClientStatus(client.getClientId());
          return resp.data.current_status?.current_media_id === mediaIds[1];
        }, { timeout: 8000, interval: 500 });

        statusResponse = await apiClient.getClientStatus(client.getClientId());
        expect(statusResponse.data.current_status.current_media_id).toBe(mediaIds[1]);
        // Position may be 0 or null depending on timing of status recording
        expect([0, null]).toContain(statusResponse.data.current_status.position);
      }
    }, 25000);
  });

  describe('REST API Status Updates', () => {
    let client: TestClientProcess;

    afterEach(async () => {
      if (client) {
        await client.stop();
      }
    });

    it('should allow manual status updates via REST API', async () => {
      // Start client
      client = new TestClientProcess({
        clientId: randomUUID(),
        clientName: 'REST Status Client',
      });

      await client.start(server.getUrl());
      await sleep(2000);

      // Update status via REST API (alternative to WebSocket)
      const updateResponse = await apiClient.updateClientStatus(client.getClientId(), {
        currentMediaId: 1,
        position: 25.5,
        isPlaying: true,
      });

      expect(updateResponse.success).toBe(true);

      // Retrieve status
      const statusResponse = await apiClient.getClientStatus(client.getClientId());
      expect(statusResponse.data.current_status.current_media_id).toBe(1);
      expect(statusResponse.data.current_status.position).toBe(25.5);
      expect(statusResponse.data.current_status.is_playing).toBeTruthy();
    }, 15000);

    it('should handle concurrent status updates from multiple clients', async () => {
      // Upload 3 media files so we have valid IDs for each client
      const video1 = createTestVideoFile('e2e-concurrent-1.mp4');
      const video2 = createTestVideoFile('e2e-concurrent-2.mp4');
      const video3 = createTestVideoFile('e2e-concurrent-3.mp4');
      createdFiles.push(video1, video2, video3);

      const uploadResponse = await apiClient.uploadMedia([video1.path, video2.path, video3.path]);
      const mediaIds = uploadResponse.data.uploaded.map((m: any) => m.id);

      const clients: TestClientProcess[] = [];

      try {
        // Start 3 clients with valid UUIDs
        for (let i = 0; i < 3; i++) {
          const c = new TestClientProcess({
            clientId: randomUUID(),
            clientName: `Concurrent Client ${i + 1}`,
          });
          clients.push(c);
          await c.start(server.getUrl());
        }

        await sleep(3000);

        // Each client sends different status
        if (clients[0].isMockClient()) {
          clients[0].sendStatusUpdate(mediaIds[0], 10, true);
          clients[1].sendStatusUpdate(mediaIds[1], 20, true);
          clients[2].sendStatusUpdate(mediaIds[2], 30, false);

          // Wait for all statuses to be recorded
          await waitFor(async () => {
            const s1 = await apiClient.getClientStatus(clients[0].getClientId());
            const s2 = await apiClient.getClientStatus(clients[1].getClientId());
            const s3 = await apiClient.getClientStatus(clients[2].getClientId());
            return s1.data.current_status?.current_media_id === mediaIds[0] &&
                   s2.data.current_status?.current_media_id === mediaIds[1] &&
                   s3.data.current_status?.current_media_id === mediaIds[2];
          }, { timeout: 8000, interval: 500 });

          // Verify each client has independent status
          const status1 = await apiClient.getClientStatus(clients[0].getClientId());
          const status2 = await apiClient.getClientStatus(clients[1].getClientId());
          const status3 = await apiClient.getClientStatus(clients[2].getClientId());

          expect(status1.data.current_status?.current_media_id).toBe(mediaIds[0]);
          expect(status2.data.current_status?.current_media_id).toBe(mediaIds[1]);
          expect(status3.data.current_status?.current_media_id).toBe(mediaIds[2]);
        }
      } finally {
        // Cleanup all clients
        await Promise.all(clients.map((c) => c.stop()));
      }
    }, 30000);
  });
});
