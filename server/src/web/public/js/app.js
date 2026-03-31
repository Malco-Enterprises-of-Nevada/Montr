// ===== Montr Web UI Application =====

// Configuration
const API_BASE = window.location.origin + '/api';
const WS_URL = `ws://${window.location.host}/ws`;

// UI configuration (loaded from server, with fallback defaults)
let UI_CONFIG = {
    dashboardRefreshInterval: 30000,
    toastDisplayDuration: 3000,
};

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
    }, UI_CONFIG.toastDisplayDuration);
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

const groupsAPI = {
    async list() {
        return await apiCall('/groups');
    },

    async get(id) {
        return await apiCall(`/groups/${id}`);
    },

    async create(data) {
        return await apiCall('/groups', {
            method: 'POST',
            body: JSON.stringify(data)
        });
    },

    async update(id, data) {
        return await apiCall(`/groups/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    },

    async delete(id) {
        return await apiCall(`/groups/${id}`, { method: 'DELETE' });
    },

    async addMember(groupId, clientId) {
        return await apiCall(`/groups/${groupId}/members`, {
            method: 'POST',
            body: JSON.stringify({ clientId })
        });
    },

    async removeMember(groupId, clientId) {
        return await apiCall(`/groups/${groupId}/members/${clientId}`, { method: 'DELETE' });
    },

    async assignPlaylist(groupId, playlistId) {
        return await apiCall(`/groups/${groupId}/assign`, {
            method: 'POST',
            body: JSON.stringify({ playlistId })
        });
    }
};

const schedulesAPI = {
    async list() {
        return await apiCall('/schedules');
    },

    async get(id) {
        return await apiCall(`/schedules/${id}`);
    },

    async create(data) {
        return await apiCall('/schedules', {
            method: 'POST',
            body: JSON.stringify(data)
        });
    },

    async update(id, data) {
        return await apiCall(`/schedules/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    },

    async delete(id) {
        return await apiCall(`/schedules/${id}`, { method: 'DELETE' });
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
        case 'groups':
            loadGroups();
            break;
        case 'schedules':
            loadSchedules();
            break;
        case 'analytics':
            loadAnalytics();
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
        loadPreviews(clients || []);
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
                    <button class="btn btn-sm btn-secondary" onclick="openClientControl('${client.id}')">
                        Controls
                    </button>
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

// ===== Groups View =====

let currentGroupId = null;

async function loadGroups() {
    const gridEl = document.getElementById('groupsGrid');
    const emptyEl = document.getElementById('groupsEmpty');

    gridEl.innerHTML = '<div class="loading">Loading groups...</div>';
    emptyEl.style.display = 'none';

    try {
        const groups = await groupsAPI.list();

        if (groups.length === 0) {
            gridEl.innerHTML = '';
            emptyEl.style.display = 'flex';
            return;
        }

        // Fetch member counts for each group
        const groupsWithMembers = await Promise.all(
            groups.map(async (group) => {
                try {
                    const detail = await groupsAPI.get(group.id);
                    return { ...group, memberCount: detail.members ? detail.members.length : 0 };
                } catch {
                    return { ...group, memberCount: 0 };
                }
            })
        );

        gridEl.innerHTML = groupsWithMembers.map(group => `
            <div class="card" data-group-id="${group.id}">
                <div class="card-header">
                    <h3 class="card-title">${escapeHtml(group.name)}</h3>
                    <div class="card-actions">
                        <button class="btn btn-sm btn-secondary edit-group-btn" data-id="${group.id}" title="Edit">Edit</button>
                        <button class="btn btn-sm btn-danger delete-group-btn" data-id="${group.id}" title="Delete">Delete</button>
                    </div>
                </div>
                <div class="card-body" style="cursor:pointer" onclick="openGroupDetail(${group.id})">
                    <p class="text-muted">${group.description ? escapeHtml(group.description) : 'No description'}</p>
                    <div class="card-meta">
                        <span>${group.memberCount} member${group.memberCount !== 1 ? 's' : ''}</span>
                        <span>Created ${formatDate(group.created_at)}</span>
                    </div>
                </div>
            </div>
        `).join('');

        // Attach event handlers
        gridEl.querySelectorAll('.edit-group-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                openEditGroup(parseInt(btn.dataset.id));
            });
        });

        gridEl.querySelectorAll('.delete-group-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const id = parseInt(btn.dataset.id);
                if (confirm('Delete this group? Members will not be deleted.')) {
                    try {
                        await groupsAPI.delete(id);
                        showToast('Group deleted', 'success');
                        loadGroups();
                    } catch (error) {
                        showToast('Failed to delete group', 'error');
                    }
                }
            });
        });
    } catch (error) {
        console.error('Failed to load groups:', error);
        gridEl.innerHTML = '<div class="error">Failed to load groups</div>';
    }
}

function initGroupModals() {
    const modal = document.getElementById('createGroupModal');
    const detailModal = document.getElementById('groupDetailModal');

    document.getElementById('createGroupBtn').addEventListener('click', () => {
        document.getElementById('groupEditId').value = '';
        document.getElementById('groupName').value = '';
        document.getElementById('groupDescription').value = '';
        document.getElementById('groupModalTitle').textContent = 'Create Group';
        document.getElementById('saveGroupBtn').textContent = 'Create';
        modal.style.display = 'flex';
    });

    document.getElementById('closeGroupModal').addEventListener('click', () => { modal.style.display = 'none'; });
    document.getElementById('cancelGroupModal').addEventListener('click', () => { modal.style.display = 'none'; });
    document.getElementById('closeGroupDetailModal').addEventListener('click', () => { detailModal.style.display = 'none'; });

    document.getElementById('saveGroupBtn').addEventListener('click', async () => {
        const name = document.getElementById('groupName').value.trim();
        const description = document.getElementById('groupDescription').value.trim();
        const editId = document.getElementById('groupEditId').value;

        if (!name) { showToast('Group name is required', 'error'); return; }

        try {
            if (editId) {
                await groupsAPI.update(parseInt(editId), { name, description: description || undefined });
                showToast('Group updated', 'success');
            } else {
                await groupsAPI.create({ name, description: description || undefined });
                showToast('Group created', 'success');
            }
            modal.style.display = 'none';
            loadGroups();
        } catch (error) {
            showToast(error.message || 'Failed to save group', 'error');
        }
    });

    // Add member button
    document.getElementById('addMemberBtn').addEventListener('click', async () => {
        const select = document.getElementById('addMemberSelect');
        const clientId = select.value;
        if (!clientId || !currentGroupId) return;

        try {
            await groupsAPI.addMember(currentGroupId, clientId);
            showToast('Member added', 'success');
            openGroupDetail(currentGroupId);
        } catch (error) {
            showToast(error.message || 'Failed to add member', 'error');
        }
    });

    // Assign playlist to group button
    document.getElementById('assignGroupPlaylistBtn').addEventListener('click', async () => {
        const select = document.getElementById('assignGroupPlaylistSelect');
        const playlistId = parseInt(select.value);
        if (!playlistId || !currentGroupId) return;

        try {
            const result = await groupsAPI.assignPlaylist(currentGroupId, playlistId);
            showToast(result.message || 'Playlist assigned', 'success');
        } catch (error) {
            showToast(error.message || 'Failed to assign playlist', 'error');
        }
    });
}

async function openEditGroup(id) {
    try {
        const group = await groupsAPI.get(id);
        document.getElementById('groupEditId').value = id;
        document.getElementById('groupName').value = group.name;
        document.getElementById('groupDescription').value = group.description || '';
        document.getElementById('groupModalTitle').textContent = 'Edit Group';
        document.getElementById('saveGroupBtn').textContent = 'Save';
        document.getElementById('createGroupModal').style.display = 'flex';
    } catch (error) {
        showToast('Failed to load group', 'error');
    }
}

async function openGroupDetail(id) {
    currentGroupId = id;
    const modal = document.getElementById('groupDetailModal');
    const membersList = document.getElementById('groupMembersList');
    membersList.innerHTML = '<div class="loading">Loading...</div>';
    modal.style.display = 'flex';

    try {
        const [group, allClients, allPlaylists] = await Promise.all([
            groupsAPI.get(id),
            clientAPI.list(),
            playlistAPI.list()
        ]);

        document.getElementById('groupDetailTitle').textContent = group.name;

        // Populate add-member select with clients not already in group
        const memberIds = new Set(group.members.map(m => m.id));
        const addSelect = document.getElementById('addMemberSelect');
        addSelect.innerHTML = '<option value="">Add client to group...</option>' +
            allClients.filter(c => !memberIds.has(c.id)).map(c =>
                `<option value="${c.id}">${escapeHtml(c.name)}</option>`
            ).join('');

        // Populate playlist select
        const playlistSelect = document.getElementById('assignGroupPlaylistSelect');
        playlistSelect.innerHTML = '<option value="">Assign playlist...</option>' +
            allPlaylists.map(p =>
                `<option value="${p.id}">${escapeHtml(p.name)}</option>`
            ).join('');

        // Render members
        if (group.members.length === 0) {
            membersList.innerHTML = '<p class="text-muted">No members in this group</p>';
        } else {
            membersList.innerHTML = group.members.map(client => `
                <div class="member-row">
                    <div>
                        <strong>${escapeHtml(client.name)}</strong>
                        <span class="badge badge-${client.status === 'online' ? 'success' : client.status === 'error' ? 'danger' : 'secondary'}">${client.status}</span>
                    </div>
                    <button class="btn btn-sm btn-danger remove-member-btn" data-client-id="${client.id}">Remove</button>
                </div>
            `).join('');

            membersList.querySelectorAll('.remove-member-btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    try {
                        await groupsAPI.removeMember(id, btn.dataset.clientId);
                        showToast('Member removed', 'success');
                        openGroupDetail(id);
                    } catch (error) {
                        showToast('Failed to remove member', 'error');
                    }
                });
            });
        }
    } catch (error) {
        membersList.innerHTML = '<div class="error">Failed to load group details</div>';
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ===== Schedules View =====

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function loadSchedules() {
    const gridEl = document.getElementById('schedulesGrid');
    const emptyEl = document.getElementById('schedulesEmpty');

    gridEl.innerHTML = '<div class="loading">Loading schedules...</div>';
    emptyEl.style.display = 'none';

    try {
        const schedules = await schedulesAPI.list();

        if (schedules.length === 0) {
            gridEl.innerHTML = '';
            emptyEl.style.display = 'flex';
            return;
        }

        gridEl.innerHTML = schedules.map(schedule => {
            const days = schedule.days_of_week.split(',').map(d => DAY_NAMES[parseInt(d)]).join(', ');
            const timeRange = schedule.end_time
                ? `${schedule.start_time} - ${schedule.end_time}`
                : `${schedule.start_time}`;
            const target = schedule.client_id
                ? `Client`
                : schedule.group_id
                ? `Group`
                : 'All Clients';

            return `
            <div class="card">
                <div class="card-header">
                    <h3 class="card-title">
                        ${escapeHtml(schedule.name)}
                        <span class="badge badge-${schedule.enabled ? 'success' : 'secondary'}">${schedule.enabled ? 'Active' : 'Disabled'}</span>
                    </h3>
                    <div class="card-actions">
                        <button class="btn btn-sm btn-secondary edit-schedule-btn" data-id="${schedule.id}">Edit</button>
                        <button class="btn btn-sm btn-danger delete-schedule-btn" data-id="${schedule.id}">Delete</button>
                    </div>
                </div>
                <div class="card-body">
                    <div class="card-meta">
                        <span>Time: ${timeRange}</span>
                        <span>Days: ${days}</span>
                    </div>
                    <div class="card-meta">
                        <span>Target: ${target}</span>
                        <span>Priority: ${schedule.priority}</span>
                    </div>
                </div>
            </div>`;
        }).join('');

        gridEl.querySelectorAll('.edit-schedule-btn').forEach(btn => {
            btn.addEventListener('click', () => openEditSchedule(parseInt(btn.dataset.id)));
        });

        gridEl.querySelectorAll('.delete-schedule-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (confirm('Delete this schedule?')) {
                    try {
                        await schedulesAPI.delete(parseInt(btn.dataset.id));
                        showToast('Schedule deleted', 'success');
                        loadSchedules();
                    } catch (error) {
                        showToast('Failed to delete schedule', 'error');
                    }
                }
            });
        });
    } catch (error) {
        console.error('Failed to load schedules:', error);
        gridEl.innerHTML = '<div class="error">Failed to load schedules</div>';
    }
}

function initScheduleModal() {
    const modal = document.getElementById('scheduleModal');
    const targetSelect = document.getElementById('scheduleTarget');
    const targetIdGroup = document.getElementById('scheduleClientGroup');

    document.getElementById('createScheduleBtn').addEventListener('click', async () => {
        resetScheduleForm();
        document.getElementById('scheduleModalTitle').textContent = 'Create Schedule';
        document.getElementById('saveScheduleBtn').textContent = 'Create';
        await populateScheduleSelects();
        modal.style.display = 'flex';
    });

    document.getElementById('closeScheduleModal').addEventListener('click', () => { modal.style.display = 'none'; });
    document.getElementById('cancelScheduleModal').addEventListener('click', () => { modal.style.display = 'none'; });

    targetSelect.addEventListener('change', () => {
        targetIdGroup.style.display = targetSelect.value === 'all' ? 'none' : 'block';
        populateTargetSelect(targetSelect.value);
    });

    document.getElementById('saveScheduleBtn').addEventListener('click', async () => {
        const editId = document.getElementById('scheduleEditId').value;
        const name = document.getElementById('scheduleName').value.trim();
        const playlist_id = parseInt(document.getElementById('schedulePlaylist').value);
        const start_time = document.getElementById('scheduleStartTime').value;
        const end_time = document.getElementById('scheduleEndTime').value || undefined;
        const priority = parseInt(document.getElementById('schedulePriority').value) || 50;
        const enabled = document.getElementById('scheduleEnabled').checked;

        const dayCheckboxes = document.querySelectorAll('#daysPicker input[type="checkbox"]:checked');
        const days_of_week = Array.from(dayCheckboxes).map(cb => cb.value).join(',');

        const target = targetSelect.value;
        let client_id = undefined;
        let group_id = undefined;
        if (target === 'client') client_id = document.getElementById('scheduleTargetId').value || undefined;
        if (target === 'group') group_id = parseInt(document.getElementById('scheduleTargetId').value) || undefined;

        if (!name || !playlist_id || !start_time) {
            showToast('Name, playlist, and start time are required', 'error');
            return;
        }

        try {
            const data = { name, playlist_id, client_id, group_id, start_time, end_time, days_of_week, priority, enabled };
            if (editId) {
                await schedulesAPI.update(parseInt(editId), data);
                showToast('Schedule updated', 'success');
            } else {
                await schedulesAPI.create(data);
                showToast('Schedule created', 'success');
            }
            modal.style.display = 'none';
            loadSchedules();
        } catch (error) {
            showToast(error.message || 'Failed to save schedule', 'error');
        }
    });
}

function resetScheduleForm() {
    document.getElementById('scheduleEditId').value = '';
    document.getElementById('scheduleName').value = '';
    document.getElementById('scheduleStartTime').value = '';
    document.getElementById('scheduleEndTime').value = '';
    document.getElementById('schedulePriority').value = '50';
    document.getElementById('scheduleEnabled').checked = true;
    document.getElementById('scheduleTarget').value = 'all';
    document.getElementById('scheduleClientGroup').style.display = 'none';
    document.querySelectorAll('#daysPicker input[type="checkbox"]').forEach(cb => { cb.checked = true; });
}

async function populateScheduleSelects() {
    try {
        const playlists = await playlistAPI.list();
        const select = document.getElementById('schedulePlaylist');
        select.innerHTML = '<option value="">Select playlist...</option>' +
            playlists.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    } catch (error) {
        console.error('Failed to load playlists for schedule:', error);
    }
}

async function populateTargetSelect(type) {
    const select = document.getElementById('scheduleTargetId');
    try {
        if (type === 'client') {
            const clients = await clientAPI.list();
            select.innerHTML = '<option value="">Select client...</option>' +
                clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
        } else if (type === 'group') {
            const groups = await groupsAPI.list();
            select.innerHTML = '<option value="">Select group...</option>' +
                groups.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
        }
    } catch (error) {
        console.error('Failed to populate target select:', error);
    }
}

async function openEditSchedule(id) {
    try {
        const schedule = await schedulesAPI.get(id);
        await populateScheduleSelects();

        document.getElementById('scheduleEditId').value = id;
        document.getElementById('scheduleName').value = schedule.name;
        document.getElementById('schedulePlaylist').value = schedule.playlist_id;
        document.getElementById('scheduleStartTime').value = schedule.start_time;
        document.getElementById('scheduleEndTime').value = schedule.end_time || '';
        document.getElementById('schedulePriority').value = schedule.priority;
        document.getElementById('scheduleEnabled').checked = schedule.enabled;

        // Set days
        const activeDays = new Set(schedule.days_of_week.split(','));
        document.querySelectorAll('#daysPicker input[type="checkbox"]').forEach(cb => {
            cb.checked = activeDays.has(cb.value);
        });

        // Set target
        const targetSelect = document.getElementById('scheduleTarget');
        if (schedule.client_id) {
            targetSelect.value = 'client';
            document.getElementById('scheduleClientGroup').style.display = 'block';
            await populateTargetSelect('client');
            document.getElementById('scheduleTargetId').value = schedule.client_id;
        } else if (schedule.group_id) {
            targetSelect.value = 'group';
            document.getElementById('scheduleClientGroup').style.display = 'block';
            await populateTargetSelect('group');
            document.getElementById('scheduleTargetId').value = schedule.group_id;
        } else {
            targetSelect.value = 'all';
            document.getElementById('scheduleClientGroup').style.display = 'none';
        }

        document.getElementById('scheduleModalTitle').textContent = 'Edit Schedule';
        document.getElementById('saveScheduleBtn').textContent = 'Save';
        document.getElementById('scheduleModal').style.display = 'flex';
    } catch (error) {
        showToast('Failed to load schedule', 'error');
    }
}

// ===== Live Previews =====

async function loadPreviews(clients) {
    const grid = document.getElementById('previewsGrid');
    if (!clients || clients.length === 0) {
        grid.innerHTML = '<p class="text-muted">No clients to preview</p>';
        return;
    }

    grid.innerHTML = clients.map(client => `
        <div class="preview-card" onclick="enlargePreview('${client.id}', '${escapeHtml(client.name || client.id)}')">
            <img src="/api/clients/${client.id}/preview?t=${Date.now()}" alt="${escapeHtml(client.name || client.id)}"
                 onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 200 140%22><rect fill=%22%23222%22 width=%22200%22 height=%22140%22/><text fill=%22%23666%22 x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22 font-size=%2214%22>No Preview</text></svg>'">
            <div class="preview-label">${escapeHtml(client.name || client.id.substring(0, 8))}</div>
        </div>
    `).join('');
}

function enlargePreview(clientId, clientName) {
    const modal = document.getElementById('previewEnlargeModal');
    document.getElementById('previewEnlargeTitle').textContent = clientName;
    document.getElementById('previewEnlargeImg').src = `/api/clients/${clientId}/preview?t=${Date.now()}`;
    modal.style.display = 'flex';
}

// ===== Analytics View =====

async function loadAnalytics() {
    await Promise.all([
        loadPlaybackSummary(),
        loadMediaPopularity(),
        loadUptimeStats(),
        loadRecentPlayback(),
    ]);
}

async function loadPlaybackSummary() {
    const el = document.getElementById('analyticsPlaybackSummary');
    try {
        const summary = await apiCall('/analytics/summary');
        if (summary.length === 0) {
            el.innerHTML = '<p class="text-muted">No playback data yet</p>';
            return;
        }
        el.innerHTML = `<table class="analytics-table">
            <thead><tr><th>Client</th><th>Total Plays</th><th>Total Duration</th></tr></thead>
            <tbody>${summary.map(s => `<tr>
                <td>${escapeHtml(s.client_name)}</td>
                <td>${s.total_plays}</td>
                <td>${formatDuration(s.total_duration)}</td>
            </tr>`).join('')}</tbody>
        </table>`;
    } catch (error) {
        el.innerHTML = '<p class="text-muted">Failed to load</p>';
    }
}

async function loadMediaPopularity() {
    const el = document.getElementById('analyticsMediaPopularity');
    try {
        const popularity = await apiCall('/analytics/media-popularity?limit=10');
        if (popularity.length === 0) {
            el.innerHTML = '<p class="text-muted">No playback data yet</p>';
            return;
        }
        el.innerHTML = `<table class="analytics-table">
            <thead><tr><th>Media</th><th>Type</th><th>Plays</th><th>Duration</th></tr></thead>
            <tbody>${popularity.map(p => `<tr>
                <td>${escapeHtml(p.original_filename)}</td>
                <td>${p.type}</td>
                <td>${p.play_count}</td>
                <td>${formatDuration(p.total_duration)}</td>
            </tr>`).join('')}</tbody>
        </table>`;
    } catch (error) {
        el.innerHTML = '<p class="text-muted">Failed to load</p>';
    }
}

async function loadUptimeStats() {
    const el = document.getElementById('analyticsUptime');
    try {
        const stats = await apiCall('/analytics/uptime');
        if (stats.length === 0) {
            el.innerHTML = '<p class="text-muted">No clients</p>';
            return;
        }
        el.innerHTML = `<table class="analytics-table">
            <thead><tr><th>Client</th><th>Status</th><th>Last Seen</th><th>Logs</th></tr></thead>
            <tbody>${stats.map(s => `<tr>
                <td>${escapeHtml(s.client_name)}</td>
                <td><span class="badge badge-${s.status === 'online' ? 'success' : s.status === 'error' ? 'danger' : 'secondary'}">${s.status}</span></td>
                <td>${s.last_seen ? formatRelativeTime(s.last_seen) : 'Never'}</td>
                <td>${s.total_logs}</td>
            </tr>`).join('')}</tbody>
        </table>`;
    } catch (error) {
        el.innerHTML = '<p class="text-muted">Failed to load</p>';
    }
}

async function loadRecentPlayback() {
    const el = document.getElementById('analyticsRecent');
    try {
        const logs = await apiCall('/analytics/playback?limit=15');
        if (logs.length === 0) {
            el.innerHTML = '<p class="text-muted">No playback history</p>';
            return;
        }
        el.innerHTML = `<table class="analytics-table">
            <thead><tr><th>Client</th><th>Media</th><th>Duration</th><th>When</th></tr></thead>
            <tbody>${logs.map(l => `<tr>
                <td>${l.client_id.substring(0, 8)}...</td>
                <td>${l.media_id}</td>
                <td>${formatDuration(l.duration_watched)}</td>
                <td>${formatRelativeTime(l.started_at)}</td>
            </tr>`).join('')}</tbody>
        </table>`;
    } catch (error) {
        el.innerHTML = '<p class="text-muted">Failed to load</p>';
    }
}

function initAnalytics() {
    document.getElementById('refreshAnalyticsBtn').addEventListener('click', loadAnalytics);
}

// ===== Client Control Modal =====

let controlClientId = null;

async function openClientControl(clientId) {
    controlClientId = clientId;
    const modal = document.getElementById('clientControlModal');
    modal.style.display = 'flex';

    try {
        const clientWithStatus = await apiCall(`/clients/${clientId}/status`);
        document.getElementById('clientControlTitle').textContent = clientWithStatus.name;

        const statusBadge = document.getElementById('controlClientStatus');
        statusBadge.textContent = clientWithStatus.status;
        statusBadge.className = `badge badge-${clientWithStatus.status === 'online' ? 'success' : clientWithStatus.status === 'error' ? 'danger' : 'secondary'}`;

        if (clientWithStatus.current_status && clientWithStatus.current_status.is_playing) {
            document.getElementById('controlNowPlaying').textContent = 'Playing';
            const pos = clientWithStatus.current_status.position || 0;
            document.getElementById('controlPosition').textContent = formatDuration(pos);
        } else {
            document.getElementById('controlNowPlaying').textContent = 'Paused / Idle';
            document.getElementById('controlPosition').textContent = '0:00';
        }

        // Load playlist assignments
        try {
            const playlists = await apiCall(`/clients/${clientId}/playlists`);
            const listEl = document.getElementById('controlPlaylistsList');
            if (playlists.length === 0) {
                listEl.innerHTML = '<p class="text-muted">No playlists assigned</p>';
            } else {
                listEl.innerHTML = playlists.map(p => `
                    <div class="member-row">
                        <span>${escapeHtml(p.playlist_name)} <small class="text-muted">(priority: ${p.priority})</small></span>
                    </div>
                `).join('');
            }
        } catch {
            document.getElementById('controlPlaylistsList').innerHTML = '';
        }
    } catch (error) {
        document.getElementById('clientControlTitle').textContent = 'Client';
        console.error('Failed to load client details:', error);
    }
}

async function sendClientCommand(command, args) {
    if (!controlClientId) return;
    try {
        const result = await apiCall(`/clients/${controlClientId}/command`, {
            method: 'POST',
            body: JSON.stringify({ command, args })
        });
        if (result.delivered) {
            showToast(`${command} sent`, 'success');
        } else {
            showToast('Client not connected', 'warning');
        }
    } catch (error) {
        showToast(error.message || `Failed to send ${command}`, 'error');
    }
}

function initClientControlModal() {
    const modal = document.getElementById('clientControlModal');
    document.getElementById('closeClientControlModal').addEventListener('click', () => {
        modal.style.display = 'none';
        controlClientId = null;
    });

    document.getElementById('controlPlayPause').addEventListener('click', async () => {
        // Toggle based on current known state — send pause if playing, resume if paused
        await sendClientCommand('pause');
    });

    document.getElementById('controlSkip').addEventListener('click', () => sendClientCommand('skip'));
    document.getElementById('controlPrevious').addEventListener('click', () => sendClientCommand('previous'));

    const volumeSlider = document.getElementById('controlVolume');
    const volumeValue = document.getElementById('controlVolumeValue');
    volumeSlider.addEventListener('input', () => {
        volumeValue.textContent = volumeSlider.value + '%';
    });
    volumeSlider.addEventListener('change', () => {
        sendClientCommand('volume', { volume: parseInt(volumeSlider.value) });
    });

    document.querySelectorAll('[data-seek]').forEach(btn => {
        btn.addEventListener('click', () => {
            sendClientCommand('seek', { position: parseInt(btn.dataset.seek) });
        });
    });
}

// ===== Initialization =====

async function init() {
    console.log('Initializing Montr Web UI...');

    // Load UI config from server
    try {
        const configResp = await fetch(API_BASE + '/ui-config');
        const configData = await configResp.json();
        if (configData.success && configData.data) {
            UI_CONFIG = { ...UI_CONFIG, ...configData.data };
        }
    } catch (e) {
        console.warn('Failed to load UI config, using defaults:', e);
    }

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

    // Initialize group functionality
    initGroupModals();

    // Initialize schedule functionality
    initScheduleModal();

    // Initialize client control modal
    initClientControlModal();

    // Initialize analytics
    initAnalytics();

    // Load initial view
    loadDashboard();

    // Auto-refresh dashboard
    setInterval(() => {
        if (state.currentView === 'dashboard') {
            checkHealth();
        }
    }, UI_CONFIG.dashboardRefreshInterval);

    console.log('Montr Web UI initialized successfully');
}

// Start the application when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
