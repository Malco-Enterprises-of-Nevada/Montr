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
  created_at: string;
  updated_at: string;
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
export interface Schedule {
  id: number;
  name: string;
  playlist_id: number;
  client_id: string | null;
  group_id: number | null;
  start_time: string;
  end_time: string | null;
  days_of_week: string;
  priority: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateScheduleInput {
  name: string;
  playlist_id: number;
  client_id?: string;
  group_id?: number;
  start_time: string;
  end_time?: string;
  days_of_week?: string;
  priority?: number;
  enabled?: boolean;
}

export interface UpdateScheduleInput {
  name?: string;
  playlist_id?: number;
  client_id?: string | null;
  group_id?: number | null;
  start_time?: string;
  end_time?: string | null;
  days_of_week?: string;
  priority?: number;
  enabled?: boolean;
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
