/**
 * Test fixtures for playlists
 */

import {
  Playlist,
  PlaylistItem,
  PlaylistWithItems,
  PlaylistItemWithMedia,
  CreatePlaylistInput,
  UpdatePlaylistInput,
} from '../../src/database/types';
import { mockVideoFile, mockImageFile } from './media.fixtures';

export const mockPlaylist: Playlist = {
  id: 1,
  name: 'Test Playlist',
  description: 'A test playlist for unit tests',
  created_at: '2025-10-10T10:00:00.000Z',
  updated_at: '2025-10-10T10:00:00.000Z',
};

export const mockPlaylist2: Playlist = {
  id: 2,
  name: 'Another Playlist',
  description: 'Another test playlist',
  created_at: '2025-10-10T11:00:00.000Z',
  updated_at: '2025-10-10T11:00:00.000Z',
};

export const mockPlaylists: Playlist[] = [mockPlaylist, mockPlaylist2];

export const mockPlaylistItem1: PlaylistItem = {
  id: 1,
  playlist_id: 1,
  media_id: 1,
  order_index: 0,
  image_duration: 5,
  created_at: '2025-10-10T10:01:00.000Z',
};

export const mockPlaylistItem2: PlaylistItem = {
  id: 2,
  playlist_id: 1,
  media_id: 2,
  order_index: 1,
  image_duration: 7,
  created_at: '2025-10-10T10:02:00.000Z',
};

export const mockPlaylistItems: PlaylistItem[] = [mockPlaylistItem1, mockPlaylistItem2];

export const mockPlaylistItemWithMedia1: PlaylistItemWithMedia = {
  ...mockPlaylistItem1,
  media: mockVideoFile,
};

export const mockPlaylistItemWithMedia2: PlaylistItemWithMedia = {
  ...mockPlaylistItem2,
  media: mockImageFile,
};

export const mockPlaylistWithItems: PlaylistWithItems = {
  ...mockPlaylist,
  items: [mockPlaylistItemWithMedia1, mockPlaylistItemWithMedia2],
};

export const mockCreatePlaylistInput: CreatePlaylistInput = {
  name: 'New Test Playlist',
  description: 'A newly created test playlist',
};

export const mockUpdatePlaylistInput: UpdatePlaylistInput = {
  name: 'Updated Playlist Name',
  description: 'Updated description',
};

export const mockEmptyPlaylist: PlaylistWithItems = {
  ...mockPlaylist,
  items: [],
};

// Playlist stats fixtures
export const mockPlaylistStats = {
  totalItems: 2,
  totalDuration: 127.5, // 120.5 (video) + 7 (image duration)
  videoCount: 1,
  imageCount: 1,
};
