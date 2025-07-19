export interface Playlist {
    id: string;
    name: string;
    description?: string;
    items?: PlaylistItem[];
    created_at: Date;
    updated_at: Date;
}

export interface MediaFile {
    id: string;
    filename: string;
    original_name: string;
    file_type: 'video' | 'image';
    mime_type: string;
    file_size: number;
    duration?: number; // in seconds for videos, display time for images
    thumbnail_path?: string;
    created_at: Date;
}

export interface PlaylistItem {
    id: string;
    playlist_id: string;
    media_file_id: string;
    order_index: number;
    display_duration?: number; // override duration for images
    media_file?: MediaFile | null; // populated when joining
}

export interface SystemState {
    key: string;
    value: string | null;
    updated_at: Date;
}

// Database row interfaces (snake_case from SQLite)
export interface PlaylistRow {
    id: string;
    name: string;
    description?: string;
    created_at: string;
    updated_at: string;
}

export interface MediaFileRow {
    id: string;
    filename: string;
    original_name: string;
    file_type: 'video' | 'image';
    mime_type: string;
    file_size: number;
    duration?: number;
    thumbnail_path?: string;
    created_at: string;
}

export interface PlaylistItemRow {
    id: string;
    playlist_id: string;
    media_file_id: string;
    order_index: number;
    display_duration?: number;
}

export interface SystemStateRow {
    key: string;
    value: string | null;
    updated_at: string;
}

// Input types for creating/updating
export interface CreatePlaylistInput {
    name: string;
    description?: string;
}

export interface UpdatePlaylistInput {
    name?: string;
    description?: string;
}

export interface CreateMediaFileInput {
    filename: string;
    original_name: string;
    file_type: 'video' | 'image';
    mime_type: string;
    file_size: number;
    duration?: number;
    thumbnail_path?: string;
}

export interface CreatePlaylistItemInput {
    playlist_id: string;
    media_file_id: string;
    order_index: number;
    display_duration?: number;
}

export interface UpdatePlaylistItemInput {
    order_index?: number;
    display_duration?: number;
}