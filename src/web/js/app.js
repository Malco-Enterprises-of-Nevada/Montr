/**
 * Main Application Controller
 * Manages the web interface, navigation, and coordinates API/WebSocket clients
 */
class MediaPlaylistApp {
    constructor() {
        this.currentSection = 'playlists';
        this.activePlaylist = null;
        this.connectedClients = [];
        
        this.initializeApp();
    }

    /**
     * Initialize the application
     */
    async initializeApp() {
        console.log('Initializing Media Playlist Management Interface');
        
        // Set up event listeners
        this.setupEventListeners();
        
        // Initialize WebSocket connection
        this.initializeWebSocket();
        
        // Load initial data
        await this.loadInitialData();
        
        // Start periodic updates
        this.startPeriodicUpdates();
        
        console.log('Application initialized successfully');
    }

    /**
     * Set up DOM event listeners
     */
    setupEventListeners() {
        // Navigation
        document.querySelectorAll('.nav-button').forEach(button => {
            button.addEventListener('click', (e) => {
                const section = e.currentTarget.dataset.section;
                this.switchSection(section);
            });
        });

        // Toast close buttons
        const closeError = document.getElementById('close-error');
        if (closeError) {
            closeError.addEventListener('click', () => {
                const errorToast = document.getElementById('error-toast');
                if (errorToast) {
                    errorToast.classList.add('hidden');
                }
            });
        }

        const closeSuccess = document.getElementById('close-success');
        if (closeSuccess) {
            closeSuccess.addEventListener('click', () => {
                const successToast = document.getElementById('success-toast');
                if (successToast) {
                    successToast.classList.add('hidden');
                }
            });
        }

        // Action buttons (will be implemented in later tasks)
        const createPlaylistBtn = document.getElementById('create-playlist-btn');
        if (createPlaylistBtn) {
            createPlaylistBtn.addEventListener('click', () => {
                this.showCreatePlaylistDialog();
            });
        }

        const uploadMediaBtn = document.getElementById('upload-media-btn');
        if (uploadMediaBtn) {
            uploadMediaBtn.addEventListener('click', () => {
                this.showUploadMediaDialog();
            });
        }
    }

    /**
     * Initialize WebSocket connection and event handlers
     */
    initializeWebSocket() {
        // Connect to WebSocket
        window.wsClient.connect();

        // Set up WebSocket event handlers
        window.wsClient.on('connected', () => {
            console.log('WebSocket connected');
            this.updateServerStatus('connected');
            
            // Send client info to server
            window.wsClient.send('client-info', {
                userAgent: navigator.userAgent
            });
        });

        window.wsClient.on('disconnected', (reason) => {
            console.log('WebSocket disconnected:', reason);
            this.updateServerStatus('disconnected');
        });

        window.wsClient.on('playlist-activated', (data) => {
            console.log('Playlist activated event:', data);
            this.handlePlaylistActivated(data);
        });

        window.wsClient.on('playlist-updated', (data) => {
            console.log('Playlist updated event:', data);
            this.handlePlaylistUpdated(data);
        });

        window.wsClient.on('client-connected', (data) => {
            console.log('Client connected event:', data);
            this.handleClientConnected(data);
        });

        window.wsClient.on('client-disconnected', (data) => {
            console.log('Client disconnected event:', data);
            this.handleClientDisconnected(data);
        });

        window.wsClient.on('client-list-updated', (clients) => {
            console.log('Client list updated event:', clients);
            this.handleClientListUpdated(clients);
        });
    }

    /**
     * Load initial application data
     */
    async loadInitialData() {
        try {
            // Load active playlist
            await this.loadActivePlaylist();
            
            // Load connected clients
            await this.loadConnectedClients();
            
            // Load section-specific data based on current section
            await this.loadSectionData(this.currentSection);
            
        } catch (error) {
            console.error('Failed to load initial data:', error);
            window.apiClient.handleApiError(error, 'loading initial data');
        }
    }

    /**
     * Load active playlist information
     */
    async loadActivePlaylist() {
        try {
            const response = await window.apiClient.getActivePlaylist();
            this.activePlaylist = response.data;
            this.updateActivePlaylistDisplay();
        } catch (error) {
            console.error('Failed to load active playlist:', error);
            this.activePlaylist = null;
            this.updateActivePlaylistDisplay();
        }
    }

    /**
     * Load connected clients information
     */
    async loadConnectedClients() {
        try {
            const response = await window.apiClient.getConnectedClients();
            this.connectedClients = response.data.clients || [];
            this.updateConnectedClientsDisplay();
        } catch (error) {
            console.error('Failed to load connected clients:', error);
            this.connectedClients = [];
            this.updateConnectedClientsDisplay();
        }
    }

    /**
     * Load data for specific section
     */
    async loadSectionData(section) {
        const loadingElement = document.querySelector(`#${section}-section .loading`);
        
        if (loadingElement) {
            loadingElement.textContent = `Loading ${section}...`;
        }

        try {
            switch (section) {
                case 'playlists':
                    await this.loadPlaylistsData();
                    break;
                case 'media':
                    await this.loadMediaData();
                    break;
                case 'control':
                    await this.loadControlPanelData();
                    break;
            }
        } catch (error) {
            console.error(`Failed to load ${section} data:`, error);
            if (loadingElement) {
                loadingElement.textContent = `Failed to load ${section}. Please try again.`;
            }
        }
    }

    /**
     * Load playlists data
     */
    async loadPlaylistsData() {
        // Initialize playlist manager if not already done
        if (!window.playlistManager) {
            window.playlistManager = new PlaylistManager();
        } else {
            // Refresh existing playlist manager
            await window.playlistManager.refresh();
        }
    }

    /**
     * Load media data
     */
    async loadMediaData() {
        // Initialize media manager if not already done
        if (!window.mediaManager) {
            window.mediaManager = new MediaManager();
        } else {
            // Refresh existing media manager
            await window.mediaManager.refresh();
        }
    }

    /**
     * Load control panel data
     */
    async loadControlPanelData() {
        // Initialize control panel manager if not already done
        if (!window.controlPanel) {
            window.controlPanel = new ControlPanelManager();
        } else {
            // Refresh existing control panel manager
            await window.controlPanel.loadInitialData();
        }
    }

    /**
     * Switch between sections
     */
    switchSection(section) {
        // Update navigation
        document.querySelectorAll('.nav-button').forEach(btn => {
            btn.classList.remove('active');
        });
        const activeNavBtn = document.querySelector(`[data-section="${section}"]`);
        if (activeNavBtn) {
            activeNavBtn.classList.add('active');
        }

        // Update content sections
        document.querySelectorAll('.content-section').forEach(sec => {
            sec.classList.remove('active');
        });
        const activeSection = document.getElementById(`${section}-section`);
        if (activeSection) {
            activeSection.classList.add('active');
        }

        // Update current section
        this.currentSection = section;

        // Load section data if needed
        this.loadSectionData(section);
    }

    /**
     * Update active playlist display
     */
    updateActivePlaylistDisplay() {
        const activePlaylistName = document.getElementById('active-playlist-name');
        if (activePlaylistName) {
            activePlaylistName.textContent = this.activePlaylist ? this.activePlaylist.name : 'None';
        }
    }

    /**
     * Update connected clients display
     */
    updateConnectedClientsDisplay() {
        const clientCount = document.getElementById('client-count');
        const clientList = document.getElementById('client-list');

        if (clientCount) {
            clientCount.textContent = this.connectedClients.length.toString();
        }

        if (clientList) {
            if (this.connectedClients.length === 0) {
                clientList.innerHTML = '<div style="color: #6c757d; font-style: italic;">No clients connected</div>';
            } else {
                clientList.innerHTML = this.connectedClients.map(client => 
                    `<div class="client-item" style="padding: 0.5rem; border-bottom: 1px solid #e9ecef;">
                        <strong>Client ${client.id}</strong>
                        <div style="font-size: 0.85rem; color: #6c757d;">
                            Connected: ${new Date(client.connectedAt).toLocaleTimeString()}
                        </div>
                    </div>`
                ).join('');
            }
        }
    }

    /**
     * Update server status display
     */
    updateServerStatus(status) {
        const serverStatus = document.getElementById('server-status');
        if (serverStatus) {
            serverStatus.textContent = status === 'connected' ? 'Connected' : 'Disconnected';
            serverStatus.className = `status-value ${status}`;
        }
    }

    /**
     * Handle playlist activated event
     */
    async handlePlaylistActivated(playlist) {
        // The server sends the full playlist object or null
        this.activePlaylist = playlist;
        this.updateActivePlaylistDisplay();
        
        window.apiClient.showSuccessToast(
            this.activePlaylist ? 
            `Playlist "${this.activePlaylist.name}" activated` : 
            'Playlist deactivated'
        );
    }

    /**
     * Handle playlist updated event
     */
    handlePlaylistUpdated(playlist) {
        console.log('Playlist updated:', playlist);
        // Refresh current section if it's playlists
        if (this.currentSection === 'playlists') {
            this.loadSectionData('playlists');
        }
        
        // Update active playlist if it's the one that was updated
        if (this.activePlaylist && playlist && this.activePlaylist.id === playlist.id) {
            this.activePlaylist = playlist;
            this.updateActivePlaylistDisplay();
        }
    }

    /**
     * Handle client connected event
     */
    handleClientConnected(data) {
        console.log('Client connected:', data);
        this.loadConnectedClients();
    }

    /**
     * Handle client disconnected event
     */
    handleClientDisconnected(data) {
        console.log('Client disconnected:', data);
        this.loadConnectedClients();
    }

    /**
     * Handle client list updated event
     */
    handleClientListUpdated(clients) {
        console.log('Client list updated:', clients);
        this.connectedClients = clients || [];
        this.updateConnectedClientsDisplay();
    }

    /**
     * Start periodic updates
     */
    startPeriodicUpdates() {
        // Update connected clients every 30 seconds
        setInterval(() => {
            if (this.currentSection === 'control') {
                this.loadConnectedClients();
            }
        }, 30000);

        // Send WebSocket ping every 25 seconds to keep connection alive
        setInterval(() => {
            window.wsClient.ping();
        }, 25000);
    }

    /**
     * Show create playlist dialog
     */
    showCreatePlaylistDialog() {
        if (window.playlistManager) {
            window.playlistManager.showCreateModal();
        } else {
            window.apiClient.showErrorToast('Playlist manager not initialized');
        }
    }

    /**
     * Show upload media dialog
     */
    showUploadMediaDialog() {
        if (window.mediaManager) {
            window.mediaManager.showUploadModal();
        } else {
            window.apiClient.showErrorToast('Media manager not initialized');
        }
    }

    /**
     * Get application status
     */
    getStatus() {
        return {
            currentSection: this.currentSection,
            activePlaylist: this.activePlaylist,
            connectedClients: this.connectedClients.length,
            websocketConnected: window.wsClient.getConnectionStatus().connected
        };
    }
}

// Initialize application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.app = new MediaPlaylistApp();
});

// Export for debugging
window.MediaPlaylistApp = MediaPlaylistApp;