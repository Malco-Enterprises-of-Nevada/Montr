/**
 * Analytics Service
 * Handles playback logging, aggregation, and data retention
 */

import { getDatabase } from '../database/connection';
import { PlaybackLog, PlaybackSummary, MediaPopularity, UptimeStat } from '../database/types';
import { getLogger } from '../utils/logger';
import { AppError, ErrorCode } from '../api/middleware/error-handler';

const logger = getLogger();

export class AnalyticsService {
  /**
   * Records a playback start event
   */
  async recordPlaybackStart(clientId: string, mediaId: number): Promise<PlaybackLog> {
    const db = await getDatabase();

    const client = await db.getClientById(clientId);
    if (!client) {
      throw new AppError(ErrorCode.CLIENT_NOT_FOUND, `Client ${clientId} not found`, 404);
    }

    const media = await db.getMediaById(mediaId);
    if (!media) {
      throw new AppError(ErrorCode.MEDIA_NOT_FOUND, `Media ${mediaId} not found`, 404);
    }

    const log = await db.createPlaybackLog({
      client_id: clientId,
      media_id: mediaId,
    });

    logger.info(`Playback started: client ${clientId}, media ${mediaId}`);
    return log;
  }

  /**
   * Records a playback end event
   */
  async recordPlaybackEnd(
    logId: number,
    durationWatched: number,
    completed: boolean
  ): Promise<PlaybackLog> {
    const db = await getDatabase();
    const log = await db.updatePlaybackLog(logId, {
      ended_at: new Date().toISOString(),
      duration_watched: durationWatched,
      completed,
    });

    logger.info(
      `Playback ended: log ${logId}, duration ${durationWatched}s, completed: ${completed}`
    );
    return log;
  }

  /**
   * Gets playback history with optional filters
   */
  async getPlaybackHistory(filter?: {
    client_id?: string;
    media_id?: number;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<PlaybackLog[]> {
    const db = await getDatabase();
    return db.getPlaybackLogs(filter);
  }

  /**
   * Gets playback summary grouped by client
   */
  async getPlaybackSummary(from?: string, to?: string): Promise<PlaybackSummary[]> {
    const db = await getDatabase();
    return db.getPlaybackSummaryByClient(from, to);
  }

  /**
   * Gets media popularity ranking
   */
  async getMediaPopularity(limit: number = 20): Promise<MediaPopularity[]> {
    const db = await getDatabase();
    return db.getMediaPopularity(limit);
  }

  /**
   * Gets client uptime statistics
   */
  async getUptimeStats(): Promise<UptimeStat[]> {
    const db = await getDatabase();
    return db.getClientUptimeStats();
  }

  /**
   * Cleans up old playback logs, client telemetry, and client log events.
   * All three tables share the same retention policy.
   */
  async cleanupOldLogs(retentionDays: number = 90): Promise<number> {
    const db = await getDatabase();
    const deletedPlayback = await db.deleteOldPlaybackLogs(retentionDays);
    const deletedTelemetry = await db.deleteOldClientTelemetry(retentionDays);
    const deletedLogEvents = await db.deleteOldClientLogEvents(retentionDays);
    const total = deletedPlayback + deletedTelemetry + deletedLogEvents;
    if (total > 0) {
      logger.info(
        `Cleaned up ${deletedPlayback} playback logs, ${deletedTelemetry} telemetry rows, ` +
          `${deletedLogEvents} log events older than ${retentionDays} days`
      );
    }
    return total;
  }
}

export const analyticsService = new AnalyticsService();
