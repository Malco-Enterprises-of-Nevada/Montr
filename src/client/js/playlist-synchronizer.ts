// Playlist Synchronization Service
// Handles playlist download, caching, updates, and conflict resolution

// Local type definitions to avoid cross-directory imports
interface Playlist {
    id: string;
    name: string;
    description?: string;
    items?: PlaylistItem[];
    created_at: Date;
    updated_at: Date;
}

interface PlaylistItem {
    id: string;
    playlist_id: string;
    media_file_id: string;
    order_index: number;
    display_duration?: number;
    media_file?: MediaFile | null;
}

interface MediaFile {
    id: string;
    filename: string;
    original_name: string;
    file_type: 'video' | 'image';
    mime_type: string;
    file_size: number;
    duration?: number;
    thumbnail_path?: string;
    created_at: Date;
}

export interface PlaylistCache {
    playlist: Playlist;
    cachedAt: Date;
    version: number;
    checksum: string;
}

export interface SyncState {
    isOnline: boolean;
    lastSyncAt: Date | null;
    pendingUpdates: PlaylistUpdate[];
    conflictResolutionMode: 'server-wins' | 'client-wins' | 'merge';
}

export interface PlaylistUpdate {
    type: 'full' | 'delta';
    playlist?: Playlist;
    changes?: PlaylistDelta[];
    timestamp: Date;
    version: number;
}

export interface PlaylistDelta {
    operation: 'add' | 'remove' | 'update' | 'reorder';
    itemId?: string;
    item?: PlaylistItem;
    oldIndex?: number;
    newIndex?: number;
    field?: string;
    oldValue?: any;
    newValue?: any;
}

export interface SyncEventHandlers {
    onPlaylistUpdated?: (playlist: Playlist, source: 'server' | 'cache') => void;
    onSyncStateChanged?: (state: SyncState) => void;
    onConflictDetected?: (serverPlaylist: Playlist, localPlaylist: Playlist) => void;
    onSyncError?: (error: Error) => void;
}

export class PlaylistSynchronizer {
    private cache: Map<string, PlaylistCache> = new Map();
    private syncState: SyncState;
    private eventHandlers: SyncEventHandlers = {};
    private syncTimer: NodeJS.Timeout | null = null;
    private readonly CACHE_KEY_PREFIX = 'playlist_cache_';
    private readonly SYNC_STATE_KEY = 'sync_state';
    private readonly SYNC_INTERVAL = 30000; // 30 seconds
    private storage: any;

    constructor() {
        this.syncState = {
            isOnline: false,
            lastSyncAt: null,
            pendingUpdates: [],
            conflictResolutionMode: 'server-wins'
        };
        
        // Initialize storage (use global localStorage or fallback for tests)
        this.storage = this.getStorageInstance();
        
        this.loadCacheFromStorage();
        this.loadSyncStateFromStorage();
    }

    // Get storage instance (browser localStorage or test mock)
    private getStorageInstance(): any {
        try {
            // Try to access localStorage through global scope
            if (typeof globalThis !== 'undefined' && (globalThis as any).localStorage) {
                return (globalThis as any).localStorage;
            }
            if (typeof global !== 'undefined' && (global as any).localStorage) {
                return (global as any).localStorage;
            }
        } catch (e) {
            // localStorage access might be blocked
        }
        
        // Fallback for environments without localStorage
        return {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {},
            clear: () => {},
            key: () => null,
            length: 0
        };
    }

    // Event handler registration
    public on(event: keyof SyncEventHandlers, handler: Function): void {
        this.eventHandlers[event] = handler as any;
    }

    // Set online/offline status
    public setOnlineStatus(isOnline: boolean): void {
        const wasOnline = this.syncState.isOnline;
        this.syncState.isOnline = isOnline;
        
        if (isOnline && !wasOnline) {
            // Just came online, sync pending updates
            this.processPendingUpdates();
        }
        
        this.saveSyncStateToStorage();
        this.eventHandlers.onSyncStateChanged?.(this.syncState);
    }

    // Download and cache playlist
    public async downloadPlaylist(playlistId: string, serverUrl: string): Promise<Playlist | null> {
        try {
            const response = await fetch(`${serverUrl}/api/playlists/${playlistId}?includeItems=true`);
            
            if (!response.ok) {
                throw new Error(`Failed to download playlist: ${response.statusText}`);
            }
            
            const playlist = await response.json() as Playlist;
            await this.cachePlaylist(playlist);
            
            this.eventHandlers.onPlaylistUpdated?.(playlist, 'server');
            return playlist;
            
        } catch (error) {
            console.error('Error downloading playlist:', error);
            this.eventHandlers.onSyncError?.(error as Error);
            return null;
        }
    }

    // Cache playlist locally
    public async cachePlaylist(playlist: Playlist): Promise<void> {
        const checksum = this.calculateChecksum(playlist);
        const version = this.getNextVersion(playlist.id);
        
        const cacheEntry: PlaylistCache = {
            playlist: JSON.parse(JSON.stringify(playlist)), // Deep clone
            cachedAt: new Date(),
            version,
            checksum
        };
        
        this.cache.set(playlist.id, cacheEntry);
        await this.saveCacheToStorage();
        
        console.log(`Playlist ${playlist.name} cached with version ${version}`);
    }

    // Get cached playlist
    public getCachedPlaylist(playlistId: string): Playlist | null {
        const cacheEntry = this.cache.get(playlistId);
        if (!cacheEntry) {
            return null;
        }
        
        // Return a deep clone to prevent mutations
        return JSON.parse(JSON.stringify(cacheEntry.playlist));
    }

    // Handle playlist update from WebSocket
    public async handlePlaylistUpdate(update: PlaylistUpdate): Promise<void> {
        if (update.type === 'full' && update.playlist) {
            // Full playlist update
            const cachedEntry = this.cache.get(update.playlist.id);
            await this.handleFullUpdate(update.playlist, cachedEntry);
        } else if (update.type === 'delta' && update.changes) {
            // Delta update - need to determine playlist ID from changes or existing cache
            let playlistId: string | undefined;
            
            // Try to get playlist ID from the first change that has an item
            for (const change of update.changes) {
                if (change.item && change.item.playlist_id) {
                    playlistId = change.item.playlist_id;
                    break;
                }
            }
            
            // If we still don't have a playlist ID, try to get it from cached playlists
            if (!playlistId && this.cache.size > 0) {
                // For now, apply to the first cached playlist (in a real app, we'd need better logic)
                playlistId = Array.from(this.cache.keys())[0];
            }
            
            if (playlistId) {
                const cachedEntry = this.cache.get(playlistId);
                await this.handleDeltaUpdate(playlistId, update.changes, cachedEntry);
            } else {
                console.warn('Received delta update but could not determine playlist ID');
            }
        } else {
            console.warn('Received playlist update without sufficient data');
        }
    }

    // Handle full playlist update
    private async handleFullUpdate(serverPlaylist: Playlist, cachedEntry?: PlaylistCache): Promise<void> {
        if (!cachedEntry) {
            // No cached version, just cache the new one
            await this.cachePlaylist(serverPlaylist);
            this.eventHandlers.onPlaylistUpdated?.(serverPlaylist, 'server');
            return;
        }

        // Check for conflicts
        const serverChecksum = this.calculateChecksum(serverPlaylist);
        if (cachedEntry.checksum !== serverChecksum) {
            // Potential conflict detected
            if (this.hasLocalModifications(cachedEntry)) {
                await this.resolveConflict(serverPlaylist, cachedEntry.playlist);
            } else {
                // No local modifications, safe to update
                await this.cachePlaylist(serverPlaylist);
                this.eventHandlers.onPlaylistUpdated?.(serverPlaylist, 'server');
            }
        }
    }

    // Handle delta update
    private async handleDeltaUpdate(playlistId: string, changes: PlaylistDelta[], cachedEntry?: PlaylistCache): Promise<void> {
        if (!cachedEntry) {
            console.warn('Received delta update for uncached playlist');
            return;
        }

        const updatedPlaylist = this.applyDeltas(cachedEntry.playlist, changes);
        await this.cachePlaylist(updatedPlaylist);
        this.eventHandlers.onPlaylistUpdated?.(updatedPlaylist, 'server');
    }

    // Apply delta changes to playlist
    private applyDeltas(playlist: Playlist, deltas: PlaylistDelta[]): Playlist {
        const updatedPlaylist = JSON.parse(JSON.stringify(playlist)); // Deep clone
        
        if (!updatedPlaylist.items) {
            updatedPlaylist.items = [];
        }

        for (const delta of deltas) {
            switch (delta.operation) {
                case 'add':
                    if (delta.item) {
                        updatedPlaylist.items.push(delta.item);
                        updatedPlaylist.items.sort((a: PlaylistItem, b: PlaylistItem) => a.order_index - b.order_index);
                    }
                    break;
                    
                case 'remove':
                    if (delta.itemId) {
                        updatedPlaylist.items = updatedPlaylist.items.filter((item: PlaylistItem) => item.id !== delta.itemId);
                    }
                    break;
                    
                case 'update':
                    if (delta.itemId && delta.field && delta.newValue !== undefined) {
                        const item = updatedPlaylist.items.find((item: PlaylistItem) => item.id === delta.itemId);
                        if (item) {
                            (item as any)[delta.field] = delta.newValue;
                        }
                    }
                    break;
                    
                case 'reorder':
                    if (delta.itemId && delta.newIndex !== undefined) {
                        const itemIndex = updatedPlaylist.items.findIndex((item: PlaylistItem) => item.id === delta.itemId);
                        if (itemIndex !== -1) {
                            const [item] = updatedPlaylist.items.splice(itemIndex, 1);
                            item.order_index = delta.newIndex;
                            updatedPlaylist.items.splice(delta.newIndex, 0, item);
                            
                            // Reindex all items
                            updatedPlaylist.items.forEach((item: PlaylistItem, index: number) => {
                                item.order_index = index;
                            });
                        }
                    }
                    break;
            }
        }

        updatedPlaylist.updated_at = new Date();
        return updatedPlaylist;
    }

    // Resolve conflicts between server and local versions
    private async resolveConflict(serverPlaylist: Playlist, localPlaylist: Playlist): Promise<void> {
        this.eventHandlers.onConflictDetected?.(serverPlaylist, localPlaylist);
        
        switch (this.syncState.conflictResolutionMode) {
            case 'server-wins':
                await this.cachePlaylist(serverPlaylist);
                this.eventHandlers.onPlaylistUpdated?.(serverPlaylist, 'server');
                break;
                
            case 'client-wins':
                // Keep local version, but mark as needing sync
                this.addPendingUpdate({
                    type: 'full',
                    playlist: localPlaylist,
                    timestamp: new Date(),
                    version: this.getNextVersion(localPlaylist.id)
                });
                break;
                
            case 'merge':
                const mergedPlaylist = await this.mergePlaylists(serverPlaylist, localPlaylist);
                await this.cachePlaylist(mergedPlaylist);
                this.eventHandlers.onPlaylistUpdated?.(mergedPlaylist, 'server');
                break;
        }
    }

    // Merge two playlist versions
    private async mergePlaylists(serverPlaylist: Playlist, localPlaylist: Playlist): Promise<Playlist> {
        // Simple merge strategy: use server metadata, merge items by timestamp
        const merged: Playlist = {
            ...serverPlaylist,
            items: []
        };

        const serverItems = serverPlaylist.items || [];
        const localItems = localPlaylist.items || [];
        
        // Create a map of items by ID for efficient lookup
        const itemMap = new Map<string, PlaylistItem>();
        
        // Add server items
        serverItems.forEach(item => itemMap.set(item.id, item));
        
        // Add or update with local items (local changes take precedence for existing items)
        localItems.forEach(localItem => {
            const serverItem = itemMap.get(localItem.id);
            if (serverItem) {
                // Item exists in both, use local version if it's newer or has modifications
                itemMap.set(localItem.id, localItem);
            } else {
                // Local-only item, add it
                itemMap.set(localItem.id, localItem);
            }
        });

        merged.items = Array.from(itemMap.values()).sort((a, b) => a.order_index - b.order_index);
        merged.updated_at = new Date();
        
        return merged;
    }

    // Check if playlist has local modifications
    private hasLocalModifications(cacheEntry: PlaylistCache): boolean {
        // Simple heuristic: if cached less than 5 minutes ago and no pending updates, likely no local mods
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        return cacheEntry.cachedAt < fiveMinutesAgo || this.syncState.pendingUpdates.length > 0;
    }

    // Add pending update for when we come back online
    private addPendingUpdate(update: PlaylistUpdate): void {
        this.syncState.pendingUpdates.push(update);
        this.saveSyncStateToStorage();
    }

    // Process pending updates when coming back online
    private async processPendingUpdates(): Promise<void> {
        if (this.syncState.pendingUpdates.length === 0) {
            return;
        }

        console.log(`Processing ${this.syncState.pendingUpdates.length} pending updates`);
        
        // For now, just clear pending updates
        // In a full implementation, we'd send these to the server
        this.syncState.pendingUpdates = [];
        this.syncState.lastSyncAt = new Date();
        this.saveSyncStateToStorage();
    }

    // Calculate checksum for playlist
    private calculateChecksum(playlist: Playlist): string {
        // Simple checksum based on playlist content
        const content = JSON.stringify({
            id: playlist.id,
            name: playlist.name,
            description: playlist.description,
            items: playlist.items?.map(item => ({
                id: item.id,
                media_file_id: item.media_file_id,
                order_index: item.order_index,
                display_duration: item.display_duration
            })) || []
        });
        
        // Simple hash function
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
            const char = content.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        
        return hash.toString(36);
    }

    // Get next version number for playlist
    private getNextVersion(playlistId: string): number {
        const cached = this.cache.get(playlistId);
        return cached ? cached.version + 1 : 1;
    }

    // Storage operations
    private async saveCacheToStorage(): Promise<void> {
        try {
            for (const [playlistId, cacheEntry] of this.cache.entries()) {
                const key = this.CACHE_KEY_PREFIX + playlistId;
                this.storage.setItem(key, JSON.stringify({
                    ...cacheEntry,
                    cachedAt: cacheEntry.cachedAt.toISOString()
                }));
            }
        } catch (error) {
            console.error('Failed to save cache to storage:', error);
        }
    }

    private loadCacheFromStorage(): void {
        try {
            for (let i = 0; i < this.storage.length; i++) {
                const key = this.storage.key(i);
                if (key?.startsWith(this.CACHE_KEY_PREFIX)) {
                    const playlistId = key.substring(this.CACHE_KEY_PREFIX.length);
                    const data = this.storage.getItem(key);
                    
                    if (data) {
                        const cacheEntry = JSON.parse(data);
                        cacheEntry.cachedAt = new Date(cacheEntry.cachedAt);
                        this.cache.set(playlistId, cacheEntry);
                    }
                }
            }
            
            console.log(`Loaded ${this.cache.size} playlists from cache`);
        } catch (error) {
            console.error('Failed to load cache from storage:', error);
        }
    }

    private saveSyncStateToStorage(): void {
        try {
            const stateToSave = {
                ...this.syncState,
                lastSyncAt: this.syncState.lastSyncAt?.toISOString() || null
            };
            this.storage.setItem(this.SYNC_STATE_KEY, JSON.stringify(stateToSave));
        } catch (error) {
            console.error('Failed to save sync state to storage:', error);
        }
    }

    private loadSyncStateFromStorage(): void {
        try {
            const data = this.storage.getItem(this.SYNC_STATE_KEY);
            if (data) {
                const state = JSON.parse(data);
                this.syncState = {
                    ...state,
                    lastSyncAt: state.lastSyncAt ? new Date(state.lastSyncAt) : null
                };
            }
        } catch (error) {
            console.error('Failed to load sync state from storage:', error);
        }
    }

    // Public getters
    public getSyncState(): SyncState {
        return { ...this.syncState };
    }

    public getCacheInfo(): { playlistId: string; cachedAt: Date; version: number }[] {
        return Array.from(this.cache.entries()).map(([playlistId, cache]) => ({
            playlistId,
            cachedAt: cache.cachedAt,
            version: cache.version
        }));
    }

    // Cleanup
    public shutdown(): void {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }
    }
}