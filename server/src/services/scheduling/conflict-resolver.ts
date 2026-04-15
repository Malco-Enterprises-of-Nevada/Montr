/**
 * Picks a winner when multiple schedules match the same target at the same
 * tick. Tiebreaks: priority DESC, id ASC.
 */

import { Schedule } from '../../database/types';

export type ScheduleTargetKey = string; // "client:<id>" | "group:<id>" | "global"

export function targetKeyFor(schedule: Schedule): ScheduleTargetKey {
  if (schedule.client_id) return `client:${schedule.client_id}`;
  if (schedule.group_id) return `group:${schedule.group_id}`;
  return 'global';
}

/**
 * Buckets schedules by target and returns the winner per bucket along with
 * the losers (so callers can report conflicts in simulation output).
 */
export function resolveConflicts(matching: Schedule[]): {
  winners: Map<ScheduleTargetKey, Schedule>;
  losers: Map<ScheduleTargetKey, Schedule[]>;
} {
  const winners = new Map<ScheduleTargetKey, Schedule>();
  const losers = new Map<ScheduleTargetKey, Schedule[]>();

  const buckets = new Map<ScheduleTargetKey, Schedule[]>();
  for (const s of matching) {
    const key = targetKeyFor(s);
    const arr = buckets.get(key) ?? [];
    arr.push(s);
    buckets.set(key, arr);
  }

  for (const [key, arr] of buckets) {
    arr.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.id - b.id;
    });
    winners.set(key, arr[0]);
    if (arr.length > 1) losers.set(key, arr.slice(1));
  }

  return { winners, losers };
}
