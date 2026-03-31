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

  // ── Client group operations ──────────────────────────────────────────────

  async createClientGroup(input: CreateClientGroupInput): Promise<ClientGroup> {
    const id = await this.nextId('client_groups');
    const now = new Date().toISOString();
    const doc = {
      id,
      name: input.name,
      description: input.description || null,
      created_at: now,
      updated_at: now,
    };
    await this.col('client_groups').insertOne(doc);
    return doc as ClientGroup;
  }

  async getClientGroupById(id: number): Promise<ClientGroup | null> {
    const doc = await this.col('client_groups').findOne({ id });
    return this.docToObj<ClientGroup>(doc);
  }

  async getClientGroupWithMembers(id: number): Promise<ClientGroupWithMembers | null> {
    const group = await this.getClientGroupById(id);
    if (!group) return null;
    const members = await this.getGroupMembers(id);
    return { ...group, members };
  }

  async getAllClientGroups(): Promise<ClientGroup[]> {
    const docs = await this.col('client_groups').find().sort({ name: 1 }).toArray();
    return docs.map((d) => this.docToObj<ClientGroup>(d)!);
  }

  async updateClientGroup(id: number, input: UpdateClientGroupInput): Promise<ClientGroup> {
    const setFields: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.name !== undefined) setFields.name = input.name;
    if (input.description !== undefined) setFields.description = input.description;

    await this.col('client_groups').updateOne({ id }, { $set: setFields });
    const group = await this.getClientGroupById(id);
    if (!group) throw new Error(`Client group with ID ${id} not found`);
    return group;
  }

  async deleteClientGroup(id: number): Promise<void> {
    await this.col('client_group_members').deleteMany({ group_id: id });
    await this.col('client_groups').deleteOne({ id });
  }

  async addClientToGroup(groupId: number, clientId: string): Promise<ClientGroupMember> {
    const id = await this.nextId('client_group_members');
    const doc = {
      id,
      group_id: groupId,
      client_id: clientId,
      added_at: new Date().toISOString(),
    };
    await this.col('client_group_members').insertOne(doc);
    return doc as ClientGroupMember;
  }

  async removeClientFromGroup(groupId: number, clientId: string): Promise<void> {
    await this.col('client_group_members').deleteOne({ group_id: groupId, client_id: clientId });
  }

  async getGroupMembers(groupId: number): Promise<Client[]> {
    const memberDocs = await this.col('client_group_members').find({ group_id: groupId }).toArray();
    const clientIds = memberDocs.map((d) => d.client_id as string);
    if (clientIds.length === 0) return [];
    const clientDocs = await this.col('clients')
      .find({ id: { $in: clientIds } })
      .sort({ name: 1 })
      .toArray();
    return clientDocs.map((d) => this.docToObj<Client>(d)!);
  }

  async getClientGroups(clientId: string): Promise<ClientGroup[]> {
    const memberDocs = await this.col('client_group_members')
      .find({ client_id: clientId })
      .toArray();
    const groupIds = memberDocs.map((d) => d.group_id as number);
    if (groupIds.length === 0) return [];
    const groupDocs = await this.col('client_groups')
      .find({ id: { $in: groupIds } })
      .sort({ name: 1 })
      .toArray();
    return groupDocs.map((d) => this.docToObj<ClientGroup>(d)!);
  }

  // ── Schedule operations ──────────────────────────────────────────────────

  async createSchedule(input: CreateScheduleInput): Promise<Schedule> {
    const id = await this.nextId('schedules');
    const now = new Date().toISOString();
    const doc = {
      id,
      name: input.name,
      playlist_id: input.playlist_id,
      client_id: input.client_id || null,
      group_id: input.group_id || null,
      start_time: input.start_time,
      end_time: input.end_time || null,
      days_of_week: input.days_of_week || '0,1,2,3,4,5,6',
      priority: input.priority ?? 50,
      enabled: input.enabled !== false,
      created_at: now,
      updated_at: now,
    };
    await this.col('schedules').insertOne(doc);
    return doc as Schedule;
  }

  async getScheduleById(id: number): Promise<Schedule | null> {
    const doc = await this.col('schedules').findOne({ id });
    return this.docToObj<Schedule>(doc);
  }

  async getAllSchedules(): Promise<Schedule[]> {
    const docs = await this.col('schedules').find().sort({ priority: -1, name: 1 }).toArray();
    return docs.map((d) => this.docToObj<Schedule>(d)!);
  }

  async updateSchedule(id: number, input: UpdateScheduleInput): Promise<Schedule> {
    const setFields: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.name !== undefined) setFields.name = input.name;
    if (input.playlist_id !== undefined) setFields.playlist_id = input.playlist_id;
    if (input.client_id !== undefined) setFields.client_id = input.client_id;
    if (input.group_id !== undefined) setFields.group_id = input.group_id;
    if (input.start_time !== undefined) setFields.start_time = input.start_time;
    if (input.end_time !== undefined) setFields.end_time = input.end_time;
    if (input.days_of_week !== undefined) setFields.days_of_week = input.days_of_week;
    if (input.priority !== undefined) setFields.priority = input.priority;
    if (input.enabled !== undefined) setFields.enabled = input.enabled;

    await this.col('schedules').updateOne({ id }, { $set: setFields });
    const schedule = await this.getScheduleById(id);
    if (!schedule) throw new Error(`Schedule with ID ${id} not found`);
    return schedule;
  }

  async deleteSchedule(id: number): Promise<void> {
    await this.col('schedules').deleteOne({ id });
  }

  async getEnabledSchedules(): Promise<Schedule[]> {
    const docs = await this.col('schedules')
      .find({ enabled: true })
      .sort({ priority: -1 })
      .toArray();
    return docs.map((d) => this.docToObj<Schedule>(d)!);
  }

  // ── Migration executor ───────────────────────────────────────────────────

  // ── Client playlist operations ──────────────────────────────────────────

  async addClientPlaylist(
    clientId: string,
    playlistId: number,
    priority: number = 50
  ): Promise<ClientPlaylist> {
    const id = await this.nextId('client_playlists');
    const doc = {
      id,
      client_id: clientId,
      playlist_id: playlistId,
      priority,
      assigned_at: new Date().toISOString(),
    };
    await this.col('client_playlists').insertOne(doc);
    return doc as ClientPlaylist;
  }

  async removeClientPlaylist(clientId: string, playlistId: number): Promise<void> {
    await this.col('client_playlists').deleteOne({ client_id: clientId, playlist_id: playlistId });
  }

  async getClientPlaylists(clientId: string): Promise<ClientPlaylistWithDetails[]> {
    const assignments = await this.col('client_playlists')
      .find({ client_id: clientId })
      .sort({ priority: -1 })
      .toArray();

    const results: ClientPlaylistWithDetails[] = [];
    for (const a of assignments) {
      const playlist = await this.col('playlists').findOne({ id: a.playlist_id });
      results.push({
        ...this.docToObj<ClientPlaylist>(a)!,
        playlist_name: playlist ? (playlist.name as string) : 'Unknown',
      });
    }
    return results;
  }

  async updateClientPlaylistPriority(
    clientId: string,
    playlistId: number,
    priority: number
  ): Promise<ClientPlaylist> {
    await this.col('client_playlists').updateOne(
      { client_id: clientId, playlist_id: playlistId },
      { $set: { priority } }
    );
    const doc = await this.col('client_playlists').findOne({
      client_id: clientId,
      playlist_id: playlistId,
    });
    if (!doc) throw new Error('Client playlist assignment not found');
    return this.docToObj<ClientPlaylist>(doc)!;
  }

  // ── Playback log operations ─────────────────────────────────────────────

  async createPlaybackLog(input: CreatePlaybackLogInput): Promise<PlaybackLog> {
    const id = await this.nextId('playback_logs');
    const doc = {
      id,
      client_id: input.client_id,
      media_id: input.media_id,
      started_at: input.started_at || new Date().toISOString(),
      ended_at: input.ended_at || null,
      duration_watched: input.duration_watched || 0,
      completed: input.completed || false,
    };
    await this.col('playback_logs').insertOne(doc);
    return doc as PlaybackLog;
  }

  async updatePlaybackLog(
    id: number,
    updates: { ended_at?: string; duration_watched?: number; completed?: boolean }
  ): Promise<PlaybackLog> {
    const setFields: Record<string, unknown> = {};
    if (updates.ended_at !== undefined) setFields.ended_at = updates.ended_at;
    if (updates.duration_watched !== undefined)
      setFields.duration_watched = updates.duration_watched;
    if (updates.completed !== undefined) setFields.completed = updates.completed;

    if (Object.keys(setFields).length > 0) {
      await this.col('playback_logs').updateOne({ id }, { $set: setFields });
    }
    const doc = await this.col('playback_logs').findOne({ id });
    if (!doc) throw new Error(`Playback log with ID ${id} not found`);
    return this.docToObj<PlaybackLog>(doc)!;
  }

  async getPlaybackLogs(filter?: {
    client_id?: string;
    media_id?: number;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<PlaybackLog[]> {
    const query: Record<string, unknown> = {};
    if (filter?.client_id) query.client_id = filter.client_id;
    if (filter?.media_id) query.media_id = filter.media_id;
    if (filter?.from || filter?.to) {
      query.started_at = {};
      if (filter?.from) (query.started_at as Record<string, unknown>).$gte = filter.from;
      if (filter?.to) (query.started_at as Record<string, unknown>).$lte = filter.to;
    }

    const docs = await this.col('playback_logs')
      .find(query)
      .sort({ started_at: -1 })
      .limit(filter?.limit || 100)
      .toArray();
    return docs.map((d) => this.docToObj<PlaybackLog>(d)!);
  }

  async getPlaybackSummaryByClient(_from?: string, _to?: string): Promise<PlaybackSummary[]> {
    const pipeline: object[] = [];
    const matchStage: Record<string, unknown> = {};
    if (_from || _to) {
      matchStage.started_at = {};
      if (_from) (matchStage.started_at as Record<string, unknown>).$gte = _from;
      if (_to) (matchStage.started_at as Record<string, unknown>).$lte = _to;
      pipeline.push({ $match: matchStage });
    }
    pipeline.push(
      {
        $group: {
          _id: '$client_id',
          total_duration: { $sum: '$duration_watched' },
          total_plays: { $sum: 1 },
        },
      },
      { $sort: { total_duration: -1 } }
    );

    const results = await this.col('playback_logs').aggregate(pipeline).toArray();
    const summaries: PlaybackSummary[] = [];
    for (const r of results) {
      const client = await this.col('clients').findOne({ id: r._id });
      summaries.push({
        client_id: r._id as string,
        client_name: client ? (client.name as string) : 'Unknown',
        total_duration: r.total_duration as number,
        total_plays: r.total_plays as number,
      });
    }
    return summaries;
  }

  async getMediaPopularity(limit: number = 20): Promise<MediaPopularity[]> {
    const results = await this.col('playback_logs')
      .aggregate([
        {
          $group: {
            _id: '$media_id',
            play_count: { $sum: 1 },
            total_duration: { $sum: '$duration_watched' },
          },
        },
        { $sort: { play_count: -1 } },
        { $limit: limit },
      ])
      .toArray();

    const popularity: MediaPopularity[] = [];
    for (const r of results) {
      const media = await this.col('media_files').findOne({ id: r._id });
      if (media) {
        popularity.push({
          media_id: r._id as number,
          filename: media.filename as string,
          original_filename: media.original_filename as string,
          type: media.type as string,
          play_count: r.play_count as number,
          total_duration: r.total_duration as number,
        });
      }
    }
    return popularity;
  }

  async getClientUptimeStats(): Promise<UptimeStat[]> {
    const clients = await this.col('clients').find().sort({ name: 1 }).toArray();
    const stats: UptimeStat[] = [];
    for (const c of clients) {
      const logCount = await this.col('playback_logs').countDocuments({ client_id: c.id });
      stats.push({
        client_id: c.id as string,
        client_name: c.name as string,
        status: c.status as string,
        last_seen: (c.last_seen as string) || null,
        total_logs: logCount,
      });
    }
    return stats;
  }

  async deleteOldPlaybackLogs(olderThanDays: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);
    const result = await this.col('playback_logs').deleteMany({
      started_at: { $lt: cutoff.toISOString() },
    });
    return result.deletedCount;
  }

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
