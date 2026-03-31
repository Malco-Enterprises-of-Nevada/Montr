/**
 * Schedule Service
 * Handles schedule CRUD, evaluation, and background playlist switching
 */

import { getDatabase } from '../database/connection';
import { Schedule, CreateScheduleInput, UpdateScheduleInput } from '../database/types';
import { getLogger } from '../utils/logger';
import { AppError, ErrorCode } from '../api/middleware/error-handler';
import { sendPlaylistToClient, sendPlaylistToGroup } from '../websocket/handlers';
import { clientConnectionManager } from '../websocket/client-manager';

const logger = getLogger();

export class ScheduleService {
  private evaluationInterval: NodeJS.Timeout | null = null;

  private lastTriggered: Map<number, string> = new Map();

  /**
   * Creates a new schedule
   */
  async createSchedule(input: CreateScheduleInput): Promise<Schedule> {
    const db = await getDatabase();

    // Validate playlist exists
    const playlist = await db.getPlaylistById(input.playlist_id);
    if (!playlist) {
      throw new AppError(
        ErrorCode.PLAYLIST_NOT_FOUND,
        `Playlist with ID ${input.playlist_id} not found`,
        404
      );
    }

    // Validate client or group exists if specified
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

  /**
   * Gets a schedule by ID
   */
  async getScheduleById(id: number): Promise<Schedule> {
    const db = await getDatabase();
    const schedule = await db.getScheduleById(id);
    if (!schedule) {
      throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, `Schedule with ID ${id} not found`, 404);
    }
    return schedule;
  }

  /**
   * Lists all schedules
   */
  async getAllSchedules(): Promise<Schedule[]> {
    const db = await getDatabase();
    return db.getAllSchedules();
  }

  /**
   * Updates a schedule
   */
  async updateSchedule(id: number, input: UpdateScheduleInput): Promise<Schedule> {
    await this.getScheduleById(id);

    const db = await getDatabase();

    // Validate playlist if changing
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

  /**
   * Deletes a schedule
   */
  async deleteSchedule(id: number): Promise<void> {
    await this.getScheduleById(id);
    const db = await getDatabase();
    await db.deleteSchedule(id);
    this.lastTriggered.delete(id);
    logger.info(`Schedule deleted: ${id}`);
  }

  /**
   * Checks if a schedule is currently active based on time and day
   */
  isScheduleActive(schedule: Schedule, now: Date = new Date()): boolean {
    if (!schedule.enabled) return false;

    // Check day of week (0=Sunday, 6=Saturday)
    const currentDay = now.getDay();
    const allowedDays = schedule.days_of_week.split(',').map(Number);
    if (!allowedDays.includes(currentDay)) return false;

    // Check time window (HH:MM format)
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    if (currentTime < schedule.start_time) return false;
    if (schedule.end_time && currentTime >= schedule.end_time) return false;

    return true;
  }

  /**
   * Evaluates all enabled schedules and triggers playlist switches
   */
  async evaluateSchedules(): Promise<void> {
    try {
      const db = await getDatabase();
      const schedules = await db.getEnabledSchedules();
      const now = new Date();
      const minuteKey = `${now.getHours()}:${now.getMinutes()}`;

      for (const schedule of schedules) {
        if (!this.isScheduleActive(schedule, now)) continue;

        // Only trigger once per minute per schedule
        if (this.lastTriggered.get(schedule.id) === minuteKey) continue;
        this.lastTriggered.set(schedule.id, minuteKey);

        // Only trigger at start_time (not throughout the window)
        const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        if (currentTime !== schedule.start_time) continue;

        logger.info(`Schedule ${schedule.id} (${schedule.name}) triggered`);

        if (schedule.client_id) {
          // Assign to specific client
          await db.updateClient(schedule.client_id, {
            assigned_playlist_id: schedule.playlist_id,
          });
          if (clientConnectionManager.isConnected(schedule.client_id)) {
            await sendPlaylistToClient(schedule.client_id, schedule.playlist_id);
          }
        } else if (schedule.group_id) {
          // Assign to group
          const members = await db.getGroupMembers(schedule.group_id);
          for (const member of members) {
            await db.updateClient(member.id, {
              assigned_playlist_id: schedule.playlist_id,
            });
          }
          await sendPlaylistToGroup(schedule.group_id, schedule.playlist_id);
        } else {
          // No target — assign to all connected clients
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
    } catch (error) {
      logger.error('Error evaluating schedules:', error);
    }
  }

  /**
   * Starts the background schedule evaluation interval
   */
  startEvaluation(intervalMs: number = 60000): void {
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

  /**
   * Stops the background schedule evaluation
   */
  stopEvaluation(): void {
    if (this.evaluationInterval) {
      clearInterval(this.evaluationInterval);
      this.evaluationInterval = null;
      logger.info('Schedule evaluation stopped');
    }
  }
}

export const scheduleService = new ScheduleService();
