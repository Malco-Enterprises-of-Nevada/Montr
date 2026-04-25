/**
 * WebSocket Message Types and Schemas
 * Defines all message types for client-server communication
 */

import { z } from 'zod';
import WebSocket from 'ws';

/**
 * Client capabilities
 */
export interface ClientCapabilities {
  video: boolean;
  image: boolean;
}

/**
 * Subtitle track associated with a playlist media item. Sent over the WS
 * wire so the Rust client can pre-fetch external files and feed mpv the
 * right `--sub-file` / `sid` parameters.
 */
export interface SubtitleTrackPayload {
  id: number;
  kind: 'external' | 'embedded';
  language: string | null;
  label: string | null;
  isDefault: boolean;
  isForced: boolean;
  // External-only fields
  downloadUrl?: string;
  filename?: string;
  format?: 'srt' | 'vtt';
  checksum?: string;
  // Embedded-only fields
  streamIndex?: number;
  codec?: string;
}

/**
 * Media item in playlist
 */
export interface PlaylistMediaItem {
  id: number;
  mediaId: number;
  filename: string;
  downloadUrl: string;
  type: 'video' | 'image';
  duration?: number;
  checksum: string | null;
  orderIndex: number;
  imageDuration: number;
  /** Subtitle tracks for this media (always an array; empty if none). Added in protocol 1.1.0. */
  subtitles: SubtitleTrackPayload[];
  /**
   * File size in bytes from `media_files.file_size`. Added in protocol 1.2.0
   * so clients can budget preload bandwidth/disk by total bytes rather than
   * just item count. Optional for backward compatibility — pre-1.2.0 clients
   * just ignore it.
   */
  fileSize?: number;
}

/**
 * Current media info in status update
 */
export interface CurrentMediaInfo {
  id: number;
  filename: string;
}

// ===========================
// Client → Server Messages
// ===========================

/**
 * Client registration message
 */
export interface RegisterMessage {
  type: 'register';
  clientId: string;
  version: string;
  capabilities: ClientCapabilities;
  name?: string;
}

/**
 * Client status update message
 */
export interface StatusUpdateMessage {
  type: 'status_update';
  clientId: string;
  currentMedia: CurrentMediaInfo | null;
  position: number | null;
  isPlaying: boolean;
  timestamp: number;
}

/**
 * Client heartbeat message
 */
export interface HeartbeatMessage {
  type: 'heartbeat';
  clientId: string;
  timestamp: number;
}

/**
 * Severity tier for client-reported errors. Defaults to `error` if absent
 * on the wire (legacy clients).
 */
export type ClientErrorSeverity = 'warn' | 'error' | 'fatal';

/**
 * Client error message
 */
export interface ErrorMessage {
  type: 'error';
  clientId: string;
  error: string;
  context?: Record<string, unknown>;
  /** Subsystem that originated the error, e.g. `playback`, `cache`, `network`. */
  source?: string;
  /** Severity tier; missing means legacy client — treat as `error`. */
  severity?: ClientErrorSeverity;
  timestamp?: number;
}

/**
 * Admin/browser registration message
 */
export interface AdminRegisterMessage {
  type: 'admin_register';
}

/**
 * Per-disk telemetry sample
 */
export interface TelemetryDiskSample {
  mount: string;
  used_bytes: number;
  total_bytes: number;
}

/**
 * Per-sensor temperature sample
 */
export interface TelemetryTempSample {
  label: string;
  celsius: number;
}

/**
 * Network telemetry sub-sample
 */
export interface TelemetryNetSample {
  ws_reconnects: number;
  last_rtt_ms: number | null;
  bytes_dl_total: number;
}

/**
 * mpv health telemetry sub-sample
 */
export interface TelemetryMpvSample {
  alive: boolean;
  dropped_frames: number;
  last_decoder_error: string | null;
}

/**
 * Process-level telemetry sub-sample
 */
export interface TelemetryProcessSample {
  client_uptime_s: number;
  mpv_uptime_s: number;
  restart_count: number;
}

/**
 * Periodic telemetry message (60s cadence)
 */
export interface TelemetryMessage {
  type: 'telemetry';
  clientId: string;
  cpu_pct: number;
  mem_used_mb: number;
  mem_total_mb: number;
  disks: TelemetryDiskSample[];
  temps: TelemetryTempSample[];
  net: TelemetryNetSample;
  mpv: TelemetryMpvSample;
  process: TelemetryProcessSample;
  timestamp: number;
}

/**
 * Auto-pushed log event message (warn/error only)
 */
export interface LogEventMessage {
  type: 'log_event';
  clientId: string;
  level: 'warn' | 'error';
  target: string;
  message: string;
  timestamp: number;
}

/**
 * Union type of all client-to-server messages (from playback clients)
 */
export type ClientMessage =
  | RegisterMessage
  | StatusUpdateMessage
  | HeartbeatMessage
  | ErrorMessage
  | TelemetryMessage
  | LogEventMessage;

// ===========================
// Server → Client Messages
// ===========================

/**
 * Playlist assigned message
 */
export interface PlaylistAssignedMessage {
  type: 'playlist_assigned';
  playlistId: number;
  playlistName: string;
  loopPlaylist: boolean;
  items: PlaylistMediaItem[];
}

/**
 * Playlist updated message
 */
export interface PlaylistUpdatedMessage {
  type: 'playlist_updated';
  playlistId: number;
  loopPlaylist: boolean;
  items: PlaylistMediaItem[];
}

/**
 * Schedule definition pushed to a client. Subset of the server `Schedule`
 * row — server-internal fields like `template_id`, `lastTriggered`, and
 * timestamps are omitted. The client uses these to re-evaluate locally
 * while offline so playlist transitions still fire when the WS link drops.
 */
export interface ScheduleDef {
  id: number;
  name: string;
  playlistId: number;
  /** Single-client target (UUID), or null for group/global scope. */
  clientId: string | null;
  /** Group target id, or null for client/global scope. */
  groupId: number | null;
  /** "HH:MM" or null when cron-only. */
  startTime: string | null;
  /** "HH:MM" or null. */
  endTime: string | null;
  /** Comma-separated day numbers, e.g. "0,1,2,3,4,5,6". */
  daysOfWeek: string;
  priority: number;
  enabled: boolean;
  /** 5-field cron expression, or null when start/end-time only. */
  cronExpression: string | null;
  /** IANA timezone (e.g. "America/Los_Angeles"); null = client local. */
  timezone: string | null;
  /** Extra rules: holidays, special_dates, event_trigger. Pass-through JSON. */
  conditions: unknown;
  interruptMode: 'assign' | 'interrupt';
  durationSeconds: number | null;
}

/**
 * Schedule definitions pushed to a single client. Server emits this on
 * registration and after any CRUD that changes which schedules apply to the
 * client (schedule create/update/delete, group membership change). Client
 * persists the latest set and re-evaluates from cache when offline.
 */
export interface ScheduleDefinitionsMessage {
  type: 'schedule_definitions';
  schedules: ScheduleDef[];
}

/**
 * Command types supported by the system
 */
export type CommandType =
  | 'reload_playlist'
  | 'pause'
  | 'resume'
  | 'skip'
  | 'previous'
  | 'volume'
  | 'seek'
  | 'fetch_logs'
  | 'screenshot';

/**
 * Command message with optional arguments
 */
export interface CommandMessage {
  type: 'command';
  command: CommandType;
  args?: Record<string, unknown>;
}

/**
 * Error response message
 */
export interface ErrorResponseMessage {
  type: 'error_response';
  error: string;
  details?: string;
}

/**
 * Success response message
 */
export interface SuccessResponseMessage {
  type: 'success';
  message: string;
}

/**
 * Playlist interrupt message — high-priority playlist overrides current
 */
export interface PlaylistInterruptMessage {
  type: 'playlist_interrupt';
  playlistId: number;
  playlistName: string;
  loopPlaylist: boolean;
  items: PlaylistMediaItem[];
  previousPlaylistId: number | null;
}

/**
 * Playlist resume message — revert to previous playlist after interruption
 */
export interface PlaylistResumeMessage {
  type: 'playlist_resume';
  playlistId: number | null;
  playlistName: string | null;
  loopPlaylist: boolean;
  items: PlaylistMediaItem[];
}

/**
 * Union type of all server-to-client messages
 */
export type ServerMessage =
  | PlaylistAssignedMessage
  | PlaylistUpdatedMessage
  | PlaylistInterruptMessage
  | PlaylistResumeMessage
  | CommandMessage
  | ErrorResponseMessage
  | SuccessResponseMessage
  | ScheduleDefinitionsMessage;

// ===========================
// Server → Admin/Browser Messages
// ===========================

/**
 * Client status broadcast to admin browsers
 */
export interface ClientStatusBroadcast {
  type: 'client_status_update';
  clientId: string;
  currentMedia: CurrentMediaInfo | null;
  position: number | null;
  isPlaying: boolean;
  timestamp: number;
}

/**
 * Client state change broadcast to admin browsers
 */
export interface ClientStateChangeBroadcast {
  type: 'client_state_change';
  clientId: string;
  status: 'online' | 'offline';
}

/**
 * Client-reported error broadcast to admin browsers. Carries severity so
 * the UI can render warnings differently from hard errors.
 */
export interface ClientErrorBroadcast {
  type: 'client_error';
  clientId: string;
  error: string;
  source?: string;
  severity: ClientErrorSeverity;
  context?: Record<string, unknown>;
  timestamp: number;
}

/**
 * Union type of admin broadcast messages
 */
export type AdminBroadcast =
  | ClientStatusBroadcast
  | ClientStateChangeBroadcast
  | ClientErrorBroadcast;

// ===========================
// Zod Validation Schemas
// ===========================

/**
 * Schema for client capabilities
 */
export const clientCapabilitiesSchema = z.object({
  video: z.boolean(),
  image: z.boolean(),
});

/**
 * Schema for current media info
 */
export const currentMediaInfoSchema = z.object({
  id: z.number(),
  filename: z.string(),
});

/**
 * Schema for register message
 */
export const registerMessageSchema = z.object({
  type: z.literal('register'),
  clientId: z.string().uuid('Client ID must be a valid UUID'),
  version: z.string().min(1, 'Version is required'),
  capabilities: clientCapabilitiesSchema,
  name: z.string().min(1).optional(),
});

/**
 * Schema for status update message
 */
export const statusUpdateMessageSchema = z.object({
  type: z.literal('status_update'),
  clientId: z.string().uuid('Client ID must be a valid UUID'),
  currentMedia: currentMediaInfoSchema.nullable(),
  position: z.number().min(0, 'Position must be non-negative').nullable(),
  isPlaying: z.boolean(),
  timestamp: z.number(),
});

/**
 * Schema for heartbeat message
 */
export const heartbeatMessageSchema = z.object({
  type: z.literal('heartbeat'),
  clientId: z.string().uuid('Client ID must be a valid UUID'),
  timestamp: z.number(),
});

/**
 * Schema for error message
 */
export const errorMessageSchema = z.object({
  type: z.literal('error'),
  clientId: z.string().uuid('Client ID must be a valid UUID'),
  error: z.string().min(1, 'Error message is required'),
  context: z.record(z.string(), z.unknown()).optional(),
  source: z.string().min(1).max(64).optional(),
  severity: z.enum(['warn', 'error', 'fatal']).optional(),
  timestamp: z.number().optional(),
});

/**
 * Schemas for telemetry sub-objects
 */
const telemetryDiskSchema = z.object({
  mount: z.string(),
  used_bytes: z.number().min(0),
  total_bytes: z.number().min(0),
});
const telemetryTempSchema = z.object({
  label: z.string(),
  celsius: z.number(),
});
const telemetryNetSchema = z.object({
  ws_reconnects: z.number().min(0),
  last_rtt_ms: z.number().min(0).nullable(),
  bytes_dl_total: z.number().min(0),
});
const telemetryMpvSchema = z.object({
  alive: z.boolean(),
  dropped_frames: z.number().min(0),
  last_decoder_error: z.string().nullable(),
});
const telemetryProcessSchema = z.object({
  client_uptime_s: z.number().min(0),
  mpv_uptime_s: z.number().min(0),
  restart_count: z.number().min(0),
});

/**
 * Schema for telemetry message
 */
export const telemetryMessageSchema = z.object({
  type: z.literal('telemetry'),
  clientId: z.string().uuid('Client ID must be a valid UUID'),
  cpu_pct: z.number().min(0).max(100),
  mem_used_mb: z.number().min(0),
  mem_total_mb: z.number().min(0),
  disks: z.array(telemetryDiskSchema),
  temps: z.array(telemetryTempSchema),
  net: telemetryNetSchema,
  mpv: telemetryMpvSchema,
  process: telemetryProcessSchema,
  timestamp: z.number(),
});

/**
 * Schema for log event message
 */
export const logEventMessageSchema = z.object({
  type: z.literal('log_event'),
  clientId: z.string().uuid('Client ID must be a valid UUID'),
  level: z.enum(['warn', 'error']),
  target: z.string(),
  message: z.string(),
  timestamp: z.number(),
});

/**
 * Schema for any client message
 */
export const clientMessageSchema = z.discriminatedUnion('type', [
  registerMessageSchema,
  statusUpdateMessageSchema,
  heartbeatMessageSchema,
  errorMessageSchema,
  telemetryMessageSchema,
  logEventMessageSchema,
]);

// ===========================
// WebSocket Extensions
// ===========================

/**
 * Extended WebSocket with client metadata
 */
export interface ExtendedWebSocket extends WebSocket {
  clientId?: string;
  isAlive?: boolean;
  lastHeartbeat?: number;
}

/**
 * Connection metadata
 */
export interface ConnectionMetadata {
  clientId: string;
  connectedAt: Date;
  lastHeartbeat: Date;
  messageCount: number;
}

/**
 * WebSocket server statistics
 */
export interface WebSocketStats {
  totalConnections: number;
  activeConnections: number;
  messagesSent: number;
  messagesReceived: number;
  errors: number;
}

/**
 * Type guard to check if a value is a valid client message
 */
export function isClientMessage(value: unknown): value is ClientMessage {
  const result = clientMessageSchema.safeParse(value);
  return result.success;
}

/**
 * Validates and parses a client message
 * @throws {ZodError} if validation fails
 */
export function parseClientMessage(data: unknown): ClientMessage {
  return clientMessageSchema.parse(data);
}
