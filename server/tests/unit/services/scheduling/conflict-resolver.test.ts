/**
 * Conflict resolver tests
 */

import {
  resolveConflicts,
  targetKeyFor,
} from '../../../../src/services/scheduling/conflict-resolver';
import { Schedule } from '../../../../src/database/types';

function mkSchedule(overrides: Partial<Schedule>): Schedule {
  return {
    id: 1,
    name: 'Test',
    playlist_id: 1,
    client_id: null,
    group_id: null,
    start_time: '09:00',
    end_time: null,
    days_of_week: '1,2,3,4,5',
    priority: 50,
    enabled: true,
    cron_expression: null,
    duration_seconds: null,
    timezone: null,
    conditions: null,
    interrupt_mode: 'assign',
    template_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('conflict-resolver', () => {
  describe('targetKeyFor', () => {
    it('returns client key when client_id set', () => {
      expect(targetKeyFor(mkSchedule({ client_id: 'abc' }))).toBe('client:abc');
    });
    it('returns group key when group_id set', () => {
      expect(targetKeyFor(mkSchedule({ group_id: 5 }))).toBe('group:5');
    });
    it('returns global when neither set', () => {
      expect(targetKeyFor(mkSchedule({}))).toBe('global');
    });
  });

  describe('resolveConflicts', () => {
    it('no conflict for different targets', () => {
      const s1 = mkSchedule({ id: 1, client_id: 'a' });
      const s2 = mkSchedule({ id: 2, client_id: 'b' });
      const { winners, losers } = resolveConflicts([s1, s2]);
      expect(winners.size).toBe(2);
      expect(losers.size).toBe(0);
    });

    it('picks highest priority winner', () => {
      const s1 = mkSchedule({ id: 1, client_id: 'a', priority: 50 });
      const s2 = mkSchedule({ id: 2, client_id: 'a', priority: 80 });
      const { winners, losers } = resolveConflicts([s1, s2]);
      expect(winners.get('client:a')!.id).toBe(2);
      expect(losers.get('client:a')!.map((l) => l.id)).toEqual([1]);
    });

    it('tiebreaks by id ASC when priority equal', () => {
      const s1 = mkSchedule({ id: 7, client_id: 'a', priority: 50 });
      const s2 = mkSchedule({ id: 3, client_id: 'a', priority: 50 });
      const { winners } = resolveConflicts([s1, s2]);
      expect(winners.get('client:a')!.id).toBe(3);
    });

    it('handles three-way conflict', () => {
      const s1 = mkSchedule({ id: 1, group_id: 9, priority: 60 });
      const s2 = mkSchedule({ id: 2, group_id: 9, priority: 90 });
      const s3 = mkSchedule({ id: 3, group_id: 9, priority: 80 });
      const { winners, losers } = resolveConflicts([s1, s2, s3]);
      expect(winners.get('group:9')!.id).toBe(2);
      const loserIds = losers.get('group:9')!.map((l) => l.id).sort();
      expect(loserIds).toEqual([1, 3]);
    });
  });
});
