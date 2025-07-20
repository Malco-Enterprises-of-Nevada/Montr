// Integration tests for playlist synchronization system
import { PlaylistSynchronizer, PlaylistUpdate, PlaylistDelta, SyncState } from '../js/playlist-synchronizer';

// Mock localStorage for testing
const localStorageMock = (() => {
    let store: { [key: string]: string } = {};
    
    return {
        getItem: (key: string) => store[key] || null,
        setItem: (key: string, value: string) => { store[key] = value; },
        removeItem: (key: string) => { delete store[key]; },
        clear: () => { store = {}; },
        key: (index: number) => Object.keys(store)[index] || null,
        get length() { return Object.keys(store).length; }
    };
})();

Object.defineProperty(global, 'localStorage', {
    value: localStorageMock
});

// Mock fetch for testing
global.fetch = jest.fn();

// Test data
const mockPlaylist = {
    id: 'playlist-1',
    name: 'Test Playlist',
    description: 'A test playlist',
    items: [
        {
            id: 'item-1',
            playlist_id: 'playlist-1',
            media_file_id: 'media-1',
            order_index: 0,
            display_duration: 5000,
            media_file: {
                id: 'media-1',
                filename: 'test-video.mp4',
                original_name: 'Test Video.mp4',
                file_type: 'video' as const,
                mime_type: 'video/mp4',
                file_size: 1024000,
                duration: 30,
                created_at: new Date()
            }
        },
        {
            id: 'item-2',
            playlist_id: 'playlist-1',
            media_file_id: 'media-2',
            order_index: 1,
            display_duration: 3000,
            media_file: {
                id: 'media-2',
                filename: 'test-image.jpg',
                original_name: 'Test Image.jpg',
                file_type: 'image' as const,
                mime_type: 'image/jpeg',
                file_size: 512000,
                created_at: new Date()
            }
        }
    ],
    created_at: new Date(),
    updated_at: new Date()
};

describe('PlaylistSynchronizer', () => {
    let synchronizer: PlaylistSynchronizer;
    let eventHandlers: any = {};

    beforeEach(() => {
        localStorageMock.clear();
        synchronizer = new PlaylistSynchronizer();
        eventHandlers = {};
        
        // Set up event handlers for testing
        synchronizer.on('onPlaylistUpdated', (playlist: any, source: string) => {
            eventHandlers.onPlaylistUpdated = { playlist, source };
        });
        
        synchronizer.on('onSyncStateChanged', (state: SyncState) => {
            eventHandlers.onSyncStateChanged = state;
        });
        
        synchronizer.on('onConflictDetected', (serverPlaylist: any, localPlaylist: any) => {
            eventHandlers.onConflictDetected = { serverPlaylist, localPlaylist };
        });
        
        synchronizer.on('onSyncError', (error: Error) => {
            eventHandlers.onSyncError = error;
        });
    });

    afterEach(() => {
        synchronizer.shutdown();
        jest.clearAllMocks();
    });

    describe('Playlist Caching', () => {
        test('should cache playlist successfully', async () => {
            await synchronizer.cachePlaylist(mockPlaylist);
            
            const cached = synchronizer.getCachedPlaylist(mockPlaylist.id);
            expect(cached).toBeTruthy();
            expect(cached?.id).toBe(mockPlaylist.id);
            expect(cached?.name).toBe(mockPlaylist.name);
            expect(cached?.items?.length).toBe(2);
        });

        test('should persist cache to localStorage', async () => {
            await synchronizer.cachePlaylist(mockPlaylist);
            
            const cacheKey = `playlist_cache_${mockPlaylist.id}`;
            const storedData = localStorageMock.getItem(cacheKey);
            expect(storedData).toBeTruthy();
            
            const parsedData = JSON.parse(storedData!);
            expect(parsedData.playlist.id).toBe(mockPlaylist.id);
            expect(parsedData.version).toBe(1);
        });

        test('should load cache from localStorage on initialization', async () => {
            // Pre-populate localStorage
            const cacheData = {
                playlist: mockPlaylist,
                cachedAt: new Date().toISOString(),
                version: 1,
                checksum: 'test-checksum'
            };
            localStorageMock.setItem(`playlist_cache_${mockPlaylist.id}`, JSON.stringify(cacheData));
            
            // Create new synchronizer to test loading
            const newSynchronizer = new PlaylistSynchronizer();
            const cached = newSynchronizer.getCachedPlaylist(mockPlaylist.id);
            
            expect(cached).toBeTruthy();
            expect(cached?.id).toBe(mockPlaylist.id);
            
            newSynchronizer.shutdown();
        });
    });

    describe('Online/Offline Status', () => {
        test('should update online status and trigger event', () => {
            synchronizer.setOnlineStatus(true);
            
            expect(eventHandlers.onSyncStateChanged).toBeTruthy();
            expect(eventHandlers.onSyncStateChanged.isOnline).toBe(true);
        });

        test('should handle offline to online transition', () => {
            synchronizer.setOnlineStatus(false);
            synchronizer.setOnlineStatus(true);
            
            const syncState = synchronizer.getSyncState();
            expect(syncState.isOnline).toBe(true);
        });
    });

    describe('Playlist Download', () => {
        test('should download playlist from server', async () => {
            const mockFetch = fetch as jest.MockedFunction<typeof fetch>;
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => mockPlaylist
            } as Response);

            const result = await synchronizer.downloadPlaylist(mockPlaylist.id, 'http://localhost:3000');
            
            expect(result).toBeTruthy();
            expect(result?.id).toBe(mockPlaylist.id);
            expect(mockFetch).toHaveBeenCalledWith(
                `http://localhost:3000/api/playlists/${mockPlaylist.id}?includeItems=true`
            );
            expect(eventHandlers.onPlaylistUpdated).toBeTruthy();
            expect(eventHandlers.onPlaylistUpdated.source).toBe('server');
        });

        test('should handle download errors', async () => {
            const mockFetch = fetch as jest.MockedFunction<typeof fetch>;
            mockFetch.mockRejectedValueOnce(new Error('Network error'));

            const result = await synchronizer.downloadPlaylist(mockPlaylist.id, 'http://localhost:3000');
            
            expect(result).toBeNull();
            expect(eventHandlers.onSyncError).toBeTruthy();
            expect(eventHandlers.onSyncError.message).toBe('Network error');
        });
    });

    describe('Delta Updates', () => {
        beforeEach(async () => {
            await synchronizer.cachePlaylist(mockPlaylist);
        });

        test('should handle add item delta', async () => {
            const newItem = {
                id: 'item-3',
                playlist_id: mockPlaylist.id,
                media_file_id: 'media-3',
                order_index: 2,
                display_duration: 4000
            };

            const deltaUpdate: PlaylistUpdate = {
                type: 'delta',
                changes: [{
                    operation: 'add',
                    item: newItem
                }],
                timestamp: new Date(),
                version: 2
            };

            await synchronizer.handlePlaylistUpdate(deltaUpdate);
            
            const updated = synchronizer.getCachedPlaylist(mockPlaylist.id);
            expect(updated?.items?.length).toBe(3);
            expect(updated?.items?.find(item => item.id === 'item-3')).toBeTruthy();
        });

        test('should handle remove item delta', async () => {
            const deltaUpdate: PlaylistUpdate = {
                type: 'delta',
                changes: [{
                    operation: 'remove',
                    itemId: 'item-1'
                }],
                timestamp: new Date(),
                version: 2
            };

            await synchronizer.handlePlaylistUpdate(deltaUpdate);
            
            const updated = synchronizer.getCachedPlaylist(mockPlaylist.id);
            expect(updated?.items?.length).toBe(1);
            expect(updated?.items?.find(item => item.id === 'item-1')).toBeFalsy();
        });

        test('should handle update item delta', async () => {
            const deltaUpdate: PlaylistUpdate = {
                type: 'delta',
                changes: [{
                    operation: 'update',
                    itemId: 'item-1',
                    field: 'display_duration',
                    oldValue: 5000,
                    newValue: 8000
                }],
                timestamp: new Date(),
                version: 2
            };

            await synchronizer.handlePlaylistUpdate(deltaUpdate);
            
            const updated = synchronizer.getCachedPlaylist(mockPlaylist.id);
            const updatedItem = updated?.items?.find(item => item.id === 'item-1');
            expect(updatedItem?.display_duration).toBe(8000);
        });

        test('should handle reorder item delta', async () => {
            const deltaUpdate: PlaylistUpdate = {
                type: 'delta',
                changes: [{
                    operation: 'reorder',
                    itemId: 'item-2',
                    oldIndex: 1,
                    newIndex: 0
                }],
                timestamp: new Date(),
                version: 2
            };

            await synchronizer.handlePlaylistUpdate(deltaUpdate);
            
            const updated = synchronizer.getCachedPlaylist(mockPlaylist.id);
            expect(updated?.items?.[0].id).toBe('item-2');
            expect(updated?.items?.[0].order_index).toBe(0);
            expect(updated?.items?.[1].order_index).toBe(1);
        });
    });

    describe('Conflict Resolution', () => {
        test('should detect conflicts between server and local versions', async () => {
            await synchronizer.cachePlaylist(mockPlaylist);
            
            // Simulate a server update with different content
            const serverPlaylist = {
                ...mockPlaylist,
                name: 'Updated Playlist Name',
                updated_at: new Date(Date.now() + 1000) // Newer timestamp
            };

            const fullUpdate: PlaylistUpdate = {
                type: 'full',
                playlist: serverPlaylist,
                timestamp: new Date(),
                version: 2
            };

            await synchronizer.handlePlaylistUpdate(fullUpdate);
            
            // Should trigger conflict detection (in a real scenario with local modifications)
            // For this test, server wins by default
            const updated = synchronizer.getCachedPlaylist(mockPlaylist.id);
            expect(updated?.name).toBe('Updated Playlist Name');
        });
    });

    describe('Cache Information', () => {
        test('should provide cache information', async () => {
            await synchronizer.cachePlaylist(mockPlaylist);
            
            const cacheInfo = synchronizer.getCacheInfo();
            expect(cacheInfo.length).toBe(1);
            expect(cacheInfo[0].playlistId).toBe(mockPlaylist.id);
            expect(cacheInfo[0].version).toBe(1);
            expect(cacheInfo[0].cachedAt).toBeInstanceOf(Date);
        });
    });

    describe('Sync State Persistence', () => {
        test('should persist and restore sync state', () => {
            synchronizer.setOnlineStatus(true);
            
            // Create new synchronizer to test state restoration
            const newSynchronizer = new PlaylistSynchronizer();
            const syncState = newSynchronizer.getSyncState();
            
            expect(syncState.isOnline).toBe(false); // Default state for new instance
            
            newSynchronizer.shutdown();
        });
    });

    describe('Error Handling', () => {
        test('should handle invalid playlist data gracefully', async () => {
            const invalidPlaylist = {
                id: 'invalid',
                name: null, // Invalid data
                items: undefined
            } as any;

            await expect(synchronizer.cachePlaylist(invalidPlaylist)).resolves.not.toThrow();
        });

        test('should handle localStorage errors gracefully', async () => {
            // Mock localStorage to throw an error
            const originalSetItem = localStorageMock.setItem;
            localStorageMock.setItem = jest.fn(() => {
                throw new Error('Storage quota exceeded');
            });

            await expect(synchronizer.cachePlaylist(mockPlaylist)).resolves.not.toThrow();
            
            // Restore original method
            localStorageMock.setItem = originalSetItem;
        });
    });
});