// Media Playlist Client Application
// Socket.IO is loaded via script tag in HTML
import MediaPlaybackEngine from './media-playback-engine.js';
import { PlaylistSynchronizer } from './playlist-synchronizer.js';
class MediaPlaylistClient {
    constructor() {
        this.socket = null;
        this.heartbeatTimer = null;
        this.reconnectionTimer = null;
        this.reconnectionAttempts = 0;
        this.config = {
            serverUrl: window.location.origin,
            reconnectionAttempts: 10,
            reconnectionDelay: 1000,
            heartbeatInterval: 30000, // 30 seconds
            maxReconnectionDelay: 30000 // 30 seconds max
        };
        this.clientState = {
            id: this.generateClientId(),
            currentItemIndex: 0,
            playbackState: 'stopped',
            connectionStatus: 'disconnected',
            lastHeartbeat: new Date()
        };
        this.initializeDOM();
        this.initializePlaylistSynchronizer();
        this.loadCachedPlaylist();
        this.connect();
        this.setupKeyboardShortcuts();
    }
    initializeDOM() {
        this.statusText = document.getElementById('status-text');
        this.statusDot = document.getElementById('status-dot');
        this.videoPlayer = document.getElementById('video-player');
        this.imagePlayer = document.getElementById('image-player');
        this.defaultScreen = document.getElementById('default-screen');
        this.loadingMessage = document.getElementById('loading-message');
        this.debugInfo = document.getElementById('debug-info');
        this.clientIdSpan = document.getElementById('client-id');
        this.currentPlaylistSpan = document.getElementById('current-playlist');
        this.currentItemSpan = document.getElementById('current-item');
        this.cacheStatusSpan = document.getElementById('cache-status');
        this.mediaContainer = document.getElementById('media-container');
        // Set initial client ID
        this.clientIdSpan.textContent = this.clientState.id;
        // Initialize the media playback engine
        this.initializePlaybackEngine();
    }
    initializePlaylistSynchronizer() {
        this.playlistSynchronizer = new PlaylistSynchronizer();
        // Set up event handlers
        this.playlistSynchronizer.on('onPlaylistUpdated', (playlist, source) => {
            console.log(`Playlist updated from ${source}:`, playlist.name);
            this.clientState.currentPlaylist = playlist;
            this.updateDebugInfo();
            // Update cache status display
            if (source === 'cache') {
                this.cacheStatusSpan.textContent = 'Loaded from Cache';
            }
            else {
                this.cacheStatusSpan.textContent = 'Synced';
            }
            // If we're currently playing this playlist, update the playback engine
            if (this.clientState.playbackState === 'playing') {
                this.playbackEngine.setPlaylist(playlist);
            }
        });
        this.playlistSynchronizer.on('onSyncStateChanged', (state) => {
            console.log('Sync state changed:', state);
            // Update connection status based on sync state
            this.playlistSynchronizer.setOnlineStatus(this.clientState.connectionStatus === 'connected');
        });
        this.playlistSynchronizer.on('onConflictDetected', (serverPlaylist, localPlaylist) => {
            console.warn('Playlist conflict detected:', {
                server: serverPlaylist.name,
                local: localPlaylist.name,
                serverUpdated: serverPlaylist.updated_at,
                localUpdated: localPlaylist.updated_at
            });
            // For now, server wins - could be made configurable
        });
        this.playlistSynchronizer.on('onSyncError', (error) => {
            console.error('Sync error:', error);
            this.cacheStatusSpan.textContent = 'Sync Error';
        });
    }
    initializePlaybackEngine() {
        const playbackOptions = {
            autoplay: true,
            loop: true,
            muted: true,
            defaultImageDuration: 5,
            transitionDuration: 500,
            preloadNext: true
        };
        this.playbackEngine = new MediaPlaybackEngine(this.videoPlayer, this.imagePlayer, this.mediaContainer, playbackOptions);
        // Set up event handlers
        this.playbackEngine.onMediaEnded(() => {
            console.log('Media ended from playback engine');
            // The engine handles advancing automatically
        });
        this.playbackEngine.onMediaError((error, item) => {
            console.error('Media error from playback engine:', error, item);
            // The engine handles skipping to next item automatically
        });
        this.playbackEngine.onPlaybackStateChange((state) => {
            // Update client state to match playback engine state
            this.clientState.playbackState = state.isPlaying ? 'playing' : 'stopped';
            this.clientState.currentItemIndex = state.currentIndex;
            this.updateDebugInfo();
        });
        this.playbackEngine.onTransitionStart((fromType, toType) => {
            console.log(`Transitioning from ${fromType} to ${toType}`);
        });
        this.playbackEngine.onTransitionComplete((mediaType) => {
            console.log(`Transition to ${mediaType} complete`);
            // Hide default screen when media starts playing
            if (mediaType !== 'none') {
                this.defaultScreen.style.display = 'none';
            }
        });
    }
    generateClientId() {
        return 'client_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
    }
    connect() {
        this.updateConnectionStatus('connecting');
        this.loadingMessage.textContent = 'Connecting to server...';
        try {
            this.socket = io(this.config.serverUrl, {
                transports: ['websocket', 'polling'],
                timeout: 10000,
                forceNew: true
            });
            this.setupSocketEventHandlers();
        }
        catch (error) {
            console.error('Failed to create socket connection:', error);
            this.scheduleReconnection();
        }
    }
    setupSocketEventHandlers() {
        if (!this.socket)
            return;
        this.socket.on('connect', () => {
            console.log('Connected to server');
            this.updateConnectionStatus('connected');
            this.reconnectionAttempts = 0;
            this.loadingMessage.textContent = 'Connected! Waiting for playlist...';
            // Send client info
            this.socket.emit('client-info', {
                userAgent: navigator.userAgent
            });
            // Request active playlist
            this.socket.emit('request-active-playlist');
            // Start heartbeat
            this.startHeartbeat();
        });
        this.socket.on('disconnect', (reason) => {
            console.log('Disconnected from server:', reason);
            this.updateConnectionStatus('disconnected');
            this.loadingMessage.textContent = 'Disconnected from server';
            this.stopHeartbeat();
            // Don't auto-reconnect if disconnected by server
            if (reason !== 'io server disconnect') {
                this.scheduleReconnection();
            }
        });
        this.socket.on('connect_error', (error) => {
            console.error('Connection error:', error);
            this.updateConnectionStatus('disconnected');
            this.loadingMessage.textContent = 'Connection failed';
            this.scheduleReconnection();
        });
        this.socket.on('playlist-activated', (playlist) => {
            console.log('Playlist activated:', playlist);
            this.handlePlaylistActivated(playlist);
        });
        this.socket.on('playlist-updated', (playlist) => {
            console.log('Playlist updated:', playlist);
            this.handlePlaylistUpdated(playlist);
        });
        this.socket.on('playlist-delta-update', (update) => {
            console.log('Playlist delta update received:', update);
            this.handlePlaylistDeltaUpdate(update);
        });
        this.socket.on('heartbeat-response', () => {
            this.clientState.lastHeartbeat = new Date();
        });
    }
    updateConnectionStatus(status) {
        this.clientState.connectionStatus = status;
        this.statusText.textContent = status.charAt(0).toUpperCase() + status.slice(1);
        this.statusDot.className = `status-dot ${status}`;
        // Update synchronizer online status
        this.playlistSynchronizer.setOnlineStatus(status === 'connected');
    }
    scheduleReconnection() {
        if (this.reconnectionTimer) {
            clearTimeout(this.reconnectionTimer);
        }
        if (this.reconnectionAttempts >= this.config.reconnectionAttempts) {
            console.log('Max reconnection attempts reached');
            this.loadingMessage.textContent = 'Connection failed. Using cached playlist if available.';
            this.tryPlayCachedPlaylist();
            return;
        }
        const delay = Math.min(this.config.reconnectionDelay * Math.pow(2, this.reconnectionAttempts), this.config.maxReconnectionDelay);
        this.reconnectionAttempts++;
        this.updateConnectionStatus('reconnecting');
        this.loadingMessage.textContent = `Reconnecting... (${this.reconnectionAttempts}/${this.config.reconnectionAttempts})`;
        this.reconnectionTimer = setTimeout(() => {
            console.log(`Reconnection attempt ${this.reconnectionAttempts}`);
            this.connect();
        }, delay);
    }
    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.socket && this.socket.connected) {
                this.socket.emit('heartbeat');
            }
        }, this.config.heartbeatInterval);
    }
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
    handlePlaylistActivated(playlist) {
        if (playlist) {
            // Use synchronizer to handle playlist caching and updates
            this.playlistSynchronizer.cachePlaylist(playlist);
            this.clientState.currentPlaylist = playlist;
            this.clientState.currentItemIndex = 0;
            this.startPlayback();
        }
        else {
            this.clientState.currentPlaylist = undefined;
            this.stopPlayback();
            this.showDefaultScreen();
        }
        this.updateDebugInfo();
    }
    handlePlaylistUpdated(playlist) {
        if (this.clientState.currentPlaylist && this.clientState.currentPlaylist.id === playlist.id) {
            // Create a playlist update object for the synchronizer
            const update = {
                type: 'full',
                playlist: playlist,
                timestamp: new Date(),
                version: 1 // Version will be calculated by synchronizer
            };
            // Handle the update through the synchronizer
            this.playlistSynchronizer.handlePlaylistUpdate(update);
        }
    }
    handlePlaylistDeltaUpdate(update) {
        // Handle delta updates through the synchronizer
        this.playlistSynchronizer.handlePlaylistUpdate(update);
    }
    startPlayback() {
        if (!this.clientState.currentPlaylist || !this.clientState.currentPlaylist.items) {
            this.showDefaultScreen();
            return;
        }
        // Use the playback engine to handle playback
        this.playbackEngine.setPlaylist(this.clientState.currentPlaylist);
        this.playbackEngine.play();
        this.clientState.playbackState = 'playing';
    }
    stopPlayback() {
        this.playbackEngine.stop();
        this.clientState.playbackState = 'stopped';
        this.showDefaultScreen();
    }
    showDefaultScreen() {
        this.defaultScreen.style.display = 'flex';
        this.loadingMessage.textContent = 'Waiting for playlist...';
    }
    // Load cached playlist using synchronizer
    loadCachedPlaylist() {
        // Check if we have any cached playlists
        const cacheInfo = this.playlistSynchronizer.getCacheInfo();
        if (cacheInfo.length > 0) {
            console.log(`Found ${cacheInfo.length} cached playlists`);
            this.cacheStatusSpan.textContent = `${cacheInfo.length} Cached`;
        }
        else {
            this.cacheStatusSpan.textContent = 'No Cache';
        }
    }
    tryPlayCachedPlaylist() {
        // Try to find the most recently cached playlist
        const cacheInfo = this.playlistSynchronizer.getCacheInfo();
        if (cacheInfo.length > 0) {
            // Sort by cached date and get the most recent
            const mostRecent = cacheInfo.sort((a, b) => b.cachedAt.getTime() - a.cachedAt.getTime())[0];
            const cachedPlaylist = this.playlistSynchronizer.getCachedPlaylist(mostRecent.playlistId);
            if (cachedPlaylist) {
                console.log('Using cached playlist for offline playback:', cachedPlaylist.name);
                this.handlePlaylistActivated(cachedPlaylist);
                this.loadingMessage.textContent = 'Playing cached playlist (offline mode)';
                return;
            }
        }
        this.loadingMessage.textContent = 'No cached playlist available';
    }
    updateDebugInfo() {
        const playlist = this.clientState.currentPlaylist;
        this.currentPlaylistSpan.textContent = playlist ? `${playlist.name} (${playlist.items?.length || 0} items)` : 'None';
        this.currentItemSpan.textContent = playlist && playlist.items ?
            `${this.clientState.currentItemIndex + 1}/${playlist.items.length}` : '-';
    }
    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (event) => {
            switch (event.key) {
                case 'F11':
                    event.preventDefault();
                    this.toggleFullscreen();
                    break;
                case 'd':
                case 'D':
                    if (event.ctrlKey) {
                        event.preventDefault();
                        this.toggleDebugInfo();
                    }
                    break;
                case 'r':
                case 'R':
                    if (event.ctrlKey) {
                        event.preventDefault();
                        this.reconnect();
                    }
                    break;
                case 'n':
                case 'N':
                    if (event.ctrlKey) {
                        event.preventDefault();
                        this.playbackEngine.next();
                    }
                    break;
                case 'p':
                case 'P':
                    if (event.ctrlKey) {
                        event.preventDefault();
                        this.playbackEngine.previous();
                    }
                    break;
                case ' ':
                    event.preventDefault();
                    if (this.playbackEngine.isPlaying()) {
                        this.playbackEngine.pause();
                    }
                    else {
                        this.playbackEngine.play();
                    }
                    break;
            }
        });
    }
    toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(err => {
                console.error('Failed to enter fullscreen:', err);
            });
        }
        else {
            document.exitFullscreen().catch(err => {
                console.error('Failed to exit fullscreen:', err);
            });
        }
    }
    toggleDebugInfo() {
        const isVisible = this.debugInfo.style.display !== 'none';
        this.debugInfo.style.display = isVisible ? 'none' : 'block';
    }
    reconnect() {
        console.log('Manual reconnection requested');
        this.reconnectionAttempts = 0;
        if (this.socket) {
            this.socket.disconnect();
        }
        setTimeout(() => {
            this.connect();
        }, 1000);
    }
    // Public methods for external control
    getClientState() {
        return { ...this.clientState };
    }
    getCurrentPlaylist() {
        return this.clientState.currentPlaylist;
    }
    isConnected() {
        return this.clientState.connectionStatus === 'connected';
    }
    shutdown() {
        console.log('Shutting down client');
        this.stopHeartbeat();
        this.stopPlayback();
        if (this.reconnectionTimer) {
            clearTimeout(this.reconnectionTimer);
        }
        if (this.socket) {
            this.socket.disconnect();
        }
        // Shutdown the playlist synchronizer
        this.playlistSynchronizer.shutdown();
    }
}
// Initialize client when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    console.log('Initializing Media Playlist Client');
    const client = new MediaPlaylistClient();
    // Make client available globally for debugging
    window.mediaClient = client;
    // Handle page unload
    window.addEventListener('beforeunload', () => {
        client.shutdown();
    });
});
export default MediaPlaylistClient;
//# sourceMappingURL=client.js.map