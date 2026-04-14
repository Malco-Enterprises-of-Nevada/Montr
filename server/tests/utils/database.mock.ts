/**
 * Database adapter mock utilities
 */

import { DatabaseAdapter } from '../../src/database/adapters/base.adapter';
import {
  MediaFile,
  Playlist,
  PlaylistItem,
  PlaylistWithItems,
  Client,
  ClientStatus,
  ClientWithStatus,
  PaginatedResult,
} from '../../src/database/types';

/**
 * Creates a mock database adapter with all required methods
 * Each method returns a jest mock function that can be configured in tests
 */
export const createMockDatabase = (): jest.Mocked<DatabaseAdapter> => ({
  // Connection methods
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn().mockResolvedValue(undefined),
  isConnected: jest.fn().mockReturnValue(true),

  // Media methods
  createMedia: jest.fn(),
  getMediaById: jest.fn(),
  getMediaByChecksum: jest.fn(),
  getAllMedia: jest.fn(),
  updateMedia: jest.fn(),
  deleteMedia: jest.fn(),

  // Playlist methods
  createPlaylist: jest.fn(),
  getPlaylistById: jest.fn(),
  getPlaylistWithItems: jest.fn(),
  getAllPlaylists: jest.fn(),
  updatePlaylist: jest.fn(),
  deletePlaylist: jest.fn(),

  // Playlist item methods
  addPlaylistItem: jest.fn(),
  getPlaylistItems: jest.fn(),
  getPlaylistItemById: jest.fn(),
  updatePlaylistItem: jest.fn(),
  deletePlaylistItem: jest.fn(),
  reorderPlaylistItems: jest.fn(),

  // Client methods
  createClient: jest.fn(),
  getClientById: jest.fn(),
  getAllClients: jest.fn(),
  updateClient: jest.fn(),
  deleteClient: jest.fn(),

  // Client status methods
  createClientStatus: jest.fn(),
  getLatestClientStatus: jest.fn(),
  getClientWithStatus: jest.fn(),

  // Client playlist assignment methods
  addClientPlaylist: jest.fn(),
  getClientPlaylists: jest.fn(),
  updateClientPlaylistPriority: jest.fn(),
  removeClientPlaylist: jest.fn(),

  // Client group methods
  createGroup: jest.fn(),
  getGroupById: jest.fn(),
  getAllGroups: jest.fn(),
  updateGroup: jest.fn(),
  deleteGroup: jest.fn(),
  addGroupMember: jest.fn(),
  getGroupMembers: jest.fn(),
  removeGroupMember: jest.fn(),
  getGroupsForClient: jest.fn(),

  // Schedule methods
  createSchedule: jest.fn(),
  getScheduleById: jest.fn(),
  getAllSchedules: jest.fn(),
  updateSchedule: jest.fn(),
  deleteSchedule: jest.fn(),
  getActiveSchedules: jest.fn(),

  // Analytics / playback log methods
  createPlaybackLog: jest.fn(),
  updatePlaybackLog: jest.fn(),
  getPlaybackLogs: jest.fn(),
  getPlaybackSummary: jest.fn(),
  getMediaPopularity: jest.fn(),
  getUptimeStats: jest.fn(),
  deleteOldPlaybackLogs: jest.fn(),

  // Telemetry methods
  recordClientTelemetry: jest.fn(),
  getClientTelemetryRange: jest.fn().mockResolvedValue([]),
  getClientTelemetryLatest: jest.fn().mockResolvedValue(null),
  getAllClientTelemetryLatest: jest.fn().mockResolvedValue({}),
  recordClientLogEvent: jest.fn(),
  getClientLogEvents: jest.fn().mockResolvedValue([]),
  deleteOldClientTelemetry: jest.fn().mockResolvedValue(0),
  deleteOldClientLogEvents: jest.fn().mockResolvedValue(0),

  // Notification methods
  createNotificationRule: jest.fn(),
  getNotificationRuleById: jest.fn(),
  getAllNotificationRules: jest.fn(),
  getNotificationRulesByEvent: jest.fn(),
  deleteNotificationRule: jest.fn(),
  createNotificationHistory: jest.fn(),
  getNotificationHistory: jest.fn(),

  // Approval methods
  updateMediaApproval: jest.fn(),
  createApprovalLog: jest.fn(),
  getApprovalLogs: jest.fn(),
  getPendingMedia: jest.fn(),

  // User methods
  createUser: jest.fn(),
  getUserById: jest.fn(),
  getUserByUsername: jest.fn(),
  getUserByEmail: jest.fn(),
  getAllUsers: jest.fn(),
  deleteUser: jest.fn(),
  updateUser: jest.fn(),
  updateUserPassword: jest.fn(),
  getUserCount: jest.fn().mockResolvedValue(0),

  // Migration executor
  getMigrationExecutor: jest.fn(),
} as unknown as jest.Mocked<DatabaseAdapter>);

/**
 * Helper to create a paginated result for testing
 */
export const createPaginatedResult = <T>(
  data: T[],
  page: number = 1,
  limit: number = 20
): PaginatedResult<T> => ({
  data,
  pagination: {
    page,
    limit,
    total: data.length,
    totalPages: Math.ceil(data.length / limit),
  },
});

/**
 * Mock database instance that can be shared across tests
 */
let mockDatabaseInstance: jest.Mocked<DatabaseAdapter> | null = null;

/**
 * Gets the mock database instance (creates one if it doesn't exist)
 */
export const getMockDatabase = (): jest.Mocked<DatabaseAdapter> => {
  if (!mockDatabaseInstance) {
    mockDatabaseInstance = createMockDatabase();
  }
  return mockDatabaseInstance;
};

/**
 * Resets the mock database instance
 */
export const resetMockDatabase = (): void => {
  if (mockDatabaseInstance) {
    jest.clearAllMocks();
  }
  mockDatabaseInstance = null;
};

/**
 * Sets up common mock responses for a database instance
 */
export const setupCommonMocks = (
  mockDb: jest.Mocked<DatabaseAdapter>,
  fixtures: {
    media?: MediaFile[];
    playlists?: Playlist[];
    playlistItems?: PlaylistItem[];
    playlistsWithItems?: PlaylistWithItems[];
    clients?: Client[];
    clientStatuses?: ClientStatus[];
  }
): void => {
  const { media, playlists, playlistItems, playlistsWithItems, clients, clientStatuses } = fixtures;

  // Media mocks
  if (media && media.length > 0) {
    mockDb.getMediaById.mockImplementation((id: number) =>
      Promise.resolve(media.find((m) => m.id === id) || null)
    );
    mockDb.getAllMedia.mockResolvedValue(createPaginatedResult(media));
  }

  // Playlist mocks
  if (playlists && playlists.length > 0) {
    mockDb.getPlaylistById.mockImplementation((id: number) =>
      Promise.resolve(playlists.find((p) => p.id === id) || null)
    );
    mockDb.getAllPlaylists.mockResolvedValue(playlists);
  }

  if (playlistsWithItems && playlistsWithItems.length > 0) {
    mockDb.getPlaylistWithItems.mockImplementation((id: number) =>
      Promise.resolve(playlistsWithItems.find((p) => p.id === id) || null)
    );
  }

  if (playlistItems && playlistItems.length > 0) {
    mockDb.getPlaylistItemById.mockImplementation((id: number) =>
      Promise.resolve(playlistItems.find((i) => i.id === id) || null)
    );
    mockDb.getPlaylistItems.mockImplementation((playlistId: number) =>
      Promise.resolve(playlistItems.filter((i) => i.playlist_id === playlistId))
    );
  }

  // Client mocks
  if (clients && clients.length > 0) {
    mockDb.getClientById.mockImplementation((id: string) =>
      Promise.resolve(clients.find((c) => c.id === id) || null)
    );
    mockDb.getAllClients.mockResolvedValue(clients);
  }

  if (clientStatuses && clientStatuses.length > 0) {
    mockDb.getLatestClientStatus.mockImplementation((clientId: string) =>
      Promise.resolve(
        clientStatuses
          .filter((s) => s.client_id === clientId)
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0] ||
          null
      )
    );
  }
};
