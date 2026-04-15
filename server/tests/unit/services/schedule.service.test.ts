/**
 * Schedule Service Tests
 */

import { ScheduleService } from '../../../src/services/schedule.service';
import { getDatabase } from '../../../src/database/connection';
import { AppError } from '../../../src/api/middleware/error-handler';
import { DatabaseAdapter } from '../../../src/database/adapters/base.adapter';
import { Schedule } from '../../../src/database/types';

jest.mock('../../../src/database/connection');

jest.mock('../../../src/websocket/handlers', () => ({
  sendPlaylistToClient: jest.fn().mockResolvedValue(undefined),
  sendPlaylistToGroup: jest.fn().mockResolvedValue(0),
}));

jest.mock('../../../src/websocket/client-manager', () => ({
  clientConnectionManager: {
    isConnected: jest.fn().mockReturnValue(true),
  },
}));

jest.mock('../../../src/services/client.service', () => ({
  clientService: {
    interruptWithPlaylist: jest.fn().mockResolvedValue({}),
    resumeFromInterrupt: jest.fn().mockResolvedValue({ assigned_playlist_id: 9 }),
  },
}));

import { sendPlaylistToClient, sendPlaylistToGroup } from '../../../src/websocket/handlers';
import { clientService } from '../../../src/services/client.service';

function mockAdapter(): jest.Mocked<DatabaseAdapter> {
  return {
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
    createScheduleTemplate: jest.fn(),
    getScheduleTemplateById: jest.fn(),
    getAllScheduleTemplates: jest.fn(),
    deleteScheduleTemplate: jest.fn(),
    addClientPlaylist: jest.fn(),
    removeClientPlaylist: jest.fn(),
    getClientPlaylists: jest.fn(),
    updateClientPlaylistPriority: jest.fn(),
    createPlaybackLog: jest.fn(),
    updatePlaybackLog: jest.fn(),
    getPlaybackLogs: jest.fn(),
    getPlaybackSummaryByClient: jest.fn(),
    getMediaPopularity: jest.fn(),
    getClientUptimeStats: jest.fn(),
    deleteOldPlaybackLogs: jest.fn(),
    createNotificationRule: jest.fn(),
    getNotificationRuleById: jest.fn(),
    getAllNotificationRules: jest.fn(),
    getEnabledRulesForEvent: jest.fn(),
    deleteNotificationRule: jest.fn(),
    createNotificationHistory: jest.fn(),
    getNotificationHistory: jest.fn(),
    updateMediaApproval: jest.fn(),
    createApprovalLog: jest.fn(),
    getApprovalLogs: jest.fn(),
    getPendingMedia: jest.fn(),
    recordClientTelemetry: jest.fn(),
    getClientTelemetryRange: jest.fn(),
    getClientTelemetryLatest: jest.fn(),
    getAllClientTelemetryLatest: jest.fn(),
    recordClientLogEvent: jest.fn(),
    getClientLogEvents: jest.fn(),
    deleteOldClientTelemetry: jest.fn(),
    deleteOldClientLogEvents: jest.fn(),
    createUser: jest.fn(),
    getUserById: jest.fn(),
    getUserByUsername: jest.fn(),
    getUserByEmail: jest.fn(),
    getAllUsers: jest.fn(),
    deleteUser: jest.fn(),
    updateUser: jest.fn(),
    updateUserPassword: jest.fn(),
    getUserCount: jest.fn(),
  } as unknown as jest.Mocked<DatabaseAdapter>;
}

let mockDb: jest.Mocked<DatabaseAdapter>;
let scheduleService: ScheduleService;

function baseSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
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
    cron_expression: null,
    duration_seconds: null,
    timezone: null,
    conditions: null,
    interrupt_mode: 'assign',
    template_id: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const mockPlaylist = {
  id: 1,
  name: 'Test Playlist',
  description: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

describe('ScheduleService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = mockAdapter();
    scheduleService = new ScheduleService();
    (getDatabase as jest.Mock).mockResolvedValue(mockDb);
    (
      require('../../../src/websocket/client-manager').clientConnectionManager
        .isConnected as jest.Mock
    ).mockReturnValue(true);
    (clientService.interruptWithPlaylist as jest.Mock).mockResolvedValue({});
    (clientService.resumeFromInterrupt as jest.Mock).mockResolvedValue({
      assigned_playlist_id: 9,
    });
  });

  describe('createSchedule', () => {
    it('creates a basic HH:MM schedule', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.createSchedule.mockResolvedValue(baseSchedule());

      const result = await scheduleService.createSchedule({
        name: 'Morning Playlist',
        playlist_id: 1,
        start_time: '09:00',
        end_time: '17:00',
        days_of_week: '1,2,3,4,5',
      });
      expect(result.name).toBe('Morning Playlist');
    });

    it('creates a cron schedule', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.createSchedule.mockResolvedValue(
        baseSchedule({ cron_expression: '0 9 * * 1-5', start_time: null })
      );
      const result = await scheduleService.createSchedule({
        name: 'Weekday 9am',
        playlist_id: 1,
        cron_expression: '0 9 * * 1-5',
      });
      expect(result.cron_expression).toBe('0 9 * * 1-5');
    });

    it('rejects invalid cron expression', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      await expect(
        scheduleService.createSchedule({
          name: 'Bad',
          playlist_id: 1,
          cron_expression: 'not a cron',
        })
      ).rejects.toThrow(AppError);
    });

    it('throws if playlist not found', async () => {
      mockDb.getPlaylistById.mockResolvedValue(null);
      await expect(
        scheduleService.createSchedule({ name: 'Test', playlist_id: 999, start_time: '09:00' })
      ).rejects.toThrow(AppError);
    });

    it('throws if client not found', async () => {
      mockDb.getPlaylistById.mockResolvedValue(mockPlaylist);
      mockDb.getClientById.mockResolvedValue(null);
      await expect(
        scheduleService.createSchedule({
          name: 'Test',
          playlist_id: 1,
          start_time: '09:00',
          client_id: 'nonexistent',
        })
      ).rejects.toThrow(AppError);
    });
  });

  describe('getScheduleById', () => {
    it('returns a schedule', async () => {
      mockDb.getScheduleById.mockResolvedValue(baseSchedule());
      const result = await scheduleService.getScheduleById(1);
      expect(result.id).toBe(1);
    });

    it('throws if not found', async () => {
      mockDb.getScheduleById.mockResolvedValue(null);
      await expect(scheduleService.getScheduleById(999)).rejects.toThrow(AppError);
    });
  });

  describe('getAllSchedules', () => {
    it('returns all schedules', async () => {
      mockDb.getAllSchedules.mockResolvedValue([baseSchedule()]);
      const result = await scheduleService.getAllSchedules();
      expect(result).toHaveLength(1);
    });
  });

  describe('updateSchedule', () => {
    it('updates a schedule', async () => {
      mockDb.getScheduleById.mockResolvedValue(baseSchedule());
      mockDb.updateSchedule.mockResolvedValue(baseSchedule({ name: 'Updated' }));
      const result = await scheduleService.updateSchedule(1, { name: 'Updated' });
      expect(result.name).toBe('Updated');
    });
  });

  describe('deleteSchedule', () => {
    it('deletes a schedule', async () => {
      mockDb.getScheduleById.mockResolvedValue(baseSchedule());
      mockDb.deleteSchedule.mockResolvedValue();
      await expect(scheduleService.deleteSchedule(1)).resolves.toBeUndefined();
    });
  });

  describe('isScheduleActive', () => {
    it('returns true within HH:MM window and correct day', () => {
      const now = new Date('2026-01-07T10:00:00'); // Wednesday
      expect(scheduleService.isScheduleActive(baseSchedule(), now)).toBe(true);
    });

    it('returns false outside HH:MM window', () => {
      const now = new Date('2026-01-07T18:00:00');
      expect(scheduleService.isScheduleActive(baseSchedule(), now)).toBe(false);
    });

    it('returns false on wrong day', () => {
      const now = new Date('2026-01-04T10:00:00'); // Sunday
      expect(scheduleService.isScheduleActive(baseSchedule(), now)).toBe(false);
    });

    it('returns false when disabled', () => {
      const now = new Date('2026-01-07T10:00:00');
      expect(scheduleService.isScheduleActive(baseSchedule({ enabled: false }), now)).toBe(false);
    });

    it('handles no end_time', () => {
      const s = baseSchedule({ end_time: null });
      const now = new Date('2026-01-07T23:00:00');
      expect(scheduleService.isScheduleActive(s, now)).toBe(true);
    });

    it('cron: active within fire minute', () => {
      const s = baseSchedule({ cron_expression: '0 9 * * *', start_time: null, timezone: 'UTC' });
      const now = new Date('2026-04-15T09:00:20Z');
      expect(scheduleService.isScheduleActive(s, now)).toBe(true);
    });

    it('cron: not active at :02 minute', () => {
      const s = baseSchedule({ cron_expression: '0 9 * * *', start_time: null, timezone: 'UTC' });
      const now = new Date('2026-04-15T09:02:00Z');
      expect(scheduleService.isScheduleActive(s, now)).toBe(false);
    });

    it('event-triggered rule is never tick-active', () => {
      const s = baseSchedule({
        cron_expression: null,
        start_time: null,
        conditions: { event_trigger: { event_type: 'client_offline' } },
      });
      const now = new Date('2026-04-15T09:00:00Z');
      expect(scheduleService.isScheduleActive(s, now)).toBe(false);
    });

    it('holiday condition blocks non-holiday days', () => {
      const s = baseSchedule({
        conditions: { holidays: { country: 'US', match: 'on' } },
      });
      // 2026-01-07 Wednesday is NOT a holiday
      const now = new Date('2026-01-07T10:00:00');
      expect(scheduleService.isScheduleActive(s, now)).toBe(false);
    });
  });

  describe('evaluateSchedules — conflict resolution', () => {
    it('dispatches only the higher-priority schedule when two match for same target', async () => {
      const client = 'c1';
      const low = baseSchedule({ id: 1, client_id: client, priority: 40 });
      const high = baseSchedule({ id: 2, client_id: client, priority: 90 });
      mockDb.getEnabledSchedules.mockResolvedValue([low, high]);
      mockDb.updateClient.mockResolvedValue({} as never);

      const now = new Date('2026-01-07T09:00:00'); // Wednesday 09:00
      await scheduleService.evaluateSchedules(now);

      expect(sendPlaylistToClient).toHaveBeenCalledTimes(1);
      expect(sendPlaylistToClient).toHaveBeenCalledWith(client, high.playlist_id);
    });

    it('dispatches independent targets separately', async () => {
      const s1 = baseSchedule({ id: 1, client_id: 'a' });
      const s2 = baseSchedule({ id: 2, client_id: 'b' });
      mockDb.getEnabledSchedules.mockResolvedValue([s1, s2]);
      mockDb.updateClient.mockResolvedValue({} as never);

      await scheduleService.evaluateSchedules(new Date('2026-01-07T09:00:00'));
      expect(sendPlaylistToClient).toHaveBeenCalledTimes(2);
    });

    it('dispatches to group when group_id set', async () => {
      const s = baseSchedule({ id: 1, group_id: 7 });
      mockDb.getEnabledSchedules.mockResolvedValue([s]);
      mockDb.getGroupMembers.mockResolvedValue([{ id: 'c1' }] as never);
      mockDb.updateClient.mockResolvedValue({} as never);

      await scheduleService.evaluateSchedules(new Date('2026-01-07T09:00:00'));
      expect(sendPlaylistToGroup).toHaveBeenCalledWith(7, 1);
    });

    it('interrupt_mode dispatches via clientService.interruptWithPlaylist', async () => {
      const s = baseSchedule({
        id: 1,
        client_id: 'c1',
        interrupt_mode: 'interrupt',
        duration_seconds: 60,
      });
      mockDb.getEnabledSchedules.mockResolvedValue([s]);

      await scheduleService.evaluateSchedules(new Date('2026-01-07T09:00:00'));
      expect(clientService.interruptWithPlaylist).toHaveBeenCalledWith('c1', 1);
      scheduleService.stopEvaluation();
    });
  });

  describe('simulateSchedule', () => {
    it('returns cron occurrences over a range', () => {
      const s = baseSchedule({
        cron_expression: '0 9 * * *',
        start_time: null,
        timezone: 'UTC',
      });
      const from = new Date('2026-04-15T00:00:00Z');
      const to = new Date('2026-04-18T00:00:00Z');
      const occ = scheduleService.simulateSchedule(s, from, to);
      expect(occ).toHaveLength(3);
    });

    it('respects holiday condition — only on US holidays', () => {
      const s = baseSchedule({
        cron_expression: '0 9 * * *',
        start_time: null,
        timezone: 'UTC',
        conditions: { holidays: { country: 'US', match: 'on' } },
      });
      // July 1–7 2026 — US Independence Day (July 4) + observed substitute day (July 3)
      const from = new Date('2026-07-01T00:00:00Z');
      const to = new Date('2026-07-07T23:59:59Z');
      const occ = scheduleService.simulateSchedule(s, from, to);
      expect(occ.length).toBe(2);
    });

    it('returns empty for event-triggered schedules', () => {
      const s = baseSchedule({
        cron_expression: null,
        start_time: null,
        conditions: { event_trigger: { event_type: 'client_offline' } },
      });
      expect(scheduleService.simulateSchedule(s, new Date(), new Date())).toEqual([]);
    });
  });

  describe('onEvent', () => {
    it('fires schedules that subscribe to the event', async () => {
      const s = baseSchedule({
        id: 1,
        client_id: 'c1',
        cron_expression: null,
        start_time: null,
        interrupt_mode: 'interrupt',
        duration_seconds: 30,
        conditions: { event_trigger: { event_type: 'client_offline' } },
      });
      mockDb.getEnabledSchedules.mockResolvedValue([s]);

      const fired = await scheduleService.onEvent('client_offline', { client_id: 'c1' });
      expect(fired).toBe(1);
      expect(clientService.interruptWithPlaylist).toHaveBeenCalled();
      scheduleService.stopEvaluation();
    });

    it('dedupes re-entrant events within the duration window', async () => {
      const s = baseSchedule({
        id: 1,
        client_id: 'c1',
        cron_expression: null,
        start_time: null,
        interrupt_mode: 'interrupt',
        duration_seconds: 60,
        conditions: { event_trigger: { event_type: 'client_offline' } },
      });
      mockDb.getEnabledSchedules.mockResolvedValue([s]);

      const first = await scheduleService.onEvent('client_offline', { client_id: 'c1' });
      const second = await scheduleService.onEvent('client_offline', { client_id: 'c1' });
      expect(first).toBe(1);
      expect(second).toBe(0);
      scheduleService.stopEvaluation();
    });

    it('ignores events without matching schedules', async () => {
      mockDb.getEnabledSchedules.mockResolvedValue([
        baseSchedule({ conditions: { event_trigger: { event_type: 'client_error' } } }),
      ]);
      const fired = await scheduleService.onEvent('storage_full', {});
      expect(fired).toBe(0);
    });
  });
});
