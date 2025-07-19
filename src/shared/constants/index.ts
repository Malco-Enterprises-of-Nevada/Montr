// Shared constants
export const SUPPORTED_VIDEO_FORMATS = ['mp4', 'avi', 'mov', 'webm'];
export const SUPPORTED_IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];

export const WEBSOCKET_EVENTS = {
  PLAYLIST_ACTIVATED: 'playlist-activated',
  PLAYLIST_UPDATED: 'playlist-updated',
  CLIENT_CONNECTED: 'client-connected',
  HEARTBEAT: 'heartbeat'
} as const;

export const API_ENDPOINTS = {
  PLAYLISTS: '/api/playlists',
  MEDIA_UPLOAD: '/api/media/upload',
  MEDIA_FILE: '/api/media',
  ACTIVATE_PLAYLIST: '/api/playlists/:id/activate'
} as const;