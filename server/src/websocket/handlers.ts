/**
 * WebSocket Message Handlers
 * Processes incoming client messages
 */

import { getLogger } from '../utils/logger';
import { clientService } from '../services/client.service';
import { playlistService } from '../services/playlist.service';
import { clientConnectionManager } from './client-manager';
import {
  RegisterMessage,
  StatusUpdateMessage,
  HeartbeatMessage,
  ErrorMessage,
  ExtendedWebSocket,
  PlaylistMediaItem,
} from './types';
import { AppError, ErrorCode } from '../api/middleware/error-handler';
import { config } from '../config/config';
import { storageService } from '../services/storage.service';

const logger = getLogger();

function getMediaDownloadUrl(mediaId: number, filepath: string): string {
  if (config.storage.backend === 'spaces') {
    return storageService.getDownloadUrl(filepath);
  }
  return `${config.server.publicUrl || `http://localhost:${config.server.port}`}/api/media/${mediaId}/download`;
}

/**
 * Handles client registration
 */
export async function handleRegister(
  ws: ExtendedWebSocket,
  message: RegisterMessage
): Promise<void> {
  const { clientId, version, capabilities } = message;

  try {
    logger.info(`Client registration request: ${clientId} (version: ${version})`);

    // Serialize capabilities as JSON string
    const capabilitiesJson = JSON.stringify(capabilities);

    // Check if client already exists
    let client;
    try {
      client = await clientService.getClientById(clientId);

      // Client exists - update it
      client = await clientService.updateClient(clientId, {
        version,
        capabilities: capabilitiesJson,
        status: 'online',
        last_seen: new Date().toISOString(),
      });

      logger.info(`Existing client reconnected: ${clientId} - ${client.name}`);
    } catch (error) {
      if (error instanceof AppError && error.code === ErrorCode.CLIENT_NOT_FOUND) {
        // Client doesn't exist - register new client
        client = await clientService.registerClient({
          id: clientId,
          name: `Client-${clientId.substring(0, 8)}`,
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

    // Send success response
    clientConnectionManager.sendSuccess(clientId, 'Registration successful');

    // If client has an assigned playlist, send it
    if (client.assigned_playlist_id !== null) {
      await sendPlaylistToClient(clientId, client.assigned_playlist_id);
    }
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
 * Handles client error report
 */
export async function handleError(_ws: ExtendedWebSocket, message: ErrorMessage): Promise<void> {
  const { clientId, error: errorMsg, context } = message;

  try {
    // Verify client is connected
    if (!clientConnectionManager.isConnected(clientId)) {
      logger.warn(`Received error from unregistered client: ${clientId}`);
      return;
    }

    // Log the error
    logger.error(`Client ${clientId} reported error: ${errorMsg}`, context);

    // Record error status
    await clientService.recordClientStatus({
      client_id: clientId,
      is_playing: false,
      error_message: errorMsg,
    });

    // Update client status to error
    await clientService.updateClient(clientId, {
      status: 'error',
      last_seen: new Date().toISOString(),
    });

    // Update heartbeat to keep connection alive
    clientConnectionManager.updateHeartbeat(clientId);
  } catch (error) {
    logger.error(`Error handling error report from ${clientId}:`, error);
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
    const items: PlaylistMediaItem[] = playlist.items.map((item) => ({
      id: item.id,
      mediaId: item.media_id,
      filename: item.media.filename,
      downloadUrl: getMediaDownloadUrl(item.media_id, item.media.filepath),
      type: item.media.type,
      duration: item.media.type === 'image' ? item.image_duration : item.media.duration || 0,
      checksum: item.media.checksum,
      orderIndex: item.order_index,
      imageDuration: item.image_duration,
    }));

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
 * Broadcasts playlist update to all clients with that playlist
 */
export async function broadcastPlaylistUpdate(playlistId: number): Promise<void> {
  try {
    // Get playlist with items
    const playlist = await playlistService.getPlaylistWithItems(playlistId);

    // Build playlist items with download URLs
    const items: PlaylistMediaItem[] = playlist.items.map((item) => ({
      id: item.id,
      mediaId: item.media_id,
      filename: item.media.filename,
      downloadUrl: getMediaDownloadUrl(item.media_id, item.media.filepath),
      type: item.media.type,
      duration: item.media.type === 'image' ? item.image_duration : item.media.duration || 0,
      checksum: item.media.checksum,
      orderIndex: item.order_index,
      imageDuration: item.image_duration,
    }));

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

    const items: PlaylistMediaItem[] = playlist.items.map((item) => ({
      id: item.id,
      mediaId: item.media_id,
      filename: item.media.filename,
      downloadUrl: getMediaDownloadUrl(item.media_id, item.media.filepath),
      type: item.media.type,
      duration: item.media.type === 'image' ? item.image_duration : item.media.duration || 0,
      checksum: item.media.checksum,
      orderIndex: item.order_index,
      imageDuration: item.image_duration,
    }));

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
      items = playlist.items.map((item) => ({
        id: item.id,
        mediaId: item.media_id,
        filename: item.media.filename,
        downloadUrl: getMediaDownloadUrl(item.media_id, item.media.filepath),
        type: item.media.type,
        duration: item.media.type === 'image' ? item.image_duration : item.media.duration || 0,
        checksum: item.media.checksum,
        orderIndex: item.order_index,
        imageDuration: item.image_duration,
      }));
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
