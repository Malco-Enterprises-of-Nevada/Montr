/**
 * Base database adapter interface
 * All database adapters must implement this interface
 */

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
  PaginationParams,
  PaginatedResult,
  MediaFilter,
  ClientFilter,
} from '../types';

export interface DatabaseAdapter {
  // Connection management
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  // Media operations
  createMedia(input: CreateMediaInput): Promise<MediaFile>;
  getMediaById(id: number): Promise<MediaFile | null>;
  getAllMedia(
    pagination: PaginationParams,
    filter?: MediaFilter
  ): Promise<PaginatedResult<MediaFile>>;
  updateMedia(id: number, updates: Partial<CreateMediaInput>): Promise<MediaFile>;
  deleteMedia(id: number): Promise<void>;
  getMediaByChecksum(checksum: string): Promise<MediaFile | null>;

  // Playlist operations
  createPlaylist(input: CreatePlaylistInput): Promise<Playlist>;
  getPlaylistById(id: number): Promise<Playlist | null>;
  getPlaylistWithItems(id: number): Promise<PlaylistWithItems | null>;
  getAllPlaylists(): Promise<Playlist[]>;
  updatePlaylist(id: number, input: UpdatePlaylistInput): Promise<Playlist>;
  deletePlaylist(id: number): Promise<void>;

  // Playlist item operations
  addPlaylistItem(input: AddPlaylistItemInput): Promise<PlaylistItem>;
  getPlaylistItems(playlistId: number): Promise<PlaylistItem[]>;
  getPlaylistItemById(itemId: number): Promise<PlaylistItem | null>;
  updatePlaylistItem(itemId: number, input: UpdatePlaylistItemInput): Promise<PlaylistItem>;
  deletePlaylistItem(itemId: number): Promise<void>;
  reorderPlaylistItems(playlistId: number, itemIds: number[]): Promise<void>;

  // Client operations
  createClient(input: CreateClientInput): Promise<Client>;
  getClientById(id: string): Promise<Client | null>;
  getAllClients(filter?: ClientFilter): Promise<Client[]>;
  updateClient(id: string, input: UpdateClientInput): Promise<Client>;
  deleteClient(id: string): Promise<void>;

  // Client status operations
  createClientStatus(input: CreateClientStatusInput): Promise<ClientStatus>;
  getLatestClientStatus(clientId: string): Promise<ClientStatus | null>;
  getClientWithStatus(clientId: string): Promise<ClientWithStatus | null>;

  // Client group operations
  createClientGroup(input: CreateClientGroupInput): Promise<ClientGroup>;
  getClientGroupById(id: number): Promise<ClientGroup | null>;
  getClientGroupWithMembers(id: number): Promise<ClientGroupWithMembers | null>;
  getAllClientGroups(): Promise<ClientGroup[]>;
  updateClientGroup(id: number, input: UpdateClientGroupInput): Promise<ClientGroup>;
  deleteClientGroup(id: number): Promise<void>;
  addClientToGroup(groupId: number, clientId: string): Promise<ClientGroupMember>;
  removeClientFromGroup(groupId: number, clientId: string): Promise<void>;
  getGroupMembers(groupId: number): Promise<Client[]>;
  getClientGroups(clientId: string): Promise<ClientGroup[]>;

  // Schedule operations
  createSchedule(input: CreateScheduleInput): Promise<Schedule>;
  getScheduleById(id: number): Promise<Schedule | null>;
  getAllSchedules(): Promise<Schedule[]>;
  updateSchedule(id: number, input: UpdateScheduleInput): Promise<Schedule>;
  deleteSchedule(id: number): Promise<void>;
  getEnabledSchedules(): Promise<Schedule[]>;

  // Client playlist operations
  addClientPlaylist(
    clientId: string,
    playlistId: number,
    priority?: number
  ): Promise<ClientPlaylist>;
  removeClientPlaylist(clientId: string, playlistId: number): Promise<void>;
  getClientPlaylists(clientId: string): Promise<ClientPlaylistWithDetails[]>;
  updateClientPlaylistPriority(
    clientId: string,
    playlistId: number,
    priority: number
  ): Promise<ClientPlaylist>;

  // Playback log operations
  createPlaybackLog(input: CreatePlaybackLogInput): Promise<PlaybackLog>;
  updatePlaybackLog(
    id: number,
    updates: { ended_at?: string; duration_watched?: number; completed?: boolean }
  ): Promise<PlaybackLog>;
  getPlaybackLogs(filter?: {
    client_id?: string;
    media_id?: number;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<PlaybackLog[]>;
  getPlaybackSummaryByClient(from?: string, to?: string): Promise<PlaybackSummary[]>;
  getMediaPopularity(limit?: number): Promise<MediaPopularity[]>;
  getClientUptimeStats(): Promise<UptimeStat[]>;
  deleteOldPlaybackLogs(olderThanDays: number): Promise<number>;

  // Notification operations
  createNotificationRule(input: CreateNotificationRuleInput): Promise<NotificationRule>;
  getNotificationRuleById(id: number): Promise<NotificationRule | null>;
  getAllNotificationRules(): Promise<NotificationRule[]>;
  getEnabledRulesForEvent(eventType: NotificationEventType): Promise<NotificationRule[]>;
  deleteNotificationRule(id: number): Promise<void>;
  createNotificationHistory(
    entry: Omit<NotificationHistory, 'id' | 'sent_at'>
  ): Promise<NotificationHistory>;
  getNotificationHistory(limit?: number): Promise<NotificationHistory[]>;

  // Approval operations
  updateMediaApproval(mediaId: number, status: ApprovalStatus): Promise<MediaFile>;
  createApprovalLog(
    mediaId: number,
    action: ApprovalStatus,
    comment?: string
  ): Promise<ApprovalLog>;
  getApprovalLogs(mediaId: number): Promise<ApprovalLog[]>;
  getPendingMedia(): Promise<MediaFile[]>;
}
