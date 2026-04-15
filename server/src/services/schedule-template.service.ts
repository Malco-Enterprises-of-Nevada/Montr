/**
 * Schedule Template Service
 * CRUD for built-in and user-defined schedule templates, plus instantiation.
 */

import { getDatabase } from '../database/connection';
import {
  Schedule,
  ScheduleTemplate,
  CreateScheduleTemplateInput,
  CreateScheduleInput,
} from '../database/types';
import { AppError, ErrorCode } from '../api/middleware/error-handler';
import { scheduleService } from './schedule.service';
import { getLogger } from '../utils/logger';

const logger = getLogger();

export interface InstantiateTemplateInput {
  name: string;
  playlist_id: number;
  client_id?: string;
  group_id?: number;
  /** Overrides applied on top of the template definition (optional). */
  overrides?: Partial<CreateScheduleInput>;
}

export class ScheduleTemplateService {
  async createTemplate(input: CreateScheduleTemplateInput): Promise<ScheduleTemplate> {
    if (!input.name?.trim()) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, 'Template name is required', 400);
    }
    const db = await getDatabase();
    const tpl = await db.createScheduleTemplate(input);
    logger.info(`Schedule template created: ${tpl.id} - ${tpl.name}`);
    return tpl;
  }

  async getTemplateById(id: number): Promise<ScheduleTemplate> {
    const db = await getDatabase();
    const tpl = await db.getScheduleTemplateById(id);
    if (!tpl) {
      throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, `Template with ID ${id} not found`, 404);
    }
    return tpl;
  }

  async getAllTemplates(): Promise<ScheduleTemplate[]> {
    const db = await getDatabase();
    return db.getAllScheduleTemplates();
  }

  async deleteTemplate(id: number): Promise<void> {
    const tpl = await this.getTemplateById(id);
    if (tpl.is_builtin) {
      throw new AppError(ErrorCode.BAD_REQUEST, 'Built-in templates cannot be deleted', 400);
    }
    const db = await getDatabase();
    await db.deleteScheduleTemplate(id);
    logger.info(`Schedule template deleted: ${id}`);
  }

  /**
   * Creates a new schedule by merging the template definition with caller
   * fields (name, target, playlist, and optional overrides).
   */
  async instantiate(id: number, input: InstantiateTemplateInput): Promise<Schedule> {
    const tpl = await this.getTemplateById(id);
    const def = tpl.definition;

    const merged: CreateScheduleInput = {
      name: input.name,
      playlist_id: input.playlist_id,
      client_id: input.client_id,
      group_id: input.group_id,
      template_id: tpl.id,
      start_time: def.start_time,
      end_time: def.end_time,
      days_of_week: def.days_of_week,
      cron_expression: def.cron_expression,
      duration_seconds: def.duration_seconds,
      timezone: def.timezone,
      conditions: def.conditions,
      interrupt_mode: def.interrupt_mode,
      priority: def.priority,
      ...input.overrides,
    };

    return scheduleService.createSchedule(merged);
  }
}

export const scheduleTemplateService = new ScheduleTemplateService();
