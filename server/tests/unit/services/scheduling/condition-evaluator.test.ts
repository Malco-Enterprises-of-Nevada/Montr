/**
 * Condition evaluator tests
 */

import {
  evaluateConditions,
  isEventTriggered,
} from '../../../../src/services/scheduling/condition-evaluator';
import { ScheduleConditions } from '../../../../src/database/types';

describe('condition-evaluator', () => {
  describe('evaluateConditions', () => {
    it('returns passed=true when conditions is null', () => {
      expect(evaluateConditions(null, new Date('2026-04-15T10:00:00Z'))).toEqual({
        passed: true,
      });
    });

    it('blocks event-triggered rules from passing on tick', () => {
      const conditions: ScheduleConditions = {
        event_trigger: { event_type: 'client_offline' },
      };
      const result = evaluateConditions(conditions, new Date('2026-04-15T10:00:00Z'));
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/event-triggered/);
    });

    it('passes when today matches holidays.on', () => {
      const conditions: ScheduleConditions = {
        holidays: { country: 'US', match: 'on' },
      };
      // 2026-07-04 is US Independence Day
      const result = evaluateConditions(conditions, new Date('2026-07-04T10:00:00'));
      expect(result.passed).toBe(true);
    });

    it('blocks when today is not a holiday and match=on', () => {
      const conditions: ScheduleConditions = {
        holidays: { country: 'US', match: 'on' },
      };
      const result = evaluateConditions(conditions, new Date('2026-07-05T10:00:00'));
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/not a holiday/);
    });

    it('passes when today is not a holiday and match=not_on', () => {
      const conditions: ScheduleConditions = {
        holidays: { country: 'US', match: 'not_on' },
      };
      const result = evaluateConditions(conditions, new Date('2026-07-05T10:00:00'));
      expect(result.passed).toBe(true);
    });

    it('blocks when today is a holiday and match=not_on', () => {
      const conditions: ScheduleConditions = {
        holidays: { country: 'US', match: 'not_on' },
      };
      const result = evaluateConditions(conditions, new Date('2026-07-04T10:00:00'));
      expect(result.passed).toBe(false);
      expect(result.reason).toMatch(/is a holiday/);
    });

    it('passes when today is in special_dates', () => {
      const conditions: ScheduleConditions = {
        special_dates: ['2026-04-15', '2026-12-25'],
      };
      const result = evaluateConditions(conditions, new Date(2026, 3, 15, 10, 0));
      expect(result.passed).toBe(true);
    });

    it('blocks when today is not in special_dates', () => {
      const conditions: ScheduleConditions = {
        special_dates: ['2026-12-25'],
      };
      const result = evaluateConditions(conditions, new Date(2026, 3, 15, 10, 0));
      expect(result.passed).toBe(false);
    });

    it('combines special_dates + holidays (both must pass)', () => {
      const conditions: ScheduleConditions = {
        special_dates: ['2026-07-04'],
        holidays: { country: 'US', match: 'on' },
      };
      // 2026-07-04 is both in special_dates AND a US holiday
      const result = evaluateConditions(conditions, new Date(2026, 6, 4, 10, 0));
      expect(result.passed).toBe(true);
    });
  });

  describe('isEventTriggered', () => {
    it('detects event-trigger conditions', () => {
      expect(isEventTriggered({ event_trigger: { event_type: 'client_error' } })).toBe(true);
    });
    it('returns false for non-event conditions', () => {
      expect(isEventTriggered({ holidays: { country: 'US', match: 'on' } })).toBe(false);
      expect(isEventTriggered(null)).toBe(false);
    });
  });
});
