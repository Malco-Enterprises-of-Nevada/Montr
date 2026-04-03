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
 * Client error message
 */
export interface ErrorMessage {
  type: 'error';
  clientId: string;
  error: string;
  context?: Record<string, unknown>;
  timestamp?: number;
}

/**
 * Admin/browser registration message
 */
export interface AdminRegisterMessage {
  type: 'admin_register';
}

/**
 * Union type of all client-to-server messages (from playback clients)
 */
export type ClientMessage = RegisterMessage | StatusUpdateMessage | HeartbeatMessage | ErrorMessage;

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
 * Command types supported by the system
 */
export type CommandType =
  | 'reload_playlist'
  | 'pause'
  | 'resume'
  | 'skip'
  | 'previous'
  | 'volume'
  | 'seek';

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
  | SuccessResponseMessage;

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
 * Union type of admin broadcast messages
 */
export type AdminBroadcast = ClientStatusBroadcast | ClientStateChangeBroadcast;

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
  timestamp: z.number().optional(),
});

/**
 * Schema for any client message
 */
export const clientMessageSchema = z.discriminatedUnion('type', [
  registerMessageSchema,
  statusUpdateMessageSchema,
  heartbeatMessageSchema,
  errorMessageSchema,
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
