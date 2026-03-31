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
  PaginationParams,
  PaginatedResult,
  MediaFilter,
  ClientFilter,
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
}
