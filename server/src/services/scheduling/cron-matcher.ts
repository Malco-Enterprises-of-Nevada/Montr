/**
 * Cron matching helpers used by ScheduleService.
 *
 * The 60-second evaluator calls `didCronFireInLastMinute` once per tick for each
 * schedule. Simulation uses `nextOccurrences` to enumerate fire times over a
 * date range.
 */

import { CronExpressionParser } from 'cron-parser';

/**
 * Returns true if `expr` produces at least one fire time in the minute
 * ending at `now`. `tz` is an optional IANA timezone.
 *
 * We compute "did fire within the last 60 seconds" rather than checking
 * for an exact minute match, because the background timer may drift by
 * a few seconds.
 */
export function didCronFireInLastMinute(expr: string, tz: string | null, now: Date): boolean {
  const windowStart = new Date(now.getTime() - 60_000);
  try {
    const iter = CronExpressionParser.parse(expr, {
      currentDate: windowStart,
      endDate: now,
      tz: tz || undefined,
    });
    const next = iter.next();
    const nextMs = next.toDate().getTime();
    return nextMs >= windowStart.getTime() && nextMs <= now.getTime();
  } catch {
    return false;
  }
}

/**
 * Enumerates cron fire timestamps in [from, to].
 * Caps the result at `max` to avoid runaway expansions.
 */
export function nextOccurrences(
  expr: string,
  tz: string | null,
  from: Date,
  to: Date,
  max: number = 500
): Date[] {
  const out: Date[] = [];
  try {
    const iter = CronExpressionParser.parse(expr, {
      currentDate: from,
      endDate: to,
      tz: tz || undefined,
    });
    for (let i = 0; i < max; i++) {
      try {
        out.push(iter.next().toDate());
      } catch {
        break;
      }
    }
  } catch {
    return [];
  }
  return out;
}

/**
 * Validates a cron expression. Returns an error message or null if valid.
 */
export function validateCron(expr: string): string | null {
  try {
    CronExpressionParser.parse(expr);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid cron expression';
  }
}
