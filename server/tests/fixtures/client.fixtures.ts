/**
 * Test fixtures for clients
 */

import {
  Client,
  ClientStatus,
  ClientWithStatus,
  CreateClientInput,
  UpdateClientInput,
  CreateClientStatusInput,
} from '../../src/database/types';

export const mockClientId = '550e8400-e29b-41d4-a716-446655440000';
export const mockClientId2 = '660e8400-e29b-41d4-a716-446655440001';

export const mockClient: Client = {
  id: mockClientId,
  name: 'Test Client 01',
  assigned_playlist_id: 1,
  status: 'online',
  last_seen: '2025-10-10T10:00:00.000Z',
  version: '1.0.0',
  capabilities: JSON.stringify({ video: true, image: true }),
  created_at: '2025-10-10T09:00:00.000Z',
  updated_at: '2025-10-10T10:00:00.000Z',
};

export const mockClient2: Client = {
  id: mockClientId2,
  name: 'Test Client 02',
  assigned_playlist_id: null,
  status: 'offline',
  last_seen: '2025-10-10T08:00:00.000Z',
  version: '1.0.0',
  capabilities: JSON.stringify({ video: true, image: true }),
  created_at: '2025-10-10T07:00:00.000Z',
  updated_at: '2025-10-10T08:00:00.000Z',
};

export const mockClients: Client[] = [mockClient, mockClient2];

export const mockClientStatus: ClientStatus = {
  id: 1,
  client_id: mockClientId,
  current_media_id: 1,
  position: 45.5,
  is_playing: true,
  error_message: null,
  timestamp: '2025-10-10T10:00:00.000Z',
};

export const mockClientStatusWithError: ClientStatus = {
  id: 2,
  client_id: mockClientId,
  current_media_id: 1,
  position: 30.0,
  is_playing: false,
  error_message: 'Failed to load media file',
  timestamp: '2025-10-10T10:05:00.000Z',
};

export const mockClientWithStatus: ClientWithStatus = {
  ...mockClient,
  current_status: mockClientStatus,
};

export const mockCreateClientInput: CreateClientInput = {
  id: mockClientId,
  name: 'Test Client 01',
  version: '1.0.0',
  capabilities: JSON.stringify({ video: true, image: true }),
};

export const mockUpdateClientInput: UpdateClientInput = {
  name: 'Updated Client Name',
  assigned_playlist_id: 2,
};

export const mockClientStatusInput: CreateClientStatusInput = {
  client_id: mockClientId,
  current_media_id: 1,
  position: 60.0,
  is_playing: true,
};

export const mockClientStatusInputWithError: CreateClientStatusInput = {
  client_id: mockClientId,
  current_media_id: 1,
  position: 30.0,
  is_playing: false,
  error_message: 'Playback error occurred',
};

// Client statistics fixtures
export const mockClientStats = {
  total: 3,
  online: 1,
  offline: 1,
  error: 1,
};
