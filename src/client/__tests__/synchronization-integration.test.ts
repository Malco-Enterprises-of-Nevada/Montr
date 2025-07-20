// Integration tests for full playlist synchronization workflow
import { PlaylistSynchronizer } from '../js/playlist-synchronizer';

// Mock WebSocket for testing
class MockSocket {
    private eventHandlers: { [event: string]: Function[] } = {};
    public connected = false;

    on(event: string, handler: Function) {
        if (!this.eventHandlers[event]) {
            this.eventHandlers[event] = [];
        }
        this.eventHandlers[event].push(handler);
    }

    emit(event: string, ...args: any[]) {
        // Simulate server response
        if (event === 'request-active-playlist') {
            setTimeout(() => {
                this.trigger('playlist-activated', mockActivePlaylist);
            }, 10);
        } else if (event === 'request-playlist-sync') {
            setTimeout(() => {
                this.trigger('playlist-delta-update', mockDeltaUpdate);
            }, 10);
        }
    }

    trigger(event: string, ...args: any[]) {
        if (this.eventHandlers[event]) {
            this.eventHandlers[event].forEach(handler => handler(...args));
        }
    }

    connect() {
        this.connected = true;
        setTimeout(() => this.trigger('connect'), 10);
    }

    disconnect() {
        this.connected = false;
        this.trigger('disconnect', 'client disconnect');
    }
}

// Mock localStorage
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

// Mock fetch
global.fetch = jest.fn();

// Test data
const mockActivePlaylist = {
    id: 'active-playlist',
    name: 'Active Test Playlist',
    description: 'Currently active playlist',
    items: [
        {
            id: 'item-1',
            playlist_id: 'active-playlist',
            media_file_id: 'media-1',
            order_index: 0,
            display_duration: 5000,
            media_file: {
                id: 'media-1',
                filename: 'video1.mp4',
                original_name: 'Video 1.mp4',
                file_type: 'video' as const,
                mime_type: 'video/mp4',
                file_size: 2048000,
                duration: 60,
                created_at: new Date()
            }
        }
    ],
    created_at: new Date(),
    updated_at: new Date()
};

const mockDeltaUpdate = {
    type: 'delta' as const,
    changes: [{
        operation: 'add' as const,
        item: {
            id: 'item-2',
            playlist_id: 'active-playlist',
            media_file_id: 'media-2',
            order_index: 1,
            display_duration: 3000
        }
    }],
    timestamp: new Date(),
    version: 2
};

describe('Playlist Synchronization Integration', () => {
    let synchronizer: PlaylistSynchronizer;
    let mockSocket: MockSocket;
    let receivedUpdates: any[] = [];

    beforeEach(() => {
        localStorageMock.clear();
        synchronizer = new PlaylistSynchronizer();
        mockSocket = new MockSocket();
        receivedUpdates = [];

        // Set up event handlers
        synchronizer.on('onPlaylistUpdated', (playlist: any, source: string) => {
            receivedUpdates.push({ type: 'updated', playlist, source });
        });

        synchronizer.on('onSyncStateChanged', (state: any) => {
            receivedUpdates.push({ type: 'syncStateChanged', state });
        });

        synchronizer.on('onConflictDetected', (serverPlaylist: any, localPlaylist: any) => {
            receivedUpdates.push({ type: 'conflict', serverPlaylist, localPlaylist });
        });
    });

    afterEach(() => {
        synchronizer.shutdown();
        jest.clearAllMocks();
    });

    describe('Online Synchronization Workflow', () => {
        test('should handle complete online sync workflow', async () => {
            // Step 1: Go online
            synchronizer.setOnlineStatus(true);
            expect(receivedUpdates.some(u => u.type === 'syncStateChanged' && u.state.isOnline)).toBe(true);

            // Step 2: Download initial playlist
            const mockFetch = fetch as jest.MockedFunction<typeof fetch>;
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => mockActivePlaylist
            } as Response);

            const downloadedPlaylist = await synchronizer.downloadPlaylist(
                mockActivePlaylist.id, 
                'http://localhost:3000'
            );

            expect(downloadedPlaylist).toBeTruthy();
            expect(downloadedPlaylist?.id).toBe(mockActivePlaylist.id);
            expect(receivedUpdates.some(u => u.type === 'updated' && u.source === 'server')).toBe(true);

            // Step 3: Verify playlist is cached
            const cachedPlaylist = synchronizer.getCachedPlaylist(mockActivePlaylist.id);
            expect(cachedPlaylist).toBeTruthy();
            expect(cachedPlaylist?.items?.length).toBe(1);

            // Step 4: Handle delta update
            await synchronizer.handlePlaylistUpdate(mockDeltaUpdate);

            const updatedPlaylist = synchronizer.getCachedPlaylist(mockActivePlaylist.id);
            expect(updatedPlaylist?.items?.length).toBe(2);
            expect(updatedPlaylist?.items?.find(item => item.id === 'item-2')).toBeTruthy();
        });

        test('should handle network interruption and recovery', async () => {
            // Start online
            synchronizer.setOnlineStatus(true);
            
            // Download and cache playlist
            const mockFetch = fetch as jest.MockedFunction<typeof fetch>;
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => mockActivePlaylist
            } as Response);

            await synchronizer.downloadPlaylist(mockActivePlaylist.id, 'http://localhost:3000');

            // Go offline
            synchronizer.setOnlineStatus(false);
            expect(synchronizer.getSyncState().isOnline).toBe(false);

            // Verify cached playlist is still available
            const cachedPlaylist = synchronizer.getCachedPlaylist(mockActivePlaylist.id);
            expect(cachedPlaylist).toBeTruthy();

            // Come back online
            synchronizer.setOnlineStatus(true);
            expect(synchronizer.getSyncState().isOnline).toBe(true);
        });
    });

    describe('Offline Mode Workflow', () => {
        test('should work with cached playlists when offline', async () => {
            // Pre-cache a playlist
            await synchronizer.cachePlaylist(mockActivePlaylist);

            // Verify we can access cached playlist when offline
            synchronizer.setOnlineStatus(false);
            
            const cachedPlaylist = synchronizer.getCachedPlaylist(mockActivePlaylist.id);
            expect(cachedPlaylist).toBeTruthy();
            expect(cachedPlaylist?.id).toBe(mockActivePlaylist.id);
            expect(cachedPlaylist?.items?.length).toBe(1);
        });

        test('should handle cache persistence across sessions', async () => {
            // Cache playlist in first session
            await synchronizer.cachePlaylist(mockActivePlaylist);
            synchronizer.shutdown();

            // Create new synchronizer instance (simulating app restart)
            const newSynchronizer = new PlaylistSynchronizer();
            
            const cachedPlaylist = newSynchronizer.getCachedPlaylist(mockActivePlaylist.id);
            expect(cachedPlaylist).toBeTruthy();
            expect(cachedPlaylist?.id).toBe(mockActivePlaylist.id);

            newSynchronizer.shutdown();
        });
    });

    describe('Conflict Resolution Workflow', () => {
        test('should handle server-wins conflict resolution', async () => {
            // Cache initial playlist
            await synchronizer.cachePlaylist(mockActivePlaylist);

            // Simulate server update with different content
            const serverPlaylist = {
                ...mockActivePlaylist,
                name: 'Server Updated Playlist',
                items: [
                    ...mockActivePlaylist.items!,
                    {
                        id: 'server-item',
                        playlist_id: mockActivePlaylist.id,
                        media_file_id: 'server-media',
                        order_index: 1,
                        display_duration: 4000
                    }
                ],
                updated_at: new Date(Date.now() + 1000)
            };

            const serverUpdate = {
                type: 'full' as const,
                playlist: serverPlaylist,
                timestamp: new Date(),
                version: 2
            };

            await synchronizer.handlePlaylistUpdate(serverUpdate);

            // Verify server version is used
            const resolvedPlaylist = synchronizer.getCachedPlaylist(mockActivePlaylist.id);
            expect(resolvedPlaylist?.name).toBe('Server Updated Playlist');
            expect(resolvedPlaylist?.items?.length).toBe(2);
            expect(resolvedPlaylist?.items?.find(item => item.id === 'server-item')).toBeTruthy();
        });
    });

    describe('Multiple Playlist Synchronization', () => {
        test('should handle multiple playlists independently', async () => {
            const playlist1 = { ...mockActivePlaylist, id: 'playlist-1', name: 'Playlist 1' };
            const playlist2 = { ...mockActivePlaylist, id: 'playlist-2', name: 'Playlist 2' };

            // Cache both playlists
            await synchronizer.cachePlaylist(playlist1);
            await synchronizer.cachePlaylist(playlist2);

            // Verify both are cached
            const cached1 = synchronizer.getCachedPlaylist('playlist-1');
            const cached2 = synchronizer.getCachedPlaylist('playlist-2');

            expect(cached1?.name).toBe('Playlist 1');
            expect(cached2?.name).toBe('Playlist 2');

            // Update one playlist
            const update1 = {
                type: 'full' as const,
                playlist: { ...playlist1, name: 'Updated Playlist 1' },
                timestamp: new Date(),
                version: 2
            };

            await synchronizer.handlePlaylistUpdate(update1);

            // Verify only the updated playlist changed
            const updatedCached1 = synchronizer.getCachedPlaylist('playlist-1');
            const unchangedCached2 = synchronizer.getCachedPlaylist('playlist-2');

            expect(updatedCached1?.name).toBe('Updated Playlist 1');
            expect(unchangedCached2?.name).toBe('Playlist 2');
        });
    });

    describe('Performance and Memory Management', () => {
        test('should handle large playlists efficiently', async () => {
            // Create a large playlist
            const largePlaylist = {
                ...mockActivePlaylist,
                items: Array.from({ length: 100 }, (_, i) => ({
                    id: `item-${i}`,
                    playlist_id: mockActivePlaylist.id,
                    media_file_id: `media-${i}`,
                    order_index: i,
                    display_duration: 5000
                }))
            };

            const startTime = Date.now();
            await synchronizer.cachePlaylist(largePlaylist);
            const cacheTime = Date.now() - startTime;

            expect(cacheTime).toBeLessThan(1000); // Should cache within 1 second

            const cached = synchronizer.getCachedPlaylist(mockActivePlaylist.id);
            expect(cached?.items?.length).toBe(100);
        });

        test('should handle rapid updates efficiently', async () => {
            await synchronizer.cachePlaylist(mockActivePlaylist);

            // Send multiple rapid updates
            const updates = Array.from({ length: 10 }, (_, i) => ({
                type: 'delta' as const,
                changes: [{
                    operation: 'add' as const,
                    item: {
                        id: `rapid-item-${i}`,
                        playlist_id: mockActivePlaylist.id,
                        media_file_id: `rapid-media-${i}`,
                        order_index: i + 1,
                        display_duration: 3000
                    }
                }],
                timestamp: new Date(),
                version: i + 2
            }));

            const startTime = Date.now();
            for (const update of updates) {
                await synchronizer.handlePlaylistUpdate(update);
            }
            const updateTime = Date.now() - startTime;

            expect(updateTime).toBeLessThan(1000); // Should handle all updates within 1 second

            const finalPlaylist = synchronizer.getCachedPlaylist(mockActivePlaylist.id);
            expect(finalPlaylist?.items?.length).toBe(11); // Original + 10 added items
        });
    });

    describe('Error Recovery', () => {
        test('should recover from sync errors gracefully', async () => {
            let errorReceived = false;
            synchronizer.on('onSyncError', () => {
                errorReceived = true;
            });

            // Simulate download error
            const mockFetch = fetch as jest.MockedFunction<typeof fetch>;
            mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

            const result = await synchronizer.downloadPlaylist(mockActivePlaylist.id, 'http://localhost:3000');
            
            expect(result).toBeNull();
            expect(errorReceived).toBe(true);

            // Verify synchronizer is still functional
            await synchronizer.cachePlaylist(mockActivePlaylist);
            const cached = synchronizer.getCachedPlaylist(mockActivePlaylist.id);
            expect(cached).toBeTruthy();
        });
    });
});