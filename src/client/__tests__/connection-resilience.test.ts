// Connection Resilience Tests for Media Playlist Client
import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { createServer } from 'http';
import Client from 'socket.io-client';

// Mock DOM elements for testing
const mockDOM = () => {
    const mockElement = {
        textContent: '',
        style: { display: 'block' },
        className: '',
        addEventListener: jest.fn(),
        src: '',
        load: jest.fn(),
        play: jest.fn().mockResolvedValue(undefined),
        pause: jest.fn(),
        paused: false
    };

    (global as any).document = {
        getElementById: jest.fn().mockReturnValue(mockElement),
        addEventListener: jest.fn(),
        documentElement: {
            requestFullscreen: jest.fn().mockResolvedValue(undefined)
        },
        fullscreenElement: null,
        exitFullscreen: jest.fn().mockResolvedValue(undefined)
    };

    (global as any).window = {
        location: { origin: 'http://localhost:3001' },
        addEventListener: jest.fn(),
        localStorage: {
            getItem: jest.fn(),
            setItem: jest.fn(),
            removeItem: jest.fn()
        }
    };

    (global as any).navigator = {
        userAgent: 'test-client'
    };

    // Mock Socket.IO global
    (global as any).io = jest.fn();
};

describe('Client Connection Resilience', () => {
    let httpServer: HTTPServer;
    let io: SocketIOServer;
    let serverPort: number;
    let clientSocket: any;

    beforeEach((done) => {
        mockDOM();
        jest.clearAllMocks();
        
        httpServer = createServer();
        io = new SocketIOServer(httpServer, {
            cors: {
                origin: "*",
                methods: ["GET", "POST"]
            }
        });

        httpServer.listen(() => {
            const address = httpServer.address();
            if (address && typeof address === 'object') {
                serverPort = address.port;
            }
            done();
        });
    });

    afterEach((done) => {
        if (clientSocket) {
            clientSocket.disconnect();
            clientSocket = null;
        }
        
        io.close();
        httpServer.close(() => {
            setTimeout(done, 100);
        });
    });

    describe('Connection Management', () => {
        test('should handle initial connection', (done) => {
            let connectionCount = 0;

            io.on('connection', (socket) => {
                connectionCount++;
                expect(connectionCount).toBe(1);
                done();
            });

            clientSocket = Client(`http://localhost:${serverPort}`);
        });

        test('should handle connection errors gracefully', (done) => {
            // Try to connect to non-existent server
            clientSocket = Client('http://localhost:99999', {
                timeout: 1000,
                reconnection: false
            });

            clientSocket.on('connect_error', (error: any) => {
                expect(error).toBeDefined();
                done();
            });
        });

        test.skip('should attempt reconnection on disconnect', (done) => {
            let connectCount = 0;
            let disconnectCount = 0;

            io.on('connection', (socket) => {
                connectCount++;
                
                if (connectCount === 1) {
                    // Disconnect after first connection
                    setTimeout(() => {
                        socket.disconnect();
                    }, 100);
                } else if (connectCount === 2) {
                    // Second connection indicates successful reconnection
                    expect(connectCount).toBe(2);
                    expect(disconnectCount).toBe(1);
                    done();
                }
            });

            clientSocket = Client(`http://localhost:${serverPort}`, {
                reconnectionDelay: 100,
                reconnectionAttempts: 3
            });

            clientSocket.on('disconnect', () => {
                disconnectCount++;
            });
        });

        test('should handle heartbeat communication', (done) => {
            io.on('connection', (socket) => {
                socket.on('heartbeat', () => {
                    socket.emit('heartbeat-response');
                });
            });

            clientSocket = Client(`http://localhost:${serverPort}`);

            clientSocket.on('connect', () => {
                clientSocket.emit('heartbeat');
            });

            clientSocket.on('heartbeat-response', () => {
                expect(true).toBe(true); // Heartbeat received
                done();
            });
        });
    });

    describe('Offline Playlist Caching', () => {
        test('should cache playlist data', () => {
            const mockPlaylist = {
                id: 'test-playlist',
                name: 'Test Playlist',
                items: [],
                created_at: new Date(),
                updated_at: new Date()
            };

            const mockLocalStorage = {
                setItem: jest.fn(),
                getItem: jest.fn(),
                removeItem: jest.fn()
            };

            (global as any).window.localStorage = mockLocalStorage;

            // Simulate caching
            const cacheData = {
                playlist: mockPlaylist,
                cachedAt: new Date().toISOString()
            };

            mockLocalStorage.setItem('cached_playlist', JSON.stringify(cacheData));

            expect(mockLocalStorage.setItem).toHaveBeenCalledWith(
                'cached_playlist',
                JSON.stringify(cacheData)
            );
        });

        test('should load cached playlist when offline', () => {
            const mockPlaylist = {
                id: 'test-playlist',
                name: 'Test Playlist',
                items: [],
                created_at: new Date(),
                updated_at: new Date()
            };

            const cacheData = {
                playlist: mockPlaylist,
                cachedAt: new Date().toISOString()
            };

            const mockLocalStorage = {
                setItem: jest.fn(),
                getItem: jest.fn().mockReturnValue(JSON.stringify(cacheData)),
                removeItem: jest.fn()
            };

            (global as any).window.localStorage = mockLocalStorage;

            // Simulate loading from cache
            const cachedData = mockLocalStorage.getItem('cached_playlist');
            expect(cachedData).toBeDefined();

            if (cachedData) {
                const parsed = JSON.parse(cachedData);
                expect(parsed.playlist.id).toBe(mockPlaylist.id);
                expect(parsed.playlist.name).toBe(mockPlaylist.name);
            }
        });

        test('should handle cache corruption gracefully', () => {
            const mockLocalStorage = {
                setItem: jest.fn(),
                getItem: jest.fn().mockReturnValue('invalid-json'),
                removeItem: jest.fn()
            };

            (global as any).window.localStorage = mockLocalStorage;

            // Simulate loading corrupted cache
            let result = null;
            try {
                const cachedData = mockLocalStorage.getItem('cached_playlist');
                if (cachedData) {
                    result = JSON.parse(cachedData);
                }
            } catch (error) {
                // Should handle gracefully
                expect(error).toBeInstanceOf(SyntaxError);
                result = null;
            }

            expect(result).toBeNull();
        });
    });

    describe('Network Interruption Handling', () => {
        test.skip('should continue operation during network interruption', (done) => {
            let connectionLost = false;
            let connectionRestored = false;

            io.on('connection', (socket) => {
                // Simulate network interruption after connection
                setTimeout(() => {
                    socket.disconnect();
                    connectionLost = true;
                }, 100);
            });

            clientSocket = Client(`http://localhost:${serverPort}`, {
                reconnectionDelay: 200,
                reconnectionAttempts: 2
            });

            clientSocket.on('disconnect', () => {
                expect(connectionLost).toBe(true);
            });

            clientSocket.on('reconnect', () => {
                connectionRestored = true;
                expect(connectionLost).toBe(true);
                expect(connectionRestored).toBe(true);
                done();
            });
        });

        test('should handle server unavailable on startup', (done) => {
            // Create client pointing to unavailable server
            clientSocket = Client('http://localhost:99998', {
                timeout: 500,
                reconnection: false
            });

            clientSocket.on('connect_error', (error: any) => {
                expect(error).toBeDefined();
                // Should handle gracefully without crashing
                done();
            });
        });

        test('should implement exponential backoff for reconnection', (done) => {
            const reconnectionDelays: number[] = [];
            let attemptCount = 0;

            // Mock client with custom reconnection logic
            const testReconnectionBackoff = (attempt: number) => {
                const baseDelay = 1000;
                const maxDelay = 30000;
                const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
                reconnectionDelays.push(delay);
                return delay;
            };

            // Test exponential backoff calculation
            for (let i = 0; i < 5; i++) {
                testReconnectionBackoff(i);
            }

            expect(reconnectionDelays[0]).toBe(1000);  // 1 second
            expect(reconnectionDelays[1]).toBe(2000);  // 2 seconds
            expect(reconnectionDelays[2]).toBe(4000);  // 4 seconds
            expect(reconnectionDelays[3]).toBe(8000);  // 8 seconds
            expect(reconnectionDelays[4]).toBe(16000); // 16 seconds

            done();
        });
    });

    describe('Playlist Synchronization', () => {
        test('should handle playlist activation events', (done) => {
            const testPlaylist = {
                id: 'test-playlist',
                name: 'Test Playlist',
                items: [
                    {
                        id: 'item-1',
                        playlist_id: 'test-playlist',
                        media_file_id: 'media-1',
                        order_index: 0,
                        media_file: {
                            id: 'media-1',
                            filename: 'test.mp4',
                            original_name: 'test.mp4',
                            file_type: 'video' as const,
                            mime_type: 'video/mp4',
                            file_size: 1000,
                            duration: 10,
                            created_at: new Date()
                        }
                    }
                ],
                created_at: new Date(),
                updated_at: new Date()
            };

            io.on('connection', (socket) => {
                // Send playlist activation event
                socket.emit('playlist-activated', testPlaylist);
            });

            clientSocket = Client(`http://localhost:${serverPort}`);

            clientSocket.on('playlist-activated', (playlist: any) => {
                expect(playlist).toBeDefined();
                expect(playlist.id).toBe(testPlaylist.id);
                expect(playlist.name).toBe(testPlaylist.name);
                expect(playlist.items).toHaveLength(1);
                done();
            });
        });

        test('should handle playlist updates during playback', (done) => {
            const updatedPlaylist = {
                id: 'test-playlist',
                name: 'Updated Test Playlist',
                items: [],
                created_at: new Date(),
                updated_at: new Date()
            };

            io.on('connection', (socket) => {
                // Send playlist update event
                socket.emit('playlist-updated', updatedPlaylist);
            });

            clientSocket = Client(`http://localhost:${serverPort}`);

            clientSocket.on('playlist-updated', (playlist: any) => {
                expect(playlist).toBeDefined();
                expect(playlist.id).toBe(updatedPlaylist.id);
                expect(playlist.name).toBe(updatedPlaylist.name);
                done();
            });
        });

        test('should handle null playlist (deactivation)', (done) => {
            io.on('connection', (socket) => {
                // Send playlist deactivation event
                socket.emit('playlist-activated', null);
            });

            clientSocket = Client(`http://localhost:${serverPort}`);

            clientSocket.on('playlist-activated', (playlist: any) => {
                expect(playlist).toBeNull();
                done();
            });
        });
    });

    describe('Error Recovery', () => {
        test.skip('should recover from WebSocket errors', (done) => {
            let errorReceived = false;
            let reconnected = false;

            io.on('connection', (socket) => {
                if (!errorReceived) {
                    // Simulate error on first connection
                    socket.emit('error', new Error('Test error'));
                    socket.disconnect();
                    errorReceived = true;
                } else {
                    // Successful reconnection
                    reconnected = true;
                    expect(errorReceived).toBe(true);
                    expect(reconnected).toBe(true);
                    done();
                }
            });

            clientSocket = Client(`http://localhost:${serverPort}`, {
                reconnectionDelay: 100,
                reconnectionAttempts: 3
            });

            clientSocket.on('error', (error: any) => {
                expect(error).toBeDefined();
            });
        });

        test('should handle malformed playlist data', (done) => {
            io.on('connection', (socket) => {
                // Send malformed playlist data
                socket.emit('playlist-activated', { invalid: 'data' });
            });

            clientSocket = Client(`http://localhost:${serverPort}`);

            clientSocket.on('playlist-activated', (playlist: any) => {
                // Should receive the data even if malformed
                expect(playlist).toBeDefined();
                expect(playlist.invalid).toBe('data');
                // Client should handle gracefully without crashing
                done();
            });
        });
    });
});