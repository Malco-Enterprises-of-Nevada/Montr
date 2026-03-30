// ===== Montr Web UI Application =====

// Configuration
const API_BASE = window.location.origin + '/api';
const WS_URL = `ws://${window.location.host}/ws`;

// State management
const state = {
    currentView: 'dashboard',
    media: [],
    playlists: [],
    clients: [],
    currentPlaylist: null,
    stats: {
        mediaCount: 0,
        playlistCount: 0,
        clientCount: 0,
        onlineCount: 0
    }
};

// ===== Utility Functions =====

// Show toast notification
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast show ${type}`;

    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// Format file size
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

// Format duration
function formatDuration(seconds) {
    if (!seconds) return 'N/A';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Format date
function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
}

// Format relative time
function formatRelativeTime(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
}

// Show/hide loading
function showLoading(show = true) {
    const loader = document.getElementById('globalLoader');
    loader.style.display = show ? 'flex' : 'none';
}

// ===== API Functions =====

// Generic API call
async function apiCall(endpoint, options = {}) {
    try {
        const response = await fetch(API_BASE + endpoint, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error?.message || 'API request failed');
        }

        return data.data;
    } catch (error) {
        console.error('API Error:', error);
        throw error;
    }
}

// Health check
async function checkHealth() {
    try {
        const health = await apiCall('/health');
        updateHealthStatus(health);
        return health;
    } catch (error) {
        console.error('Health check failed:', error);
        return null;
    }
}

// Media API
const mediaAPI = {
    async list() {
        return await apiCall('/media');
    },

    async upload(file, onProgress) {
        const formData = new FormData();
        formData.append('files', file);

        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const percent = (e.loaded / e.total) * 100;
                    if (onProgress) onProgress(percent);
                }
            });

            xhr.addEventListener('load', () => {
                if (xhr.status === 200) {
                    const response = JSON.parse(xhr.responseText);
                    resolve(response.data);
                } else {
                    reject(new Error('Upload failed'));
                }
            });

            xhr.addEventListener('error', () => {
                reject(new Error('Upload failed'));
            });

            xhr.open('POST', API_BASE + '/media/upload');
            xhr.send(formData);
        });
    },

    async delete(id) {
        return await apiCall(`/media/${id}`, { method: 'DELETE' });
    },

    async download(id) {
        window.open(API_BASE + `/media/${id}/download`, '_blank');
    }
};

// Playlist API
const playlistAPI = {
    async list() {
        return await apiCall('/playlists');
    },

    async get(id) {
        return await apiCall(`/playlists/${id}`);
    },

    async create(data) {
        return await apiCall('/playlists', {
            method: 'POST',
            body: JSON.stringify(data)
        });
    },

    async update(id, data) {
        return await apiCall(`/playlists/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    },

    async delete(id) {
        return await apiCall(`/playlists/${id}`, { method: 'DELETE' });
    },

    async addItem(playlistId, mediaId, imageDuration = 5) {
        return await apiCall(`/playlists/${playlistId}/items`, {
            method: 'POST',
            body: JSON.stringify({ mediaId, imageDuration })
        });
    },

    async removeItem(playlistId, itemId) {
        return await apiCall(`/playlists/${playlistId}/items/${itemId}`, {
            method: 'DELETE'
        });
    },

    async reorderItems(playlistId, itemIds) {
        return await apiCall(`/playlists/${playlistId}/items/reorder`, {
            method: 'PUT',
            body: JSON.stringify({ itemIds })
        });
    }
};

// Client API
const clientAPI = {
    async list() {
        return await apiCall('/clients');
    },

    async get(id) {
        return await apiCall(`/clients/${id}`);
    },

    async update(id, data) {
        return await apiCall(`/clients/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    },

    async assignPlaylist(clientId, playlistId) {
        return await apiCall(`/clients/${clientId}/playlist`, {
            method: 'PUT',
            body: JSON.stringify({ playlistId })
        });
    }
};

// ===== Navigation =====

function initNavigation() {
    const navLinks = document.querySelectorAll('.nav-link');
    const navToggle = document.getElementById('navToggle');
    const navMenu = document.getElementById('navMenu');

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            const page = link.dataset.page;
            navigateTo(page);

            // Close mobile menu
            navMenu.classList.remove('active');
        });
    });

    navToggle.addEventListener('click', () => {
        navMenu.classList.toggle('active');
    });
}

function navigateTo(view) {
    // Update nav links
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.toggle('active', link.dataset.page === view);
    });

    // Update views
    document.querySelectorAll('.view').forEach(v => {
        v.classList.toggle('active', v.id === `${view}-view`);
    });

    state.currentView = view;

    // Load data for the view
    switch(view) {
        case 'dashboard':
            loadDashboard();
            break;
        case 'media':
            loadMedia();
            break;
        case 'playlists':
            loadPlaylists();
            break;
        case 'clients':
            loadClients();
            break;
    }
}

// ===== Dashboard View =====

async function loadDashboard() {
    try {
        const [health, media, playlists, clients] = await Promise.all([
            checkHealth(),
            mediaAPI.list(),
            playlistAPI.list(),
            clientAPI.list()
        ]);

        state.media = media || [];
        state.playlists = playlists || [];
        state.clients = clients || [];

        updateDashboardStats();
        updateHealthStatus(health);
    } catch (error) {
        console.error('Failed to load dashboard:', error);
        showToast('Failed to load dashboard data', 'error');
    }
}

function updateDashboardStats() {
    const onlineClients = state.clients.filter(c => c.status === 'online').length;

    document.getElementById('stat-media-count').textContent = state.media.length;
    document.getElementById('stat-playlist-count').textContent = state.playlists.length;
    document.getElementById('stat-client-count').textContent = state.clients.length;
    document.getElementById('stat-online-count').textContent = onlineClients;

    state.stats = {
        mediaCount: state.media.length,
        playlistCount: state.playlists.length,
        clientCount: state.clients.length,
        onlineCount: onlineClients
    };
}

function updateHealthStatus(health) {
    if (!health) return;

    document.getElementById('server-status').textContent = health.status === 'ok' ? 'Running' : 'Error';
    document.getElementById('server-status').className = `badge badge-${health.status === 'ok' ? 'success' : 'danger'}`;

    document.getElementById('db-status').textContent = 'Connected';
    document.getElementById('db-status').className = 'badge badge-success';

    const wsActive = health.websocket?.connections >= 0;
    document.getElementById('ws-status').textContent = wsActive ? 'Active' : 'Inactive';
    document.getElementById('ws-status').className = `badge badge-${wsActive ? 'success' : 'danger'}`;

    if (health.uptime) {
        const uptime = Math.floor(health.uptime);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = uptime % 60;
        document.getElementById('server-uptime').textContent =
            hours > 0 ? `${hours}h ${minutes}m ${seconds}s` :
            minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
    }
}

// ===== Media View =====

async function loadMedia() {
    const gridEl = document.getElementById('mediaGrid');
    const emptyEl = document.getElementById('mediaEmpty');

    gridEl.innerHTML = '<div class="loading">Loading media files...</div>';
    emptyEl.style.display = 'none';

    try {
        const response = await mediaAPI.list();
        const media = response?.data || [];
        state.media = media;
        renderMediaGrid(media);
    } catch (error) {
        console.error('Failed to load media:', error);
        showToast('Failed to load media files', 'error');
        gridEl.innerHTML = '<div class="empty-state"><p>Failed to load media files</p></div>';
    }
}

function renderMediaGrid(media) {
    const gridEl = document.getElementById('mediaGrid');
    const emptyEl = document.getElementById('mediaEmpty');

    if (!media || media.length === 0) {
        gridEl.innerHTML = '';
        emptyEl.style.display = 'block';
        return;
    }

    emptyEl.style.display = 'none';

    gridEl.innerHTML = media.map(item => `
        <div class="media-item" data-id="${item.id}">
            <div class="media-thumbnail">
                ${item.type === 'video' ? `
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                ` : `
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="3" width="18" height="18" rx="2"/>
                        <circle cx="8.5" cy="8.5" r="1.5"/>
                        <path d="M21 15l-5-5L5 21"/>
                    </svg>
                `}
            </div>
            <div class="media-info">
                <div class="media-name" title="${item.filename}">${item.filename}</div>
                <div class="media-meta">
                    <span class="badge badge-info">${item.type}</span>
                    <span>${item.duration ? formatDuration(item.duration) : 'N/A'}</span>
                </div>
            </div>
            <div class="media-actions">
                <button class="btn btn-sm btn-secondary" onclick="handleMediaDownload('${item.id}')">
                    Download
                </button>
                <button class="btn btn-sm btn-danger" onclick="handleMediaDelete('${item.id}')">
                    Delete
                </button>
            </div>
        </div>
    `).join('');
}

function initMediaSearch() {
    const searchInput = document.getElementById('mediaSearch');
    const typeFilter = document.getElementById('mediaTypeFilter');

    searchInput.addEventListener('input', filterMedia);
    typeFilter.addEventListener('change', filterMedia);
}

function filterMedia() {
    const searchTerm = document.getElementById('mediaSearch').value.toLowerCase();
    const typeFilter = document.getElementById('mediaTypeFilter').value;

    const filtered = state.media.filter(item => {
        const matchesSearch = item.filename.toLowerCase().includes(searchTerm);
        const matchesType = typeFilter === 'all' || item.type === typeFilter;
        return matchesSearch && matchesType;
    });

    renderMediaGrid(filtered);
}

// ===== Media Upload =====

function initMediaUpload() {
    const uploadBtn = document.getElementById('uploadBtn');
    const uploadModal = document.getElementById('uploadModal');
    const closeModalBtn = document.getElementById('closeUploadModal');
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('fileInput');
    const browseBtn = document.getElementById('browseBtn');

    console.log('initMediaUpload:', { uploadBtn, uploadModal, closeModalBtn, uploadZone, fileInput, browseBtn });

    uploadBtn.addEventListener('click', () => {
        console.log('Upload button clicked!');
        openModal('uploadModal');
    });
    closeModalBtn.addEventListener('click', () => closeModal('uploadModal'));
    browseBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
        handleFileSelection(e.target.files);
    });

    // Drag and drop
    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.classList.add('dragover');
    });

    uploadZone.addEventListener('dragleave', () => {
        uploadZone.classList.remove('dragover');
    });

    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('dragover');
        handleFileSelection(e.dataTransfer.files);
    });
}

async function handleFileSelection(files) {
    if (!files || files.length === 0) return;

    closeModal('uploadModal');

    for (const file of files) {
        await uploadFile(file);
    }

    loadMedia();
}

async function uploadFile(file) {
    const progressEl = document.getElementById('uploadProgress');
    const fileNameEl = document.getElementById('uploadFileName');
    const percentEl = document.getElementById('uploadPercent');
    const progressBar = document.getElementById('uploadProgressBar');

    progressEl.style.display = 'block';
    fileNameEl.textContent = `Uploading: ${file.name}`;

    try {
        await mediaAPI.upload(file, (percent) => {
            percentEl.textContent = `${Math.round(percent)}%`;
            progressBar.style.width = `${percent}%`;
        });

        showToast(`Successfully uploaded ${file.name}`, 'success');
    } catch (error) {
        console.error('Upload failed:', error);
        showToast(`Failed to upload ${file.name}`, 'error');
    } finally {
        setTimeout(() => {
            progressEl.style.display = 'none';
            progressBar.style.width = '0%';
        }, 1000);
    }
}

async function handleMediaDelete(id) {
    if (!confirm('Are you sure you want to delete this media file?')) return;

    try {
        await mediaAPI.delete(id);
        showToast('Media file deleted successfully', 'success');
        loadMedia();
    } catch (error) {
        console.error('Delete failed:', error);
        showToast('Failed to delete media file', 'error');
    }
}

function handleMediaDownload(id) {
    mediaAPI.download(id);
}

// ===== Playlists View =====

async function loadPlaylists() {
    const listEl = document.getElementById('playlistsList');
    const emptyEl = document.getElementById('playlistsEmpty');

    listEl.innerHTML = '<div class="loading">Loading playlists...</div>';
    emptyEl.style.display = 'none';

    try {
        const playlists = await playlistAPI.list();
        state.playlists = playlists || [];
        renderPlaylistsList(playlists || []);
    } catch (error) {
        console.error('Failed to load playlists:', error);
        showToast('Failed to load playlists', 'error');
        listEl.innerHTML = '<div class="empty-state"><p>Failed to load playlists</p></div>';
    }
}

function renderPlaylistsList(playlists) {
    const listEl = document.getElementById('playlistsList');
    const emptyEl = document.getElementById('playlistsEmpty');

    if (!playlists || playlists.length === 0) {
        listEl.innerHTML = '';
        emptyEl.style.display = 'block';
        return;
    }

    emptyEl.style.display = 'none';

    listEl.innerHTML = playlists.map(playlist => `
        <div class="playlist-card" onclick="openPlaylistDetail('${playlist.id}')">
            <div class="playlist-header">
                <h3 class="playlist-title">${playlist.name}</h3>
                <span class="badge badge-info">${playlist.itemCount || 0} items</span>
            </div>
            ${playlist.description ? `<p class="playlist-description">${playlist.description}</p>` : ''}
            <div class="playlist-footer">
                <span>Created: ${formatDate(playlist.createdAt)}</span>
                <span>Updated: ${formatRelativeTime(playlist.updatedAt)}</span>
            </div>
        </div>
    `).join('');
}

function initCreatePlaylist() {
    const createBtn = document.getElementById('createPlaylistBtn');
    const modal = document.getElementById('createPlaylistModal');
    const closeBtn = document.getElementById('closeCreatePlaylistModal');
    const cancelBtn = document.getElementById('cancelCreatePlaylist');
    const form = document.getElementById('createPlaylistForm');

    createBtn.addEventListener('click', () => openModal('createPlaylistModal'));
    closeBtn.addEventListener('click', () => closeModal('createPlaylistModal'));
    cancelBtn.addEventListener('click', () => closeModal('createPlaylistModal'));

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const formData = new FormData(form);
        const data = {
            name: formData.get('name'),
            description: formData.get('description') || undefined
        };

        try {
            await playlistAPI.create(data);
            showToast('Playlist created successfully', 'success');
            closeModal('createPlaylistModal');
            form.reset();
            loadPlaylists();
        } catch (error) {
            console.error('Failed to create playlist:', error);
            showToast('Failed to create playlist', 'error');
        }
    });
}

async function openPlaylistDetail(playlistId) {
    try {
        showLoading();
        const playlist = await playlistAPI.get(playlistId);
        state.currentPlaylist = playlist;

        document.getElementById('playlistDetailTitle').textContent = playlist.name;
        document.getElementById('playlistDetailDescription').textContent = playlist.description || 'No description';

        renderPlaylistItems(playlist.items || []);
        renderPlaylistMediaLibrary();

        openModal('playlistDetailModal');
    } catch (error) {
        console.error('Failed to load playlist:', error);
        showToast('Failed to load playlist details', 'error');
    } finally {
        showLoading(false);
    }
}

function renderPlaylistItems(items) {
    const container = document.getElementById('playlistItems');
    const countEl = document.getElementById('playlistItemCount');

    countEl.textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;

    if (!items || items.length === 0) {
        container.innerHTML = `
            <div class="empty-state-small">
                <p>No items in this playlist</p>
                <p class="text-muted">Add media files from the library</p>
            </div>
        `;
        return;
    }

    container.innerHTML = items.map((item, index) => `
        <div class="playlist-item" data-item-id="${item.id}">
            <span class="item-order">${index + 1}</span>
            <div class="item-thumbnail">
                ${item.media.type === 'video' ? `
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                ` : `
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="3" width="18" height="18" rx="2"/>
                        <circle cx="8.5" cy="8.5" r="1.5"/>
                        <path d="M21 15l-5-5L5 21"/>
                    </svg>
                `}
            </div>
            <div class="item-info">
                <div class="item-name">${item.media.filename}</div>
                <div class="item-meta">
                    ${item.media.type} • ${item.media.duration ? formatDuration(item.media.duration) :
                        `${item.imageDuration || 5}s`}
                </div>
            </div>
            <div class="item-controls">
                ${index > 0 ? `<button class="btn btn-sm btn-secondary" onclick="moveItemUp(${index})">↑</button>` : ''}
                ${index < items.length - 1 ? `<button class="btn btn-sm btn-secondary" onclick="moveItemDown(${index})">↓</button>` : ''}
                <button class="btn btn-sm btn-danger" onclick="removePlaylistItem('${item.id}')">×</button>
            </div>
        </div>
    `).join('');
}

function renderPlaylistMediaLibrary() {
    const container = document.getElementById('playlistMediaLibrary');
    const searchInput = document.getElementById('playlistMediaSearch');

    searchInput.addEventListener('input', (e) => {
        const term = e.target.value.toLowerCase();
        const filtered = state.media.filter(m =>
            m.filename.toLowerCase().includes(term)
        );
        renderMediaLibraryItems(filtered);
    });

    renderMediaLibraryItems(state.media);
}

function renderMediaLibraryItems(media) {
    const container = document.getElementById('playlistMediaLibrary');

    if (!media || media.length === 0) {
        container.innerHTML = '<div class="loading">No media files available</div>';
        return;
    }

    container.innerHTML = media.map(item => `
        <div class="playlist-media-item" onclick="addToPlaylist('${item.id}')">
            <div class="playlist-media-thumb">
                ${item.type === 'video' ? `
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                ` : `
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="3" width="18" height="18" rx="2"/>
                        <circle cx="8.5" cy="8.5" r="1.5"/>
                        <path d="M21 15l-5-5L5 21"/>
                    </svg>
                `}
            </div>
            <div class="playlist-media-name" title="${item.filename}">${item.filename}</div>
        </div>
    `).join('');
}

async function addToPlaylist(mediaId) {
    if (!state.currentPlaylist) return;

    try {
        await playlistAPI.addItem(state.currentPlaylist.id, mediaId);
        showToast('Item added to playlist', 'success');

        // Reload playlist details
        const playlist = await playlistAPI.get(state.currentPlaylist.id);
        state.currentPlaylist = playlist;
        renderPlaylistItems(playlist.items || []);
    } catch (error) {
        console.error('Failed to add item:', error);
        showToast('Failed to add item to playlist', 'error');
    }
}

async function removePlaylistItem(itemId) {
    if (!state.currentPlaylist) return;

    try {
        await playlistAPI.removeItem(state.currentPlaylist.id, itemId);
        showToast('Item removed from playlist', 'success');

        // Reload playlist details
        const playlist = await playlistAPI.get(state.currentPlaylist.id);
        state.currentPlaylist = playlist;
        renderPlaylistItems(playlist.items || []);
    } catch (error) {
        console.error('Failed to remove item:', error);
        showToast('Failed to remove item', 'error');
    }
}

async function moveItemUp(index) {
    if (!state.currentPlaylist || !state.currentPlaylist.items) return;

    const items = [...state.currentPlaylist.items];
    if (index > 0) {
        [items[index], items[index - 1]] = [items[index - 1], items[index]];
        await reorderPlaylistItems(items);
    }
}

async function moveItemDown(index) {
    if (!state.currentPlaylist || !state.currentPlaylist.items) return;

    const items = [...state.currentPlaylist.items];
    if (index < items.length - 1) {
        [items[index], items[index + 1]] = [items[index + 1], items[index]];
        await reorderPlaylistItems(items);
    }
}

async function reorderPlaylistItems(items) {
    try {
        const itemIds = items.map(item => item.id);
        await playlistAPI.reorderItems(state.currentPlaylist.id, itemIds);

        // Update local state
        state.currentPlaylist.items = items;
        renderPlaylistItems(items);
        showToast('Playlist reordered', 'success');
    } catch (error) {
        console.error('Failed to reorder items:', error);
        showToast('Failed to reorder items', 'error');
    }
}

function initPlaylistDetailModal() {
    const closeBtn = document.getElementById('closePlaylistDetailModal');
    const closeBtn2 = document.getElementById('closePlaylistDetail');
    const deleteBtn = document.getElementById('deletePlaylistBtn');

    closeBtn.addEventListener('click', () => closeModal('playlistDetailModal'));
    closeBtn2.addEventListener('click', () => closeModal('playlistDetailModal'));

    deleteBtn.addEventListener('click', async () => {
        if (!state.currentPlaylist) return;

        if (!confirm(`Are you sure you want to delete the playlist "${state.currentPlaylist.name}"?`)) {
            return;
        }

        try {
            await playlistAPI.delete(state.currentPlaylist.id);
            showToast('Playlist deleted successfully', 'success');
            closeModal('playlistDetailModal');
            loadPlaylists();
        } catch (error) {
            console.error('Failed to delete playlist:', error);
            showToast('Failed to delete playlist', 'error');
        }
    });
}

// ===== Clients View =====

async function loadClients() {
    const gridEl = document.getElementById('clientsGrid');
    const emptyEl = document.getElementById('clientsEmpty');

    gridEl.innerHTML = '<div class="loading">Loading clients...</div>';
    emptyEl.style.display = 'none';

    try {
        const clients = await clientAPI.list();
        state.clients = clients || [];
        renderClientsGrid(clients || []);
        updateClientStats(clients || []);
    } catch (error) {
        console.error('Failed to load clients:', error);
        showToast('Failed to load clients', 'error');
        gridEl.innerHTML = '<div class="empty-state"><p>Failed to load clients</p></div>';
    }
}

function updateClientStats(clients) {
    const total = clients.length;
    const online = clients.filter(c => c.status === 'online').length;
    const idle = clients.filter(c => c.status === 'idle').length;
    const offline = total - online - idle;

    document.getElementById('clients-total').textContent = total;
    document.getElementById('clients-online').textContent = online;
    document.getElementById('clients-idle').textContent = idle;
    document.getElementById('clients-offline').textContent = offline;
}

function renderClientsGrid(clients) {
    const gridEl = document.getElementById('clientsGrid');
    const emptyEl = document.getElementById('clientsEmpty');

    if (!clients || clients.length === 0) {
        gridEl.innerHTML = '';
        emptyEl.style.display = 'block';
        return;
    }

    emptyEl.style.display = 'none';

    gridEl.innerHTML = clients.map(client => {
        const statusClass = client.status || 'offline';
        const assignedPlaylist = state.playlists.find(p => p.id === client.assignedPlaylistId);

        return `
            <div class="client-card">
                <div class="client-header">
                    <h3 class="client-name">${client.name || client.id}</h3>
                    <div class="client-status">
                        <span class="status-indicator ${statusClass}"></span>
                        <span>${statusClass}</span>
                    </div>
                </div>
                <div class="client-info">
                    <div class="info-row">
                        <span class="info-label">Client ID:</span>
                        <span>${client.id.substring(0, 8)}...</span>
                    </div>
                    <div class="info-row">
                        <span class="info-label">Playlist:</span>
                        <span>${assignedPlaylist ? assignedPlaylist.name : 'None'}</span>
                    </div>
                    <div class="info-row">
                        <span class="info-label">Last Seen:</span>
                        <span>${client.lastSeen ? formatRelativeTime(client.lastSeen) : 'Never'}</span>
                    </div>
                </div>
                <div class="client-actions">
                    <button class="btn btn-sm btn-primary" onclick="openAssignPlaylistModal('${client.id}', '${client.name || client.id}')">
                        Assign Playlist
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function initRefreshClients() {
    const refreshBtn = document.getElementById('refreshClientsBtn');
    refreshBtn.addEventListener('click', loadClients);
}

function openAssignPlaylistModal(clientId, clientName) {
    const modal = document.getElementById('assignPlaylistModal');
    const nameEl = document.getElementById('assignClientName');
    const selectEl = document.getElementById('assignPlaylistSelect');

    nameEl.textContent = clientName;

    // Populate playlist options
    selectEl.innerHTML = '<option value="">-- Select Playlist --</option>' +
        state.playlists.map(p =>
            `<option value="${p.id}">${p.name}</option>`
        ).join('');

    // Store client ID for form submission
    selectEl.dataset.clientId = clientId;

    openModal('assignPlaylistModal');
}

function initAssignPlaylistModal() {
    const closeBtn = document.getElementById('closeAssignPlaylistModal');
    const cancelBtn = document.getElementById('cancelAssignPlaylist');
    const form = document.getElementById('assignPlaylistForm');

    closeBtn.addEventListener('click', () => closeModal('assignPlaylistModal'));
    cancelBtn.addEventListener('click', () => closeModal('assignPlaylistModal'));

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const selectEl = document.getElementById('assignPlaylistSelect');
        const clientId = selectEl.dataset.clientId;
        const playlistId = selectEl.value;

        if (!playlistId) {
            showToast('Please select a playlist', 'warning');
            return;
        }

        try {
            await clientAPI.assignPlaylist(clientId, playlistId);
            showToast('Playlist assigned successfully', 'success');
            closeModal('assignPlaylistModal');
            loadClients();
        } catch (error) {
            console.error('Failed to assign playlist:', error);
            showToast('Failed to assign playlist', 'error');
        }
    });
}

// ===== Modal Management =====

function openModal(modalId) {
    console.log('openModal called for:', modalId);
    const modal = document.getElementById(modalId);
    console.log('Modal element:', modal);
    if (modal) {
        modal.classList.add('active');
        console.log('Modal opened, classList:', modal.classList.toString());
    } else {
        console.error('Modal not found:', modalId);
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    modal.classList.remove('active');
}

// Close modal when clicking outside
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
        e.target.classList.remove('active');
    }
});

// ===== Initialization =====

async function init() {
    console.log('Initializing Montr Web UI...');

    // Initialize navigation
    initNavigation();

    // Initialize media functionality
    initMediaSearch();
    initMediaUpload();

    // Initialize playlist functionality
    initCreatePlaylist();
    initPlaylistDetailModal();

    // Initialize client functionality
    initRefreshClients();
    initAssignPlaylistModal();

    // Load initial view
    loadDashboard();

    // TODO: This 30s refresh interval and the 3s toast timeout (line 32) are hardcoded.
    // Consider making UI refresh intervals configurable or at least defined as constants.
    // Auto-refresh dashboard every 30 seconds
    setInterval(() => {
        if (state.currentView === 'dashboard') {
            checkHealth();
        }
    }, 30000);

    console.log('Montr Web UI initialized successfully');
}

// Start the application when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
