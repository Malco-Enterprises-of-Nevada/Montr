/**
 * Database types and interfaces
 */

export type ThumbnailStatus = 'pending' | 'generating' | 'generated' | 'failed';

export interface MediaFile {
  id: number;
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
  thumbnail_status: ThumbnailStatus;
  approval_status: ApprovalStatus;
  folder_id: number | null;
  created_at: string;
  updated_at: string;
}

// Media folder types
export interface MediaFolder {
  id: number;
  name: string;
  parent_id: number | null;
  path: string;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

export interface CreateMediaFolderInput {
  name: string;
  parent_id?: number | null;
  created_by?: number | null;
}

export interface UpdateMediaFolderInput {
  name?: string;
  parent_id?: number | null;
}

// Subtitle track types
export type SubtitleKind = 'external' | 'embedded';
export type SubtitleFormat = 'srt' | 'vtt';

export interface SubtitleTrack {
  id: number;
  media_file_id: number;
  kind: SubtitleKind;
  // External-only fields
  storage_filename: string | null;
  original_filename: string | null;
  format: SubtitleFormat | null;
  size_bytes: number | null;
  checksum: string | null;
  // Embedded-only fields
  stream_index: number | null;
  codec: string | null;
  // Common metadata
  language: string | null;
  label: string | null;
  is_default: boolean;
  is_forced: boolean;
  created_at: string;
}

export interface CreateExternalSubtitleInput {
  media_file_id: number;
  storage_filename: string;
  original_filename: string;
  format: SubtitleFormat;
  size_bytes: number;
  checksum: string;
  language?: string | null;
  label?: string | null;
  is_default?: boolean;
  is_forced?: boolean;
}

export interface CreateEmbeddedSubtitleInput {
  media_file_id: number;
  stream_index: number;
  codec: string;
  language?: string | null;
  label?: string | null;
  is_default?: boolean;
  is_forced?: boolean;
}

export interface UpdateSubtitleInput {
  language?: string | null;
  label?: string | null;
  is_default?: boolean;
  is_forced?: boolean;
}

export interface Playlist {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlaylistItem {
  id: number;
  playlist_id: number;
  media_id: number;
  order_index: number;
  image_duration: number;
  created_at: string;
}

export interface PlaylistWithItems extends Playlist {
  items: Array<PlaylistItemWithMedia>;
}

export interface PlaylistItemWithMedia extends PlaylistItem {
  media: MediaFile;
}

export interface Client {
  id: string;
  name: string;
  assigned_playlist_id: number | null;
  interrupted_from_playlist_id: number | null;
  status: 'online' | 'offline' | 'error';
  last_seen: string | null;
  version: string | null;
  capabilities: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientStatus {
  id: number;
  client_id: string;
  current_media_id: number | null;
  position: number | null;
  is_playing: boolean;
  error_message: string | null;
  timestamp: string;
}

export interface ClientWithStatus extends Client {
  current_status: ClientStatus | null;
}

// Input types for creating/updating records
export interface CreateMediaInput {
  filename: string;
  original_filename: string;
  filepath: string;
  type: 'video' | 'image';
  mime_type?: string;
  file_size?: number;
  duration?: number;
  width?: number;
  height?: number;
  checksum?: string;
  thumbnail_status?: ThumbnailStatus;
  folder_id?: number | null;
}

export interface UpdateMediaInput {
  original_filename?: string;
  folder_id?: number | null;
}

export interface CreatePlaylistInput {
  name: string;
  description?: string;
}

export interface UpdatePlaylistInput {
  name?: string;
  description?: string;
}

export interface AddPlaylistItemInput {
  playlist_id: number;
  media_id: number;
  order_index?: number;
  image_duration?: number;
}

export interface UpdatePlaylistItemInput {
  order_index?: number;
  image_duration?: number;
}

export interface CreateClientInput {
  id: string;
  name: string;
  version?: string;
  capabilities?: string;
}

export interface UpdateClientInput {
  name?: string;
  assigned_playlist_id?: number | null;
  interrupted_from_playlist_id?: number | null;
  status?: 'online' | 'offline' | 'error';
  last_seen?: string;
  version?: string;
  capabilities?: string;
}

export interface CreateClientStatusInput {
  client_id: string;
  current_media_id?: number;
  position?: number;
  is_playing: boolean;
  error_message?: string;
}

// Pagination types
export interface PaginationParams {
  page: number;
  limit: number;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// Filter types
export interface MediaFilter {
  type?: 'video' | 'image';
  search?: string;
  /** Numeric ID filters by folder; 'root' filters for media with NULL folder_id; undefined = no filter */
  folder_id?: number | 'root';
}

export interface ClientFilter {
  status?: 'online' | 'offline' | 'error';
  assigned_playlist_id?: number;
}

// Client Group types
export interface ClientGroup {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientGroupMember {
  id: number;
  group_id: number;
  client_id: string;
  added_at: string;
}

export interface ClientGroupWithMembers extends ClientGroup {
  members: Client[];
}

export interface CreateClientGroupInput {
  name: string;
  description?: string;
}

export interface UpdateClientGroupInput {
  name?: string;
  description?: string;
}

// Schedule types
export type ScheduleInterruptMode = 'assign' | 'interrupt';

export interface ScheduleHolidayCondition {
  country: string;
  regions?: string[];
  /** 'on' = fires when today IS a holiday; 'not_on' = fires when today is NOT a holiday */
  match: 'on' | 'not_on';
}

export interface ScheduleEventCondition {
  event_type: NotificationEventType;
}

export interface ScheduleConditions {
  holidays?: ScheduleHolidayCondition;
  /** ISO yyyy-mm-dd strings. Fires only when today matches one of these. */
  special_dates?: string[];
  /** Rule fires when a matching NotificationEvent is emitted (not on the 60s tick). */
  event_trigger?: ScheduleEventCondition;
}

export interface Schedule {
  id: number;
  name: string;
  playlist_id: number;
  client_id: string | null;
  group_id: number | null;
  start_time: string | null;
  end_time: string | null;
  days_of_week: string;
  priority: number;
  enabled: boolean;
  cron_expression: string | null;
  duration_seconds: number | null;
  timezone: string | null;
  conditions: ScheduleConditions | null;
  interrupt_mode: ScheduleInterruptMode;
  template_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface CreateScheduleInput {
  name: string;
  playlist_id: number;
  client_id?: string;
  group_id?: number;
  start_time?: string;
  end_time?: string;
  days_of_week?: string;
  priority?: number;
  enabled?: boolean;
  cron_expression?: string;
  duration_seconds?: number;
  timezone?: string;
  conditions?: ScheduleConditions;
  interrupt_mode?: ScheduleInterruptMode;
  template_id?: number;
}

export interface UpdateScheduleInput {
  name?: string;
  playlist_id?: number;
  client_id?: string | null;
  group_id?: number | null;
  start_time?: string | null;
  end_time?: string | null;
  days_of_week?: string;
  priority?: number;
  enabled?: boolean;
  cron_expression?: string | null;
  duration_seconds?: number | null;
  timezone?: string | null;
  conditions?: ScheduleConditions | null;
  interrupt_mode?: ScheduleInterruptMode;
  template_id?: number | null;
}

// Schedule template types
export interface ScheduleTemplateDefinition {
  mode: 'simple' | 'advanced';
  start_time?: string;
  end_time?: string;
  days_of_week?: string;
  cron_expression?: string;
  duration_seconds?: number;
  timezone?: string;
  conditions?: ScheduleConditions;
  interrupt_mode?: ScheduleInterruptMode;
  priority?: number;
}

export interface ScheduleTemplate {
  id: number;
  name: string;
  description: string | null;
  definition: ScheduleTemplateDefinition;
  is_builtin: boolean;
  created_at: string;
}

export interface CreateScheduleTemplateInput {
  name: string;
  description?: string;
  definition: ScheduleTemplateDefinition;
}

// Client playlist assignment types
export interface ClientPlaylist {
  id: number;
  client_id: string;
  playlist_id: number;
  priority: number;
  assigned_at: string;
}

export interface ClientPlaylistWithDetails extends ClientPlaylist {
  playlist_name: string;
}

// Playback log types
export interface PlaybackLog {
  id: number;
  client_id: string;
  media_id: number;
  started_at: string;
  ended_at: string | null;
  duration_watched: number;
  completed: boolean;
}

export interface CreatePlaybackLogInput {
  client_id: string;
  media_id: number;
  started_at?: string;
  ended_at?: string;
  duration_watched?: number;
  completed?: boolean;
}

export interface PlaybackSummary {
  client_id: string;
  client_name: string;
  total_duration: number;
  total_plays: number;
}

export interface MediaPopularity {
  media_id: number;
  filename: string;
  original_filename: string;
  type: string;
  play_count: number;
  total_duration: number;
}

export interface UptimeStat {
  client_id: string;
  client_name: string;
  status: string;
  last_seen: string | null;
  total_logs: number;
}

// Notification types
// User types
export type UserRole = 'admin' | 'editor' | 'viewer';

export interface User {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  role: UserRole;
  created_at: string;
}

export interface CreateUserInput {
  username: string;
  email: string;
  password_hash: string;
  role?: UserRole;
}

export interface UpdateUserInput {
  email?: string;
  role?: UserRole;
}

export interface UserPublic {
  id: number;
  username: string;
  email: string;
  role: UserRole;
  created_at: string;
}

// Content approval types
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalLog {
  id: number;
  media_id: number;
  action: ApprovalStatus;
  comment: string | null;
  timestamp: string;
}

// Notification types
export type NotificationEventType =
  | 'client_offline'
  | 'client_error'
  | 'playlist_empty'
  | 'storage_full'
  | 'media_approval_needed';
export type NotificationChannel = 'email' | 'webhook';

export interface NotificationRule {
  id: number;
  name: string;
  event_type: NotificationEventType;
  channel: NotificationChannel;
  destination: string;
  enabled: boolean;
  created_at: string;
}

export interface CreateNotificationRuleInput {
  name: string;
  event_type: NotificationEventType;
  channel: NotificationChannel;
  destination: string;
  enabled?: boolean;
}

export interface NotificationHistory {
  id: number;
  rule_id: number;
  event_type: NotificationEventType;
  channel: NotificationChannel;
  destination: string;
  payload: string;
  status: 'sent' | 'failed';
  error_message: string | null;
  sent_at: string;
}

// Client telemetry types
export interface TelemetryDiskSample {
  mount: string;
  used_bytes: number;
  total_bytes: number;
}

export interface TelemetryTempSample {
  label: string;
  celsius: number;
}

export interface TelemetryNetSample {
  ws_reconnects: number;
  last_rtt_ms: number | null;
  bytes_dl_total: number;
}

export interface TelemetryMpvSample {
  alive: boolean;
  dropped_frames: number;
  last_decoder_error: string | null;
}

export interface TelemetryProcessSample {
  client_uptime_s: number;
  mpv_uptime_s: number;
  restart_count: number;
}

export interface ClientTelemetryRow {
  id: number;
  client_id: string;
  cpu_pct: number;
  mem_used_mb: number;
  mem_total_mb: number;
  disks: TelemetryDiskSample[];
  temps: TelemetryTempSample[];
  net: TelemetryNetSample;
  mpv: TelemetryMpvSample;
  process: TelemetryProcessSample;
  recorded_at: string;
}

export interface CreateClientTelemetryInput {
  client_id: string;
  cpu_pct: number;
  mem_used_mb: number;
  mem_total_mb: number;
  disks: TelemetryDiskSample[];
  temps: TelemetryTempSample[];
  net: TelemetryNetSample;
  mpv: TelemetryMpvSample;
  process: TelemetryProcessSample;
}

export type ClientLogLevel = 'warn' | 'error';

export interface ClientLogEventRow {
  id: number;
  client_id: string;
  level: ClientLogLevel;
  target: string;
  message: string;
  recorded_at: string;
}

export interface CreateClientLogEventInput {
  client_id: string;
  level: ClientLogLevel;
  target: string;
  message: string;
}
