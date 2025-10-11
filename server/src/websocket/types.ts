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
}

/**
 * Client status update message
 */
export interface StatusUpdateMessage {
  type: 'status_update';
  clientId: string;
  currentMedia: CurrentMediaInfo | null;
  position: number;
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
}

/**
 * Union type of all client-to-server messages
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
  items: PlaylistMediaItem[];
}

/**
 * Playlist updated message
 */
export interface PlaylistUpdatedMessage {
  type: 'playlist_updated';
  playlistId: number;
  items: PlaylistMediaItem[];
}

/**
 * Command message
 */
export interface CommandMessage {
  type: 'command';
  command: 'reload_playlist' | 'pause' | 'resume';
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
 * Union type of all server-to-client messages
 */
export type ServerMessage =
  | PlaylistAssignedMessage
  | PlaylistUpdatedMessage
  | CommandMessage
  | ErrorResponseMessage
  | SuccessResponseMessage;

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
});

/**
 * Schema for status update message
 */
export const statusUpdateMessageSchema = z.object({
  type: z.literal('status_update'),
  clientId: z.string().uuid('Client ID must be a valid UUID'),
  currentMedia: currentMediaInfoSchema.nullable(),
  position: z.number().min(0, 'Position must be non-negative'),
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
