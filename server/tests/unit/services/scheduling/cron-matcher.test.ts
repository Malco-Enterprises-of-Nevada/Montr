/**
 * Cron matcher tests
 */

import {
  didCronFireInLastMinute,
  nextOccurrences,
  validateCron,
} from '../../../../src/services/scheduling/cron-matcher';

describe('cron-matcher', () => {
  describe('validateCron', () => {
    it('accepts a valid 5-field cron', () => {
      expect(validateCron('0 9 * * 1-5')).toBeNull();
      expect(validateCron('*/15 * * * *')).toBeNull();
    });

    it('rejects garbage', () => {
      expect(validateCron('not a cron')).not.toBeNull();
      expect(validateCron('99 99 * * *')).not.toBeNull();
    });
  });

  describe('didCronFireInLastMinute', () => {
    it('returns true when expr fires exactly at now', () => {
      // 09:00 on a Wednesday
      const now = new Date('2026-04-15T09:00:00Z');
      expect(didCronFireInLastMinute('0 9 * * *', 'UTC', now)).toBe(true);
    });

    it('returns true when expr fires within the last 60s', () => {
      // fire at 09:00:00, check at 09:00:30
      const now = new Date('2026-04-15T09:00:30Z');
      expect(didCronFireInLastMinute('0 9 * * *', 'UTC', now)).toBe(true);
    });

    it('returns false when next fire is in the future', () => {
      // It's 08:59, fire at 09:00 hasn't happened yet
      const now = new Date('2026-04-15T08:59:00Z');
      expect(didCronFireInLastMinute('0 9 * * *', 'UTC', now)).toBe(false);
    });

    it('returns false when wrong day of week', () => {
      // Weekday-only rule, check on Saturday
      const now = new Date('2026-04-18T09:00:00Z'); // 2026-04-18 is Saturday
      expect(didCronFireInLastMinute('0 9 * * 1-5', 'UTC', now)).toBe(false);
    });

    it('respects timezone', () => {
      // Rule "fire at 09:00 America/Los_Angeles"
      // At UTC 16:00 that is 09:00 LA (PDT, UTC-7)
      const now = new Date('2026-04-15T16:00:00Z');
      expect(didCronFireInLastMinute('0 9 * * *', 'America/Los_Angeles', now)).toBe(true);
      // At UTC 09:00 it is 02:00 LA, so should NOT fire
      const wrong = new Date('2026-04-15T09:00:00Z');
      expect(didCronFireInLastMinute('0 9 * * *', 'America/Los_Angeles', wrong)).toBe(false);
    });

    it('returns false for invalid expr', () => {
      const now = new Date('2026-04-15T09:00:00Z');
      expect(didCronFireInLastMinute('bad expr', null, now)).toBe(false);
    });

    it('handles every-minute pattern', () => {
      const now = new Date('2026-04-15T09:37:00Z');
      expect(didCronFireInLastMinute('* * * * *', 'UTC', now)).toBe(true);
    });

    it('handles every-15-minutes pattern at :15', () => {
      const now = new Date('2026-04-15T09:15:00Z');
      expect(didCronFireInLastMinute('*/15 * * * *', 'UTC', now)).toBe(true);
    });

    it('every-15-minutes does not fire at :20', () => {
      // last fire was :15 = 5 min ago, more than 60s ago
      const now = new Date('2026-04-15T09:20:00Z');
      expect(didCronFireInLastMinute('*/15 * * * *', 'UTC', now)).toBe(false);
    });
  });

  describe('nextOccurrences', () => {
    it('enumerates daily cron over 3 days', () => {
      const from = new Date('2026-04-15T00:00:00Z');
      const to = new Date('2026-04-18T00:00:00Z');
      const occ = nextOccurrences('0 9 * * *', 'UTC', from, to);
      expect(occ).toHaveLength(3);
      expect(occ[0].toISOString()).toBe('2026-04-15T09:00:00.000Z');
    });

    it('respects max cap', () => {
      const from = new Date('2026-04-15T00:00:00Z');
      const to = new Date('2026-04-16T00:00:00Z');
      const occ = nextOccurrences('* * * * *', 'UTC', from, to, 10);
      expect(occ.length).toBe(10);
    });

    it('returns empty for invalid expr', () => {
      const from = new Date('2026-04-15T00:00:00Z');
      const to = new Date('2026-04-18T00:00:00Z');
      expect(nextOccurrences('garbage', null, from, to)).toEqual([]);
    });
  });
});
