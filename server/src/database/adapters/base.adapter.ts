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
  ScheduleTemplate,
  CreateScheduleTemplateInput,
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
  UpdateUserInput,
  PaginationParams,
  PaginatedResult,
  MediaFilter,
  ClientFilter,
  ClientTelemetryRow,
  CreateClientTelemetryInput,
  ClientLogEventRow,
  CreateClientLogEventInput,
  ClientLogLevel,
  MediaFolder,
  CreateMediaFolderInput,
  UpdateMediaFolderInput,
  SubtitleTrack,
  CreateExternalSubtitleInput,
  CreateEmbeddedSubtitleInput,
  UpdateSubtitleInput,
  ThumbnailJob,
  UploadCompletionJob,
  UploadCompletionJobInput,
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
  /** Bulk move media to folder (null = root). Returns number of rows affected. */
  moveMediaToFolder(mediaIds: number[], folderId: number | null): Promise<number>;
  /**
   * Reset any rows stuck at thumbnail_status='generating' (from a prior crash)
   * to 'failed' so the UI shows a retry button instead of silently hanging.
   * Returns the number of rows updated. Called once at startup.
   */
  resetStuckThumbnails(): Promise<number>;

  // ── Thumbnail job queue ──────────────────────────────────────────────
  /** Insert a new queued thumbnail job for the given media. */
  enqueueThumbnailJob(mediaId: number): Promise<ThumbnailJob>;
  /** Atomically claim the oldest queued job: mark it 'running' and return it.
   *  Returns null when the queue is empty. */
  claimNextThumbnailJob(): Promise<ThumbnailJob | null>;
  /** Mark a job successfully complete. */
  markThumbnailJobDone(jobId: number): Promise<void>;
  /** Mark a job failed; increments `attempts` and stores the error. */
  markThumbnailJobFailed(jobId: number, error: string): Promise<void>;
  /** On startup: flip any jobs stuck at 'running' back to 'queued'. */
  requeueRunningThumbnailJobs(): Promise<number>;
  /** Look up the most recent job for a given media (any state). */
  getLatestThumbnailJobForMedia(mediaId: number): Promise<ThumbnailJob | null>;

  // ── Upload completion job queue ──────────────────────────────────────
  /**
   * Insert (or return existing) a queued upload-completion job. Idempotent
   * on `upload_id` — repeat calls for the same session yield the same row.
   */
  enqueueUploadCompletionJob(input: UploadCompletionJobInput): Promise<UploadCompletionJob>;
  /** Atomically claim the oldest queued job. Returns null when empty. */
  claimNextUploadCompletionJob(): Promise<UploadCompletionJob | null>;
  /** Terminal: job produced a new media row. */
  markUploadCompletionJobDone(jobId: number, mediaId: number): Promise<void>;
  /** Terminal: checksum matched an existing media row; no new row created. */
  markUploadCompletionJobDuplicate(jobId: number, existingMediaId: number): Promise<void>;
  /** Terminal: processing failed. `error` is truncated to 2000 chars. */
  markUploadCompletionJobFailed(jobId: number, error: string): Promise<void>;
  /** On startup: flip any jobs stuck at 'running' back to 'queued'. */
  requeueRunningUploadCompletionJobs(): Promise<number>;
  /** Drives `GET /api/media/upload/:uploadId/status`. */
  getUploadCompletionJobByUploadId(uploadId: string): Promise<UploadCompletionJob | null>;

  // Media folder operations
  createMediaFolder(input: CreateMediaFolderInput): Promise<MediaFolder>;
  getMediaFolderById(id: number): Promise<MediaFolder | null>;
  getAllMediaFolders(): Promise<MediaFolder[]>;
  updateMediaFolder(id: number, input: UpdateMediaFolderInput): Promise<MediaFolder>;
  deleteMediaFolder(id: number): Promise<void>;
  /** Returns all descendant folders of the given folder (not including itself). */
  getMediaFolderDescendants(id: number): Promise<MediaFolder[]>;
  /** Count of media files + subfolders directly under this folder. */
  getMediaFolderContentCounts(id: number): Promise<{ media: number; subfolders: number }>;

  // Subtitle track operations
  createExternalSubtitle(input: CreateExternalSubtitleInput): Promise<SubtitleTrack>;
  createEmbeddedSubtitle(input: CreateEmbeddedSubtitleInput): Promise<SubtitleTrack>;
  getSubtitleById(id: number): Promise<SubtitleTrack | null>;
  getSubtitlesForMedia(mediaFileId: number): Promise<SubtitleTrack[]>;
  updateSubtitle(id: number, input: UpdateSubtitleInput): Promise<SubtitleTrack>;
  deleteSubtitle(id: number): Promise<void>;
  /** Removes embedded rows for a media whose stream_index is NOT in the keep set. */
  pruneEmbeddedSubtitles(mediaFileId: number, keepStreamIndexes: number[]): Promise<number>;
  /** Per-media subtitle counts across all media in the library. */
  getSubtitleCountsByMedia(): Promise<Record<number, number>>;

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

  // Schedule template operations
  createScheduleTemplate(input: CreateScheduleTemplateInput): Promise<ScheduleTemplate>;
  getScheduleTemplateById(id: number): Promise<ScheduleTemplate | null>;
  getAllScheduleTemplates(): Promise<ScheduleTemplate[]>;
  deleteScheduleTemplate(id: number): Promise<void>;

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
    updates: {
      ended_at?: string;
      duration_watched?: number;
      completed?: boolean;
      rebuffer_count?: number;
      dropped_frames?: number;
      time_to_first_frame_ms?: number;
      decoder_errors?: number;
    }
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

  // Client telemetry operations
  recordClientTelemetry(input: CreateClientTelemetryInput): Promise<ClientTelemetryRow>;
  getClientTelemetryRange(
    clientId: string,
    fromMs: number,
    toMs: number,
    limit?: number
  ): Promise<ClientTelemetryRow[]>;
  getClientTelemetryLatest(clientId: string): Promise<ClientTelemetryRow | null>;
  getAllClientTelemetryLatest(): Promise<Record<string, ClientTelemetryRow>>;
  recordClientLogEvent(input: CreateClientLogEventInput): Promise<ClientLogEventRow>;
  getClientLogEvents(
    clientId: string,
    level?: ClientLogLevel,
    limit?: number
  ): Promise<ClientLogEventRow[]>;
  deleteOldClientTelemetry(olderThanDays: number): Promise<number>;
  deleteOldClientLogEvents(olderThanDays: number): Promise<number>;

  // User operations
  createUser(input: CreateUserInput): Promise<User>;
  getUserById(id: number): Promise<User | null>;
  getUserByUsername(username: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  getAllUsers(): Promise<User[]>;
  deleteUser(id: number): Promise<void>;
  updateUser(id: number, input: UpdateUserInput): Promise<User>;
  updateUserPassword(id: number, passwordHash: string): Promise<void>;
  getUserCount(): Promise<number>;
}
