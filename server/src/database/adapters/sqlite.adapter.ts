/**
 * SQLite database adapter implementation
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
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
  PaginationParams,
  PaginatedResult,
  MediaFilter,
  ClientFilter,
  PlaylistItemWithMedia,
} from '../types';
import { getLogger } from '../../utils/logger';

const logger = getLogger();

export class SQLiteAdapter implements DatabaseAdapter {
  private db: Database.Database | null = null;

  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async connect(): Promise<void> {
    try {
      // Ensure database directory exists
      const dbDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      // Open database connection
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');

      // Initialize schema
      await this.initializeSchema();

      logger.info(`SQLite database connected: ${this.dbPath}`);
    } catch (error) {
      logger.error('Failed to connect to SQLite database:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      logger.info('SQLite database disconnected');
    }
  }

  isConnected(): boolean {
    return this.db !== null;
  }

  private async initializeSchema(): Promise<void> {
    if (!this.db) throw new Error('Database not connected');

    const schemaPath = path.join(__dirname, '../schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf-8');

    // Execute schema in a transaction
    this.db.exec(schema);
    logger.info('Database schema initialized');
  }

  private getDb(): Database.Database {
    if (!this.db) {
      throw new Error('Database not connected');
    }
    return this.db;
  }

  // Media operations
  async createMedia(input: CreateMediaInput): Promise<MediaFile> {
    const db = this.getDb();
    const stmt = db.prepare(`
      INSERT INTO media_files (
        filename, original_filename, filepath, type, mime_type,
        file_size, duration, width, height, checksum
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      input.filename,
      input.original_filename,
      input.filepath,
      input.type,
      input.mime_type || null,
      input.file_size || null,
      input.duration || null,
      input.width || null,
      input.height || null,
      input.checksum || null
    );

    const media = await this.getMediaById(Number(result.lastInsertRowid));
    if (!media) throw new Error('Failed to retrieve created media');
    return media;
  }

  async getMediaById(id: number): Promise<MediaFile | null> {
    const db = this.getDb();
    const stmt = db.prepare('SELECT * FROM media_files WHERE id = ?');
    const result = stmt.get(id) as MediaFile | undefined;
    return result || null;
  }

  async getAllMedia(
    pagination: PaginationParams,
    filter?: MediaFilter
  ): Promise<PaginatedResult<MediaFile>> {
    const db = this.getDb();
    const { page, limit } = pagination;
    const offset = (page - 1) * limit;

    let whereClause = '';
    const params: unknown[] = [];

    if (filter) {
      const conditions: string[] = [];
      if (filter.type) {
        conditions.push('type = ?');
        params.push(filter.type);
      }
      if (filter.search) {
        conditions.push('(original_filename LIKE ? OR filename LIKE ?)');
        params.push(`%${filter.search}%`, `%${filter.search}%`);
      }
      if (conditions.length > 0) {
        whereClause = `WHERE ${conditions.join(' AND ')}`;
      }
    }

    // Get total count
    const countStmt = db.prepare(`SELECT COUNT(*) as count FROM media_files ${whereClause}`);
    const { count } = countStmt.get(...params) as { count: number };

    // Get paginated data
    const dataStmt = db.prepare(`
      SELECT * FROM media_files
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);
    const data = dataStmt.all(...params, limit, offset) as MediaFile[];

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
    const db = this.getDb();
    const fields: string[] = [];
    const values: unknown[] = [];

    Object.entries(updates).forEach(([key, value]) => {
      fields.push(`${key} = ?`);
      values.push(value);
    });

    if (fields.length === 0) {
      const media = await this.getMediaById(id);
      if (!media) throw new Error(`Media with ID ${id} not found`);
      return media;
    }

    values.push(id);
    const stmt = db.prepare(`
      UPDATE media_files
      SET ${fields.join(', ')}
      WHERE id = ?
    `);
    stmt.run(...values);

    const media = await this.getMediaById(id);
    if (!media) throw new Error(`Media with ID ${id} not found`);
    return media;
  }

  async deleteMedia(id: number): Promise<void> {
    const db = this.getDb();
    const stmt = db.prepare('DELETE FROM media_files WHERE id = ?');
    stmt.run(id);
  }

  async getMediaByChecksum(checksum: string): Promise<MediaFile | null> {
    const db = this.getDb();
    const stmt = db.prepare('SELECT * FROM media_files WHERE checksum = ?');
    const result = stmt.get(checksum) as MediaFile | undefined;
    return result || null;
  }

  // Playlist operations
  async createPlaylist(input: CreatePlaylistInput): Promise<Playlist> {
    const db = this.getDb();
    const stmt = db.prepare(`
      INSERT INTO playlists (name, description)
      VALUES (?, ?)
    `);

    const result = stmt.run(input.name, input.description || null);
    const playlist = await this.getPlaylistById(Number(result.lastInsertRowid));
    if (!playlist) throw new Error('Failed to retrieve created playlist');
    return playlist;
  }

  async getPlaylistById(id: number): Promise<Playlist | null> {
    const db = this.getDb();
    const stmt = db.prepare('SELECT * FROM playlists WHERE id = ?');
    const result = stmt.get(id) as Playlist | undefined;
    return result || null;
  }

  async getPlaylistWithItems(id: number): Promise<PlaylistWithItems | null> {
    const playlist = await this.getPlaylistById(id);
    if (!playlist) return null;

    const db = this.getDb();
    const stmt = db.prepare(`
      SELECT
        pi.id, pi.playlist_id, pi.media_id, pi.order_index, pi.image_duration, pi.created_at,
        mf.id as media_id, mf.filename, mf.original_filename, mf.filepath, mf.type,
        mf.mime_type, mf.file_size, mf.duration, mf.width, mf.height, mf.checksum,
        mf.created_at as media_created_at, mf.updated_at as media_updated_at
      FROM playlist_items pi
      JOIN media_files mf ON pi.media_id = mf.id
      WHERE pi.playlist_id = ?
      ORDER BY pi.order_index ASC
    `);

    const rows = stmt.all(id) as Array<PlaylistItem & {
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
      media_created_at: string;
      media_updated_at: string;
    }>;

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
        created_at: row.media_created_at,
        updated_at: row.media_updated_at,
      },
    }));

    return {
      ...playlist,
      items,
    };
  }

  async getAllPlaylists(): Promise<Playlist[]> {
    const db = this.getDb();
    const stmt = db.prepare('SELECT * FROM playlists ORDER BY created_at DESC');
    return stmt.all() as Playlist[];
  }

  async updatePlaylist(id: number, input: UpdatePlaylistInput): Promise<Playlist> {
    const db = this.getDb();
    const fields: string[] = [];
    const values: unknown[] = [];

    if (input.name !== undefined) {
      fields.push('name = ?');
      values.push(input.name);
    }
    if (input.description !== undefined) {
      fields.push('description = ?');
      values.push(input.description);
    }

    if (fields.length === 0) {
      const playlist = await this.getPlaylistById(id);
      if (!playlist) throw new Error(`Playlist with ID ${id} not found`);
      return playlist;
    }

    values.push(id);
    const stmt = db.prepare(`
      UPDATE playlists
      SET ${fields.join(', ')}
      WHERE id = ?
    `);
    stmt.run(...values);

    const playlist = await this.getPlaylistById(id);
    if (!playlist) throw new Error(`Playlist with ID ${id} not found`);
    return playlist;
  }

  async deletePlaylist(id: number): Promise<void> {
    const db = this.getDb();
    const stmt = db.prepare('DELETE FROM playlists WHERE id = ?');
    stmt.run(id);
  }

  // Playlist item operations
  async addPlaylistItem(input: AddPlaylistItemInput): Promise<PlaylistItem> {
    const db = this.getDb();
    const stmt = db.prepare(`
      INSERT INTO playlist_items (playlist_id, media_id, order_index, image_duration)
      VALUES (?, ?, ?, ?)
    `);

    const result = stmt.run(
      input.playlist_id,
      input.media_id,
      input.order_index,
      input.image_duration || 5
    );

    const item = await this.getPlaylistItemById(Number(result.lastInsertRowid));
    if (!item) throw new Error('Failed to retrieve created playlist item');
    return item;
  }

  async getPlaylistItems(playlistId: number): Promise<PlaylistItem[]> {
    const db = this.getDb();
    const stmt = db.prepare(`
      SELECT * FROM playlist_items
      WHERE playlist_id = ?
      ORDER BY order_index ASC
    `);
    return stmt.all(playlistId) as PlaylistItem[];
  }

  async getPlaylistItemById(itemId: number): Promise<PlaylistItem | null> {
    const db = this.getDb();
    const stmt = db.prepare('SELECT * FROM playlist_items WHERE id = ?');
    const result = stmt.get(itemId) as PlaylistItem | undefined;
    return result || null;
  }

  async updatePlaylistItem(itemId: number, input: UpdatePlaylistItemInput): Promise<PlaylistItem> {
    const db = this.getDb();
    const fields: string[] = [];
    const values: unknown[] = [];

    if (input.order_index !== undefined) {
      fields.push('order_index = ?');
      values.push(input.order_index);
    }
    if (input.image_duration !== undefined) {
      fields.push('image_duration = ?');
      values.push(input.image_duration);
    }

    if (fields.length === 0) {
      const item = await this.getPlaylistItemById(itemId);
      if (!item) throw new Error(`Playlist item with ID ${itemId} not found`);
      return item;
    }

    values.push(itemId);
    const stmt = db.prepare(`
      UPDATE playlist_items
      SET ${fields.join(', ')}
      WHERE id = ?
    `);
    stmt.run(...values);

    const item = await this.getPlaylistItemById(itemId);
    if (!item) throw new Error(`Playlist item with ID ${itemId} not found`);
    return item;
  }

  async deletePlaylistItem(itemId: number): Promise<void> {
    const db = this.getDb();
    const stmt = db.prepare('DELETE FROM playlist_items WHERE id = ?');
    stmt.run(itemId);
  }

  async reorderPlaylistItems(_playlistId: number, itemIds: number[]): Promise<void> {
    const db = this.getDb();
    const updateStmt = db.prepare('UPDATE playlist_items SET order_index = ? WHERE id = ?');

    const transaction = db.transaction(() => {
      itemIds.forEach((itemId, index) => {
        updateStmt.run(index, itemId);
      });
    });

    transaction();
  }

  // Client operations
  async createClient(input: CreateClientInput): Promise<Client> {
    const db = this.getDb();
    const stmt = db.prepare(`
      INSERT INTO clients (id, name, version, capabilities, last_seen)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    stmt.run(input.id, input.name, input.version || null, input.capabilities || null);

    const client = await this.getClientById(input.id);
    if (!client) throw new Error('Failed to retrieve created client');
    return client;
  }

  async getClientById(id: string): Promise<Client | null> {
    const db = this.getDb();
    const stmt = db.prepare('SELECT * FROM clients WHERE id = ?');
    const result = stmt.get(id) as Client | undefined;
    return result || null;
  }

  async getAllClients(filter?: ClientFilter): Promise<Client[]> {
    const db = this.getDb();
    let whereClause = '';
    const params: unknown[] = [];

    if (filter) {
      const conditions: string[] = [];
      if (filter.status) {
        conditions.push('status = ?');
        params.push(filter.status);
      }
      if (filter.assigned_playlist_id !== undefined) {
        conditions.push('assigned_playlist_id = ?');
        params.push(filter.assigned_playlist_id);
      }
      if (conditions.length > 0) {
        whereClause = `WHERE ${conditions.join(' AND ')}`;
      }
    }

    const stmt = db.prepare(`
      SELECT * FROM clients
      ${whereClause}
      ORDER BY created_at DESC
    `);
    return stmt.all(...params) as Client[];
  }

  async updateClient(id: string, input: UpdateClientInput): Promise<Client> {
    const db = this.getDb();
    const fields: string[] = [];
    const values: unknown[] = [];

    if (input.name !== undefined) {
      fields.push('name = ?');
      values.push(input.name);
    }
    if (input.assigned_playlist_id !== undefined) {
      fields.push('assigned_playlist_id = ?');
      values.push(input.assigned_playlist_id);
    }
    if (input.status !== undefined) {
      fields.push('status = ?');
      values.push(input.status);
    }
    if (input.last_seen !== undefined) {
      fields.push('last_seen = ?');
      values.push(input.last_seen);
    }
    if (input.version !== undefined) {
      fields.push('version = ?');
      values.push(input.version);
    }
    if (input.capabilities !== undefined) {
      fields.push('capabilities = ?');
      values.push(input.capabilities);
    }

    if (fields.length === 0) {
      const client = await this.getClientById(id);
      if (!client) throw new Error(`Client with ID ${id} not found`);
      return client;
    }

    values.push(id);
    const stmt = db.prepare(`
      UPDATE clients
      SET ${fields.join(', ')}
      WHERE id = ?
    `);
    stmt.run(...values);

    const client = await this.getClientById(id);
    if (!client) throw new Error(`Client with ID ${id} not found`);
    return client;
  }

  async deleteClient(id: string): Promise<void> {
    const db = this.getDb();
    const stmt = db.prepare('DELETE FROM clients WHERE id = ?');
    stmt.run(id);
  }

  // Client status operations
  async createClientStatus(input: CreateClientStatusInput): Promise<ClientStatus> {
    const db = this.getDb();
    const stmt = db.prepare(`
      INSERT INTO client_status (
        client_id, current_media_id, position, is_playing, error_message
      )
      VALUES (?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      input.client_id,
      input.current_media_id || null,
      input.position || null,
      input.is_playing ? 1 : 0,
      input.error_message || null
    );

    const db2 = this.getDb();
    const getStmt = db2.prepare('SELECT * FROM client_status WHERE id = ?');
    const status = getStmt.get(result.lastInsertRowid) as ClientStatus | undefined;
    if (!status) throw new Error('Failed to retrieve created client status');
    return status;
  }

  async getLatestClientStatus(clientId: string): Promise<ClientStatus | null> {
    const db = this.getDb();
    const stmt = db.prepare(`
      SELECT * FROM client_status
      WHERE client_id = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    const result = stmt.get(clientId) as ClientStatus | undefined;
    return result || null;
  }

  async getClientWithStatus(clientId: string): Promise<ClientWithStatus | null> {
    const client = await this.getClientById(clientId);
    if (!client) return null;

    const status = await this.getLatestClientStatus(clientId);

    return {
      ...client,
      current_status: status,
    };
  }
}
