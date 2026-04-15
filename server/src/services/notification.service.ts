/**
 * Notification Service
 * Dispatches email and webhook notifications based on configurable rules
 */

import nodemailer from 'nodemailer';
import { getDatabase } from '../database/connection';
import {
  NotificationRule,
  CreateNotificationRuleInput,
  NotificationEventType,
  NotificationHistory,
} from '../database/types';
import { getLogger } from '../utils/logger';
import { AppError, ErrorCode } from '../api/middleware/error-handler';
import { scheduleService } from './schedule.service';

const logger = getLogger();

export class NotificationService {
  private transporter: nodemailer.Transporter | null = null;

  /**
   * Initializes the SMTP transporter if configured
   */
  initializeEmail(): void {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (host && user) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
      logger.info(`SMTP configured: ${host}:${port}`);
    }
  }

  // ── Rule CRUD ───────────────────────────────────────────────────────────

  async createRule(input: CreateNotificationRuleInput): Promise<NotificationRule> {
    const db = await getDatabase();
    const rule = await db.createNotificationRule(input);
    logger.info(`Notification rule created: ${rule.id} - ${rule.name}`);
    return rule;
  }

  async getRuleById(id: number): Promise<NotificationRule> {
    const db = await getDatabase();
    const rule = await db.getNotificationRuleById(id);
    if (!rule) {
      throw new AppError(
        ErrorCode.RESOURCE_NOT_FOUND,
        `Notification rule with ID ${id} not found`,
        404
      );
    }
    return rule;
  }

  async getAllRules(): Promise<NotificationRule[]> {
    const db = await getDatabase();
    return db.getAllNotificationRules();
  }

  async deleteRule(id: number): Promise<void> {
    await this.getRuleById(id);
    const db = await getDatabase();
    await db.deleteNotificationRule(id);
    logger.info(`Notification rule deleted: ${id}`);
  }

  async getHistory(limit?: number): Promise<NotificationHistory[]> {
    const db = await getDatabase();
    return db.getNotificationHistory(limit);
  }

  // ── Event Triggering ────────────────────────────────────────────────────

  /**
   * Fires notifications for an event. Finds all enabled rules matching
   * the event type and dispatches to each.
   */
  async fireEvent(
    eventType: NotificationEventType,
    payload: Record<string, unknown>
  ): Promise<number> {
    const db = await getDatabase();
    const rules = await db.getEnabledRulesForEvent(eventType);

    let sentCount = 0;
    for (const rule of rules) {
      const success = await this.dispatch(rule, payload);
      if (success) sentCount++;
    }

    if (rules.length > 0) {
      logger.info(`Event '${eventType}': dispatched to ${sentCount}/${rules.length} rules`);
    }

    // Fan out to event-triggered schedules. Run async but await so callers
    // can assert on side effects in tests.
    try {
      await scheduleService.onEvent(eventType, payload);
    } catch (err) {
      logger.error('Schedule onEvent dispatch failed:', err);
    }

    return sentCount;
  }

  /**
   * Dispatches a notification to a single rule's channel
   */
  private async dispatch(
    rule: NotificationRule,
    payload: Record<string, unknown>
  ): Promise<boolean> {
    const db = await getDatabase();
    const payloadJson = JSON.stringify(payload);

    try {
      if (rule.channel === 'webhook') {
        await this.sendWebhook(rule.destination, payload);
      } else if (rule.channel === 'email') {
        await this.sendEmail(rule.destination, rule.event_type, payload);
      }

      await db.createNotificationHistory({
        rule_id: rule.id,
        event_type: rule.event_type,
        channel: rule.channel,
        destination: rule.destination,
        payload: payloadJson,
        status: 'sent',
        error_message: null,
      });
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Notification dispatch failed for rule ${rule.id}: ${errorMsg}`);

      await db.createNotificationHistory({
        rule_id: rule.id,
        event_type: rule.event_type,
        channel: rule.channel,
        destination: rule.destination,
        payload: payloadJson,
        status: 'failed',
        error_message: errorMsg,
      });
      return false;
    }
  }

  /**
   * Sends a webhook notification via HTTP POST
   */
  private async sendWebhook(url: string, payload: Record<string, unknown>): Promise<void> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'montr',
        timestamp: new Date().toISOString(),
        ...payload,
      }),
    });

    if (!response.ok) {
      throw new Error(`Webhook failed with status ${response.status}`);
    }
  }

  /**
   * Sends an email notification
   */
  private async sendEmail(
    to: string,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.transporter) {
      throw new Error('SMTP not configured. Set SMTP_HOST and SMTP_USER environment variables.');
    }

    const from = process.env.SMTP_FROM || process.env.SMTP_USER;
    const subject = `[Montr] ${eventType.replace(/_/g, ' ')}`;
    const text = Object.entries(payload)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join('\n');

    await this.transporter.sendMail({
      from,
      to,
      subject,
      text: `Montr Notification\n\nEvent: ${eventType}\nTime: ${new Date().toISOString()}\n\n${text}`,
    });
  }
}

export const notificationService = new NotificationService();
