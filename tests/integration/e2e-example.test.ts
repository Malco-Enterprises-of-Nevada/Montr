/**
 * Example E2E Integration Test
 *
 * This is a sample test demonstrating how to use the E2E test helpers.
 * This file serves as both a working test and documentation.
 */

import {
  TestServerProcess,
  TestClientProcess,
  waitForClientOnline,
  createCommonTestFixtures,
  createTestPlaylistWithMedia,
  assignPlaylist,
  getClient,
} from './helpers';

describe('E2E: Example Test Suite', () => {
  let server: TestServerProcess;

  // Start server once for all tests in this suite
  beforeAll(async () => {
    // Use port 3010 for this test suite to avoid conflicts
    server = new TestServerProcess({ port: 3010 });
    await server.start();
    await server.waitUntilReady();

    console.log(`Server started at: ${server.getUrl()}`);
  }, 30000);

  // Stop server after all tests complete
  afterAll(async () => {
    await server.stop();
    console.log('Server stopped');
  });

  it('should demonstrate basic client registration', async () => {
    // Create a client instance
    const client = new TestClientProcess({
      clientName: 'Example Test Client',
    });

    try {
      // Start the client
      await client.start(server.getUrl());

      // Wait for client to come online
      await waitForClientOnline(server.getUrl(), client.getClientId(), {
        timeout: 15000,
      });

      // Verify client is registered
      const clientData = await getClient(server.getUrl(), client.getClientId());
      expect(clientData.id).toBe(client.getClientId());
      expect(clientData.name).toBe('Example Test Client');
      expect(clientData.status).toBe('online');

      console.log(`Client registered: ${clientData.id}`);
    } finally {
      // Always cleanup
      await client.stop();
    }
  }, 20000);

  it('should demonstrate playlist assignment', async () => {
    const client = new TestClientProcess({
      clientName: 'Playlist Test Client',
    });

    try {
      // Start client
      await client.start(server.getUrl());
      await waitForClientOnline(server.getUrl(), client.getClientId());

      // Create test fixtures (video and image files)
      const { videoPath, imagePath } = createCommonTestFixtures();

      // Create a playlist with media
      const { playlistId, mediaIds } = await createTestPlaylistWithMedia(
        server.getUrl(),
        'Example Test Playlist',
        [videoPath, imagePath]
      );

      console.log(`Created playlist ${playlistId} with ${mediaIds.length} media items`);

      // Assign playlist to client
      await assignPlaylist(server.getUrl(), client.getClientId(), playlistId);

      // Verify assignment
      const clientData = await getClient(server.getUrl(), client.getClientId());
      expect(clientData.assignedPlaylistId).toBe(playlistId);

      console.log(`Playlist ${playlistId} assigned to client ${client.getClientId()}`);
    } finally {
      await client.stop();
    }
  }, 30000);

  it('should demonstrate multiple clients', async () => {
    const client1 = new TestClientProcess({ clientName: 'Multi Client 1' });
    const client2 = new TestClientProcess({ clientName: 'Multi Client 2' });

    try {
      // Start both clients
      await Promise.all([
        client1.start(server.getUrl()),
        client2.start(server.getUrl()),
      ]);

      // Wait for both to come online
      await Promise.all([
        waitForClientOnline(server.getUrl(), client1.getClientId()),
        waitForClientOnline(server.getUrl(), client2.getClientId()),
      ]);

      // Verify both are registered
      const client1Data = await getClient(server.getUrl(), client1.getClientId());
      const client2Data = await getClient(server.getUrl(), client2.getClientId());

      expect(client1Data.status).toBe('online');
      expect(client2Data.status).toBe('online');

      console.log(`Two clients registered: ${client1.getClientId()}, ${client2.getClientId()}`);
    } finally {
      await Promise.all([client1.stop(), client2.stop()]);
    }
  }, 30000);
});
