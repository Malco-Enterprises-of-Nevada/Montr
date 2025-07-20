/**
 * Control Panel Manager Tests
 * Tests for the control panel functionality
 */

// Mock API client for testing
const mockApiClient = {
    getActivePlaylist: jest.fn(),
    getConnectedClients: jest.fn(),
    getPlaylists: jest.fn(),
    getPlaylist: jest.fn(),
    activatePlaylist: jest.fn(),
    request: jest.fn(),
    showLoading: jest.fn(),
    hideLoading: jest.fn(),
    showSuccessToast: jest.fn(),
    showErrorToast: jest.fn()
};

// Mock WebSocket client for testing
const mockWsClient = {
    on: jest.fn(),
    getConnectionStatus: jest.fn(() => ({ connected: true })),
    forceReconnect: jest.fn()
};

// Mock DOM elements
const mockElements = {
    'active-playlist-name': { textContent: '' },
    'client-count': { textContent: '' },
    'client-list': { innerHTML: '' },
    'server-status': { textContent: '', className: '' },
    'websocket-status': { textContent: '', className: '' },
    'overall-system-status': { textContent: '', className: '' },
    'playlist-status': { innerHTML: '' },
    'activate-playlist-btn': { 
        textContent: '', 
        addEventListener: jest.fn(),
        style: { display: '' }
    },
    'deactivate-playlist-btn': { 
        style: { display: '' },
        addEventListener: jest.fn()
    },
    'refresh-clients-btn': { 
        addEventListener: jest.fn(),
        disabled: false,
        textContent: ''
    },
    'refresh-status-btn': { 
        addEventListener: jest.fn(),
        disabled: false,
        textContent: ''
    }
};

// Mock document.getElementById
global.document = {
    getElementById: jest.fn((id) => mockElements[id] || null),
    body: {
        insertAdjacentHTML: jest.fn()
    }
};

// Mock window objects
global.window = {
    apiClient: mockApiClient,
    wsClient: mockWsClient,
    confirm: jest.fn(() => true)
};

describe('ControlPanelManager', () => {
    let controlPanel;

    beforeEach(() => {
        // Reset all mocks
        jest.clearAllMocks();
        
        // Reset mock element states
        Object.values(mockElements).forEach(element => {
            if (element.textContent !== undefined) element.textContent = '';
            if (element.innerHTML !== undefined) element.innerHTML = '';
            if (element.className !== undefined) element.className = '';
            if (element.style) element.style.display = '';
            if (element.disabled !== undefined) element.disabled = false;
        });

        // Mock successful API responses
        mockApiClient.getActivePlaylist.mockResolvedValue({
            success: true,
            data: {
                id: 'playlist-1',
                name: 'Test Playlist',
                items: [{ id: 'item-1' }, { id: 'item-2' }],
                created_at: new Date().toISOString()
            }
        });

        mockApiClient.getConnectedClients.mockResolvedValue({
            success: true,
            data: {
                clients: [
                    {
                        id: 'client-1',
                        connectedAt: new Date().toISOString(),
                        lastHeartbeat: new Date().toISOString(),
                        userAgent: 'Test Browser'
                    }
                ]
            }
        });

        mockApiClient.getPlaylists.mockResolvedValue({
            success: true,
            data: [
                { id: 'playlist-1', name: 'Test Playlist 1', items: [] },
                { id: 'playlist-2', name: 'Test Playlist 2', items: [] }
            ]
        });

        // Create new instance for each test
        controlPanel = new ControlPanelManager();
    });

    describe('Initialization', () => {
        test('should initialize with default values', () => {
            expect(controlPanel.activePlaylist).toBeNull();
            expect(controlPanel.connectedClients).toEqual([]);
            expect(controlPanel.playlists).toEqual([]);
            expect(controlPanel.systemHealth).toEqual({
                server: 'connected',
                websocket: 'connecting',
                database: 'unknown'
            });
        });

        test('should set up event listeners', () => {
            expect(mockElements['activate-playlist-btn'].addEventListener).toHaveBeenCalled();
            expect(mockElements['deactivate-playlist-btn'].addEventListener).toHaveBeenCalled();
            expect(mockElements['refresh-clients-btn'].addEventListener).toHaveBeenCalled();
            expect(mockElements['refresh-status-btn'].addEventListener).toHaveBeenCalled();
        });

        test('should register WebSocket event handlers', () => {
            expect(mockWsClient.on).toHaveBeenCalledWith('playlist-activated', expect.any(Function));
            expect(mockWsClient.on).toHaveBeenCalledWith('client-list-updated', expect.any(Function));
            expect(mockWsClient.on).toHaveBeenCalledWith('connected', expect.any(Function));
            expect(mockWsClient.on).toHaveBeenCalledWith('disconnected', expect.any(Function));
        });
    });

    describe('Active Playlist Management', () => {
        test('should load and display active playlist', async () => {
            await controlPanel.loadActivePlaylist();

            expect(mockApiClient.getActivePlaylist).toHaveBeenCalled();
            expect(controlPanel.activePlaylist).toEqual({
                id: 'playlist-1',
                name: 'Test Playlist',
                items: [{ id: 'item-1' }, { id: 'item-2' }],
                created_at: expect.any(String)
            });
            expect(mockElements['active-playlist-name'].textContent).toBe('Test Playlist');
        });

        test('should handle no active playlist', async () => {
            mockApiClient.getActivePlaylist.mockResolvedValue({
                success: true,
                data: null
            });

            await controlPanel.loadActivePlaylist();

            expect(controlPanel.activePlaylist).toBeNull();
            expect(mockElements['active-playlist-name'].textContent).toBe('None');
        });

        test('should update button states based on active playlist', () => {
            // Test with active playlist
            controlPanel.activePlaylist = { id: 'playlist-1', name: 'Test' };
            controlPanel.updateActivePlaylistDisplay();

            expect(mockElements['activate-playlist-btn'].textContent).toBe('Change Active Playlist');
            expect(mockElements['deactivate-playlist-btn'].style.display).toBe('inline-flex');

            // Test without active playlist
            controlPanel.activePlaylist = null;
            controlPanel.updateActivePlaylistDisplay();

            expect(mockElements['activate-playlist-btn'].textContent).toBe('Activate Playlist');
            expect(mockElements['deactivate-playlist-btn'].style.display).toBe('none');
        });
    });

    describe('Connected Clients Management', () => {
        test('should load and display connected clients', async () => {
            await controlPanel.loadConnectedClients();

            expect(mockApiClient.getConnectedClients).toHaveBeenCalled();
            expect(controlPanel.connectedClients).toHaveLength(1);
            expect(mockElements['client-count'].textContent).toBe('1');
        });

        test('should display no clients message when empty', () => {
            controlPanel.connectedClients = [];
            controlPanel.updateConnectedClientsDisplay();

            expect(mockElements['client-list'].innerHTML).toContain('No clients connected');
        });

        test('should display client information', () => {
            controlPanel.connectedClients = [{
                id: 'client-123',
                connectedAt: new Date().toISOString(),
                lastHeartbeat: new Date().toISOString(),
                userAgent: 'Test Browser'
            }];
            controlPanel.updateConnectedClientsDisplay();

            expect(mockElements['client-list'].innerHTML).toContain('Client client-12');
            expect(mockElements['client-list'].innerHTML).toContain('Test Browser');
        });
    });

    describe('System Health Monitoring', () => {
        test('should update system health status', () => {
            controlPanel.updateSystemHealth('server', 'connected');

            expect(controlPanel.systemHealth.server).toBe('connected');
            expect(mockElements['server-status'].textContent).toBe('Connected');
            expect(mockElements['server-status'].className).toBe('status-value connected');
        });

        test('should update overall system health', () => {
            controlPanel.systemHealth = {
                server: 'connected',
                websocket: 'connected',
                database: 'connected'
            };
            controlPanel.updateOverallSystemHealth();

            expect(mockElements['overall-system-status'].textContent).toBe('Connected');
            expect(mockElements['overall-system-status'].className).toBe('status-value connected');
        });

        test('should show disconnected when any component is down', () => {
            controlPanel.systemHealth = {
                server: 'disconnected',
                websocket: 'connected',
                database: 'connected'
            };
            controlPanel.updateOverallSystemHealth();

            expect(mockElements['overall-system-status'].textContent).toBe('Disconnected');
            expect(mockElements['overall-system-status'].className).toBe('status-value disconnected');
        });
    });

    describe('Playlist Activation', () => {
        test('should activate playlist successfully', async () => {
            mockApiClient.activatePlaylist.mockResolvedValue({
                success: true,
                data: {
                    playlist: { id: 'playlist-1', name: 'Test Playlist' }
                }
            });

            await controlPanel.activatePlaylist('playlist-1');

            expect(mockApiClient.activatePlaylist).toHaveBeenCalledWith('playlist-1');
            expect(mockApiClient.showLoading).toHaveBeenCalled();
            expect(mockApiClient.hideLoading).toHaveBeenCalled();
            expect(mockApiClient.showSuccessToast).toHaveBeenCalledWith(
                'Playlist "Test Playlist" activated successfully'
            );
        });

        test('should handle activation error', async () => {
            const error = new Error('Activation failed');
            mockApiClient.activatePlaylist.mockRejectedValue(error);

            await controlPanel.activatePlaylist('playlist-1');

            expect(mockApiClient.showErrorToast).toHaveBeenCalledWith(
                'Failed to activate playlist: Activation failed'
            );
            expect(mockApiClient.hideLoading).toHaveBeenCalled();
        });
    });

    describe('Playlist Deactivation', () => {
        test('should deactivate current playlist', async () => {
            controlPanel.activePlaylist = { id: 'playlist-1', name: 'Test Playlist' };
            mockApiClient.request.mockResolvedValue({ success: true });

            await controlPanel.deactivateCurrentPlaylist();

            expect(window.confirm).toHaveBeenCalledWith(
                'Are you sure you want to deactivate "Test Playlist"? All connected clients will stop playback.'
            );
            expect(mockApiClient.request).toHaveBeenCalledWith('/api/playlists/active/clear', {
                method: 'POST'
            });
            expect(controlPanel.activePlaylist).toBeNull();
        });

        test('should not deactivate if user cancels', async () => {
            controlPanel.activePlaylist = { id: 'playlist-1', name: 'Test Playlist' };
            window.confirm.mockReturnValue(false);

            await controlPanel.deactivateCurrentPlaylist();

            expect(mockApiClient.request).not.toHaveBeenCalled();
        });
    });

    describe('WebSocket Event Handling', () => {
        test('should handle playlist activated event', () => {
            const playlist = { id: 'playlist-1', name: 'New Playlist' };
            
            controlPanel.handlePlaylistActivated(playlist);

            expect(controlPanel.activePlaylist).toEqual(playlist);
            expect(mockApiClient.showSuccessToast).toHaveBeenCalledWith(
                'Playlist "New Playlist" activated'
            );
        });

        test('should handle playlist deactivated event', () => {
            controlPanel.handlePlaylistActivated(null);

            expect(controlPanel.activePlaylist).toBeNull();
            expect(mockApiClient.showSuccessToast).toHaveBeenCalledWith('Playlist deactivated');
        });

        test('should handle client list updated event', () => {
            const clients = [
                { id: 'client-1', connectedAt: new Date() },
                { id: 'client-2', connectedAt: new Date() }
            ];

            controlPanel.handleClientListUpdated(clients);

            expect(controlPanel.connectedClients).toEqual(clients);
        });
    });

    describe('Refresh Operations', () => {
        test('should refresh connected clients', async () => {
            await controlPanel.refreshConnectedClients();

            expect(mockElements['refresh-clients-btn'].disabled).toBe(false);
            expect(mockElements['refresh-clients-btn'].textContent).toBe('Refresh');
            expect(mockApiClient.showSuccessToast).toHaveBeenCalledWith('Client list refreshed');
        });

        test('should refresh system status', async () => {
            await controlPanel.refreshSystemStatus();

            expect(mockElements['refresh-status-btn'].disabled).toBe(false);
            expect(mockElements['refresh-status-btn'].textContent).toBe('Refresh');
            expect(mockApiClient.showSuccessToast).toHaveBeenCalledWith('System status refreshed');
        });
    });

    describe('Status Reporting', () => {
        test('should return current status', () => {
            controlPanel.activePlaylist = { id: 'playlist-1', name: 'Test' };
            controlPanel.connectedClients = [{ id: 'client-1' }];
            controlPanel.playlists = [{ id: 'playlist-1' }, { id: 'playlist-2' }];

            const status = controlPanel.getStatus();

            expect(status).toEqual({
                activePlaylist: { id: 'playlist-1', name: 'Test' },
                connectedClients: 1,
                systemHealth: controlPanel.systemHealth,
                availablePlaylists: 2
            });
        });
    });
});