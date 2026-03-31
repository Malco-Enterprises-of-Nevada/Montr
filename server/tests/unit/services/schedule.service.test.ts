/**
 * Schedule Service Tests
 */

import { ScheduleService } from '../../../src/services/schedule.service';
import { getDatabase } from '../../../src/database/connection';
import { AppError } from '../../../src/api/middleware/error-handler';
import { DatabaseAdapter } from '../../../src/database/adapters/base.adapter';
import { Schedule } from '../../../src/database/types';

// Mock the database connection
jest.mock('../../../src/database/connection');

// Mock WebSocket handlers
jest.mock('../../../src/websocket/handlers', () => ({
  sendPlaylistToClient: jest.fn().mockResolvedValue(undefined),
  sendPlaylistToGroup: jest.fn().mockResolvedValue(0),
}));

jest.mock('../../../src/websocket/client-manager', () => ({
  clientConnectionManager: {
    isConnected: jest.fn().mockReturnValue(true),
  },
}));

const mockDb: jest.Mocked<DatabaseAdapter> = {
  connect: jest.fn(),
  disconnect: jest.fn(),
  isConnected: jest.fn(),
  createMedia: jest.fn(),
  getMediaById: jest.fn(),
  getAllMedia: jest.fn(),
  updateMedia: jest.fn(),
  deleteMedia: jest.fn(),
  getMediaByChecksum: jest.fn(),
  createPlaylist: jest.fn(),
  getPlaylistById: jest.fn(),
  getPlaylistWithItems: jest.fn(),
  getAllPlaylists: jest.fn(),
  updatePlaylist: jest.fn(),
  deletePlaylist: jest.fn(),
  addPlaylistItem: jest.fn(),
  getPlaylistItems: jest.fn(),
  getPlaylistItemById: jest.fn(),
  updatePlaylistItem: jest.fn(),
  deletePlaylistItem: jest.fn(),
  reorderPlaylistItems: jest.fn(),
  createClient: jest.fn(),
  getClientById: jest.fn(),
  getAllClients: jest.fn(),
  updateClient: jest.fn(),
  deleteClient: jest.fn(),
  createClientStatus: jest.fn(),
  getLatestClientStatus: jest.fn(),
  getClientWithStatus: jest.fn(),
  createClientGroup: jest.fn(),
  getClientGroupById: jest.fn(),
  getClientGroupWithMembers: jest.fn(),
  getAllClientGroups: jest.fn(),
  updateClientGroup: jest.fn(),
  deleteClientGroup: jest.fn(),
  addClientToGroup: jest.fn(),
  removeClientFromGroup: jest.fn(),
  getGroupMembers: jest.fn(),
  getClientGroups: jest.fn(),
  createSchedule: jest.fn(),
  getScheduleById: jest.fn(),
  getAllSchedules: jest.fn(),
  updateSchedule: jest.fn(),
  deleteSchedule: jest.fn(),
  getEnabledSchedules: jest.fn(),
};

const scheduleService = new ScheduleService();

const mockSchedule: Schedule = {
  id: 1,
  name: 'Morning Playlist',
  playlist_id: 1,
  client_id: null,
  group_id: null,
  start_time: '09:00',
  end_time: '17:00',
  days_of_week: '1,2,3,4,5',
  priority: 50,
  enabled: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const mockPlaylist = {
  id: 1,
  name: 'Test Playlist',
  description: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

describe('ScheduleService', () => {
  beforeEach(() => {
    (getDatabase as jest.Mock).mockResolvedValue(mockDb);
  });

  describe('createSchedule', () => {
    it('should create a schedule', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.createSchedule.mockResolvedValue(mockSchedule);

      const result = await scheduleService.createSchedule({
        name: 'Morning Playlist',
        playlist_id: 1,
        start_time: '09:00',
        end_time: '17:00',
        days_of_week: '1,2,3,4,5',
      });

      expect(result).toEqual(mockSchedule);
    });

    it('should throw if playlist not found', async () => {
      mockDb.getPlaylistById.mockResolvedValue(null);

      await expect(
        scheduleService.createSchedule({
          name: 'Test',
          playlist_id: 999,
          start_time: '09:00',
        }),
      ).rejects.toThrow(AppError);
    });

    it('should throw if client not found', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getClientById.mockResolvedValue(null);

      await expect(
        scheduleService.createSchedule({
          name: 'Test',
          playlist_id: 1,
          start_time: '09:00',
          client_id: 'nonexistent',
        }),
      ).rejects.toThrow(AppError);
    });
  });

  describe('getScheduleById', () => {
    it('should return a schedule', async () => {
      mockDb.getScheduleById.mockResolvedValue(mockSchedule);
      const result = await scheduleService.getScheduleById(1);
      expect(result).toEqual(mockSchedule);
    });

    it('should throw if not found', async () => {
      mockDb.getScheduleById.mockResolvedValue(null);
      await expect(scheduleService.getScheduleById(999)).rejects.toThrow(AppError);
    });
  });

  describe('getAllSchedules', () => {
    it('should return all schedules', async () => {
      mockDb.getAllSchedules.mockResolvedValue([mockSchedule]);
      const result = await scheduleService.getAllSchedules();
      expect(result).toHaveLength(1);
    });
  });

  describe('updateSchedule', () => {
    it('should update a schedule', async () => {
      mockDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockDb.updateSchedule.mockResolvedValue({ ...mockSchedule, name: 'Updated' });

      const result = await scheduleService.updateSchedule(1, { name: 'Updated' });
      expect(result.name).toBe('Updated');
    });
  });

  describe('deleteSchedule', () => {
    it('should delete a schedule', async () => {
      mockDb.getScheduleById.mockResolvedValue(mockSchedule);
      mockDb.deleteSchedule.mockResolvedValue();

      await expect(scheduleService.deleteSchedule(1)).resolves.toBeUndefined();
    });
  });

  describe('isScheduleActive', () => {
    it('should return true when within time window and correct day', () => {
      // Wednesday at 10:00 AM
      const now = new Date('2026-01-07T10:00:00');
      const result = scheduleService.isScheduleActive(mockSchedule, now);
      expect(result).toBe(true);
    });

    it('should return false when outside time window', () => {
      // Wednesday at 18:00 (after end_time 17:00)
      const now = new Date('2026-01-07T18:00:00');
      const result = scheduleService.isScheduleActive(mockSchedule, now);
      expect(result).toBe(false);
    });

    it('should return false on wrong day', () => {
      // Sunday at 10:00 (not in days_of_week 1,2,3,4,5)
      const now = new Date('2026-01-04T10:00:00');
      const result = scheduleService.isScheduleActive(mockSchedule, now);
      expect(result).toBe(false);
    });

    it('should return false when disabled', () => {
      const disabledSchedule = { ...mockSchedule, enabled: false };
      const now = new Date('2026-01-07T10:00:00');
      const result = scheduleService.isScheduleActive(disabledSchedule, now);
      expect(result).toBe(false);
    });

    it('should handle schedule with no end_time', () => {
      const noEnd = { ...mockSchedule, end_time: null };
      // Wednesday at 23:00 (after start but no end)
      const now = new Date('2026-01-07T23:00:00');
      const result = scheduleService.isScheduleActive(noEnd, now);
      expect(result).toBe(true);
    });
  });
});
