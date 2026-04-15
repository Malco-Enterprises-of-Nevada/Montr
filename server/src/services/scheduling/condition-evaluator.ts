/**
 * Evaluates schedule conditions (holidays, special dates).
 *
 * Event-trigger conditions are checked separately — they fire via
 * NotificationService.fireEvent, not on the 60s tick.
 */

import Holidays from 'date-holidays';
import { ScheduleConditions } from '../../database/types';

export interface ConditionResult {
  passed: boolean;
  reason?: string;
}

/**
 * Caches Holidays instances per country+regions combo. Cache is small
 * (one entry per configured rule) and long-lived.
 */
const holidaysCache = new Map<string, Holidays>();

function getHolidays(country: string, regions?: string[]): Holidays {
  const key = `${country}|${(regions ?? []).join(',')}`;
  let h = holidaysCache.get(key);
  if (!h) {
    // Holidays' constructor accepts positional (country, state, region) strings,
    // but TS overloads don't cover that shape cleanly. Cast through unknown.
    const Ctor = Holidays as unknown as new (...args: string[]) => Holidays;
    h = regions && regions.length > 0 ? new Ctor(country, ...regions) : new Ctor(country);
    holidaysCache.set(key, h);
  }
  return h;
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Evaluates the non-event conditions for a schedule. Returns `passed: true`
 * if the conditions allow the schedule to fire, or if `conditions` is null.
 */
export function evaluateConditions(
  conditions: ScheduleConditions | null,
  now: Date = new Date()
): ConditionResult {
  if (!conditions) return { passed: true };

  // Event-trigger conditions are handled by the notification hook, not
  // the tick-based evaluator. If a schedule has an event_trigger, it
  // should not fire from time-based evaluation at all.
  if (conditions.event_trigger) {
    return { passed: false, reason: 'event-triggered only' };
  }

  if (conditions.special_dates && conditions.special_dates.length > 0) {
    const today = toIsoDate(now);
    if (!conditions.special_dates.includes(today)) {
      return { passed: false, reason: 'date not in special_dates' };
    }
  }

  if (conditions.holidays) {
    const { country, regions, match } = conditions.holidays;
    const h = getHolidays(country, regions);
    const isHoliday = Boolean(h.isHoliday(now));
    if (match === 'on' && !isHoliday) {
      return { passed: false, reason: 'not a holiday' };
    }
    if (match === 'not_on' && isHoliday) {
      return { passed: false, reason: 'is a holiday' };
    }
  }

  return { passed: true };
}

/**
 * True if the schedule is configured to fire only in response to an event.
 */
export function isEventTriggered(conditions: ScheduleConditions | null): boolean {
  return Boolean(conditions?.event_trigger);
}
