/**
 * Client Service
 * Handles client registration, status tracking, and playlist assignment
 */

import { getDatabase } from '../database/connection';
import {
  Client,
  CreateClientInput,
  UpdateClientInput,
  ClientStatus,
  CreateClientStatusInput,
  ClientWithStatus,
  ClientFilter,
  ClientPlaylist,
  ClientPlaylistWithDetails,
} from '../database/types';
import { getLogger } from '../utils/logger';
import { AppError, ErrorCode } from '../api/middleware/error-handler';

const logger = getLogger();

export class ClientService {
  /**
   * Registers a new client
   */
  async registerClient(input: CreateClientInput): Promise<Client> {
    const db = await getDatabase();

    // Check if client already exists
    const existing = await db.getClientById(input.id);
    if (existing) {
      throw new AppError(
        ErrorCode.CLIENT_ALREADY_REGISTERED,
        `Client with ID ${input.id} is already registered`,
        409
      );
    }

    const client = await db.createClient(input);
    logger.info(`Client registered: ${client.id} - ${client.name}`);
    return client;
  }

  /**
   * Gets a client by ID
   */
  async getClientById(id: string): Promise<Client> {
    const db = await getDatabase();
    const client = await db.getClientById(id);

    if (!client) {
      throw new AppError(ErrorCode.CLIENT_NOT_FOUND, `Client with ID ${id} not found`, 404);
    }

    return client;
  }

  /**
   * Gets a client with its latest status
   */
  async getClientWithStatus(id: string): Promise<ClientWithStatus> {
    const db = await getDatabase();
    const client = await db.getClientWithStatus(id);

    if (!client) {
      throw new AppError(ErrorCode.CLIENT_NOT_FOUND, `Client with ID ${id} not found`, 404);
    }

    return client;
  }

  /**
   * Gets all clients
   */
  async getAllClients(filter?: ClientFilter): Promise<Client[]> {
    const db = await getDatabase();
    return db.getAllClients(filter);
  }

  /**
   * Updates a client
   */
  async updateClient(id: string, input: UpdateClientInput): Promise<Client> {
    // Verify client exists
    await this.getClientById(id);

    // If assigning a playlist, verify it exists
    if (input.assigned_playlist_id !== undefined && input.assigned_playlist_id !== null) {
      const db = await getDatabase();
      const playlist = await db.getPlaylistById(input.assigned_playlist_id);
      if (!playlist) {
        throw new AppError(
          ErrorCode.PLAYLIST_NOT_FOUND,
          `Playlist with ID ${input.assigned_playlist_id} not found`,
          404
        );
      }
    }

    const db = await getDatabase();
    const client = await db.updateClient(id, input);

    logger.info(`Client updated: ${id} - ${client.name}`);
    return client;
  }

  /**
   * Unregisters a client
   */
  async unregisterClient(id: string): Promise<void> {
    // Verify client exists
    await this.getClientById(id);

    const db = await getDatabase();
    await db.deleteClient(id);

    logger.info(`Client unregistered: ${id}`);
  }

  /**
   * Updates client heartbeat (last_seen timestamp)
   */
  async updateHeartbeat(id: string): Promise<void> {
    const db = await getDatabase();
    await db.updateClient(id, {
      last_seen: new Date().toISOString(),
      status: 'online',
    });
  }

  /**
   * Records client status update
   */
  async recordClientStatus(input: CreateClientStatusInput): Promise<ClientStatus> {
    // Verify client exists
    await this.getClientById(input.client_id);

    const db = await getDatabase();
    const status = await db.createClientStatus(input);

    // Update client's last_seen and status
    await db.updateClient(input.client_id, {
      last_seen: new Date().toISOString(),
      status: input.error_message ? 'error' : 'online',
    });

    return status;
  }

  /**
   * Gets latest status for a client
   */
  async getLatestClientStatus(clientId: string): Promise<ClientStatus | null> {
    // Verify client exists
    await this.getClientById(clientId);

    const db = await getDatabase();
    return db.getLatestClientStatus(clientId);
  }

  /**
   * Assigns a playlist to a client
   */
  async assignPlaylist(clientId: string, playlistId: number | null): Promise<Client> {
    // Verify client exists
    await this.getClientById(clientId);

    // If assigning a playlist (not null), verify it exists
    if (playlistId !== null) {
      const db = await getDatabase();
      const playlist = await db.getPlaylistById(playlistId);
      if (!playlist) {
        throw new AppError(
          ErrorCode.PLAYLIST_NOT_FOUND,
          `Playlist with ID ${playlistId} not found`,
          404
        );
      }
    }

    return this.updateClient(clientId, { assigned_playlist_id: playlistId });
  }

  // ── Multi-playlist operations ──────────────────────────────────────────

  /**
   * Adds a playlist to a client's assignment list with priority.
   * Updates assigned_playlist_id to the highest-priority playlist.
   */
  async addPlaylistAssignment(
    clientId: string,
    playlistId: number,
    priority: number = 50
  ): Promise<ClientPlaylist> {
    await this.getClientById(clientId);

    const db = await getDatabase();
    const playlist = await db.getPlaylistById(playlistId);
    if (!playlist) {
      throw new AppError(
        ErrorCode.PLAYLIST_NOT_FOUND,
        `Playlist with ID ${playlistId} not found`,
        404
      );
    }

    const assignment = await db.addClientPlaylist(clientId, playlistId, priority);
    logger.info(`Playlist ${playlistId} assigned to client ${clientId} (priority: ${priority})`);

    // Resolve active playlist
    await this.resolveActivePlaylist(clientId);

    return assignment;
  }

  /**
   * Removes a playlist from a client's assignment list.
   * Updates assigned_playlist_id to the next highest-priority playlist.
   */
  async removePlaylistAssignment(clientId: string, playlistId: number): Promise<void> {
    await this.getClientById(clientId);

    const db = await getDatabase();
    await db.removeClientPlaylist(clientId, playlistId);
    logger.info(`Playlist ${playlistId} removed from client ${clientId}`);

    // Resolve active playlist
    await this.resolveActivePlaylist(clientId);
  }

  /**
   * Gets all playlist assignments for a client, ordered by priority.
   */
  async getPlaylistAssignments(clientId: string): Promise<ClientPlaylistWithDetails[]> {
    await this.getClientById(clientId);

    const db = await getDatabase();
    return db.getClientPlaylists(clientId);
  }

  /**
   * Updates the priority of a playlist assignment.
   * Re-resolves the active playlist.
   */
  async updatePlaylistPriority(
    clientId: string,
    playlistId: number,
    priority: number
  ): Promise<ClientPlaylist> {
    await this.getClientById(clientId);

    const db = await getDatabase();
    const updated = await db.updateClientPlaylistPriority(clientId, playlistId, priority);
    logger.info(`Playlist ${playlistId} priority updated to ${priority} for client ${clientId}`);

    // Resolve active playlist
    await this.resolveActivePlaylist(clientId);

    return updated;
  }

  /**
   * Resolves the active playlist for a client based on priority.
   * Sets assigned_playlist_id to the highest-priority assigned playlist.
   */
  async resolveActivePlaylist(clientId: string): Promise<number | null> {
    const db = await getDatabase();
    const assignments = await db.getClientPlaylists(clientId);

    const activePlaylistId = assignments.length > 0 ? assignments[0].playlist_id : null;

    await db.updateClient(clientId, { assigned_playlist_id: activePlaylistId });
    return activePlaylistId;
  }

  /**
   * Marks offline clients based on last_seen timestamp
   * @param timeoutMs - Timeout in milliseconds (default: 2 minutes)
   */
  async markOfflineClients(timeoutMs: number = 120000): Promise<number> {
    const db = await getDatabase();
    const clients = await db.getAllClients({ status: 'online' });

    const now = Date.now();
    let markedOffline = 0;

    for (const client of clients) {
      if (client.last_seen) {
        const lastSeenTime = new Date(client.last_seen).getTime();
        if (now - lastSeenTime > timeoutMs) {
          await db.updateClient(client.id, { status: 'offline' });
          markedOffline += 1;
          logger.info(`Client marked offline: ${client.id} - ${client.name}`);
        }
      }
    }

    return markedOffline;
  }

  /**
   * Gets client statistics
   */
  async getClientStats(): Promise<{
    total: number;
    online: number;
    offline: number;
    error: number;
  }> {
    const db = await getDatabase();
    const clients = await db.getAllClients();

    const stats = {
      total: clients.length,
      online: 0,
      offline: 0,
      error: 0,
    };

    clients.forEach((client) => {
      if (client.status === 'online') stats.online += 1;
      else if (client.status === 'offline') stats.offline += 1;
      else if (client.status === 'error') stats.error += 1;
    });

    return stats;
  }
}

// Export singleton instance
export const clientService = new ClientService();
