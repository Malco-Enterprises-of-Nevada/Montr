/**
 * Integration tests for Client Routes
 */

import request from 'supertest';
import { Application } from 'express';
import MontrServer from '../../../src/index';
import { getDatabase } from '../../../src/database/connection';
import { createMockDatabase } from '../../utils/database.mock';
import { expectSuccessResponse, expectErrorResponse, expectValidationError } from '../../utils/test-helpers';
import {
  mockClient,
  mockClient2,
  mockClients,
  mockClientId,
  mockClientId2,
  mockClientStatus,
  mockClientWithStatus,
  mockCreateClientInput,
  mockUpdateClientInput,
  mockClientStatusInput,
} from '../../fixtures/client.fixtures';
import { mockPlaylist } from '../../fixtures/playlist.fixtures';

// Mock dependencies
jest.mock('../../../src/database/connection');

describe('Client Routes Integration Tests', () => {
  let app: Application;
  let mockDb: ReturnType<typeof createMockDatabase>;

  beforeAll(() => {
    const server = new MontrServer();
    app = server.getApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = createMockDatabase();
    (getDatabase as jest.Mock).mockResolvedValue(mockDb);
  });

  describe('POST /api/clients/register', () => {
    it('should register a new client successfully', async () => {
      mockDb.getClientById.mockResolvedValue(null);
      mockDb.createClient.mockResolvedValue(mockClient);

      const response = await request(app)
        .post('/api/clients/register')
        .send(mockCreateClientInput);

      const data = expectSuccessResponse(response, 201);
      expect(data).toMatchObject({
        id: mockClient.id,
        name: mockCreateClientInput.name,
      });
      expect(mockDb.createClient).toHaveBeenCalledWith(mockCreateClientInput);
    });

    it('should return 409 when client already exists', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);

      const response = await request(app)
        .post('/api/clients/register')
        .send(mockCreateClientInput);

      expectErrorResponse(response, 409, 'CLIENT_ALREADY_REGISTERED');
    });

    it('should validate required fields', async () => {
      const response = await request(app)
        .post('/api/clients/register')
        .send({});

      expectValidationError(response, ['id', 'name']);
    });

    it('should validate UUID format', async () => {
      const response = await request(app)
        .post('/api/clients/register')
        .send({ id: 'invalid-uuid', name: 'Test Client' });

      expectValidationError(response, ['id']);
    });

    it('should validate name length', async () => {
      const response = await request(app)
        .post('/api/clients/register')
        .send({ id: mockClientId, name: '' });

      expectValidationError(response);
    });
  });

  describe('GET /api/clients', () => {
    it('should return all clients', async () => {
      mockDb.getAllClients.mockResolvedValue(mockClients);

      const response = await request(app).get('/api/clients');

      const data = expectSuccessResponse(response);
      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(2);
      expect(data[0]).toHaveProperty('id');
      expect(data[0]).toHaveProperty('name');
      expect(data[0]).toHaveProperty('status');
    });

    it('should filter clients by status', async () => {
      mockDb.getAllClients.mockResolvedValue([mockClient]);

      const response = await request(app)
        .get('/api/clients')
        .query({ status: 'online' });

      const data = expectSuccessResponse(response);
      expect(data).toHaveLength(1);
      expect(mockDb.getAllClients).toHaveBeenCalledWith({ status: 'online' });
    });

    it('should filter clients by assigned_playlist_id', async () => {
      mockDb.getAllClients.mockResolvedValue([mockClient]);

      const response = await request(app)
        .get('/api/clients')
        .query({ assigned_playlist_id: 1 });

      const data = expectSuccessResponse(response);
      expect(data).toHaveLength(1);
      expect(mockDb.getAllClients).toHaveBeenCalledWith({ assigned_playlist_id: 1 });
    });

    it('should validate status filter values', async () => {
      const response = await request(app)
        .get('/api/clients')
        .query({ status: 'invalid' });

      expectValidationError(response);
    });

    it('should return empty array when no clients exist', async () => {
      mockDb.getAllClients.mockResolvedValue([]);

      const response = await request(app).get('/api/clients');

      const data = expectSuccessResponse(response);
      expect(data).toEqual([]);
    });
  });

  describe('GET /api/clients/:id', () => {
    it('should return client details by ID', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);

      const response = await request(app).get(`/api/clients/${mockClientId}`);

      const data = expectSuccessResponse(response);
      expect(data).toMatchObject({
        id: mockClientId,
        name: mockClient.name,
        status: mockClient.status,
      });
    });

    it('should return 404 when client not found', async () => {
      mockDb.getClientById.mockResolvedValue(null);

      const response = await request(app).get(`/api/clients/${mockClientId2}`);

      expectErrorResponse(response, 404, 'CLIENT_NOT_FOUND');
    });

    it('should validate UUID format', async () => {
      const response = await request(app).get('/api/clients/invalid-uuid');

      expectValidationError(response);
    });
  });

  describe('PUT /api/clients/:id', () => {
    it('should update client successfully', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.updateClient.mockResolvedValue({ ...mockClient, ...mockUpdateClientInput });

      const response = await request(app)
        .put(`/api/clients/${mockClientId}`)
        .send(mockUpdateClientInput);

      const data = expectSuccessResponse(response);
      expect(data.name).toBe(mockUpdateClientInput.name);
      expect(data.assigned_playlist_id).toBe(mockUpdateClientInput.assigned_playlist_id);
    });

    it('should update only specified fields', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.updateClient.mockResolvedValue({ ...mockClient, name: 'New Name' });

      const response = await request(app)
        .put(`/api/clients/${mockClientId}`)
        .send({ name: 'New Name' });

      const data = expectSuccessResponse(response);
      expect(data.name).toBe('New Name');
    });

    it('should allow unassigning playlist with null', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.updateClient.mockResolvedValue({ ...mockClient, assigned_playlist_id: null });

      const response = await request(app)
        .put(`/api/clients/${mockClientId}`)
        .send({ assigned_playlist_id: null });

      const data = expectSuccessResponse(response);
      expect(data.assigned_playlist_id).toBeNull();
    });

    it('should return 404 when client not found', async () => {
      mockDb.getClientById.mockResolvedValue(null);

      const response = await request(app)
        .put(`/api/clients/${mockClientId}`)
        .send(mockUpdateClientInput);

      expectErrorResponse(response, 404, 'CLIENT_NOT_FOUND');
    });

    it('should return 404 when assigning non-existent playlist', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.getPlaylistById.mockResolvedValue(null);

      const response = await request(app)
        .put(`/api/clients/${mockClientId}`)
        .send({ assigned_playlist_id: 999 });

      expectErrorResponse(response, 404, 'PLAYLIST_NOT_FOUND');
    });

    it('should validate UUID format', async () => {
      const response = await request(app)
        .put('/api/clients/invalid-uuid')
        .send(mockUpdateClientInput);

      expectValidationError(response);
    });

    it('should validate name length', async () => {
      const response = await request(app)
        .put(`/api/clients/${mockClientId}`)
        .send({ name: '' });

      expectValidationError(response);
    });
  });

  describe('DELETE /api/clients/:id', () => {
    it('should unregister client successfully', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.deleteClient.mockResolvedValue(undefined);

      const response = await request(app).delete(`/api/clients/${mockClientId}`);

      const data = expectSuccessResponse(response);
      expect(data).toHaveProperty('message');
      expect(data.id).toBe(mockClientId);
      expect(mockDb.deleteClient).toHaveBeenCalledWith(mockClientId);
    });

    it('should return 404 when client not found', async () => {
      mockDb.getClientById.mockResolvedValue(null);

      const response = await request(app).delete(`/api/clients/${mockClientId}`);

      expectErrorResponse(response, 404, 'CLIENT_NOT_FOUND');
    });

    it('should validate UUID format', async () => {
      const response = await request(app).delete('/api/clients/invalid-uuid');

      expectValidationError(response);
    });
  });

  describe('GET /api/clients/:id/status', () => {
    it('should return client with current status', async () => {
      mockDb.getClientWithStatus.mockResolvedValue(mockClientWithStatus);

      const response = await request(app).get(`/api/clients/${mockClientId}/status`);

      const data = expectSuccessResponse(response);
      expect(data).toHaveProperty('id', mockClientId);
      expect(data).toHaveProperty('current_status');
      expect(data.current_status).toHaveProperty('is_playing');
      expect(data.current_status).toHaveProperty('current_media_id');
    });

    it('should return 404 when client not found', async () => {
      mockDb.getClientWithStatus.mockResolvedValue(null);

      const response = await request(app).get(`/api/clients/${mockClientId}/status`);

      expectErrorResponse(response, 404, 'CLIENT_NOT_FOUND');
    });

    it('should validate UUID format', async () => {
      const response = await request(app).get('/api/clients/invalid-uuid/status');

      expectValidationError(response);
    });
  });

  describe('POST /api/clients/:id/status', () => {
    it('should record client status successfully', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.createClientStatus.mockResolvedValue(mockClientStatus);
      mockDb.updateClient.mockResolvedValue({ ...mockClient, last_seen: expect.any(String) as string });

      const response = await request(app)
        .post(`/api/clients/${mockClientId}/status`)
        .send(mockClientStatusInput);

      const data = expectSuccessResponse(response, 201);
      expect(data).toHaveProperty('client_id', mockClientId);
      expect(data).toHaveProperty('is_playing', true);
      expect(mockDb.createClientStatus).toHaveBeenCalled();
    });

    it('should record status with error message', async () => {
      mockDb.getClientById.mockResolvedValue(mockClient);
      mockDb.createClientStatus.mockResolvedValue({
        ...mockClientStatus,
        error_message: 'Test error',
      });
      mockDb.updateClient.mockResolvedValue({ ...mockClient, last_seen: expect.any(String) as string });

      const response = await request(app)
        .post(`/api/clients/${mockClientId}/status`)
        .send({
          ...mockClientStatusInput,
          error_message: 'Test error',
        });

      const data = expectSuccessResponse(response, 201);
      expect(data).toHaveProperty('error_message', 'Test error');
    });

    it('should return 404 when client not found', async () => {
      mockDb.getClientById.mockResolvedValue(null);

      const response = await request(app)
        .post(`/api/clients/${mockClientId}/status`)
        .send(mockClientStatusInput);

      expectErrorResponse(response, 404, 'CLIENT_NOT_FOUND');
    });

    it('should validate required fields', async () => {
      const response = await request(app)
        .post(`/api/clients/${mockClientId}/status`)
        .send({});

      expectValidationError(response, ['is_playing']);
    });

    it('should validate position is non-negative', async () => {
      const response = await request(app)
        .post(`/api/clients/${mockClientId}/status`)
        .send({ is_playing: true, position: -1 });

      expectValidationError(response);
    });

    it('should validate UUID format', async () => {
      const response = await request(app)
        .post('/api/clients/invalid-uuid/status')
        .send(mockClientStatusInput);

      expectValidationError(response);
    });
  });

  describe('POST /api/clients/:id/heartbeat', () => {
    it('should update client heartbeat successfully', async () => {
      mockDb.updateClient.mockResolvedValue({
        ...mockClient,
        status: 'online',
        last_seen: expect.any(String) as string
      });

      const response = await request(app)
        .post(`/api/clients/${mockClientId}/heartbeat`);

      const data = expectSuccessResponse(response);
      expect(data).toHaveProperty('message', 'Heartbeat recorded');
      expect(data).toHaveProperty('timestamp');
      expect(mockDb.updateClient).toHaveBeenCalledWith(
        mockClientId,
        expect.objectContaining({
          status: 'online',
          last_seen: expect.any(String),
        })
      );
    });

    it('should validate UUID format', async () => {
      const response = await request(app)
        .post('/api/clients/invalid-uuid/heartbeat');

      expectValidationError(response);
    });
  });
});
