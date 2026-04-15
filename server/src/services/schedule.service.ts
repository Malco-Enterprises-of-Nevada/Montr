/**
 * Schedule Service
 * CRUD + evaluation with cron, conditions, templates, and conflict resolution.
 */

import { getDatabase } from '../database/connection';
import {
  Schedule,
  CreateScheduleInput,
  UpdateScheduleInput,
  NotificationEventType,
} from '../database/types';
import { getLogger } from '../utils/logger';
import { AppError, ErrorCode } from '../api/middleware/error-handler';
import { sendPlaylistToClient, sendPlaylistToGroup } from '../websocket/handlers';
import { clientConnectionManager } from '../websocket/client-manager';
import { clientService } from './client.service';
import { didCronFireInLastMinute, nextOccurrences, validateCron } from './scheduling/cron-matcher';
import { evaluateConditions, isEventTriggered } from './scheduling/condition-evaluator';
import { resolveConflicts, targetKeyFor } from './scheduling/conflict-resolver';

const logger = getLogger();

export interface SimulationOccurrence {
  schedule_id: number;
  schedule_name: string;
  playlist_id: number;
  target: string;
  priority: number;
  fires_at: string; // ISO timestamp
  ends_at: string | null;
  interrupt_mode: 'assign' | 'interrupt';
}

export interface SimulationResult {
  occurrences: SimulationOccurrence[];
  /** Timestamps where two or more schedules collide on the same target */
  conflicts: Array<{ fires_at: string; target: string; winner_id: number; loser_ids: number[] }>;
}

export class ScheduleService {
  private evaluationInterval: NodeJS.Timeout | null = null;

  /** Per-schedule last-fire minute key, for dedupe within the 60s window. */
  private lastTriggered: Map<number, string> = new Map();

  /** Pending auto-resume timers keyed by clientId. */
  private resumeTimers: Map<string, NodeJS.Timeout> = new Map();

  /** Per-event-schedule de-duplication window (drops re-entrant event fires). */
  private eventLastFired: Map<number, number> = new Map();

  // ── CRUD ────────────────────────────────────────────────────────────────

  async createSchedule(input: CreateScheduleInput): Promise<Schedule> {
    this.validateInput(input);

    const db = await getDatabase();

    const playlist = await db.getPlaylistById(input.playlist_id);
    if (!playlist) {
      throw new AppError(
        ErrorCode.PLAYLIST_NOT_FOUND,
        `Playlist with ID ${input.playlist_id} not found`,
        404
      );
    }

    if (input.client_id) {
      const client = await db.getClientById(input.client_id);
      if (!client) {
        throw new AppError(
          ErrorCode.CLIENT_NOT_FOUND,
          `Client with ID ${input.client_id} not found`,
          404
        );
      }
    }

    if (input.group_id) {
      const group = await db.getClientGroupById(input.group_id);
      if (!group) {
        throw new AppError(
          ErrorCode.RESOURCE_NOT_FOUND,
          `Group with ID ${input.group_id} not found`,
          404
        );
      }
    }

    const schedule = await db.createSchedule(input);
    logger.info(`Schedule created: ${schedule.id} - ${schedule.name}`);
    return schedule;
  }

  async getScheduleById(id: number): Promise<Schedule> {
    const db = await getDatabase();
    const schedule = await db.getScheduleById(id);
    if (!schedule) {
      throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, `Schedule with ID ${id} not found`, 404);
    }
    return schedule;
  }

  async getAllSchedules(): Promise<Schedule[]> {
    const db = await getDatabase();
    return db.getAllSchedules();
  }

  async updateSchedule(id: number, input: UpdateScheduleInput): Promise<Schedule> {
    await this.getScheduleById(id);
    this.validateInput(input);

    const db = await getDatabase();

    if (input.playlist_id !== undefined) {
      const playlist = await db.getPlaylistById(input.playlist_id);
      if (!playlist) {
        throw new AppError(
          ErrorCode.PLAYLIST_NOT_FOUND,
          `Playlist with ID ${input.playlist_id} not found`,
          404
        );
      }
    }

    const schedule = await db.updateSchedule(id, input);
    logger.info(`Schedule updated: ${schedule.id} - ${schedule.name}`);
    return schedule;
  }

  async deleteSchedule(id: number): Promise<void> {
    await this.getScheduleById(id);
    const db = await getDatabase();
    await db.deleteSchedule(id);
    this.lastTriggered.delete(id);
    this.eventLastFired.delete(id);
    logger.info(`Schedule deleted: ${id}`);
  }

  // ── Activation logic ─────────────────────────────────────────────────────

  /**
   * True if the schedule is currently in its active window.
   *
   * For cron-based schedules, "active" means the cron fired in the last minute
   * (start of window). For HH:MM schedules, "active" means `now` is within
   * `start_time` and `end_time`.
   *
   * Event-triggered schedules are never considered active by this function —
   * they fire via the notification hook.
   */
  isScheduleActive(schedule: Schedule, now: Date = new Date()): boolean {
    if (!schedule.enabled) return false;

    if (isEventTriggered(schedule.conditions)) return false;

    const cond = evaluateConditions(schedule.conditions, now);
    if (!cond.passed) return false;

    if (schedule.cron_expression) {
      return didCronFireInLastMinute(schedule.cron_expression, schedule.timezone, now);
    }

    // Legacy HH:MM path
    if (!schedule.start_time) return false;

    const currentDay = now.getDay();
    const allowedDays = schedule.days_of_week.split(',').map(Number);
    if (!allowedDays.includes(currentDay)) return false;

    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (currentTime < schedule.start_time) return false;
    if (schedule.end_time && currentTime >= schedule.end_time) return false;

    return true;
  }

  /**
   * Returns schedules whose *start moment* is in the current minute — i.e.
   * they should actually dispatch a playlist right now (not every minute of
   * their window).
   */
  private findTriggering(schedules: Schedule[], now: Date): Schedule[] {
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return schedules.filter((s) => {
      if (!this.isScheduleActive(s, now)) return false;
      if (s.cron_expression) return true; // cron match == trigger moment
      return s.start_time === currentTime;
    });
  }

  // ── Tick evaluator ───────────────────────────────────────────────────────

  async evaluateSchedules(now: Date = new Date()): Promise<void> {
    try {
      const db = await getDatabase();
      const schedules = await db.getEnabledSchedules();
      const minuteKey = `${now.getHours()}:${now.getMinutes()}`;

      const triggering = this.findTriggering(schedules, now).filter((s) => {
        if (this.lastTriggered.get(s.id) === minuteKey) return false;
        this.lastTriggered.set(s.id, minuteKey);
        return true;
      });

      if (triggering.length === 0) return;

      const { winners, losers } = resolveConflicts(triggering);

      for (const [key, schedule] of winners) {
        if (losers.get(key)) {
          const loserIds = losers.get(key)!.map((l) => l.id);
          logger.info(
            `Schedule conflict on ${key}: winner=${schedule.id} (${schedule.name}, priority=${schedule.priority}), losers=[${loserIds.join(',')}]`
          );
        }
        await this.dispatchSchedule(schedule);
      }
    } catch (error) {
      logger.error('Error evaluating schedules:', error);
    }
  }

  private async dispatchSchedule(schedule: Schedule): Promise<void> {
    const db = await getDatabase();

    logger.info(`Schedule ${schedule.id} (${schedule.name}) triggered`);

    if (schedule.interrupt_mode === 'interrupt') {
      await this.dispatchInterrupt(schedule);
      return;
    }

    if (schedule.client_id) {
      await db.updateClient(schedule.client_id, {
        assigned_playlist_id: schedule.playlist_id,
      });
      if (clientConnectionManager.isConnected(schedule.client_id)) {
        await sendPlaylistToClient(schedule.client_id, schedule.playlist_id);
      }
    } else if (schedule.group_id) {
      const members = await db.getGroupMembers(schedule.group_id);
      for (const member of members) {
        await db.updateClient(member.id, {
          assigned_playlist_id: schedule.playlist_id,
        });
      }
      await sendPlaylistToGroup(schedule.group_id, schedule.playlist_id);
    } else {
      const clients = await db.getAllClients();
      for (const client of clients) {
        await db.updateClient(client.id, {
          assigned_playlist_id: schedule.playlist_id,
        });
        if (clientConnectionManager.isConnected(client.id)) {
          await sendPlaylistToClient(client.id, schedule.playlist_id);
        }
      }
    }
  }

  private async dispatchInterrupt(schedule: Schedule): Promise<void> {
    const db = await getDatabase();
    const targets: string[] = [];

    if (schedule.client_id) {
      targets.push(schedule.client_id);
    } else if (schedule.group_id) {
      const members = await db.getGroupMembers(schedule.group_id);
      targets.push(...members.map((m) => m.id));
    } else {
      const clients = await db.getAllClients();
      targets.push(...clients.map((c) => c.id));
    }

    for (const clientId of targets) {
      try {
        await clientService.interruptWithPlaylist(clientId, schedule.playlist_id);
        if (clientConnectionManager.isConnected(clientId)) {
          await sendPlaylistToClient(clientId, schedule.playlist_id);
        }

        if (schedule.duration_seconds && schedule.duration_seconds > 0) {
          this.scheduleAutoResume(clientId, schedule.duration_seconds);
        }
      } catch (err) {
        logger.error(`Interrupt dispatch failed for client ${clientId}:`, err);
      }
    }
  }

  private scheduleAutoResume(clientId: string, delaySeconds: number): void {
    const existing = this.resumeTimers.get(clientId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.resumeTimers.delete(clientId);
      void (async () => {
        try {
          const resumed = await clientService.resumeFromInterrupt(clientId);
          if (resumed.assigned_playlist_id && clientConnectionManager.isConnected(clientId)) {
            await sendPlaylistToClient(clientId, resumed.assigned_playlist_id);
          }
          logger.info(`Auto-resume for client ${clientId} fired`);
        } catch (err) {
          logger.warn(`Auto-resume failed for client ${clientId}: ${String(err)}`);
        }
      })();
    }, delaySeconds * 1000);

    this.resumeTimers.set(clientId, timer);
  }

  // ── Event-triggered playlists ────────────────────────────────────────────

  /**
   * Invoked by NotificationService after it dispatches email/webhook. Finds
   * event-triggered schedules matching the eventType and fires them.
   */
  async onEvent(
    eventType: NotificationEventType,
    payload: Record<string, unknown>
  ): Promise<number> {
    try {
      const db = await getDatabase();
      const schedules = await db.getEnabledSchedules();

      const matching = schedules.filter(
        (s) => s.conditions?.event_trigger?.event_type === eventType
      );

      if (matching.length === 0) return 0;

      const now = Date.now();
      let fired = 0;

      for (const schedule of matching) {
        // De-dupe re-entrant events within duration_seconds (or 60s default).
        const windowMs = (schedule.duration_seconds ?? 60) * 1000;
        const last = this.eventLastFired.get(schedule.id);
        if (last && now - last < windowMs) {
          logger.debug(
            `Schedule ${schedule.id} event dedupe: last fire ${now - last}ms ago < ${windowMs}ms`
          );
          continue;
        }
        this.eventLastFired.set(schedule.id, now);

        // If payload carries a client_id and the schedule is not client-scoped,
        // narrow dispatch to that client only (scope to the event source).
        const targetedSchedule = this.narrowEventTarget(schedule, payload);

        await this.dispatchSchedule(targetedSchedule);
        fired++;
      }

      if (fired > 0) {
        logger.info(
          `Event '${eventType}' fired ${fired} schedule(s) (from ${matching.length} match)`
        );
      }
      return fired;
    } catch (err) {
      logger.error('onEvent dispatch error:', err);
      return 0;
    }
  }

  private narrowEventTarget(schedule: Schedule, payload: Record<string, unknown>): Schedule {
    if (schedule.client_id || schedule.group_id) return schedule;
    const clientId = payload.client_id;
    if (typeof clientId === 'string' && clientId.length > 0) {
      return { ...schedule, client_id: clientId };
    }
    return schedule;
  }

  // ── Simulation ───────────────────────────────────────────────────────────

  /**
   * Returns the occurrences a single schedule will fire in [from, to].
   */
  simulateSchedule(schedule: Schedule, from: Date, to: Date, max: number = 500): Date[] {
    if (isEventTriggered(schedule.conditions)) return [];

    let times: Date[];
    if (schedule.cron_expression) {
      times = nextOccurrences(schedule.cron_expression, schedule.timezone, from, to, max);
    } else if (schedule.start_time) {
      times = this.simulateHhmm(schedule, from, to);
    } else {
      return [];
    }

    return times.filter((t) => evaluateConditions(schedule.conditions, t).passed);
  }

  private simulateHhmm(schedule: Schedule, from: Date, to: Date): Date[] {
    if (!schedule.start_time) return [];
    const [hh, mm] = schedule.start_time.split(':').map(Number);
    const allowedDays = schedule.days_of_week.split(',').map(Number);
    const out: Date[] = [];

    const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate(), hh, mm, 0, 0);
    while (cursor.getTime() <= to.getTime()) {
      if (cursor.getTime() >= from.getTime() && allowedDays.includes(cursor.getDay())) {
        out.push(new Date(cursor.getTime()));
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return out;
  }

  /**
   * Merged occurrences across all schedules for a target, with conflict
   * resolution applied. `target` is optional — if omitted, returns all
   * schedules.
   */
  async simulateForTarget(
    from: Date,
    to: Date,
    target?: { client_id?: string; group_id?: number }
  ): Promise<SimulationResult> {
    const db = await getDatabase();
    const schedules = await db.getEnabledSchedules();

    const candidates = schedules.filter((s) => {
      if (!target) return true;
      if (target.client_id) {
        // include client-specific, group the client belongs to, and global
        if (s.client_id === target.client_id) return true;
        if (s.client_id) return false;
        return true; // group_id might include; global always
      }
      if (target.group_id) {
        if (s.group_id === target.group_id) return true;
        if (s.group_id) return false;
        if (s.client_id) return false;
        return true;
      }
      return true;
    });

    type Tuple = { fires: Date; s: Schedule };
    const tuples: Tuple[] = [];
    for (const s of candidates) {
      for (const fires of this.simulateSchedule(s, from, to)) {
        tuples.push({ fires, s });
      }
    }

    // Group by minute + targetKey to detect conflicts.
    type Bucket = { fires: Date; target: string; entries: Tuple[] };
    const buckets = new Map<string, Bucket>();
    for (const t of tuples) {
      const minute = Math.floor(t.fires.getTime() / 60_000);
      const key = `${minute}|${targetKeyFor(t.s)}`;
      let b = buckets.get(key);
      if (!b) {
        b = { fires: t.fires, target: targetKeyFor(t.s), entries: [] };
        buckets.set(key, b);
      }
      b.entries.push(t);
    }

    const occurrences: SimulationOccurrence[] = [];
    const conflicts: SimulationResult['conflicts'] = [];

    for (const b of buckets.values()) {
      const { winners, losers } = resolveConflicts(b.entries.map((e) => e.s));
      for (const [, winner] of winners) {
        occurrences.push({
          schedule_id: winner.id,
          schedule_name: winner.name,
          playlist_id: winner.playlist_id,
          target: targetKeyFor(winner),
          priority: winner.priority,
          fires_at: b.fires.toISOString(),
          ends_at: winner.duration_seconds
            ? new Date(b.fires.getTime() + winner.duration_seconds * 1000).toISOString()
            : null,
          interrupt_mode: winner.interrupt_mode,
        });
        if (losers.size > 0) {
          conflicts.push({
            fires_at: b.fires.toISOString(),
            target: targetKeyFor(winner),
            winner_id: winner.id,
            loser_ids: losers.get(targetKeyFor(winner))?.map((l) => l.id) ?? [],
          });
        }
      }
    }

    occurrences.sort((a, b) => a.fires_at.localeCompare(b.fires_at));
    return { occurrences, conflicts };
  }

  // ── Background interval ──────────────────────────────────────────────────

  startEvaluation(intervalMs: number = 60_000): void {
    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval);
    }
    this.evaluationInterval = setInterval(() => {
      this.evaluateSchedules().catch((error) => {
        logger.error('Schedule evaluation error:', error);
      });
    }, intervalMs);
    logger.info(`Schedule evaluation started (interval: ${intervalMs}ms)`);
  }

  stopEvaluation(): void {
    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval);
      this.evaluationInterval = null;
    }
    for (const timer of this.resumeTimers.values()) clearTimeout(timer);
    this.resumeTimers.clear();
    logger.info('Schedule evaluation stopped');
  }

  // ── Validation ───────────────────────────────────────────────────────────

  private validateInput(input: CreateScheduleInput | UpdateScheduleInput): void {
    if ('cron_expression' in input && input.cron_expression) {
      const err = validateCron(input.cron_expression);
      if (err) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, `Invalid cron expression: ${err}`, 400);
      }
    }
    if (
      input.interrupt_mode === 'interrupt' &&
      input.duration_seconds !== undefined &&
      input.duration_seconds !== null &&
      input.duration_seconds <= 0
    ) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'duration_seconds must be positive when interrupt_mode is "interrupt"',
        400
      );
    }
  }
}

export const scheduleService = new ScheduleService();
