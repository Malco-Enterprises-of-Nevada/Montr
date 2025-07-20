// Media Playlist Client Application
// Socket.IO is loaded via script tag in HTML
class MediaPlaylistClient {
    constructor() {
        this.socket = null;
        this.heartbeatTimer = null;
        this.reconnectionTimer = null;
        this.currentMediaTimeout = null;
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
        // Set initial client ID
        this.clientIdSpan.textContent = this.clientState.id;
        // Setup video player events
        this.videoPlayer.addEventListener('ended', () => this.onMediaEnded());
        this.videoPlayer.addEventListener('error', (e) => this.onMediaError(e));
        this.videoPlayer.addEventListener('loadstart', () => this.onMediaLoadStart());
        this.videoPlayer.addEventListener('canplay', () => this.onMediaCanPlay());
        // Setup image player events
        this.imagePlayer.addEventListener('error', (e) => this.onMediaError(e));
        this.imagePlayer.addEventListener('load', () => this.onImageLoaded());
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
        this.socket.on('heartbeat-response', () => {
            this.clientState.lastHeartbeat = new Date();
        });
    }
    updateConnectionStatus(status) {
        this.clientState.connectionStatus = status;
        this.statusText.textContent = status.charAt(0).toUpperCase() + status.slice(1);
        this.statusDot.className = `status-dot ${status}`;
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
            this.clientState.currentPlaylist = playlist;
            this.clientState.currentItemIndex = 0;
            this.cachePlaylist(playlist);
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
            this.clientState.currentPlaylist = playlist;
            this.cachePlaylist(playlist);
            // Continue playing current item, but update for next transitions
            this.updateDebugInfo();
        }
    }
    startPlayback() {
        if (!this.clientState.currentPlaylist || !this.clientState.currentPlaylist.items) {
            this.showDefaultScreen();
            return;
        }
        this.clientState.playbackState = 'playing';
        this.playCurrentItem();
    }
    stopPlayback() {
        this.clientState.playbackState = 'stopped';
        this.hideAllPlayers();
        if (this.currentMediaTimeout) {
            clearTimeout(this.currentMediaTimeout);
            this.currentMediaTimeout = null;
        }
    }
    playCurrentItem() {
        const playlist = this.clientState.currentPlaylist;
        if (!playlist || !playlist.items || playlist.items.length === 0) {
            this.showDefaultScreen();
            return;
        }
        const currentItem = playlist.items[this.clientState.currentItemIndex];
        if (!currentItem || !currentItem.media_file) {
            this.advanceToNextItem();
            return;
        }
        const mediaFile = currentItem.media_file;
        const mediaUrl = `/uploads/${mediaFile.file_type}s/${mediaFile.filename}`;
        console.log(`Playing item ${this.clientState.currentItemIndex + 1}/${playlist.items.length}:`, mediaFile.original_name);
        if (mediaFile.file_type === 'video') {
            this.playVideo(mediaUrl, mediaFile);
        }
        else if (mediaFile.file_type === 'image') {
            this.playImage(mediaUrl, mediaFile, currentItem.display_duration);
        }
        this.updateDebugInfo();
    }
    playVideo(url, mediaFile) {
        this.hideAllPlayers();
        this.videoPlayer.src = url;
        this.videoPlayer.style.display = 'block';
        this.videoPlayer.load();
    }
    playImage(url, mediaFile, displayDuration) {
        this.hideAllPlayers();
        this.imagePlayer.src = url;
        this.imagePlayer.style.display = 'block';
        // Use display duration from playlist item, or default duration, or 5 seconds
        const duration = (displayDuration || mediaFile.duration || 5) * 1000;
        this.currentMediaTimeout = setTimeout(() => {
            this.onMediaEnded();
        }, duration);
    }
    hideAllPlayers() {
        this.videoPlayer.style.display = 'none';
        this.imagePlayer.style.display = 'none';
        this.defaultScreen.style.display = 'none';
        // Stop video if playing
        if (!this.videoPlayer.paused) {
            this.videoPlayer.pause();
        }
        // Clear any image timeout
        if (this.currentMediaTimeout) {
            clearTimeout(this.currentMediaTimeout);
            this.currentMediaTimeout = null;
        }
    }
    showDefaultScreen() {
        this.hideAllPlayers();
        this.defaultScreen.style.display = 'flex';
        this.loadingMessage.textContent = 'Waiting for playlist...';
    }
    onMediaEnded() {
        console.log('Media ended, advancing to next item');
        this.advanceToNextItem();
    }
    onMediaError(event) {
        console.error('Media playback error:', event);
        // Skip to next item on error
        this.advanceToNextItem();
    }
    onMediaLoadStart() {
        console.log('Video loading started');
    }
    onMediaCanPlay() {
        console.log('Video can play');
        this.videoPlayer.play().catch(error => {
            console.error('Video play failed:', error);
            this.advanceToNextItem();
        });
    }
    onImageLoaded() {
        console.log('Image loaded successfully');
    }
    advanceToNextItem() {
        const playlist = this.clientState.currentPlaylist;
        if (!playlist || !playlist.items || playlist.items.length === 0) {
            this.showDefaultScreen();
            return;
        }
        this.clientState.currentItemIndex++;
        // Loop back to beginning if at end
        if (this.clientState.currentItemIndex >= playlist.items.length) {
            this.clientState.currentItemIndex = 0;
        }
        // Small delay before playing next item
        setTimeout(() => {
            this.playCurrentItem();
        }, 500);
    }
    // Offline playlist caching
    cachePlaylist(playlist) {
        try {
            const cacheData = {
                playlist,
                cachedAt: new Date().toISOString()
            };
            localStorage.setItem('cached_playlist', JSON.stringify(cacheData));
            this.cacheStatusSpan.textContent = 'Cached';
            console.log('Playlist cached successfully');
        }
        catch (error) {
            console.error('Failed to cache playlist:', error);
            this.cacheStatusSpan.textContent = 'Cache Failed';
        }
    }
    loadCachedPlaylist() {
        try {
            const cachedData = localStorage.getItem('cached_playlist');
            if (cachedData) {
                const { playlist, cachedAt } = JSON.parse(cachedData);
                console.log('Loaded cached playlist from:', cachedAt);
                this.cacheStatusSpan.textContent = 'Loaded from Cache';
                return playlist;
            }
        }
        catch (error) {
            console.error('Failed to load cached playlist:', error);
        }
        this.cacheStatusSpan.textContent = 'No Cache';
        return null;
    }
    tryPlayCachedPlaylist() {
        const cachedPlaylist = this.loadCachedPlaylist();
        if (cachedPlaylist) {
            console.log('Using cached playlist for offline playback');
            this.handlePlaylistActivated(cachedPlaylist);
            this.loadingMessage.textContent = 'Playing cached playlist (offline mode)';
        }
        else {
            this.loadingMessage.textContent = 'No cached playlist available';
        }
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
                        this.advanceToNextItem();
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