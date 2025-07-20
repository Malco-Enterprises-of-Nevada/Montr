/**
 * WebSocket Client for Real-time Communication
 * Handles WebSocket connection and real-time updates
 */
class WebSocketClient {
    constructor() {
        this.socket = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000; // Start with 1 second
        this.maxReconnectDelay = 30000; // Max 30 seconds
        this.eventHandlers = new Map();
        
        // Connection status elements
        this.connectionIndicator = document.getElementById('connection-indicator');
        this.connectionText = document.getElementById('connection-text');
        this.websocketStatus = document.getElementById('websocket-status');
    }

    /**
     * Initialize WebSocket connection
     */
    connect() {
        try {
            // Initialize Socket.IO connection
            this.socket = io({
                transports: ['websocket', 'polling'],
                upgrade: true,
                rememberUpgrade: true
            });

            this.setupEventHandlers();
            this.updateConnectionStatus('connecting');
            
        } catch (error) {
            console.error('Failed to initialize WebSocket connection:', error);
            this.updateConnectionStatus('disconnected');
        }
    }

    /**
     * Set up Socket.IO event handlers
     */
    setupEventHandlers() {
        if (!this.socket) return;

        // Connection events
        this.socket.on('connect', () => {
            console.log('WebSocket connected');
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.reconnectDelay = 1000;
            this.updateConnectionStatus('connected');
            this.emit('connected');
        });

        this.socket.on('disconnect', (reason) => {
            console.log('WebSocket disconnected:', reason);
            this.isConnected = false;
            this.updateConnectionStatus('disconnected');
            this.emit('disconnected', reason);
            
            // Attempt to reconnect if not manually disconnected
            if (reason !== 'io client disconnect') {
                this.scheduleReconnect();
            }
        });

        this.socket.on('connect_error', (error) => {
            console.error('WebSocket connection error:', error);
            this.updateConnectionStatus('disconnected');
            this.emit('connection_error', error);
            this.scheduleReconnect();
        });

        // Application-specific events
        this.socket.on('playlist-activated', (data) => {
            console.log('Playlist activated:', data);
            this.emit('playlist-activated', data);
        });

        this.socket.on('playlist-updated', (data) => {
            console.log('Playlist updated:', data);
            this.emit('playlist-updated', data);
        });

        this.socket.on('client-connected', (data) => {
            console.log('Client connected:', data);
            this.emit('client-connected', data);
        });

        this.socket.on('client-disconnected', (data) => {
            console.log('Client disconnected:', data);
            this.emit('client-disconnected', data);
        });

        this.socket.on('client-list-updated', (clients) => {
            console.log('Client list updated:', clients);
            this.emit('client-list-updated', clients);
        });

        // Heartbeat/ping events
        this.socket.on('pong', (latency) => {
            this.emit('pong', latency);
        });
    }

    /**
     * Schedule reconnection attempt
     */
    scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error('Max reconnection attempts reached');
            this.updateConnectionStatus('disconnected');
            return;
        }

        this.reconnectAttempts++;
        this.updateConnectionStatus('connecting');
        
        console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${this.reconnectDelay}ms`);
        
        setTimeout(() => {
            if (!this.isConnected && this.socket) {
                this.socket.connect();
            }
        }, this.reconnectDelay);

        // Exponential backoff with jitter
        this.reconnectDelay = Math.min(
            this.reconnectDelay * 2 + Math.random() * 1000,
            this.maxReconnectDelay
        );
    }

    /**
     * Update connection status UI
     */
    updateConnectionStatus(status) {
        const statusMap = {
            connected: {
                indicator: 'connected',
                text: 'Connected',
                websocket: 'Connected'
            },
            connecting: {
                indicator: 'connecting',
                text: 'Connecting...',
                websocket: 'Connecting...'
            },
            disconnected: {
                indicator: 'disconnected',
                text: 'Disconnected',
                websocket: 'Disconnected'
            }
        };

        const config = statusMap[status] || statusMap.disconnected;

        if (this.connectionIndicator) {
            this.connectionIndicator.className = `status-indicator ${config.indicator}`;
        }

        if (this.connectionText) {
            this.connectionText.textContent = config.text;
        }

        if (this.websocketStatus) {
            this.websocketStatus.textContent = config.websocket;
            this.websocketStatus.className = `status-value ${config.indicator}`;
        }
    }

    /**
     * Send message to server
     */
    send(event, data = null) {
        if (this.socket && this.isConnected) {
            this.socket.emit(event, data);
            return true;
        } else {
            console.warn('Cannot send message: WebSocket not connected');
            return false;
        }
    }

    /**
     * Register event handler
     */
    on(event, handler) {
        if (!this.eventHandlers.has(event)) {
            this.eventHandlers.set(event, []);
        }
        this.eventHandlers.get(event).push(handler);
    }

    /**
     * Remove event handler
     */
    off(event, handler) {
        if (this.eventHandlers.has(event)) {
            const handlers = this.eventHandlers.get(event);
            const index = handlers.indexOf(handler);
            if (index > -1) {
                handlers.splice(index, 1);
            }
        }
    }

    /**
     * Emit event to registered handlers
     */
    emit(event, data = null) {
        if (this.eventHandlers.has(event)) {
            this.eventHandlers.get(event).forEach(handler => {
                try {
                    handler(data);
                } catch (error) {
                    console.error(`Error in event handler for ${event}:`, error);
                }
            });
        }
    }

    /**
     * Send heartbeat/ping
     */
    ping() {
        if (this.socket && this.isConnected) {
            this.socket.emit('ping');
        }
    }

    /**
     * Disconnect WebSocket
     */
    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
        this.isConnected = false;
        this.updateConnectionStatus('disconnected');
    }

    /**
     * Get connection status
     */
    getConnectionStatus() {
        return {
            connected: this.isConnected,
            reconnectAttempts: this.reconnectAttempts,
            maxReconnectAttempts: this.maxReconnectAttempts
        };
    }

    /**
     * Force reconnection
     */
    forceReconnect() {
        if (this.socket) {
            this.reconnectAttempts = 0;
            this.reconnectDelay = 1000;
            this.socket.disconnect();
            setTimeout(() => {
                this.socket.connect();
            }, 100);
        }
    }
}

// Create global WebSocket client instance
window.wsClient = new WebSocketClient();