/**
 * Abstract base class for SQL-based database adapters.
 * Provides shared business logic (filtering, pagination, field validation)
 * that MySQL, MSSQL, and SQLite adapters all inherit.
 */

import { DatabaseAdapter } from './base.adapter';
import {
  MediaFile,
  CreateMediaInput,
  Playlist,
  CreatePlaylistInput,
  UpdatePlaylistInput,
  PlaylistItem,
  AddPlaylistItemInput,
  UpdatePlaylistItemInput,
  PlaylistWithItems,
  Client,
  CreateClientInput,
  UpdateClientInput,
  ClientStatus,
  CreateClientStatusInput,
  ClientWithStatus,
  ClientGroup,
  ClientGroupMember,
  ClientGroupWithMembers,
  CreateClientGroupInput,
  UpdateClientGroupInput,
  Schedule,
  CreateScheduleInput,
  UpdateScheduleInput,
  ClientPlaylist,
  ClientPlaylistWithDetails,
  PlaybackLog,
  CreatePlaybackLogInput,
  PlaybackSummary,
  MediaPopularity,
  UptimeStat,
  NotificationRule,
  CreateNotificationRuleInput,
  NotificationEventType,
  NotificationHistory,
  ApprovalStatus,
  ApprovalLog,
  User,
  CreateUserInput,
  PaginationParams,
  PaginatedResult,
  MediaFilter,
  ClientFilter,
  PlaylistItemWithMedia,
} from '../types';
import { MigrationExecutor } from '../migrations/runner';

/** Fields that can be updated on media_files */
const MEDIA_UPDATABLE_FIELDS = new Set([
  'filename',
  'original_filename',
  'filepath',
  'type',
  'mime_type',
  'file_size',
  'duration',
  'width',
  'height',
  'checksum',
  'thumbnail_status',
  'approval_status',
]);

/** Row result from a query with execution metadata */
export interface ExecuteResult {
  lastInsertId: number;
  affectedRows: number;
}

/**
 * Abstract SQL adapter base class.
 * Subclasses must implement the raw database access methods and
 * provide dialect-specific SQL where needed.
 */
export abstract class SqlBaseAdapter implements DatabaseAdapter {
  // ── Abstract methods (dialect-specific) ──────────────────────────────────

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract isConnected(): boolean;

  /** Execute a query that returns rows */
  abstract rawQuery<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;

  /** Execute a query that returns a single row */
  abstract rawQueryOne<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<T | null>;

  /** Execute a statement (INSERT/UPDATE/DELETE) */
  abstract rawExecute(sql: string, params?: unknown[]): Promise<ExecuteResult>;

  /** Execute multiple statements inside a transaction */
  abstract rawTransaction(fn: () => Promise<void>): Promise<void>;

  /** Returns a MigrationExecutor for use by the migration runner */
  abstract getMigrationExecutor(): MigrationExecutor;

  /**
   * Dialect-specific placeholder for parameterized queries.
   * SQLite/MySQL use `?`, MSSQL uses `@p1`, `@p2`, etc.
   * Override in MSSQL adapter.
   */
  protected placeholder(_index: number): string {
    return '?';
  }

  /**
   * Dialect-specific function for current timestamp in SQL.
   * SQLite: CURRENT_TIMESTAMP, MySQL: NOW(), MSSQL: GETUTCDATE()
   */
  protected abstract currentTimestampFn(): string;

  /**
   * Build a pagination clause.
   * SQLite/MySQL: LIMIT ? OFFSET ?
   * MSSQL: OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
   */
  protected paginationClause(paramStartIndex: number): string {
    return `LIMIT ${this.placeholder(paramStartIndex)} OFFSET ${this.placeholder(paramStartIndex + 1)}`;
  }

  /** Pagination params order: [limit, offset] for SQLite/MySQL, [offset, limit] for MSSQL */
  protected paginationParams(limit: number, offset: number): unknown[] {
    return [limit, offset];
  }

  // ── Media operations ─────────────────────────────────────────────────────

  async createMedia(input: CreateMediaInput): Promise<MediaFile> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO media_files (
        filename, original_filename, filepath, type, mime_type,
        file_size, duration, width, height, checksum, thumbnail_status, approval_status
      ) VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)}, ${p(11)}, ${p(12)})`,
      [
        input.filename,
        input.original_filename,
        input.filepath,
        input.type,
        input.mime_type || null,
        input.file_size || null,
        input.duration || null,
        input.width || null,
        input.height || null,
        input.checksum || null,
        input.thumbnail_status || 'pending',
        'pending',
      ]
    );

    const media = await this.getMediaById(result.lastInsertId);
    if (!media) throw new Error('Failed to retrieve created media');
    return media;
  }

  async getMediaById(id: number): Promise<MediaFile | null> {
    return this.rawQueryOne<MediaFile>(
      `SELECT * FROM media_files WHERE id = ${this.placeholder(1)}`,
      [id]
    );
  }

  async getAllMedia(
    pagination: PaginationParams,
    filter?: MediaFilter
  ): Promise<PaginatedResult<MediaFile>> {
    const { page, limit } = pagination;
    const offset = (page - 1) * limit;

    let whereClause = '';
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filter) {
      const conditions: string[] = [];
      if (filter.type) {
        conditions.push(`type = ${this.placeholder(paramIndex++)}`);
        params.push(filter.type);
      }
      if (filter.search) {
        conditions.push(
          `(original_filename LIKE ${this.placeholder(paramIndex++)} OR filename LIKE ${this.placeholder(paramIndex++)})`
        );
        params.push(`%${filter.search}%`, `%${filter.search}%`);
      }
      if (conditions.length > 0) {
        whereClause = `WHERE ${conditions.join(' AND ')}`;
      }
    }

    const countRows = await this.rawQuery<{ count: number }>(
      `SELECT COUNT(*) as count FROM media_files ${whereClause}`,
      params
    );
    const count = countRows[0]?.count ?? 0;

    const data = await this.rawQuery<MediaFile>(
      `SELECT * FROM media_files ${whereClause} ORDER BY created_at DESC ${this.paginationClause(paramIndex)}`,
      [...params, ...this.paginationParams(limit, offset)]
    );

    return {
      data,
      pagination: {
        page,
        limit,
        total: count,
        totalPages: Math.ceil(count / limit),
      },
    };
  }

  async updateMedia(id: number, updates: Partial<CreateMediaInput>): Promise<MediaFile> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    Object.entries(updates).forEach(([key, value]) => {
      if (!MEDIA_UPDATABLE_FIELDS.has(key)) {
        throw new Error(`Invalid field name: ${key}`);
      }
      fields.push(`${key} = ${this.placeholder(paramIndex++)}`);
      values.push(value);
    });

    if (fields.length === 0) {
      const media = await this.getMediaById(id);
      if (!media) throw new Error(`Media with ID ${id} not found`);
      return media;
    }

    values.push(id);
    await this.rawExecute(
      `UPDATE media_files SET ${fields.join(', ')} WHERE id = ${this.placeholder(paramIndex)}`,
      values
    );

    const media = await this.getMediaById(id);
    if (!media) throw new Error(`Media with ID ${id} not found`);
    return media;
  }

  async deleteMedia(id: number): Promise<void> {
    await this.rawExecute(`DELETE FROM media_files WHERE id = ${this.placeholder(1)}`, [id]);
  }

  async getMediaByChecksum(checksum: string): Promise<MediaFile | null> {
    return this.rawQueryOne<MediaFile>(
      `SELECT * FROM media_files WHERE checksum = ${this.placeholder(1)}`,
      [checksum]
    );
  }

  // ── Playlist operations ──────────────────────────────────────────────────

  async createPlaylist(input: CreatePlaylistInput): Promise<Playlist> {
    const result = await this.rawExecute(
      `INSERT INTO playlists (name, description) VALUES (${this.placeholder(1)}, ${this.placeholder(2)})`,
      [input.name, input.description || null]
    );

    const playlist = await this.getPlaylistById(result.lastInsertId);
    if (!playlist) throw new Error('Failed to retrieve created playlist');
    return playlist;
  }

  async getPlaylistById(id: number): Promise<Playlist | null> {
    return this.rawQueryOne<Playlist>(`SELECT * FROM playlists WHERE id = ${this.placeholder(1)}`, [
      id,
    ]);
  }

  async getPlaylistWithItems(id: number): Promise<PlaylistWithItems | null> {
    const playlist = await this.getPlaylistById(id);
    if (!playlist) return null;

    const rows = await this.rawQuery<
      PlaylistItem & {
        media_id: number;
        filename: string;
        original_filename: string;
        filepath: string;
        type: 'video' | 'image';
        mime_type: string | null;
        file_size: number | null;
        duration: number | null;
        width: number | null;
        height: number | null;
        checksum: string | null;
        thumbnail_status: import('../types').ThumbnailStatus;
        approval_status: import('../types').ApprovalStatus;
        media_created_at: string;
        media_updated_at: string;
      }
    >(
      `SELECT
        pi.id, pi.playlist_id, pi.media_id, pi.order_index, pi.image_duration, pi.created_at,
        mf.id as media_id, mf.filename, mf.original_filename, mf.filepath, mf.type,
        mf.mime_type, mf.file_size, mf.duration, mf.width, mf.height, mf.checksum,
        mf.thumbnail_status, mf.approval_status,
        mf.created_at as media_created_at, mf.updated_at as media_updated_at
      FROM playlist_items pi
      JOIN media_files mf ON pi.media_id = mf.id
      WHERE pi.playlist_id = ${this.placeholder(1)}
      ORDER BY pi.order_index ASC`,
      [id]
    );

    const items: PlaylistItemWithMedia[] = rows.map((row) => ({
      id: row.id,
      playlist_id: row.playlist_id,
      media_id: row.media_id,
      order_index: row.order_index,
      image_duration: row.image_duration,
      created_at: row.created_at,
      media: {
        id: row.media_id,
        filename: row.filename,
        original_filename: row.original_filename,
        filepath: row.filepath,
        type: row.type,
        mime_type: row.mime_type,
        file_size: row.file_size,
        duration: row.duration,
        width: row.width,
        height: row.height,
        checksum: row.checksum,
        thumbnail_status: row.thumbnail_status || 'pending',
        approval_status: row.approval_status || 'pending',
        created_at: row.media_created_at,
        updated_at: row.media_updated_at,
      },
    }));

    return { ...playlist, items };
  }

  async getAllPlaylists(): Promise<Playlist[]> {
    return this.rawQuery<Playlist>('SELECT * FROM playlists ORDER BY created_at DESC');
  }

  async updatePlaylist(id: number, input: UpdatePlaylistInput): Promise<Playlist> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.name !== undefined) {
      fields.push(`name = ${this.placeholder(paramIndex++)}`);
      values.push(input.name);
    }
    if (input.description !== undefined) {
      fields.push(`description = ${this.placeholder(paramIndex++)}`);
      values.push(input.description);
    }

    if (fields.length === 0) {
      const playlist = await this.getPlaylistById(id);
      if (!playlist) throw new Error(`Playlist with ID ${id} not found`);
      return playlist;
    }

    values.push(id);
    await this.rawExecute(
      `UPDATE playlists SET ${fields.join(', ')} WHERE id = ${this.placeholder(paramIndex)}`,
      values
    );

    const playlist = await this.getPlaylistById(id);
    if (!playlist) throw new Error(`Playlist with ID ${id} not found`);
    return playlist;
  }

  async deletePlaylist(id: number): Promise<void> {
    await this.rawExecute(`DELETE FROM playlists WHERE id = ${this.placeholder(1)}`, [id]);
  }

  // ── Playlist item operations ─────────────────────────────────────────────

  async addPlaylistItem(input: AddPlaylistItemInput): Promise<PlaylistItem> {
    const result = await this.rawExecute(
      `INSERT INTO playlist_items (playlist_id, media_id, order_index, image_duration)
       VALUES (${this.placeholder(1)}, ${this.placeholder(2)}, ${this.placeholder(3)}, ${this.placeholder(4)})`,
      [input.playlist_id, input.media_id, input.order_index, input.image_duration || 5]
    );

    const item = await this.getPlaylistItemById(result.lastInsertId);
    if (!item) throw new Error('Failed to retrieve created playlist item');
    return item;
  }

  async getPlaylistItems(playlistId: number): Promise<PlaylistItem[]> {
    return this.rawQuery<PlaylistItem>(
      `SELECT * FROM playlist_items WHERE playlist_id = ${this.placeholder(1)} ORDER BY order_index ASC`,
      [playlistId]
    );
  }

  async getPlaylistItemById(itemId: number): Promise<PlaylistItem | null> {
    return this.rawQueryOne<PlaylistItem>(
      `SELECT * FROM playlist_items WHERE id = ${this.placeholder(1)}`,
      [itemId]
    );
  }

  async updatePlaylistItem(itemId: number, input: UpdatePlaylistItemInput): Promise<PlaylistItem> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.order_index !== undefined) {
      fields.push(`order_index = ${this.placeholder(paramIndex++)}`);
      values.push(input.order_index);
    }
    if (input.image_duration !== undefined) {
      fields.push(`image_duration = ${this.placeholder(paramIndex++)}`);
      values.push(input.image_duration);
    }

    if (fields.length === 0) {
      const item = await this.getPlaylistItemById(itemId);
      if (!item) throw new Error(`Playlist item with ID ${itemId} not found`);
      return item;
    }

    values.push(itemId);
    await this.rawExecute(
      `UPDATE playlist_items SET ${fields.join(', ')} WHERE id = ${this.placeholder(paramIndex)}`,
      values
    );

    const item = await this.getPlaylistItemById(itemId);
    if (!item) throw new Error(`Playlist item with ID ${itemId} not found`);
    return item;
  }

  async deletePlaylistItem(itemId: number): Promise<void> {
    await this.rawExecute(`DELETE FROM playlist_items WHERE id = ${this.placeholder(1)}`, [itemId]);
  }

  async reorderPlaylistItems(_playlistId: number, itemIds: number[]): Promise<void> {
    await this.rawTransaction(async () => {
      // First, set all to negative temporary values to avoid UNIQUE constraint violations
      for (let i = 0; i < itemIds.length; i++) {
        await this.rawExecute(
          `UPDATE playlist_items SET order_index = ${this.placeholder(1)} WHERE id = ${this.placeholder(2)}`,
          [-(i + 1), itemIds[i]]
        );
      }
      // Then set to final values
      for (let i = 0; i < itemIds.length; i++) {
        await this.rawExecute(
          `UPDATE playlist_items SET order_index = ${this.placeholder(1)} WHERE id = ${this.placeholder(2)}`,
          [i, itemIds[i]]
        );
      }
    });
  }

  // ── Client operations ────────────────────────────────────────────────────

  async createClient(input: CreateClientInput): Promise<Client> {
    await this.rawExecute(
      `INSERT INTO clients (id, name, version, capabilities, last_seen)
       VALUES (${this.placeholder(1)}, ${this.placeholder(2)}, ${this.placeholder(3)}, ${this.placeholder(4)}, ${this.currentTimestampFn()})`,
      [input.id, input.name, input.version || null, input.capabilities || null]
    );

    const client = await this.getClientById(input.id);
    if (!client) throw new Error('Failed to retrieve created client');
    return client;
  }

  async getClientById(id: string): Promise<Client | null> {
    return this.rawQueryOne<Client>(`SELECT * FROM clients WHERE id = ${this.placeholder(1)}`, [
      id,
    ]);
  }

  async getAllClients(filter?: ClientFilter): Promise<Client[]> {
    let whereClause = '';
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filter) {
      const conditions: string[] = [];
      if (filter.status) {
        conditions.push(`status = ${this.placeholder(paramIndex++)}`);
        params.push(filter.status);
      }
      if (filter.assigned_playlist_id !== undefined) {
        conditions.push(`assigned_playlist_id = ${this.placeholder(paramIndex++)}`);
        params.push(filter.assigned_playlist_id);
      }
      if (conditions.length > 0) {
        whereClause = `WHERE ${conditions.join(' AND ')}`;
      }
    }

    return this.rawQuery<Client>(
      `SELECT * FROM clients ${whereClause} ORDER BY created_at DESC`,
      params
    );
  }

  async updateClient(id: string, input: UpdateClientInput): Promise<Client> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.name !== undefined) {
      fields.push(`name = ${this.placeholder(paramIndex++)}`);
      values.push(input.name);
    }
    if (input.assigned_playlist_id !== undefined) {
      fields.push(`assigned_playlist_id = ${this.placeholder(paramIndex++)}`);
      values.push(input.assigned_playlist_id);
    }
    if (input.status !== undefined) {
      fields.push(`status = ${this.placeholder(paramIndex++)}`);
      values.push(input.status);
    }
    if (input.last_seen !== undefined) {
      fields.push(`last_seen = ${this.placeholder(paramIndex++)}`);
      values.push(input.last_seen);
    }
    if (input.version !== undefined) {
      fields.push(`version = ${this.placeholder(paramIndex++)}`);
      values.push(input.version);
    }
    if (input.capabilities !== undefined) {
      fields.push(`capabilities = ${this.placeholder(paramIndex++)}`);
      values.push(input.capabilities);
    }

    if (fields.length === 0) {
      const client = await this.getClientById(id);
      if (!client) throw new Error(`Client with ID ${id} not found`);
      return client;
    }

    values.push(id);
    await this.rawExecute(
      `UPDATE clients SET ${fields.join(', ')} WHERE id = ${this.placeholder(paramIndex)}`,
      values
    );

    const client = await this.getClientById(id);
    if (!client) throw new Error(`Client with ID ${id} not found`);
    return client;
  }

  async deleteClient(id: string): Promise<void> {
    await this.rawExecute(`DELETE FROM clients WHERE id = ${this.placeholder(1)}`, [id]);
  }

  // ── Client status operations ─────────────────────────────────────────────

  async createClientStatus(input: CreateClientStatusInput): Promise<ClientStatus> {
    const result = await this.rawExecute(
      `INSERT INTO client_status (client_id, current_media_id, position, is_playing, error_message)
       VALUES (${this.placeholder(1)}, ${this.placeholder(2)}, ${this.placeholder(3)}, ${this.placeholder(4)}, ${this.placeholder(5)})`,
      [
        input.client_id,
        input.current_media_id || null,
        input.position || null,
        input.is_playing ? 1 : 0,
        input.error_message || null,
      ]
    );

    const status = await this.rawQueryOne<ClientStatus>(
      `SELECT * FROM client_status WHERE id = ${this.placeholder(1)}`,
      [result.lastInsertId]
    );
    if (!status) throw new Error('Failed to retrieve created client status');
    return status;
  }

  async getLatestClientStatus(clientId: string): Promise<ClientStatus | null> {
    return this.rawQueryOne<ClientStatus>(
      `SELECT cs.*, mf.original_filename AS media_filename FROM client_status cs LEFT JOIN media_files mf ON cs.current_media_id = mf.id WHERE cs.client_id = ${this.placeholder(1)} ORDER BY cs.timestamp DESC, cs.id DESC LIMIT 1`,
      [clientId]
    );
  }

  async getClientWithStatus(clientId: string): Promise<ClientWithStatus | null> {
    const client = await this.getClientById(clientId);
    if (!client) return null;

    const status = await this.getLatestClientStatus(clientId);
    return { ...client, current_status: status };
  }

  // ── Client group operations ─────────────────────────────────────────────

  async createClientGroup(input: CreateClientGroupInput): Promise<ClientGroup> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO client_groups (name, description) VALUES (${p(1)}, ${p(2)})`,
      [input.name, input.description || null]
    );
    const group = await this.getClientGroupById(result.lastInsertId);
    if (!group) throw new Error('Failed to retrieve created client group');
    return group;
  }

  async getClientGroupById(id: number): Promise<ClientGroup | null> {
    return this.rawQueryOne<ClientGroup>(
      `SELECT * FROM client_groups WHERE id = ${this.placeholder(1)}`,
      [id]
    );
  }

  async getClientGroupWithMembers(id: number): Promise<ClientGroupWithMembers | null> {
    const group = await this.getClientGroupById(id);
    if (!group) return null;
    const members = await this.getGroupMembers(id);
    return { ...group, members };
  }

  async getAllClientGroups(): Promise<ClientGroup[]> {
    return this.rawQuery<ClientGroup>('SELECT * FROM client_groups ORDER BY name ASC');
  }

  async updateClientGroup(id: number, input: UpdateClientGroupInput): Promise<ClientGroup> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (input.name !== undefined) {
      fields.push(`name = ${this.placeholder(paramIndex++)}`);
      values.push(input.name);
    }
    if (input.description !== undefined) {
      fields.push(`description = ${this.placeholder(paramIndex++)}`);
      values.push(input.description);
    }

    if (fields.length > 0) {
      values.push(id);
      await this.rawExecute(
        `UPDATE client_groups SET ${fields.join(', ')} WHERE id = ${this.placeholder(paramIndex)}`,
        values
      );
    }

    const group = await this.getClientGroupById(id);
    if (!group) throw new Error(`Client group with ID ${id} not found`);
    return group;
  }

  async deleteClientGroup(id: number): Promise<void> {
    await this.rawExecute(`DELETE FROM client_groups WHERE id = ${this.placeholder(1)}`, [id]);
  }

  async addClientToGroup(groupId: number, clientId: string): Promise<ClientGroupMember> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO client_group_members (group_id, client_id) VALUES (${p(1)}, ${p(2)})`,
      [groupId, clientId]
    );
    const member = await this.rawQueryOne<ClientGroupMember>(
      `SELECT * FROM client_group_members WHERE id = ${p(1)}`,
      [result.lastInsertId]
    );
    if (!member) throw new Error('Failed to retrieve created group member');
    return member;
  }

  async removeClientFromGroup(groupId: number, clientId: string): Promise<void> {
    const p = this.placeholder;
    await this.rawExecute(
      `DELETE FROM client_group_members WHERE group_id = ${p(1)} AND client_id = ${p(2)}`,
      [groupId, clientId]
    );
  }

  async getGroupMembers(groupId: number): Promise<Client[]> {
    return this.rawQuery<Client>(
      `SELECT c.* FROM clients c
       JOIN client_group_members cgm ON c.id = cgm.client_id
       WHERE cgm.group_id = ${this.placeholder(1)}
       ORDER BY c.name ASC`,
      [groupId]
    );
  }

  async getClientGroups(clientId: string): Promise<ClientGroup[]> {
    return this.rawQuery<ClientGroup>(
      `SELECT cg.* FROM client_groups cg
       JOIN client_group_members cgm ON cg.id = cgm.group_id
       WHERE cgm.client_id = ${this.placeholder(1)}
       ORDER BY cg.name ASC`,
      [clientId]
    );
  }

  // ── Schedule operations ─────────────────────────────────────────────────

  async createSchedule(input: CreateScheduleInput): Promise<Schedule> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO schedules (name, playlist_id, client_id, group_id, start_time, end_time, days_of_week, priority, enabled)
       VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)})`,
      [
        input.name,
        input.playlist_id,
        input.client_id || null,
        input.group_id || null,
        input.start_time,
        input.end_time || null,
        input.days_of_week || '0,1,2,3,4,5,6',
        input.priority ?? 50,
        input.enabled !== false ? 1 : 0,
      ]
    );
    const schedule = await this.getScheduleById(result.lastInsertId);
    if (!schedule) throw new Error('Failed to retrieve created schedule');
    return schedule;
  }

  async getScheduleById(id: number): Promise<Schedule | null> {
    const row = await this.rawQueryOne<Omit<Schedule, 'enabled'> & { enabled: number }>(
      `SELECT * FROM schedules WHERE id = ${this.placeholder(1)}`,
      [id]
    );
    if (!row) return null;
    return { ...row, enabled: Boolean(row.enabled) };
  }

  async getAllSchedules(): Promise<Schedule[]> {
    const rows = await this.rawQuery<Omit<Schedule, 'enabled'> & { enabled: number }>(
      'SELECT * FROM schedules ORDER BY priority DESC, name ASC'
    );
    return rows.map((r) => ({ ...r, enabled: Boolean(r.enabled) }));
  }

  async updateSchedule(id: number, input: UpdateScheduleInput): Promise<Schedule> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    const updatable: Record<string, unknown> = {};
    if (input.name !== undefined) updatable.name = input.name;
    if (input.playlist_id !== undefined) updatable.playlist_id = input.playlist_id;
    if (input.client_id !== undefined) updatable.client_id = input.client_id;
    if (input.group_id !== undefined) updatable.group_id = input.group_id;
    if (input.start_time !== undefined) updatable.start_time = input.start_time;
    if (input.end_time !== undefined) updatable.end_time = input.end_time;
    if (input.days_of_week !== undefined) updatable.days_of_week = input.days_of_week;
    if (input.priority !== undefined) updatable.priority = input.priority;
    if (input.enabled !== undefined) updatable.enabled = input.enabled ? 1 : 0;

    for (const [key, value] of Object.entries(updatable)) {
      fields.push(`${key} = ${this.placeholder(paramIndex++)}`);
      values.push(value);
    }

    if (fields.length > 0) {
      values.push(id);
      await this.rawExecute(
        `UPDATE schedules SET ${fields.join(', ')} WHERE id = ${this.placeholder(paramIndex)}`,
        values
      );
    }

    const schedule = await this.getScheduleById(id);
    if (!schedule) throw new Error(`Schedule with ID ${id} not found`);
    return schedule;
  }

  async deleteSchedule(id: number): Promise<void> {
    await this.rawExecute(`DELETE FROM schedules WHERE id = ${this.placeholder(1)}`, [id]);
  }

  async getEnabledSchedules(): Promise<Schedule[]> {
    const rows = await this.rawQuery<Omit<Schedule, 'enabled'> & { enabled: number }>(
      `SELECT * FROM schedules WHERE enabled = 1 ORDER BY priority DESC`
    );
    return rows.map((r) => ({ ...r, enabled: Boolean(r.enabled) }));
  }

  // ── Client playlist operations ──────────────────────────────────────────

  async addClientPlaylist(
    clientId: string,
    playlistId: number,
    priority: number = 50
  ): Promise<ClientPlaylist> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO client_playlists (client_id, playlist_id, priority)
       VALUES (${p(1)}, ${p(2)}, ${p(3)})`,
      [clientId, playlistId, priority]
    );
    const row = await this.rawQueryOne<ClientPlaylist>(
      `SELECT * FROM client_playlists WHERE id = ${p(1)}`,
      [result.lastInsertId]
    );
    if (!row) throw new Error('Failed to retrieve created client playlist');
    return row;
  }

  async removeClientPlaylist(clientId: string, playlistId: number): Promise<void> {
    const p = this.placeholder;
    await this.rawExecute(
      `DELETE FROM client_playlists WHERE client_id = ${p(1)} AND playlist_id = ${p(2)}`,
      [clientId, playlistId]
    );
  }

  async getClientPlaylists(clientId: string): Promise<ClientPlaylistWithDetails[]> {
    const p = this.placeholder;
    return this.rawQuery<ClientPlaylistWithDetails>(
      `SELECT cp.*, p.name as playlist_name
       FROM client_playlists cp
       JOIN playlists p ON cp.playlist_id = p.id
       WHERE cp.client_id = ${p(1)}
       ORDER BY cp.priority DESC`,
      [clientId]
    );
  }

  async updateClientPlaylistPriority(
    clientId: string,
    playlistId: number,
    priority: number
  ): Promise<ClientPlaylist> {
    const p = this.placeholder;
    await this.rawExecute(
      `UPDATE client_playlists SET priority = ${p(1)}
       WHERE client_id = ${p(2)} AND playlist_id = ${p(3)}`,
      [priority, clientId, playlistId]
    );
    const row = await this.rawQueryOne<ClientPlaylist>(
      `SELECT * FROM client_playlists WHERE client_id = ${p(1)} AND playlist_id = ${p(2)}`,
      [clientId, playlistId]
    );
    if (!row) throw new Error('Client playlist assignment not found');
    return row;
  }

  // ── Playback log operations ─────────────────────────────────────────────

  async createPlaybackLog(input: CreatePlaybackLogInput): Promise<PlaybackLog> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO playback_logs (client_id, media_id, started_at, ended_at, duration_watched, completed)
       VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)})`,
      [
        input.client_id,
        input.media_id,
        input.started_at || new Date().toISOString(),
        input.ended_at || null,
        input.duration_watched || 0,
        input.completed ? 1 : 0,
      ]
    );
    const log = await this.rawQueryOne<PlaybackLog>(
      `SELECT * FROM playback_logs WHERE id = ${p(1)}`,
      [result.lastInsertId]
    );
    if (!log) throw new Error('Failed to retrieve created playback log');
    return { ...log, completed: Boolean(log.completed) };
  }

  async updatePlaybackLog(
    id: number,
    updates: { ended_at?: string; duration_watched?: number; completed?: boolean }
  ): Promise<PlaybackLog> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (updates.ended_at !== undefined) {
      fields.push(`ended_at = ${this.placeholder(paramIndex++)}`);
      values.push(updates.ended_at);
    }
    if (updates.duration_watched !== undefined) {
      fields.push(`duration_watched = ${this.placeholder(paramIndex++)}`);
      values.push(updates.duration_watched);
    }
    if (updates.completed !== undefined) {
      fields.push(`completed = ${this.placeholder(paramIndex++)}`);
      values.push(updates.completed ? 1 : 0);
    }

    if (fields.length > 0) {
      values.push(id);
      await this.rawExecute(
        `UPDATE playback_logs SET ${fields.join(', ')} WHERE id = ${this.placeholder(paramIndex)}`,
        values
      );
    }

    const log = await this.rawQueryOne<PlaybackLog>(
      `SELECT * FROM playback_logs WHERE id = ${this.placeholder(1)}`,
      [id]
    );
    if (!log) throw new Error(`Playback log with ID ${id} not found`);
    return { ...log, completed: Boolean(log.completed) };
  }

  async getPlaybackLogs(filter?: {
    client_id?: string;
    media_id?: number;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<PlaybackLog[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (filter?.client_id) {
      conditions.push(`client_id = ${this.placeholder(paramIndex++)}`);
      values.push(filter.client_id);
    }
    if (filter?.media_id) {
      conditions.push(`media_id = ${this.placeholder(paramIndex++)}`);
      values.push(filter.media_id);
    }
    if (filter?.from) {
      conditions.push(`started_at >= ${this.placeholder(paramIndex++)}`);
      values.push(filter.from);
    }
    if (filter?.to) {
      conditions.push(`started_at <= ${this.placeholder(paramIndex++)}`);
      values.push(filter.to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter?.limit || 100;

    const rows = await this.rawQuery<PlaybackLog>(
      `SELECT * FROM playback_logs ${where} ORDER BY started_at DESC LIMIT ${limit}`,
      values
    );
    return rows.map((r) => ({ ...r, completed: Boolean(r.completed) }));
  }

  async getPlaybackSummaryByClient(from?: string, to?: string): Promise<PlaybackSummary[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (from) {
      conditions.push(`pl.started_at >= ${this.placeholder(paramIndex++)}`);
      values.push(from);
    }
    if (to) {
      conditions.push(`pl.started_at <= ${this.placeholder(paramIndex++)}`);
      values.push(to);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    return this.rawQuery<PlaybackSummary>(
      `SELECT pl.client_id, c.name as client_name,
              SUM(pl.duration_watched) as total_duration,
              COUNT(pl.id) as total_plays
       FROM playback_logs pl
       JOIN clients c ON pl.client_id = c.id
       ${where}
       GROUP BY pl.client_id, c.name
       ORDER BY total_duration DESC`,
      values
    );
  }

  async getMediaPopularity(limit: number = 20): Promise<MediaPopularity[]> {
    return this.rawQuery<MediaPopularity>(
      `SELECT pl.media_id, mf.filename, mf.original_filename, mf.type,
              COUNT(pl.id) as play_count,
              SUM(pl.duration_watched) as total_duration
       FROM playback_logs pl
       JOIN media_files mf ON pl.media_id = mf.id
       GROUP BY pl.media_id, mf.filename, mf.original_filename, mf.type
       ORDER BY play_count DESC
       LIMIT ${limit}`
    );
  }

  async getClientUptimeStats(): Promise<UptimeStat[]> {
    return this.rawQuery<UptimeStat>(
      `SELECT c.id as client_id, c.name as client_name, c.status, c.last_seen,
              COUNT(pl.id) as total_logs
       FROM clients c
       LEFT JOIN playback_logs pl ON c.id = pl.client_id
       GROUP BY c.id, c.name, c.status, c.last_seen
       ORDER BY c.name ASC`
    );
  }

  async deleteOldPlaybackLogs(olderThanDays: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    const result = await this.rawExecute(
      `DELETE FROM playback_logs WHERE started_at < ${this.placeholder(1)}`,
      [cutoff.toISOString()]
    );
    return result.affectedRows;
  }

  // ── Notification operations ─────────────────────────────────────────────

  async createNotificationRule(input: CreateNotificationRuleInput): Promise<NotificationRule> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO notification_rules (name, event_type, channel, destination, enabled)
       VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)})`,
      [
        input.name,
        input.event_type,
        input.channel,
        input.destination,
        input.enabled !== false ? 1 : 0,
      ]
    );
    const rule = await this.getNotificationRuleById(result.lastInsertId);
    if (!rule) throw new Error('Failed to retrieve created notification rule');
    return rule;
  }

  async getNotificationRuleById(id: number): Promise<NotificationRule | null> {
    const row = await this.rawQueryOne<Omit<NotificationRule, 'enabled'> & { enabled: number }>(
      `SELECT * FROM notification_rules WHERE id = ${this.placeholder(1)}`,
      [id]
    );
    if (!row) return null;
    return { ...row, enabled: Boolean(row.enabled) };
  }

  async getAllNotificationRules(): Promise<NotificationRule[]> {
    const rows = await this.rawQuery<Omit<NotificationRule, 'enabled'> & { enabled: number }>(
      'SELECT * FROM notification_rules ORDER BY created_at DESC'
    );
    return rows.map((r) => ({ ...r, enabled: Boolean(r.enabled) }));
  }

  async getEnabledRulesForEvent(eventType: NotificationEventType): Promise<NotificationRule[]> {
    const rows = await this.rawQuery<Omit<NotificationRule, 'enabled'> & { enabled: number }>(
      `SELECT * FROM notification_rules WHERE event_type = ${this.placeholder(1)} AND enabled = 1`,
      [eventType]
    );
    return rows.map((r) => ({ ...r, enabled: Boolean(r.enabled) }));
  }

  async deleteNotificationRule(id: number): Promise<void> {
    await this.rawExecute(`DELETE FROM notification_rules WHERE id = ${this.placeholder(1)}`, [id]);
  }

  async createNotificationHistory(
    entry: Omit<NotificationHistory, 'id' | 'sent_at'>
  ): Promise<NotificationHistory> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO notification_history (rule_id, event_type, channel, destination, payload, status, error_message)
       VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)})`,
      [
        entry.rule_id,
        entry.event_type,
        entry.channel,
        entry.destination,
        entry.payload,
        entry.status,
        entry.error_message || null,
      ]
    );
    const row = await this.rawQueryOne<NotificationHistory>(
      `SELECT * FROM notification_history WHERE id = ${p(1)}`,
      [result.lastInsertId]
    );
    if (!row) throw new Error('Failed to retrieve created notification history');
    return row;
  }

  async getNotificationHistory(limit: number = 50): Promise<NotificationHistory[]> {
    return this.rawQuery<NotificationHistory>(
      `SELECT * FROM notification_history ORDER BY sent_at DESC LIMIT ${limit}`
    );
  }

  // ── Approval operations ─────────────────────────────────────────────────

  async updateMediaApproval(mediaId: number, status: ApprovalStatus): Promise<MediaFile> {
    return this.updateMedia(mediaId, { approval_status: status } as Partial<CreateMediaInput>);
  }

  async createApprovalLog(
    mediaId: number,
    action: ApprovalStatus,
    comment?: string
  ): Promise<ApprovalLog> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO approval_logs (media_id, action, comment) VALUES (${p(1)}, ${p(2)}, ${p(3)})`,
      [mediaId, action, comment || null]
    );
    const log = await this.rawQueryOne<ApprovalLog>(
      `SELECT * FROM approval_logs WHERE id = ${p(1)}`,
      [result.lastInsertId]
    );
    if (!log) throw new Error('Failed to retrieve created approval log');
    return log;
  }

  async getApprovalLogs(mediaId: number): Promise<ApprovalLog[]> {
    return this.rawQuery<ApprovalLog>(
      `SELECT * FROM approval_logs WHERE media_id = ${this.placeholder(1)} ORDER BY timestamp DESC`,
      [mediaId]
    );
  }

  async getPendingMedia(): Promise<MediaFile[]> {
    return this.rawQuery<MediaFile>(
      `SELECT * FROM media_files WHERE approval_status = 'pending' ORDER BY created_at DESC`
    );
  }

  // ── User operations ─────────────────────────────────────────────────────

  async createUser(input: CreateUserInput): Promise<User> {
    const p = this.placeholder;
    const result = await this.rawExecute(
      `INSERT INTO users (username, email, password_hash, role)
       VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)})`,
      [input.username, input.email, input.password_hash, input.role || 'viewer']
    );
    const user = await this.getUserById(result.lastInsertId);
    if (!user) throw new Error('Failed to retrieve created user');
    return user;
  }

  async getUserById(id: number): Promise<User | null> {
    return this.rawQueryOne<User>(`SELECT * FROM users WHERE id = ${this.placeholder(1)}`, [id]);
  }

  async getUserByUsername(username: string): Promise<User | null> {
    return this.rawQueryOne<User>(`SELECT * FROM users WHERE username = ${this.placeholder(1)}`, [
      username,
    ]);
  }

  async getUserByEmail(email: string): Promise<User | null> {
    return this.rawQueryOne<User>(`SELECT * FROM users WHERE email = ${this.placeholder(1)}`, [
      email,
    ]);
  }

  async getAllUsers(): Promise<User[]> {
    return this.rawQuery<User>('SELECT * FROM users ORDER BY created_at DESC');
  }

  async deleteUser(id: number): Promise<void> {
    await this.rawExecute(`DELETE FROM users WHERE id = ${this.placeholder(1)}`, [id]);
  }

  async updateUserPassword(id: number, passwordHash: string): Promise<void> {
    await this.rawExecute(
      `UPDATE users SET password_hash = ${this.placeholder(1)} WHERE id = ${this.placeholder(2)}`,
      [passwordHash, id]
    );
  }

  async getUserCount(): Promise<number> {
    const row = await this.rawQueryOne<{ count: number }>('SELECT COUNT(*) as count FROM users');
    return row?.count || 0;
  }
}
