/**
 * Telemetry Service
 * Stores client system metrics + log events and evaluates alerting thresholds.
 *
 * Threshold-based alerts are dispatched through the existing NotificationService.
 * To avoid altering migration 008's CHECK constraint on notification_rules.event_type,
 * telemetry alerts reuse the existing event types and put a `subtype` discriminator
 * in the payload:
 *   - disk warnings  → 'storage_full'
 *   - cpu/temp/mpv   → 'client_error'
 */

import { getDatabase } from '../database/connection';
import {
  ClientTelemetryRow,
  CreateClientTelemetryInput,
  CreateClientLogEventInput,
  ClientLogEventRow,
  ClientLogLevel,
} from '../database/types';
import { getLogger } from '../utils/logger';
import { notificationService } from './notification.service';

const logger = getLogger();

/**
 * Hardcoded alerting thresholds. Tuned conservatively for v1; expose as
 * configuration in a future PR if operators need to override.
 */
export const TELEMETRY_THRESHOLDS = {
  disk_warn_pct_free: 10,
  disk_crit_pct_free: 5,
  cpu_warn_pct: 90,
  /** How many consecutive ticks of CPU >= cpu_warn_pct before firing. 60s ticks → 5 ticks ≈ 5 min. */
  cpu_warn_consecutive_ticks: 5,
  temp_warn_celsius: 85,
} as const;

/** Subtype discriminators we put in the notification payload. */
export type TelemetryAlertSubtype =
  | 'disk_low_warn'
  | 'disk_low_crit'
  | 'cpu_high'
  | 'temp_high'
  | 'mpv_dead';

function diskPctFree(used: number, total: number): number {
  if (!total) return 100;
  return ((total - used) / total) * 100;
}

function maxTempCelsius(temps: { celsius: number }[]): number | null {
  if (!temps.length) return null;
  return temps.reduce((max, t) => (t.celsius > max ? t.celsius : max), -Infinity);
}

export class TelemetryService {
  async recordTelemetry(input: CreateClientTelemetryInput): Promise<ClientTelemetryRow> {
    const db = await getDatabase();
    return db.recordClientTelemetry(input);
  }

  async recordLogEvent(input: CreateClientLogEventInput): Promise<ClientLogEventRow> {
    const db = await getDatabase();
    return db.recordClientLogEvent(input);
  }

  async getTelemetryRange(
    clientId: string,
    fromMs: number,
    toMs: number,
    limit?: number
  ): Promise<ClientTelemetryRow[]> {
    const db = await getDatabase();
    return db.getClientTelemetryRange(clientId, fromMs, toMs, limit);
  }

  async getTelemetryLatest(clientId: string): Promise<ClientTelemetryRow | null> {
    const db = await getDatabase();
    return db.getClientTelemetryLatest(clientId);
  }

  async getAllTelemetryLatest(): Promise<Record<string, ClientTelemetryRow>> {
    const db = await getDatabase();
    return db.getAllClientTelemetryLatest();
  }

  async getLogEvents(
    clientId: string,
    level?: ClientLogLevel,
    limit?: number
  ): Promise<ClientLogEventRow[]> {
    const db = await getDatabase();
    return db.getClientLogEvents(clientId, level, limit);
  }

  /**
   * Evaluates alerting thresholds against the latest telemetry sample.
   *
   * Uses rising-edge detection: a metric must transition from "OK" to "exceeded"
   * before firing a notification. This prevents spamming the operator every minute
   * while a disk stays full.
   *
   * For CPU, the rising edge requires `cpu_warn_consecutive_ticks` consecutive
   * over-threshold readings — a single spike does not page.
   *
   * Should be called *after* the new telemetry row has been inserted, so the
   * "previous" rows include the just-inserted one at index 0.
   */
  async evaluateThresholds(input: CreateClientTelemetryInput): Promise<void> {
    const db = await getDatabase();
    const recent = await db.getClientTelemetryRange(
      input.client_id,
      Date.now() - 10 * 60 * 1000,
      Date.now() + 1000,
      TELEMETRY_THRESHOLDS.cpu_warn_consecutive_ticks + 2
    );
    // recent is ASC by recorded_at; the most recent (just inserted) is the last element.
    const previous = recent.slice(0, -1);

    // Disk: warn / crit thresholds, rising edge per mount.
    for (const disk of input.disks) {
      const pctFree = diskPctFree(disk.used_bytes, disk.total_bytes);
      const wasUnderCrit = previous.some((row) => {
        const prev = row.disks.find((d) => d.mount === disk.mount);
        return (
          !prev ||
          diskPctFree(prev.used_bytes, prev.total_bytes) > TELEMETRY_THRESHOLDS.disk_crit_pct_free
        );
      });
      const wasUnderWarn = previous.some((row) => {
        const prev = row.disks.find((d) => d.mount === disk.mount);
        return (
          !prev ||
          diskPctFree(prev.used_bytes, prev.total_bytes) > TELEMETRY_THRESHOLDS.disk_warn_pct_free
        );
      });

      if (pctFree <= TELEMETRY_THRESHOLDS.disk_crit_pct_free && wasUnderCrit) {
        await this.fireAlert('storage_full', 'disk_low_crit', input.client_id, {
          mount: disk.mount,
          pct_free: pctFree,
          threshold: TELEMETRY_THRESHOLDS.disk_crit_pct_free,
        });
      } else if (
        pctFree <= TELEMETRY_THRESHOLDS.disk_warn_pct_free &&
        pctFree > TELEMETRY_THRESHOLDS.disk_crit_pct_free &&
        wasUnderWarn
      ) {
        await this.fireAlert('storage_full', 'disk_low_warn', input.client_id, {
          mount: disk.mount,
          pct_free: pctFree,
          threshold: TELEMETRY_THRESHOLDS.disk_warn_pct_free,
        });
      }
    }

    // CPU: rising edge after N consecutive over-threshold ticks.
    if (input.cpu_pct >= TELEMETRY_THRESHOLDS.cpu_warn_pct) {
      const ticksNeeded = TELEMETRY_THRESHOLDS.cpu_warn_consecutive_ticks;
      const lastNticks = previous.slice(-ticksNeeded + 1);
      const allOver =
        lastNticks.length === ticksNeeded - 1 &&
        lastNticks.every((r) => r.cpu_pct >= TELEMETRY_THRESHOLDS.cpu_warn_pct);
      // Rising edge: tick *before* this run must have been below threshold (or no history yet).
      const tickBefore = previous[previous.length - ticksNeeded];
      const risingEdge = !tickBefore || tickBefore.cpu_pct < TELEMETRY_THRESHOLDS.cpu_warn_pct;
      if (allOver && risingEdge) {
        await this.fireAlert('client_error', 'cpu_high', input.client_id, {
          cpu_pct: input.cpu_pct,
          threshold: TELEMETRY_THRESHOLDS.cpu_warn_pct,
          sustained_ticks: ticksNeeded,
        });
      }
    }

    // Temperature: simple rising edge.
    const maxTemp = maxTempCelsius(input.temps);
    if (maxTemp !== null && maxTemp >= TELEMETRY_THRESHOLDS.temp_warn_celsius) {
      const prevTemp = previous.length ? maxTempCelsius(previous[previous.length - 1].temps) : null;
      if (prevTemp === null || prevTemp < TELEMETRY_THRESHOLDS.temp_warn_celsius) {
        await this.fireAlert('client_error', 'temp_high', input.client_id, {
          celsius: maxTemp,
          threshold: TELEMETRY_THRESHOLDS.temp_warn_celsius,
        });
      }
    }

    // mpv dead: rising edge.
    if (input.mpv && input.mpv.alive === false) {
      const prevMpv = previous.length ? previous[previous.length - 1].mpv : null;
      if (!prevMpv || prevMpv.alive === true) {
        await this.fireAlert('client_error', 'mpv_dead', input.client_id, {
          last_decoder_error: input.mpv.last_decoder_error,
        });
      }
    }
  }

  private async fireAlert(
    eventType: 'storage_full' | 'client_error',
    subtype: TelemetryAlertSubtype,
    clientId: string,
    extra: Record<string, unknown>
  ): Promise<void> {
    try {
      await notificationService.fireEvent(eventType, {
        subtype,
        client_id: clientId,
        ...extra,
      });
      logger.info(`Telemetry alert fired: ${subtype} for client ${clientId}`);
    } catch (err) {
      logger.error(`Failed to fire telemetry alert ${subtype} for ${clientId}:`, err);
    }
  }
}

export const telemetryService = new TelemetryService();
