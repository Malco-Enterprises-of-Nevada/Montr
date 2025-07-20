/**
 * Control Panel Manager
 * Handles playlist activation controls, client monitoring, and system status
 */
class ControlPanelManager {
    constructor() {
        this.activePlaylist = null;
        this.connectedClients = [];
        this.playlists = [];
        this.systemHealth = {
            server: 'connected',
            websocket: 'connecting',
            database: 'unknown'
        };
        
        this.initializeControlPanel();
    }

    /**
     * Initialize the control panel
     */
    async initializeControlPanel() {
        console.log('Initializing Control Panel Manager');
        
        // Set up event listeners
        this.setupEventListeners();
        
        // Load initial data
        await this.loadInitialData();
        
        // Set up periodic updates
        this.startPeriodicUpdates();
        
        console.log('Control Panel Manager initialized');
    }

    /**
     * Set up DOM event listeners
     */
    setupEventListeners() {
        // Playlist activation controls
        const activateBtn = document.getElementById('activate-playlist-btn');
        if (activateBtn) {
            activateBtn.addEventListener('click', () => {
                this.showPlaylistActivationModal();
            });
        }

        const deactivateBtn = document.getElementById('deactivate-playlist-btn');
        if (deactivateBtn) {
            deactivateBtn.addEventListener('click', () => {
                this.deactivateCurrentPlaylist();
            });
        }

        // Refresh controls
        const refreshClientsBtn = document.getElementById('refresh-clients-btn');
        if (refreshClientsBtn) {
            refreshClientsBtn.addEventListener('click', () => {
                this.refreshConnectedClients();
            });
        }

        const refreshStatusBtn = document.getElementById('refresh-status-btn');
        if (refreshStatusBtn) {
            refreshStatusBtn.addEventListener('click', () => {
                this.refreshSystemStatus();
            });
        }

        // WebSocket event handlers
        if (window.wsClient) {
            window.wsClient.on('playlist-activated', (playlist) => {
                this.handlePlaylistActivated(playlist);
            });

            window.wsClient.on('client-list-updated', (clients) => {
                this.handleClientListUpdated(clients);
            });

            window.wsClient.on('connected', () => {
                this.updateSystemHealth('websocket', 'connected');
            });

            window.wsClient.on('disconnected', () => {
                this.updateSystemHealth('websocket', 'disconnected');
            });
        }
    }

    /**
     * Load initial control panel data
     */
    async loadInitialData() {
        try {
            // Load active playlist
            await this.loadActivePlaylist();
            
            // Load connected clients
            await this.loadConnectedClients();
            
            // Load available playlists for activation
            await this.loadAvailablePlaylists();
            
            // Check system health
            await this.checkSystemHealth();
            
        } catch (error) {
            console.error('Failed to load control panel data:', error);
            window.apiClient.showErrorToast('Failed to load control panel data');
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
     * Load connected clients
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
     * Load available playlists for activation
     */
    async loadAvailablePlaylists() {
        try {
            const response = await window.apiClient.getPlaylists(false);
            this.playlists = response.data || [];
        } catch (error) {
            console.error('Failed to load playlists:', error);
            this.playlists = [];
        }
    }

    /**
     * Check system health
     */
    async checkSystemHealth() {
        // Check server connectivity
        try {
            await window.apiClient.getPlaylists(false);
            this.updateSystemHealth('server', 'connected');
        } catch (error) {
            this.updateSystemHealth('server', 'disconnected');
        }

        // WebSocket status is handled by event listeners
        const wsStatus = window.wsClient?.getConnectionStatus();
        if (wsStatus) {
            this.updateSystemHealth('websocket', wsStatus.connected ? 'connected' : 'disconnected');
        }
    }

    /**
     * Update active playlist display
     */
    updateActivePlaylistDisplay() {
        const activePlaylistName = document.getElementById('active-playlist-name');
        const activateBtn = document.getElementById('activate-playlist-btn');
        const deactivateBtn = document.getElementById('deactivate-playlist-btn');
        const playlistStatus = document.getElementById('playlist-status');

        if (activePlaylistName) {
            activePlaylistName.textContent = this.activePlaylist ? this.activePlaylist.name : 'None';
        }

        if (playlistStatus) {
            if (this.activePlaylist) {
                playlistStatus.innerHTML = `
                    <div class="status-item">
                        <span>Status:</span>
                        <span class="status-value connected">Active</span>
                    </div>
                    <div class="status-item">
                        <span>Items:</span>
                        <span class="status-value">${this.activePlaylist.items?.length || 0}</span>
                    </div>
                    <div class="status-item">
                        <span>Activated:</span>
                        <span class="status-value">${new Date(this.activePlaylist.updated_at || this.activePlaylist.created_at).toLocaleTimeString()}</span>
                    </div>
                `;
            } else {
                playlistStatus.innerHTML = `
                    <div class="status-item">
                        <span>Status:</span>
                        <span class="status-value disconnected">No Active Playlist</span>
                    </div>
                `;
            }
        }

        // Update button states
        if (activateBtn && deactivateBtn) {
            if (this.activePlaylist) {
                activateBtn.textContent = 'Change Active Playlist';
                deactivateBtn.style.display = 'inline-flex';
            } else {
                activateBtn.textContent = 'Activate Playlist';
                deactivateBtn.style.display = 'none';
            }
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
                clientList.innerHTML = '<div class="no-clients">No clients connected</div>';
            } else {
                clientList.innerHTML = this.connectedClients.map(client => {
                    const connectedTime = new Date(client.connectedAt).toLocaleTimeString();
                    const lastHeartbeat = new Date(client.lastHeartbeat).toLocaleTimeString();
                    
                    return `
                        <div class="client-item">
                            <div class="client-header">
                                <strong>Client ${client.id.substring(0, 8)}...</strong>
                                <span class="client-status connected">●</span>
                            </div>
                            <div class="client-details">
                                <div class="client-detail">
                                    <span>Connected:</span>
                                    <span>${connectedTime}</span>
                                </div>
                                <div class="client-detail">
                                    <span>Last Heartbeat:</span>
                                    <span>${lastHeartbeat}</span>
                                </div>
                                ${client.userAgent ? `
                                    <div class="client-detail">
                                        <span>User Agent:</span>
                                        <span class="user-agent">${client.userAgent.substring(0, 50)}${client.userAgent.length > 50 ? '...' : ''}</span>
                                    </div>
                                ` : ''}
                            </div>
                        </div>
                    `;
                }).join('');
            }
        }
    }

    /**
     * Update system health status
     */
    updateSystemHealth(component, status) {
        this.systemHealth[component] = status;
        
        const statusElement = document.getElementById(`${component}-status`);
        if (statusElement) {
            statusElement.textContent = status.charAt(0).toUpperCase() + status.slice(1);
            statusElement.className = `status-value ${status}`;
        }

        // Update overall system health indicator
        this.updateOverallSystemHealth();
    }

    /**
     * Update overall system health indicator
     */
    updateOverallSystemHealth() {
        const overallStatus = document.getElementById('overall-system-status');
        if (!overallStatus) return;

        const statuses = Object.values(this.systemHealth);
        let overallState = 'connected';

        if (statuses.includes('disconnected')) {
            overallState = 'disconnected';
        } else if (statuses.includes('connecting') || statuses.includes('unknown')) {
            overallState = 'connecting';
        }

        overallStatus.textContent = overallState.charAt(0).toUpperCase() + overallState.slice(1);
        overallStatus.className = `status-value ${overallState}`;
    }

    /**
     * Show playlist activation modal
     */
    async showPlaylistActivationModal() {
        // Ensure we have the latest playlists
        await this.loadAvailablePlaylists();

        if (this.playlists.length === 0) {
            window.apiClient.showErrorToast('No playlists available to activate');
            return;
        }

        // Create modal HTML
        const modalHtml = `
            <div id="playlist-activation-modal" class="modal">
                <div class="modal-content">
                    <div class="modal-header">
                        <h3>Activate Playlist</h3>
                        <button class="modal-close" onclick="this.closest('.modal').remove()">&times;</button>
                    </div>
                    <div class="modal-body">
                        <div class="form-group">
                            <label for="playlist-select">Select Playlist to Activate:</label>
                            <select id="playlist-select" class="form-control">
                                <option value="">-- Select a playlist --</option>
                                ${this.playlists.map(playlist => `
                                    <option value="${playlist.id}" ${this.activePlaylist?.id === playlist.id ? 'selected' : ''}>
                                        ${playlist.name} (${playlist.items?.length || 0} items)
                                    </option>
                                `).join('')}
                            </select>
                        </div>
                        <div id="playlist-preview" class="playlist-preview" style="display: none;">
                            <h4>Playlist Preview:</h4>
                            <div id="preview-content"></div>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">Cancel</button>
                        <button id="confirm-activate-btn" class="btn btn-primary" disabled>Activate</button>
                    </div>
                </div>
            </div>
        `;

        // Add modal to DOM
        document.body.insertAdjacentHTML('beforeend', modalHtml);

        // Set up modal event listeners
        const modal = document.getElementById('playlist-activation-modal');
        const playlistSelect = document.getElementById('playlist-select');
        const confirmBtn = document.getElementById('confirm-activate-btn');
        const previewDiv = document.getElementById('playlist-preview');
        const previewContent = document.getElementById('preview-content');

        playlistSelect.addEventListener('change', async (e) => {
            const playlistId = e.target.value;
            
            if (playlistId) {
                confirmBtn.disabled = false;
                
                // Show playlist preview
                const playlist = this.playlists.find(p => p.id === playlistId);
                if (playlist) {
                    try {
                        // Get full playlist details
                        const response = await window.apiClient.getPlaylist(playlistId, true);
                        const fullPlaylist = response.data;
                        
                        previewContent.innerHTML = `
                            <div class="preview-info">
                                <p><strong>Name:</strong> ${fullPlaylist.name}</p>
                                <p><strong>Description:</strong> ${fullPlaylist.description || 'No description'}</p>
                                <p><strong>Items:</strong> ${fullPlaylist.items?.length || 0}</p>
                                <p><strong>Created:</strong> ${new Date(fullPlaylist.created_at).toLocaleString()}</p>
                            </div>
                            ${fullPlaylist.items && fullPlaylist.items.length > 0 ? `
                                <div class="preview-items">
                                    <h5>Items:</h5>
                                    <ul>
                                        ${fullPlaylist.items.slice(0, 5).map(item => `
                                            <li>${item.media_file?.original_name || 'Unknown file'} (${item.media_file?.file_type || 'unknown'})</li>
                                        `).join('')}
                                        ${fullPlaylist.items.length > 5 ? `<li>... and ${fullPlaylist.items.length - 5} more items</li>` : ''}
                                    </ul>
                                </div>
                            ` : ''}
                        `;
                        previewDiv.style.display = 'block';
                    } catch (error) {
                        console.error('Failed to load playlist preview:', error);
                        previewContent.innerHTML = '<p class="error">Failed to load playlist preview</p>';
                        previewDiv.style.display = 'block';
                    }
                }
            } else {
                confirmBtn.disabled = true;
                previewDiv.style.display = 'none';
            }
        });

        confirmBtn.addEventListener('click', async () => {
            const playlistId = playlistSelect.value;
            if (playlistId) {
                await this.activatePlaylist(playlistId);
                modal.remove();
            }
        });

        // Close modal when clicking outside
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });
    }

    /**
     * Activate a playlist
     */
    async activatePlaylist(playlistId) {
        try {
            window.apiClient.showLoading();
            
            const response = await window.apiClient.activatePlaylist(playlistId);
            
            if (response.success) {
                this.activePlaylist = response.data.playlist;
                this.updateActivePlaylistDisplay();
                window.apiClient.showSuccessToast(`Playlist "${this.activePlaylist.name}" activated successfully`);
            } else {
                throw new Error(response.error?.message || 'Failed to activate playlist');
            }
        } catch (error) {
            console.error('Failed to activate playlist:', error);
            window.apiClient.showErrorToast(`Failed to activate playlist: ${error.message}`);
        } finally {
            window.apiClient.hideLoading();
        }
    }

    /**
     * Deactivate current playlist
     */
    async deactivateCurrentPlaylist() {
        if (!this.activePlaylist) {
            return;
        }

        const confirmed = confirm(`Are you sure you want to deactivate "${this.activePlaylist.name}"? All connected clients will stop playback.`);
        if (!confirmed) {
            return;
        }

        try {
            window.apiClient.showLoading();
            
            // There's no direct deactivate endpoint, so we'll use a special activate with null
            // For now, we'll implement this by clearing the active playlist on the server
            const response = await window.apiClient.request('/api/playlists/active/clear', {
                method: 'POST'
            });
            
            this.activePlaylist = null;
            this.updateActivePlaylistDisplay();
            window.apiClient.showSuccessToast('Playlist deactivated successfully');
        } catch (error) {
            console.error('Failed to deactivate playlist:', error);
            window.apiClient.showErrorToast(`Failed to deactivate playlist: ${error.message}`);
        } finally {
            window.apiClient.hideLoading();
        }
    }

    /**
     * Refresh connected clients
     */
    async refreshConnectedClients() {
        const refreshBtn = document.getElementById('refresh-clients-btn');
        if (refreshBtn) {
            refreshBtn.disabled = true;
            refreshBtn.textContent = 'Refreshing...';
        }

        try {
            await this.loadConnectedClients();
            window.apiClient.showSuccessToast('Client list refreshed');
        } catch (error) {
            console.error('Failed to refresh clients:', error);
            window.apiClient.showErrorToast('Failed to refresh client list');
        } finally {
            if (refreshBtn) {
                refreshBtn.disabled = false;
                refreshBtn.textContent = 'Refresh';
            }
        }
    }

    /**
     * Refresh system status
     */
    async refreshSystemStatus() {
        const refreshBtn = document.getElementById('refresh-status-btn');
        if (refreshBtn) {
            refreshBtn.disabled = true;
            refreshBtn.textContent = 'Checking...';
        }

        try {
            await this.checkSystemHealth();
            window.apiClient.showSuccessToast('System status refreshed');
        } catch (error) {
            console.error('Failed to refresh system status:', error);
            window.apiClient.showErrorToast('Failed to refresh system status');
        } finally {
            if (refreshBtn) {
                refreshBtn.disabled = false;
                refreshBtn.textContent = 'Refresh';
            }
        }
    }

    /**
     * Handle playlist activated event from WebSocket
     */
    handlePlaylistActivated(playlist) {
        this.activePlaylist = playlist;
        this.updateActivePlaylistDisplay();
        
        if (playlist) {
            window.apiClient.showSuccessToast(`Playlist "${playlist.name}" activated`);
        } else {
            window.apiClient.showSuccessToast('Playlist deactivated');
        }
    }

    /**
     * Handle client list updated event from WebSocket
     */
    handleClientListUpdated(clients) {
        this.connectedClients = clients || [];
        this.updateConnectedClientsDisplay();
    }

    /**
     * Start periodic updates
     */
    startPeriodicUpdates() {
        // Update connected clients every 30 seconds
        setInterval(() => {
            this.loadConnectedClients();
        }, 30000);

        // Check system health every 60 seconds
        setInterval(() => {
            this.checkSystemHealth();
        }, 60000);
    }

    /**
     * Get control panel status
     */
    getStatus() {
        return {
            activePlaylist: this.activePlaylist,
            connectedClients: this.connectedClients.length,
            systemHealth: this.systemHealth,
            availablePlaylists: this.playlists.length
        };
    }
}

// Export for use in other modules
window.ControlPanelManager = ControlPanelManager;