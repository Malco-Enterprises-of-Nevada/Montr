/**
 * WebSocket Message Handlers
 * Processes incoming client messages
 */

import { getLogger } from '../utils/logger';
import { clientService } from '../services/client.service';
import { playlistService } from '../services/playlist.service';
import { scheduleService } from '../services/schedule.service';
import { telemetryService } from '../services/telemetry.service';
import { clientConnectionManager } from './client-manager';
import {
  RegisterMessage,
  StatusUpdateMessage,
  HeartbeatMessage,
  ErrorMessage,
  TelemetryMessage,
  LogEventMessage,
  ExtendedWebSocket,
  PlaylistMediaItem,
  SubtitleTrackPayload,
} from './types';
import { AppError, ErrorCode } from '../api/middleware/error-handler';
import { config } from '../config/config';
import { storageService } from '../services/storage.service';
import { PlaylistItemWithMedia, SubtitleTrack } from '../database/types';
import { getDatabase } from '../database/connection';

const logger = getLogger();

function getMediaDownloadUrl(mediaId: number, filepath: string): string {
  if (config.storage.backend === 'spaces') {
    return storageService.getDownloadUrl(filepath);
  }
  return `${config.server.publicUrl || `http://localhost:${config.server.port}`}/api/media/${mediaId}/download`;
}

function getSubtitleDownloadUrl(subtitleId: number): string {
  return `${config.server.publicUrl || `http://localhost:${config.server.port}`}/api/subtitles/${subtitleId}/download`;
}

function toSubtitlePayload(row: SubtitleTrack): SubtitleTrackPayload {
  if (row.kind === 'external') {
    return {
      id: row.id,
      kind: 'external',
      language: row.language,
      label: row.label,
      isDefault: row.is_default,
      isForced: row.is_forced,
      downloadUrl: getSubtitleDownloadUrl(row.id),
      filename: row.storage_filename ? `${row.id}.${row.format ?? 'srt'}` : undefined,
      format: row.format ?? undefined,
      checksum: row.checksum ?? undefined,
    };
  }
  return {
    id: row.id,
    kind: 'embedded',
    language: row.language,
    label: row.label,
    isDefault: row.is_default,
    isForced: row.is_forced,
    streamIndex: row.stream_index ?? undefined,
    codec: row.codec ?? undefined,
  };
}

/**
 * Fetch subtitle tracks for every video in the playlist in a single pass.
 * Image items get an empty array without a DB round-trip. Returns a map
 * keyed by media_file_id for O(1) lookup when shaping the payload.
 */
async function fetchSubtitlesByMedia(
  items: PlaylistItemWithMedia[]
): Promise<Map<number, SubtitleTrackPayload[]>> {
  const db = await getDatabase();
  const videoMediaIds = Array.from(
    new Set(items.filter((i) => i.media.type === 'video').map((i) => i.media_id))
  );
  const result = new Map<number, SubtitleTrackPayload[]>();
  for (const mediaId of videoMediaIds) {
    const rows = await db.getSubtitlesForMedia(mediaId);
    result.set(mediaId, rows.map(toSubtitlePayload));
  }
  return result;
}

function buildPlaylistItem(
  item: PlaylistItemWithMedia,
  subtitlesByMedia: Map<number, SubtitleTrackPayload[]>
): PlaylistMediaItem {
  return {
    id: item.id,
    mediaId: item.media_id,
    filename: item.media.filename,
    downloadUrl: getMediaDownloadUrl(item.media_id, item.media.filepath),
    type: item.media.type,
    duration: item.media.type === 'image' ? item.image_duration : item.media.duration || 0,
    checksum: item.media.checksum,
    orderIndex: item.order_index,
    imageDuration: item.image_duration,
    subtitles: subtitlesByMedia.get(item.media_id) ?? [],
    // Optional — clients on protocol < 1.2.0 ignore it. Only emit when the
    // server actually has a size; legacy rows or rows mid-upload may be null.
    ...(item.media.file_size != null ? { fileSize: item.media.file_size } : {}),
  };
}

/**
 * Handles client registration
 */
export async function handleRegister(
  ws: ExtendedWebSocket,
  message: RegisterMessage
): Promise<void> {
  const { clientId, version, capabilities, name } = message;

  try {
    logger.info(`Client registration request: ${clientId} (version: ${version})`);

    // Serialize capabilities as JSON string
    const capabilitiesJson = JSON.stringify(capabilities);

    // Check if client already exists
    let client;
    try {
      client = await clientService.getClientById(clientId);

      // Client exists - update it (include name if provided)
      client = await clientService.updateClient(clientId, {
        version,
        capabilities: capabilitiesJson,
        status: 'online',
        last_seen: new Date().toISOString(),
        ...(name && { name }),
      });

      logger.info(`Existing client reconnected: ${clientId} - ${client.name}`);
    } catch (error) {
      if (error instanceof AppError && error.code === ErrorCode.CLIENT_NOT_FOUND) {
        // Client doesn't exist - register new client
        client = await clientService.registerClient({
          id: clientId,
          name: name || `Client-${clientId.substring(0, 8)}`,
          version,
          capabilities: capabilitiesJson,
        });

        // Set status to online after registration
        client = await clientService.updateClient(clientId, {
          status: 'online',
          last_seen: new Date().toISOString(),
        });

        logger.info(`New client registered: ${clientId} - ${client.name}`);
      } else {
        throw error;
      }
    }

    // Add connection to manager
    clientConnectionManager.addConnection(clientId, ws);

    // Broadcast online state to admin browsers
    clientConnectionManager.broadcastToAdmins({
      type: 'client_state_change',
      clientId,
      status: 'online',
    });

    // Send success response
    clientConnectionManager.sendSuccess(clientId, 'Registration successful');

    // If client has an assigned playlist, send it
    if (client.assigned_playlist_id !== null) {
      await sendPlaylistToClient(clientId, client.assigned_playlist_id);
    }

    // Push the schedules that apply to this client so it can locally
    // re-evaluate while offline. Best-effort — failures here don't block
    // registration.
    await sendSchedulesToClient(clientId);
  } catch (error) {
    logger.error(`Error handling client registration for ${clientId}:`, error);

    const errorMessage = error instanceof Error ? error.message : 'Registration failed';
    clientConnectionManager.sendError(clientId, errorMessage);

    // Close the connection on registration failure
    if (ws.readyState === ws.OPEN) {
      ws.close(1008, 'Registration failed');
    }
  }
}

/**
 * Handles client status update
 */
export async function handleStatusUpdate(
  _ws: ExtendedWebSocket,
  message: StatusUpdateMessage
): Promise<void> {
  const { clientId, currentMedia, position, isPlaying } = message;

  try {
    // Verify client is connected
    if (!clientConnectionManager.isConnected(clientId)) {
      logger.warn(`Received status update from unregistered client: ${clientId}`);
      clientConnectionManager.sendError(clientId, 'Client not registered');
      return;
    }

    // Record status in database
    await clientService.recordClientStatus({
      client_id: clientId,
      current_media_id: currentMedia?.id ?? undefined,
      position: position ?? undefined,
      is_playing: isPlaying,
    });

    // Update heartbeat
    clientConnectionManager.updateHeartbeat(clientId);

    // Broadcast to admin browsers for real-time dashboard updates
    clientConnectionManager.broadcastToAdmins({
      type: 'client_status_update',
      clientId,
      currentMedia,
      position,
      isPlaying,
      timestamp: Date.now(),
    });

    logger.debug(
      `Status update from ${clientId}: ${isPlaying ? 'playing' : 'paused'} ${currentMedia?.filename || 'no media'} at ${position}s`
    );
  } catch (error) {
    logger.error(`Error handling status update for ${clientId}:`, error);

    const errorMessage = error instanceof Error ? error.message : 'Failed to record status';
    clientConnectionManager.sendError(clientId, errorMessage);
  }
}

/**
 * Handles client heartbeat
 */
export async function handleHeartbeat(
  _ws: ExtendedWebSocket,
  message: HeartbeatMessage
): Promise<void> {
  const { clientId } = message;

  try {
    // Verify client is connected
    if (!clientConnectionManager.isConnected(clientId)) {
      logger.warn(`Received heartbeat from unregistered client: ${clientId}`);
      clientConnectionManager.sendError(clientId, 'Client not registered');
      return;
    }

    // Update heartbeat timestamp
    await clientService.updateHeartbeat(clientId);
    clientConnectionManager.updateHeartbeat(clientId);

    logger.debug(`Heartbeat received from ${clientId}`);
  } catch (error) {
    logger.error(`Error handling heartbeat for ${clientId}:`, error);
  }
}

/**
 * Handles client error report.
 *
 * Severity controls server-side handling:
 * - `warn`: log + broadcast to admins. No status flap, no DB row.
 * - `error` (default if missing — legacy clients): the above plus persist the
 *   error to client status and mark the client as `error`.
 * - `fatal`: above plus fire `client_error` notification rules.
 */
export async function handleError(_ws: ExtendedWebSocket, message: ErrorMessage): Promise<void> {
  const { clientId, error: errorMsg, context, source } = message;
  const severity = message.severity ?? 'error';

  try {
    if (!clientConnectionManager.isConnected(clientId)) {
      logger.warn(`Received error from unregistered client: ${clientId}`);
      return;
    }

    const logCtx = { source, severity, ...(context ?? {}) };
    if (severity === 'warn') {
      logger.warn(`Client ${clientId} reported warning: ${errorMsg}`, logCtx);
    } else {
      logger.error(`Client ${clientId} reported ${severity}: ${errorMsg}`, logCtx);
    }

    // Always broadcast so the admin UI sees the event in real time.
    clientConnectionManager.broadcastToAdmins({
      type: 'client_error',
      clientId,
      error: errorMsg,
      source,
      severity,
      context,
      timestamp: Date.now(),
    });

    // Only treat error/fatal as a status-flapping event. `warn` is purely
    // informational so transient hiccups don't mark the client as faulted.
    if (severity !== 'warn') {
      await clientService.recordClientStatus({
        client_id: clientId,
        is_playing: false,
        error_message: errorMsg,
      });

      await clientService.updateClient(clientId, {
        status: 'error',
        last_seen: new Date().toISOString(),
      });
    }

    if (severity === 'fatal') {
      // Best-effort fan-out to notification rules; never block the WS handler.
      try {
        const { notificationService } = await import('../services/notification.service');
        await notificationService.fireEvent('client_error', {
          clientId,
          error: errorMsg,
          source,
          context,
        });
      } catch (notifyErr) {
        logger.error(`Failed to fire client_error notification for ${clientId}:`, notifyErr);
      }
    }

    // Cache subsystem reporting `storage_low` is the client-side counterpart
    // to the existing `storage_full` notification event. Route any severity
    // here (the throttling lives on the client) so an admin's notification
    // rule fires when a fleet member is running out of disk.
    if (source === 'cache' && errorMsg === 'storage_low') {
      try {
        const { notificationService } = await import('../services/notification.service');
        await notificationService.fireEvent('storage_full', {
          clientId,
          source,
          context,
        });
      } catch (notifyErr) {
        logger.error(`Failed to fire storage_full notification for ${clientId}:`, notifyErr);
      }
    }

    clientConnectionManager.updateHeartbeat(clientId);
  } catch (error) {
    logger.error(`Error handling error report from ${clientId}:`, error);
  }
}

/**
 * Handles client telemetry message (60s cadence sysinfo + mpv health snapshot).
 * Persists the row, then evaluates rising-edge alerting thresholds.
 */
export async function handleTelemetry(
  _ws: ExtendedWebSocket,
  message: TelemetryMessage
): Promise<void> {
  const {
    clientId,
    cpu_pct,
    mem_used_mb,
    mem_total_mb,
    disks,
    temps,
    net,
    mpv,
    process: proc,
  } = message;

  try {
    if (!clientConnectionManager.isConnected(clientId)) {
      logger.warn(`Received telemetry from unregistered client: ${clientId}`);
      return;
    }

    const input = {
      client_id: clientId,
      cpu_pct,
      mem_used_mb,
      mem_total_mb,
      disks,
      temps,
      net,
      mpv,
      process: proc,
    };

    await telemetryService.recordTelemetry(input);
    await telemetryService.evaluateThresholds(input);

    clientConnectionManager.updateHeartbeat(clientId);

    logger.debug(
      `Telemetry from ${clientId}: cpu=${cpu_pct.toFixed(0)}% mem=${mem_used_mb}/${mem_total_mb}MB disks=${disks.length}`
    );
  } catch (error) {
    logger.error(`Error handling telemetry for ${clientId}:`, error);
  }
}

/**
 * Handles auto-pushed log events (warn/error only). Persists for the dashboard
 * "Recent log events" panel; rate is unbounded by design.
 */
export async function handleLogEvent(
  _ws: ExtendedWebSocket,
  message: LogEventMessage
): Promise<void> {
  const { clientId, level, target, message: msg } = message;

  try {
    if (!clientConnectionManager.isConnected(clientId)) {
      logger.warn(`Received log event from unregistered client: ${clientId}`);
      return;
    }

    await telemetryService.recordLogEvent({
      client_id: clientId,
      level,
      target,
      message: msg,
    });

    logger.debug(`Log event from ${clientId} [${level}] ${target}: ${msg}`);
  } catch (error) {
    logger.error(`Error handling log event for ${clientId}:`, error);
  }
}

/**
 * Sends a playlist to a client
 */
export async function sendPlaylistToClient(clientId: string, playlistId: number): Promise<void> {
  try {
    // Get playlist with items
    const playlist = await playlistService.getPlaylistWithItems(playlistId);

    // Build playlist items with download URLs
    const subtitlesByMedia = await fetchSubtitlesByMedia(playlist.items);
    const items: PlaylistMediaItem[] = playlist.items.map((item) =>
      buildPlaylistItem(item, subtitlesByMedia)
    );

    const sent = clientConnectionManager.sendToClient(clientId, {
      type: 'playlist_assigned',
      playlistId: playlist.id,
      playlistName: playlist.name,
      loopPlaylist: true,
      items,
    });

    if (sent) {
      logger.info(`Sent playlist ${playlistId} to client ${clientId} (${items.length} items)`);
    } else {
      logger.warn(`Failed to send playlist ${playlistId} to client ${clientId}`);
    }
  } catch (error) {
    logger.error(`Error sending playlist to client ${clientId}:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to load playlist';
    clientConnectionManager.sendError(clientId, errorMessage);
  }
}

/**
 * Pushes the set of schedules that apply to a single client. Sent on
 * registration and after any CRUD that changes which schedules apply
 * (schedule create/update/delete or group membership change). The client
 * persists the latest set so it can re-evaluate locally and trigger
 * playlist switches even when the WebSocket is disconnected.
 */
export async function sendSchedulesToClient(clientId: string): Promise<void> {
  try {
    if (!clientConnectionManager.isConnected(clientId)) {
      // No active connection — push will fire on next register.
      return;
    }
    const schedules = await scheduleService.getSchedulesForClient(clientId);
    const payload = schedules.map((s) => ({
      id: s.id,
      name: s.name,
      playlistId: s.playlist_id,
      clientId: s.client_id,
      groupId: s.group_id,
      startTime: s.start_time,
      endTime: s.end_time,
      daysOfWeek: s.days_of_week,
      priority: s.priority,
      enabled: s.enabled,
      cronExpression: s.cron_expression,
      timezone: s.timezone,
      conditions: s.conditions,
      interruptMode: s.interrupt_mode,
      durationSeconds: s.duration_seconds,
    }));

    const sent = clientConnectionManager.sendToClient(clientId, {
      type: 'schedule_definitions',
      schedules: payload,
    });

    if (sent) {
      logger.info(`Sent ${payload.length} schedule definition(s) to client ${clientId}`);
    } else {
      logger.warn(`Failed to send schedule definitions to client ${clientId}`);
    }
  } catch (error) {
    logger.error(`Error sending schedule definitions to ${clientId}:`, error);
  }
}

/**
 * Broadcasts playlist update to all clients with that playlist
 */
export async function broadcastPlaylistUpdate(playlistId: number): Promise<void> {
  try {
    // Get playlist with items
    const playlist = await playlistService.getPlaylistWithItems(playlistId);

    // Build playlist items with download URLs
    const subtitlesByMedia = await fetchSubtitlesByMedia(playlist.items);
    const items: PlaylistMediaItem[] = playlist.items.map((item) =>
      buildPlaylistItem(item, subtitlesByMedia)
    );

    const sentCount = await clientConnectionManager.broadcastToPlaylist(playlistId, {
      type: 'playlist_updated',
      playlistId: playlist.id,
      loopPlaylist: true,
      items,
    });

    logger.info(`Broadcast playlist ${playlistId} update to ${sentCount} clients`);
  } catch (error) {
    logger.error(`Error broadcasting playlist ${playlistId} update:`, error);
  }
}

/**
 * Sends a command to a specific client
 */
export function sendCommandToClient(
  clientId: string,
  command: import('./types').CommandType,
  args?: Record<string, unknown>
): boolean {
  const sent = clientConnectionManager.sendToClient(clientId, {
    type: 'command',
    command,
    args,
  });

  if (sent) {
    logger.info(`Sent ${command} command to client ${clientId}`);
  } else {
    logger.warn(`Failed to send ${command} command to client ${clientId}`);
  }

  return sent;
}

/**
 * Broadcasts a command to all connected clients
 */
export function broadcastCommand(
  command: import('./types').CommandType,
  args?: Record<string, unknown>
): number {
  const sentCount = clientConnectionManager.broadcastToAll({
    type: 'command',
    command,
    args,
  });

  logger.info(`Broadcast ${command} command to ${sentCount} clients`);
  return sentCount;
}

/**
 * Sends a playlist to all connected members of a group
 */
export async function sendPlaylistToGroup(groupId: number, playlistId: number): Promise<number> {
  const { getDatabase } = await import('../database/connection');
  const db = await getDatabase();
  const members = await db.getGroupMembers(groupId);
  let sentCount = 0;

  for (const member of members) {
    if (clientConnectionManager.isConnected(member.id)) {
      await sendPlaylistToClient(member.id, playlistId);
      sentCount += 1;
    }
  }

  logger.info(`Sent playlist ${playlistId} to ${sentCount} clients in group ${groupId}`);
  return sentCount;
}

/**
 * Broadcasts a command to all connected members of a group
 */
export async function sendCommandToGroup(
  groupId: number,
  command: import('./types').CommandType,
  args?: Record<string, unknown>
): Promise<number> {
  const sentCount = await clientConnectionManager.broadcastToGroup(groupId, {
    type: 'command',
    command,
    args,
  });

  logger.info(`Sent ${command} command to ${sentCount} clients in group ${groupId}`);
  return sentCount;
}

/**
 * Sends a playlist interrupt message to a client
 */
export async function sendPlaylistInterrupt(
  clientId: string,
  playlistId: number,
  previousPlaylistId: number | null
): Promise<boolean> {
  try {
    const playlist = await playlistService.getPlaylistWithItems(playlistId);

    const subtitlesByMedia = await fetchSubtitlesByMedia(playlist.items);
    const items: PlaylistMediaItem[] = playlist.items.map((item) =>
      buildPlaylistItem(item, subtitlesByMedia)
    );

    const sent = clientConnectionManager.sendToClient(clientId, {
      type: 'playlist_interrupt',
      playlistId: playlist.id,
      playlistName: playlist.name,
      loopPlaylist: true,
      items,
      previousPlaylistId,
    });

    if (sent) {
      logger.info(`Sent playlist interrupt ${playlistId} to client ${clientId}`);
    }
    return sent;
  } catch (error) {
    logger.error(`Error sending playlist interrupt to client ${clientId}:`, error);
    return false;
  }
}

/**
 * Sends a playlist resume message to a client
 */
export async function sendPlaylistResume(
  clientId: string,
  playlistId: number | null
): Promise<boolean> {
  try {
    let items: PlaylistMediaItem[] = [];
    let playlistName: string | null = null;

    if (playlistId) {
      const playlist = await playlistService.getPlaylistWithItems(playlistId);
      playlistName = playlist.name;
      const subtitlesByMedia = await fetchSubtitlesByMedia(playlist.items);
      items = playlist.items.map((item) => buildPlaylistItem(item, subtitlesByMedia));
    }

    const sent = clientConnectionManager.sendToClient(clientId, {
      type: 'playlist_resume',
      playlistId,
      playlistName,
      loopPlaylist: true,
      items,
    });

    if (sent) {
      logger.info(`Sent playlist resume to client ${clientId} (playlist: ${playlistId})`);
    }
    return sent;
  } catch (error) {
    logger.error(`Error sending playlist resume to client ${clientId}:`, error);
    return false;
  }
}
