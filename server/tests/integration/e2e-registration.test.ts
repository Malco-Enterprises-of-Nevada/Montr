import { randomUUID } from 'crypto';
import { TestServerProcess } from './helpers/server-process';
import { TestClientProcess } from './helpers/client-process';
import { MontrApiClient } from './helpers/api-client';
import { waitFor, sleep } from './helpers/wait-for';

/**
 * End-to-End Integration Tests: Client Registration
 *
 * Tests the complete client registration flow including:
 * - Initial registration via WebSocket
 * - Client appearing in server's client list
 * - Disconnect and status changes
 * - Reconnection handling
 * - Heartbeat messages
 */
describe('E2E: Client Registration', () => {
  let server: TestServerProcess;
  let apiClient: MontrApiClient;
  const testPort = 3101;

  // Start server once for all tests in this suite
  beforeAll(async () => {
    server = new TestServerProcess({ port: testPort });
    await server.start();
    await server.waitUntilReady();

    apiClient = new MontrApiClient(server.getUrl());
  }, 40000);

  afterAll(async () => {
    await server.stop();
  }, 10000);

  describe('Client Registration Flow', () => {
    let client: TestClientProcess;

    afterEach(async () => {
      if (client) {
        await client.stop();
      }
    });

    it('should register client successfully', async () => {
      // Start client
      client = new TestClientProcess({
        clientId: randomUUID(),
        clientName: 'E2E Registration Test Client 1',
      });

      await client.start(server.getUrl());

      // Wait for client to register
      await sleep(3000);

      // Verify client is registered in server
      const response = await apiClient.getClient(client.getClientId());

      expect(response.success).toBe(true);
      expect(response.data).toBeDefined();
      expect(response.data.id).toBe(client.getClientId());
      expect(response.data.name).toBeDefined(); // Server auto-generates name from clientId
      expect(response.data.status).toBe('online');
      expect(response.data.last_seen).toBeDefined();

      // Verify client appears in list
      const listResponse = await apiClient.listClients({ status: 'online' });
      expect(listResponse.success).toBe(true);
      expect(listResponse.data).toBeInstanceOf(Array);

      const registeredClient = listResponse.data.find(
        (c: any) => c.id === client.getClientId()
      );
      expect(registeredClient).toBeDefined();
      expect(registeredClient.status).toBe('online');
    }, 15000);

    it('should handle client disconnect and status change to offline', async () => {
      // Start client
      client = new TestClientProcess({
        clientId: randomUUID(),
        clientName: 'E2E Registration Test Client 2',
      });

      await client.start(server.getUrl());
      await sleep(2000);

      // Verify client is online
      let response = await apiClient.getClient(client.getClientId());
      expect(response.data.status).toBe('online');

      // Stop client
      await client.stop();
      await sleep(3000); // Wait for server to detect disconnect

      // Verify client status changed to offline
      response = await apiClient.getClient(client.getClientId());
      expect(response.data.status).toBe('offline');

      // Verify offline clients list includes this client
      const listResponse = await apiClient.listClients({ status: 'offline' });
      const offlineClient = listResponse.data.find(
        (c: any) => c.id === client.getClientId()
      );
      expect(offlineClient).toBeDefined();
      expect(offlineClient.status).toBe('offline');
    }, 20000);

    it('should handle client reconnect and status change back to online', async () => {
      // Start client
      const testClientId = randomUUID();
      client = new TestClientProcess({
        clientId: testClientId,
        clientName: 'E2E Registration Test Client 3',
      });

      await client.start(server.getUrl());
      await sleep(2000);

      // Verify initially online
      let response = await apiClient.getClient(client.getClientId());
      expect(response.data.status).toBe('online');
      const firstSeenTime = new Date(response.data.last_seen);

      // Disconnect
      await client.stop();
      await sleep(3000);

      // Verify offline
      response = await apiClient.getClient(client.getClientId());
      expect(response.data.status).toBe('offline');

      // Reconnect (create new client with same ID)
      client = new TestClientProcess({
        clientId: testClientId, // Same ID
        clientName: 'E2E Registration Test Client 3 Reconnected',
      });

      await client.start(server.getUrl());
      await sleep(2000);

      // Verify back online
      response = await apiClient.getClient(client.getClientId());
      expect(response.data.status).toBe('online');

      // last_seen should be updated
      const secondSeenTime = new Date(response.data.last_seen);
      expect(secondSeenTime.getTime()).toBeGreaterThan(firstSeenTime.getTime());
    }, 25000);

    it('should send heartbeat messages and update last_seen timestamp', async () => {
      // Start client with short heartbeat interval
      client = new TestClientProcess({
        clientId: randomUUID(),
        clientName: 'E2E Registration Test Client 4',
        heartbeatInterval: 2, // 2 seconds
      });

      await client.start(server.getUrl());
      await sleep(1000);

      // Get initial last_seen
      let response = await apiClient.getClient(client.getClientId());
      const initialLastSeen = new Date(response.data.last_seen);

      // Wait for at least 2 heartbeats
      await sleep(5000);

      // Get updated last_seen
      response = await apiClient.getClient(client.getClientId());
      const updatedLastSeen = new Date(response.data.last_seen);

      // Verify last_seen was updated
      expect(updatedLastSeen.getTime()).toBeGreaterThan(initialLastSeen.getTime());

      // Verify client is still online
      expect(response.data.status).toBe('online');
    }, 15000);
  });

  describe('Multiple Clients', () => {
    const clients: TestClientProcess[] = [];

    afterEach(async () => {
      // Stop all clients
      await Promise.all(clients.map((c) => c.stop()));
      clients.length = 0;
    });

    it('should handle multiple clients registering simultaneously', async () => {
      // Start 3 clients simultaneously
      const clientPromises = [1, 2, 3].map(async (i) => {
        const client = new TestClientProcess({
          clientId: randomUUID(),
          clientName: `Multi Client ${i}`,
        });
        clients.push(client);
        await client.start(server.getUrl());
        return client;
      });

      const startedClients = await Promise.all(clientPromises);
      const startedClientIds = startedClients.map((c) => c.getClientId());

      // Wait for all clients to be registered and online in the database
      await waitFor(
        async () => {
          const listResponse = await apiClient.listClients({ status: 'online' });
          const registeredIds = listResponse.data.map((c: any) => c.id);
          return startedClientIds.every((id) => registeredIds.includes(id));
        },
        {
          timeout: 10000,
          interval: 500,
          message: 'All clients should be registered and online',
        }
      );

      // Verify all clients are registered
      const listResponse = await apiClient.listClients({ status: 'online' });

      const registeredIds = listResponse.data.map((c: any) => c.id);

      // Check that all started clients are in the registered list
      startedClientIds.forEach((clientId) => {
        expect(registeredIds).toContain(clientId);
      });

      // Verify all are online
      startedClientIds.forEach((clientId) => {
        const clientData = listResponse.data.find((c: any) => c.id === clientId);
        expect(clientData).toBeDefined();
        expect(clientData.status).toBe('online');
      });
    }, 20000);

    it('should maintain separate states for different clients', async () => {
      // Start two clients
      const client1 = new TestClientProcess({
        clientId: randomUUID(),
        clientName: 'Separate Client 1',
      });
      const client2 = new TestClientProcess({
        clientId: randomUUID(),
        clientName: 'Separate Client 2',
      });

      clients.push(client1, client2);

      await client1.start(server.getUrl());
      await sleep(2000);
      await client2.start(server.getUrl());
      await sleep(3000);

      // Both should be online
      let response1 = await apiClient.getClient(client1.getClientId());
      let response2 = await apiClient.getClient(client2.getClientId());

      expect(response1.data.status).toBe('online');
      expect(response2.data.status).toBe('online');

      // Stop only client1
      await client1.stop();
      await sleep(3000);

      // Client1 should be offline, client2 still online
      response1 = await apiClient.getClient(client1.getClientId());
      response2 = await apiClient.getClient(client2.getClientId());

      expect(response1.data.status).toBe('offline');
      expect(response2.data.status).toBe('online');
    }, 20000);
  });

  describe('Error Handling', () => {
    it('should handle invalid client ID format gracefully', async () => {
      try {
        await apiClient.getClient('invalid-client-id-not-uuid');
        fail('Should have thrown an error');
      } catch (error: any) {
        // Expect 404 or validation error
        expect(error.response?.status).toBeGreaterThanOrEqual(400);
      }
    });

    it('should return error for non-existent client', async () => {
      const nonExistentId = randomUUID(); // Use valid UUID format

      try {
        await apiClient.getClient(nonExistentId);
        fail('Should have thrown an error');
      } catch (error: any) {
        expect(error.response?.status).toBe(404);
      }
    });
  });
});
