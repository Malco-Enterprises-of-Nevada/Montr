// Shared type definitions
export interface Playlist {
  id: string;
  name: string;
  description?: string;
  items: PlaylistItem[];
  createdAt: Date;
  updatedAt: Date;
}

export interface MediaFile {
  id: string;
  filename: string;
  originalName: string;
  fileType: 'video' | 'image';
  mimeType: string;
  fileSize: number;
  duration?: number;
  thumbnailPath?: string;
  createdAt: Date;
}

export interface PlaylistItem {
  id: string;
  playlistId: string;
  mediaFileId: string;
  orderIndex: number;
  displayDuration?: number;
}

export interface ClientState {
  id: string;
  currentPlaylist?: Playlist;
  currentItemIndex: number;
  playbackState: 'playing' | 'paused' | 'stopped';
  connectionStatus: 'connected' | 'disconnected' | 'reconnecting';
  lastHeartbeat: Date;
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: any;
    timestamp: Date;
  };
}