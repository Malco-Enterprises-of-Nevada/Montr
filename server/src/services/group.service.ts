/**
 * Group Service
 * Handles client group CRUD, member management, and batch operations
 */

import { getDatabase } from '../database/connection';
import {
  ClientGroup,
  ClientGroupMember,
  ClientGroupWithMembers,
  CreateClientGroupInput,
  UpdateClientGroupInput,
  Client,
} from '../database/types';
import { getLogger } from '../utils/logger';
import { AppError, ErrorCode } from '../api/middleware/error-handler';

const logger = getLogger();

export class GroupService {
  /**
   * Creates a new client group
   */
  async createGroup(input: CreateClientGroupInput): Promise<ClientGroup> {
    const db = await getDatabase();
    const group = await db.createClientGroup(input);
    logger.info(`Group created: ${group.id} - ${group.name}`);
    return group;
  }

  /**
   * Gets a group by ID
   */
  async getGroupById(id: number): Promise<ClientGroup> {
    const db = await getDatabase();
    const group = await db.getClientGroupById(id);
    if (!group) {
      throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, `Group with ID ${id} not found`, 404);
    }
    return group;
  }

  /**
   * Gets a group with all its members
   */
  async getGroupWithMembers(id: number): Promise<ClientGroupWithMembers> {
    const db = await getDatabase();
    const group = await db.getClientGroupWithMembers(id);
    if (!group) {
      throw new AppError(ErrorCode.RESOURCE_NOT_FOUND, `Group with ID ${id} not found`, 404);
    }
    return group;
  }

  /**
   * Lists all groups
   */
  async getAllGroups(): Promise<ClientGroup[]> {
    const db = await getDatabase();
    return db.getAllClientGroups();
  }

  /**
   * Updates a group
   */
  async updateGroup(id: number, input: UpdateClientGroupInput): Promise<ClientGroup> {
    await this.getGroupById(id);
    const db = await getDatabase();
    const group = await db.updateClientGroup(id, input);
    logger.info(`Group updated: ${group.id} - ${group.name}`);
    return group;
  }

  /**
   * Deletes a group
   */
  async deleteGroup(id: number): Promise<void> {
    await this.getGroupById(id);
    const db = await getDatabase();
    await db.deleteClientGroup(id);
    logger.info(`Group deleted: ${id}`);
  }

  /**
   * Adds a client to a group
   */
  async addMember(groupId: number, clientId: string): Promise<ClientGroupMember> {
    await this.getGroupById(groupId);

    const db = await getDatabase();
    const client = await db.getClientById(clientId);
    if (!client) {
      throw new AppError(ErrorCode.CLIENT_NOT_FOUND, `Client with ID ${clientId} not found`, 404);
    }

    // Check if already a member
    const members = await db.getGroupMembers(groupId);
    if (members.some((m) => m.id === clientId)) {
      throw new AppError(
        ErrorCode.RESOURCE_ALREADY_EXISTS,
        `Client ${clientId} is already a member of group ${groupId}`,
        409
      );
    }

    const member = await db.addClientToGroup(groupId, clientId);
    logger.info(`Client ${clientId} added to group ${groupId}`);
    return member;
  }

  /**
   * Removes a client from a group
   */
  async removeMember(groupId: number, clientId: string): Promise<void> {
    await this.getGroupById(groupId);
    const db = await getDatabase();
    await db.removeClientFromGroup(groupId, clientId);
    logger.info(`Client ${clientId} removed from group ${groupId}`);
  }

  /**
   * Gets all members of a group
   */
  async getMembers(groupId: number): Promise<Client[]> {
    await this.getGroupById(groupId);
    const db = await getDatabase();
    return db.getGroupMembers(groupId);
  }

  /**
   * Assigns a playlist to all members of a group
   */
  async assignPlaylistToGroup(
    groupId: number,
    playlistId: number
  ): Promise<{ updated: number; clients: Client[] }> {
    await this.getGroupById(groupId);

    const db = await getDatabase();

    // Verify playlist exists
    const playlist = await db.getPlaylistById(playlistId);
    if (!playlist) {
      throw new AppError(
        ErrorCode.PLAYLIST_NOT_FOUND,
        `Playlist with ID ${playlistId} not found`,
        404
      );
    }

    const members = await db.getGroupMembers(groupId);
    const updatedClients: Client[] = [];

    for (const member of members) {
      const updated = await db.updateClient(member.id, {
        assigned_playlist_id: playlistId,
      });
      updatedClients.push(updated);
    }

    logger.info(
      `Playlist ${playlistId} assigned to ${updatedClients.length} clients in group ${groupId}`
    );
    return { updated: updatedClients.length, clients: updatedClients };
  }

  /**
   * Gets all groups a client belongs to
   */
  async getClientGroups(clientId: string): Promise<ClientGroup[]> {
    const db = await getDatabase();
    const client = await db.getClientById(clientId);
    if (!client) {
      throw new AppError(ErrorCode.CLIENT_NOT_FOUND, `Client with ID ${clientId} not found`, 404);
    }
    return db.getClientGroups(clientId);
  }
}

export const groupService = new GroupService();
