/**
 * MongoDB database adapter implementation
 * Uses the official mongodb driver
 */

import { MongoClient, Db, Collection, ObjectId, Document } from 'mongodb';
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
import { MigrationRunner, MigrationExecutor } from '../migrations/runner';
import { AdapterType } from '../migrations/types';
import { getLogger } from '../../utils/logger';

const logger = getLogger();

export class MongoDBAdapter implements DatabaseAdapter {
  private client: MongoClient | null = null;

  private db: Db | null = null;

  private uri: string;

  private dbName: string;

  constructor(uri: string) {
    this.uri = uri;
    // Extract database name from URI or default to 'montr'
    const match = uri.match(/\/([^/?]+)(\?|$)/);
    this.dbName = match?.[1] || 'montr';
  }

  async connect(): Promise<void> {
    try {
      this.client = new MongoClient(this.uri);
      await this.client.connect();
      this.db = this.client.db(this.dbName);

      // Run migrations
      const runner = new MigrationRunner(this.getMigrationExecutor());
      await runner.run();

      logger.info(`MongoDB connected: ${this.dbName}`);
    } catch (error) {
      logger.error('Failed to connect to MongoDB:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
      logger.info('MongoDB disconnected');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.db !== null;
  }

  private getDb(): Db {
    if (!this.db) throw new Error('Database not connected');
    return this.db;
  }

  private col(name: string): Collection {
    return this.getDb().collection(name);
  }

  /** Get next auto-increment ID for a collection */
  private async nextId(collectionName: string): Promise<number> {
    const result = await this.col('counters').findOneAndUpdate(
      { _id: collectionName as unknown as ObjectId },
      { $inc: { seq: 1 } },
      { returnDocument: 'after', upsert: true }
    );
    return (result?.seq as number) || 1;
  }

  /** Convert MongoDB document to typed object, mapping _id if needed */
  private docToObj<T>(doc: Document | null): T | null {
    if (!doc) return null;
    // Remove MongoDB's _id if the type has its own id field
    const { _id, ...rest } = doc;
    return rest as T;
  }

  // ── Media operations ─────────────────────────────────────────────────────

  async createMedia(input: CreateMediaInput): Promise<MediaFile> {
    const id = await this.nextId('media_files');
    const now = new Date().toISOString();
    const doc = {
      id,
      filename: input.filename,
      original_filename: input.original_filename,
      filepath: input.filepath,
      type: input.type,
      mime_type: input.mime_type || null,
      file_size: input.file_size || null,
      duration: input.duration || null,
      width: input.width || null,
      height: input.height || null,
      checksum: input.checksum || null,
      thumbnail_status: input.thumbnail_status || 'pending',
      created_at: now,
      updated_at: now,
    };
    await this.col('media_files').insertOne(doc);
    return doc as MediaFile;
  }

  async getMediaById(id: number): Promise<MediaFile | null> {
    const doc = await this.col('media_files').findOne({ id });
    return this.docToObj<MediaFile>(doc);
  }

  async getAllMedia(
    pagination: PaginationParams,
    filter?: MediaFilter
  ): Promise<PaginatedResult<MediaFile>> {
    const { page, limit } = pagination;
    const offset = (page - 1) * limit;
    const query: Record<string, unknown> = {};

    if (filter?.type) {
      query.type = filter.type;
    }
    if (filter?.search) {
      query.$or = [
        { original_filename: { $regex: filter.search, $options: 'i' } },
        { filename: { $regex: filter.search, $options: 'i' } },
      ];
    }

    const total = await this.col('media_files').countDocuments(query);
    const docs = await this.col('media_files')
      .find(query)
      .sort({ created_at: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();

    return {
      data: docs.map((d) => this.docToObj<MediaFile>(d)!),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async updateMedia(id: number, updates: Partial<CreateMediaInput>): Promise<MediaFile> {
    const validFields = new Set([
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
    ]);

    const setFields: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const [key, value] of Object.entries(updates)) {
      if (!validFields.has(key)) throw new Error(`Invalid field name: ${key}`);
      setFields[key] = value;
    }

    if (Object.keys(setFields).length === 1) {
      // Only updated_at, no real updates
      const media = await this.getMediaById(id);
      if (!media) throw new Error(`Media with ID ${id} not found`);
      return media;
    }

    await this.col('media_files').updateOne({ id }, { $set: setFields });
    const media = await this.getMediaById(id);
    if (!media) throw new Error(`Media with ID ${id} not found`);
    return media;
  }

  async deleteMedia(id: number): Promise<void> {
    // Cascade: remove playlist items referencing this media
    await this.col('playlist_items').deleteMany({ media_id: id });
    // Cascade: null out client_status references
    await this.col('client_status').updateMany(
      { current_media_id: id },
      { $set: { current_media_id: null } }
    );
    await this.col('media_files').deleteOne({ id });
  }

  async getMediaByChecksum(checksum: string): Promise<MediaFile | null> {
    const doc = await this.col('media_files').findOne({ checksum });
    return this.docToObj<MediaFile>(doc);
  }

  // ── Playlist operations ──────────────────────────────────────────────────

  async createPlaylist(input: CreatePlaylistInput): Promise<Playlist> {
    const id = await this.nextId('playlists');
    const now = new Date().toISOString();
    const doc = {
      id,
      name: input.name,
      description: input.description || null,
      created_at: now,
      updated_at: now,
    };
    await this.col('playlists').insertOne(doc);
    return doc as Playlist;
  }

  async getPlaylistById(id: number): Promise<Playlist | null> {
    const doc = await this.col('playlists').findOne({ id });
    return this.docToObj<Playlist>(doc);
  }

  async getPlaylistWithItems(id: number): Promise<PlaylistWithItems | null> {
    const playlist = await this.getPlaylistById(id);
    if (!playlist) return null;

    const itemDocs = await this.col('playlist_items')
      .find({ playlist_id: id })
      .sort({ order_index: 1 })
      .toArray();

    const items: PlaylistItemWithMedia[] = [];
    for (const itemDoc of itemDocs) {
      const mediaDoc = await this.col('media_files').findOne({ id: itemDoc.media_id });
      if (mediaDoc) {
        items.push({
          id: itemDoc.id as number,
          playlist_id: itemDoc.playlist_id as number,
          media_id: itemDoc.media_id as number,
          order_index: itemDoc.order_index as number,
          image_duration: itemDoc.image_duration as number,
          created_at: itemDoc.created_at as string,
          media: this.docToObj<MediaFile>(mediaDoc)!,
        });
      }
    }

    return { ...playlist, items };
  }

  async getAllPlaylists(): Promise<Playlist[]> {
    const docs = await this.col('playlists').find().sort({ created_at: -1 }).toArray();
    return docs.map((d) => this.docToObj<Playlist>(d)!);
  }

  async updatePlaylist(id: number, input: UpdatePlaylistInput): Promise<Playlist> {
    const setFields: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (input.name !== undefined) setFields.name = input.name;
    if (input.description !== undefined) setFields.description = input.description;

    if (Object.keys(setFields).length === 1) {
      const playlist = await this.getPlaylistById(id);
      if (!playlist) throw new Error(`Playlist with ID ${id} not found`);
      return playlist;
    }

    await this.col('playlists').updateOne({ id }, { $set: setFields });
    const playlist = await this.getPlaylistById(id);
    if (!playlist) throw new Error(`Playlist with ID ${id} not found`);
    return playlist;
  }

  async deletePlaylist(id: number): Promise<void> {
    // Cascade: delete playlist items
    await this.col('playlist_items').deleteMany({ playlist_id: id });
    // Cascade: null out client assignments
    await this.col('clients').updateMany(
      { assigned_playlist_id: id },
      { $set: { assigned_playlist_id: null } }
    );
    await this.col('playlists').deleteOne({ id });
  }

  // ── Playlist item operations ─────────────────────────────────────────────

  async addPlaylistItem(input: AddPlaylistItemInput): Promise<PlaylistItem> {
    const id = await this.nextId('playlist_items');
    const now = new Date().toISOString();
    const doc = {
      id,
      playlist_id: input.playlist_id,
      media_id: input.media_id,
      order_index: input.order_index,
      image_duration: input.image_duration || 5,
      created_at: now,
    };
    await this.col('playlist_items').insertOne(doc);

    // Update playlist's updated_at
    await this.col('playlists').updateOne({ id: input.playlist_id }, { $set: { updated_at: now } });

    return doc as PlaylistItem;
  }

  async getPlaylistItems(playlistId: number): Promise<PlaylistItem[]> {
    const docs = await this.col('playlist_items')
      .find({ playlist_id: playlistId })
      .sort({ order_index: 1 })
      .toArray();
    return docs.map((d) => this.docToObj<PlaylistItem>(d)!);
  }

  async getPlaylistItemById(itemId: number): Promise<PlaylistItem | null> {
    const doc = await this.col('playlist_items').findOne({ id: itemId });
    return this.docToObj<PlaylistItem>(doc);
  }

  async updatePlaylistItem(itemId: number, input: UpdatePlaylistItemInput): Promise<PlaylistItem> {
    const setFields: Record<string, unknown> = {};

    if (input.order_index !== undefined) setFields.order_index = input.order_index;
    if (input.image_duration !== undefined) setFields.image_duration = input.image_duration;

    if (Object.keys(setFields).length === 0) {
      const item = await this.getPlaylistItemById(itemId);
      if (!item) throw new Error(`Playlist item with ID ${itemId} not found`);
      return item;
    }

    await this.col('playlist_items').updateOne({ id: itemId }, { $set: setFields });

    // Update playlist's updated_at
    const item = await this.getPlaylistItemById(itemId);
    if (!item) throw new Error(`Playlist item with ID ${itemId} not found`);

    await this.col('playlists').updateOne(
      { id: item.playlist_id },
      { $set: { updated_at: new Date().toISOString() } }
    );

    return item;
  }

  async deletePlaylistItem(itemId: number): Promise<void> {
    const item = await this.getPlaylistItemById(itemId);
    await this.col('playlist_items').deleteOne({ id: itemId });

    // Update playlist's updated_at
    if (item) {
      await this.col('playlists').updateOne(
        { id: item.playlist_id },
        { $set: { updated_at: new Date().toISOString() } }
      );
    }
  }

  async reorderPlaylistItems(_playlistId: number, itemIds: number[]): Promise<void> {
    for (let i = 0; i < itemIds.length; i++) {
      await this.col('playlist_items').updateOne({ id: itemIds[i] }, { $set: { order_index: i } });
    }
  }

  // ── Client operations ────────────────────────────────────────────────────

  async createClient(input: CreateClientInput): Promise<Client> {
    const now = new Date().toISOString();
    const doc = {
      id: input.id,
      name: input.name,
      assigned_playlist_id: null,
      status: 'offline' as const,
      last_seen: now,
      version: input.version || null,
      capabilities: input.capabilities || null,
      created_at: now,
      updated_at: now,
    };
    await this.col('clients').insertOne(doc);
    return doc as Client;
  }

  async getClientById(id: string): Promise<Client | null> {
    const doc = await this.col('clients').findOne({ id });
    return this.docToObj<Client>(doc);
  }

  async getAllClients(filter?: ClientFilter): Promise<Client[]> {
    const query: Record<string, unknown> = {};
    if (filter?.status) query.status = filter.status;
    if (filter?.assigned_playlist_id !== undefined) {
      query.assigned_playlist_id = filter.assigned_playlist_id;
    }

    const docs = await this.col('clients').find(query).sort({ created_at: -1 }).toArray();
    return docs.map((d) => this.docToObj<Client>(d)!);
  }

  async updateClient(id: string, input: UpdateClientInput): Promise<Client> {
    const setFields: Record<string, unknown> = { updated_at: new Date().toISOString() };

    if (input.name !== undefined) setFields.name = input.name;
    if (input.assigned_playlist_id !== undefined)
      setFields.assigned_playlist_id = input.assigned_playlist_id;
    if (input.status !== undefined) setFields.status = input.status;
    if (input.last_seen !== undefined) setFields.last_seen = input.last_seen;
    if (input.version !== undefined) setFields.version = input.version;
    if (input.capabilities !== undefined) setFields.capabilities = input.capabilities;

    if (Object.keys(setFields).length === 1) {
      const client = await this.getClientById(id);
      if (!client) throw new Error(`Client with ID ${id} not found`);
      return client;
    }

    await this.col('clients').updateOne({ id }, { $set: setFields });
    const client = await this.getClientById(id);
    if (!client) throw new Error(`Client with ID ${id} not found`);
    return client;
  }

  async deleteClient(id: string): Promise<void> {
    // Cascade: delete client status records
    await this.col('client_status').deleteMany({ client_id: id });
    await this.col('clients').deleteOne({ id });
  }

  // ── Client status operations ─────────────────────────────────────────────

  async createClientStatus(input: CreateClientStatusInput): Promise<ClientStatus> {
    const id = await this.nextId('client_status');
    const doc = {
      id,
      client_id: input.client_id,
      current_media_id: input.current_media_id || null,
      position: input.position || null,
      is_playing: input.is_playing,
      error_message: input.error_message || null,
      timestamp: new Date().toISOString(),
    };
    await this.col('client_status').insertOne(doc);
    return doc as ClientStatus;
  }

  async getLatestClientStatus(clientId: string): Promise<ClientStatus | null> {
    const doc = await this.col('client_status').findOne(
      { client_id: clientId },
      { sort: { timestamp: -1 } }
    );
    return this.docToObj<ClientStatus>(doc);
  }

  async getClientWithStatus(clientId: string): Promise<ClientWithStatus | null> {
    const client = await this.getClientById(clientId);
    if (!client) return null;

    const status = await this.getLatestClientStatus(clientId);
    return { ...client, current_status: status };
  }

  // ── Migration executor ───────────────────────────────────────────────────

  getMigrationExecutor(): MigrationExecutor {
    const self = this;
    return {
      adapterType: 'mongodb' as AdapterType,
      getMongoDb(): Db {
        return self.getDb();
      },
      async tableExists(name: string): Promise<boolean> {
        const collections = await self.getDb().listCollections({ name }).toArray();
        return collections.length > 0;
      },
    };
  }
}
