// ===== Montr Web UI Application =====

// Configuration
const API_BASE = window.location.origin + '/api';
const WS_URL = `ws://${window.location.host}/ws`;

// UI configuration (loaded from server, with fallback defaults)
let UI_CONFIG = {
    dashboardRefreshInterval: 30000,
    toastDisplayDuration: 3000,
};

// Auth state
const auth = {
    token: localStorage.getItem('montr_token'),
    user: null, // { id, username, email, role }
};

// Auto-refresh state
let autoRefreshIntervalId = null;

// State management
const state = {
    currentView: 'dashboard',
    media: [],
    playlists: [],
    clients: [],
    schedules: [],
    latestTelemetry: {},
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
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return 'N/A';
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
        const headers = {
            'Content-Type': 'application/json',
            ...options.headers
        };
        if (auth.token) {
            headers['Authorization'] = 'Bearer ' + auth.token;
        }

        const response = await fetch(API_BASE + endpoint, {
            ...options,
            headers
        });

        // Handle auth errors
        if (response.status === 401) {
            auth.token = null;
            auth.user = null;
            localStorage.removeItem('montr_token');
            showAuthScreen('login');
            throw new Error('Session expired');
        }

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
        const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB

        // Small files: use simple upload
        if (file.size <= CHUNK_SIZE) {
            return this._simpleUpload(file, onProgress);
        }

        // Large files: chunked upload
        const { uploadId, chunkSize, totalChunks } = await apiCall('/media/upload/init', {
            method: 'POST',
            body: JSON.stringify({
                filename: file.name,
                mimeType: file.type || 'application/octet-stream',
                totalSize: file.size,
            }),
        });

        let totalUploaded = 0;

        for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, file.size);
            const chunk = file.slice(start, end);

            await new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();

                xhr.upload.addEventListener('progress', (e) => {
                    if (e.lengthComputable && onProgress) {
                        onProgress(((totalUploaded + e.loaded) / file.size) * 100);
                    }
                });

                xhr.addEventListener('load', () => {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        totalUploaded += (end - start);
                        resolve();
                    } else {
                        reject(new Error(`Chunk ${i + 1}/${totalChunks} upload failed`));
                    }
                });

                xhr.addEventListener('error', () => {
                    reject(new Error(`Chunk ${i + 1}/${totalChunks} upload failed`));
                });

                xhr.open('POST', `${API_BASE}/media/upload/${uploadId}/chunk/${i}`);
                xhr.setRequestHeader('Content-Type', 'application/octet-stream');
                if (auth.token) xhr.setRequestHeader('Authorization', 'Bearer ' + auth.token);
                xhr.send(chunk);
            });
        }

        return await apiCall(`/media/upload/${uploadId}/complete`, { method: 'POST' });
    },

    _simpleUpload(file, onProgress) {
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
                if (xhr.status >= 200 && xhr.status < 300) {
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
            if (auth.token) xhr.setRequestHeader('Authorization', 'Bearer ' + auth.token);
            xhr.send(formData);
        });
    },

    async delete(id) {
        return await apiCall(`/media/${id}`, { method: 'DELETE' });
    },

    async download(id) {
        const headers = {};
        if (auth.token) headers['Authorization'] = 'Bearer ' + auth.token;
        const response = await fetch(API_BASE + `/media/${id}/download`, { headers });
        if (!response.ok) throw new Error('Download failed');
        const blob = await response.blob();
        const disposition = response.headers.get('Content-Disposition');
        let filename = `media_${id}`;
        if (disposition) {
            const match = disposition.match(/filename="?(.+?)"?$/);
            if (match) filename = match[1];
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
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

    async addItem(playlistId, mediaId) {
        return await apiCall(`/playlists/${playlistId}/items`, {
            method: 'POST',
            body: JSON.stringify({ mediaIds: [mediaId] })
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
        return await apiCall(`/clients/${clientId}`, {
            method: 'PUT',
            body: JSON.stringify({ assigned_playlist_id: playlistId })
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

const approvalsAPI = {
    async listPending() {
        return await apiCall('/media/pending');
    },

    async approve(mediaId) {
        return await apiCall(`/media/${mediaId}/approve`, { method: 'POST' });
    },

    async reject(mediaId, comment) {
        return await apiCall(`/media/${mediaId}/reject`, {
            method: 'POST',
            body: JSON.stringify({ comment: comment || null })
        });
    },

    async getLogs(mediaId) {
        return await apiCall(`/media/${mediaId}/approval-logs`);
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

// ===== Auto-Refresh =====

function isModalOpen() {
    return document.querySelector('.modal.active') !== null;
}

function startAutoRefresh() {
    stopAutoRefresh();
    const interval = state.currentView === 'clients'
        ? 10000  // 10s for clients (real-time status)
        : UI_CONFIG.dashboardRefreshInterval;  // 30s for everything else

    autoRefreshIntervalId = setInterval(() => {
        if (isModalOpen()) return;
        switch (state.currentView) {
            case 'dashboard': loadDashboard(); break;
            case 'media': loadMedia(); break;
            case 'playlists': loadPlaylists(); break;
            case 'clients': loadClients(); break;
            case 'groups': loadGroups(); break;
            case 'schedules': loadSchedules(); break;
            case 'analytics': loadAnalytics(); break;
        }
    }, interval);
}

function stopAutoRefresh() {
    if (autoRefreshIntervalId) {
        clearInterval(autoRefreshIntervalId);
        autoRefreshIntervalId = null;
    }
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

    // Restart auto-refresh for the new view
    startAutoRefresh();

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
        case 'notifications':
            loadNotifications();
            break;
        case 'approvals':
            loadApprovals();
            break;
        case 'users':
            loadUsers();
            break;
    }
}

// ===== Dashboard View =====

async function loadDashboard() {
    try {
        const [health, mediaResult, playlists, clients] = await Promise.all([
            checkHealth(),
            mediaAPI.list(),
            playlistAPI.list(),
            clientAPI.list()
        ]);

        state.media = mediaResult?.data || mediaResult || [];
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

    const wsActive = health.websocket?.totalConnections >= 0;
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
        emptyEl.style.display = '';
        return;
    }

    emptyEl.style.display = 'none';

    const videoIcon = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
    const imageIcon = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`;

    gridEl.innerHTML = media.map(item => {
        const displayName = item.original_filename || item.filename;
        return `
        <div class="media-item" data-id="${item.id}">
            <div class="media-thumbnail" data-id="${item.id}">
                <img class="thumb-img" data-thumb-id="${item.id}" alt="" style="display:none">
                <div class="thumb-fallback">${item.type === 'video' ? videoIcon : imageIcon}</div>
                ${item.type === 'video' ? '<div class="thumb-play-badge">&#9654;</div>' : ''}
            </div>
            <div class="media-info">
                <div class="media-name" title="${displayName}">${displayName}</div>
                <div class="media-meta">
                    <span class="badge badge-info">${item.type}</span>
                    <span>${item.file_size ? formatFileSize(item.file_size) : 'N/A'}${item.duration ? ' / ' + formatDuration(item.duration) : ''}</span>
                </div>
            </div>
            <div class="media-actions">
                <button class="btn btn-sm btn-secondary media-download-btn" data-id="${item.id}">
                    Download
                </button>
                ${auth.user?.role !== 'viewer' ? `<button class="btn btn-sm btn-danger media-delete-btn" data-id="${item.id}">
                    Delete
                </button>` : ''}
            </div>
        </div>`;
    }).join('');

    // Click media item to open preview
    gridEl.querySelectorAll('.media-item').forEach(el => {
        el.addEventListener('click', () => openMediaPreview(parseInt(el.dataset.id)));
    });
    gridEl.querySelectorAll('.media-download-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            handleMediaDownload(btn.dataset.id);
        });
    });
    gridEl.querySelectorAll('.media-delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            handleMediaDelete(btn.dataset.id);
        });
    });

    // Load thumbnails asynchronously
    loadThumbnails(media);
}

async function loadThumbnails(media) {
    for (const item of media) {
        const img = document.querySelector(`img[data-thumb-id="${item.id}"]`);
        if (!img) continue;
        try {
            const headers = {};
            if (auth.token) headers['Authorization'] = 'Bearer ' + auth.token;
            const response = await fetch(API_BASE + `/media/${item.id}/thumbnail`, { headers });
            if (!response.ok) continue;
            const blob = await response.blob();
            img.src = URL.createObjectURL(blob);
            img.style.display = '';
            img.parentElement.querySelector('.thumb-fallback').style.display = 'none';
        } catch {
            // Keep fallback icon
        }
    }
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

// ===== Media Preview =====

let _previewBlobUrl = null;

async function openMediaPreview(id) {
    try {
        const media = await apiCall(`/media/${id}`);
        const displayName = media.original_filename || media.filename;

        document.getElementById('mediaPreviewTitle').textContent = displayName;

        const video = document.getElementById('mediaPreviewVideo');
        const img = document.getElementById('mediaPreviewImage');

        // Clean up previous
        video.style.display = 'none';
        video.pause();
        video.removeAttribute('src');
        img.style.display = 'none';
        img.removeAttribute('src');
        if (_previewBlobUrl) {
            URL.revokeObjectURL(_previewBlobUrl);
            _previewBlobUrl = null;
        }

        // Build metadata string
        const parts = [media.type];
        if (media.file_size) parts.push(formatFileSize(media.file_size));
        if (media.duration) parts.push(formatDuration(media.duration));
        if (media.width && media.height) parts.push(`${media.width}x${media.height}`);
        document.getElementById('mediaPreviewMeta').textContent = parts.join(' · ');

        // Load media via fetch with auth
        const headers = {};
        if (auth.token) headers['Authorization'] = 'Bearer ' + auth.token;
        const response = await fetch(API_BASE + `/media/${id}/stream`, { headers });
        if (!response.ok) throw new Error('Failed to load media');
        const blob = await response.blob();
        _previewBlobUrl = URL.createObjectURL(blob);

        if (media.type === 'video') {
            video.src = _previewBlobUrl;
            video.style.display = '';
        } else {
            img.src = _previewBlobUrl;
            img.style.display = '';
        }

        // Wire download button
        document.getElementById('mediaPreviewDownload').onclick = () => mediaAPI.download(id);

        openModal('mediaPreviewModal');
    } catch (error) {
        console.error('Failed to open preview:', error);
        showToast('Failed to load media preview', 'error');
    }
}

function initMediaPreviewModal() {
    document.getElementById('closeMediaPreview').addEventListener('click', closeMediaPreview);
    document.getElementById('closeMediaPreviewBtn').addEventListener('click', closeMediaPreview);
}

function closeMediaPreview() {
    const video = document.getElementById('mediaPreviewVideo');
    video.pause();
    video.removeAttribute('src');
    document.getElementById('mediaPreviewImage').removeAttribute('src');
    if (_previewBlobUrl) {
        URL.revokeObjectURL(_previewBlobUrl);
        _previewBlobUrl = null;
    }
    closeModal('mediaPreviewModal');
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
        emptyEl.style.display = '';
        return;
    }

    emptyEl.style.display = 'none';

    listEl.innerHTML = playlists.map(playlist => `
        <div class="playlist-card" data-playlist-id="${playlist.id}">
            <div class="playlist-header">
                <h3 class="playlist-title">${playlist.name}</h3>
                <span class="badge badge-info">${playlist.itemCount || 0} items</span>
            </div>
            ${playlist.description ? `<p class="playlist-description">${playlist.description}</p>` : ''}
            <div class="playlist-footer">
                <span>Created: ${formatDate(playlist.created_at)}</span>
                <span>Updated: ${formatRelativeTime(playlist.updated_at)}</span>
            </div>
        </div>
    `).join('');

    listEl.querySelectorAll('.playlist-card').forEach(card => {
        card.addEventListener('click', () => {
            openPlaylistDetail(card.dataset.playlistId);
        });
    });
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
        const [playlist, mediaResult] = await Promise.all([
            playlistAPI.get(playlistId),
            mediaAPI.list(),
        ]);
        state.currentPlaylist = playlist;
        state.media = mediaResult?.data || mediaResult || [];

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
                ${index > 0 ? `<button class="btn btn-sm btn-secondary move-up-btn" data-index="${index}">↑</button>` : ''}
                ${index < items.length - 1 ? `<button class="btn btn-sm btn-secondary move-down-btn" data-index="${index}">↓</button>` : ''}
                <button class="btn btn-sm btn-danger remove-item-btn" data-item-id="${item.id}">×</button>
            </div>
        </div>
    `).join('');

    container.querySelectorAll('.move-up-btn').forEach(btn => {
        btn.addEventListener('click', () => moveItemUp(parseInt(btn.dataset.index)));
    });
    container.querySelectorAll('.move-down-btn').forEach(btn => {
        btn.addEventListener('click', () => moveItemDown(parseInt(btn.dataset.index)));
    });
    container.querySelectorAll('.remove-item-btn').forEach(btn => {
        btn.addEventListener('click', () => removePlaylistItem(btn.dataset.itemId));
    });
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
        <div class="playlist-media-item" data-media-id="${item.id}">
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

    container.querySelectorAll('.playlist-media-item').forEach(el => {
        el.addEventListener('click', () => addToPlaylist(el.dataset.mediaId));
    });
}

async function addToPlaylist(mediaId) {
    if (!state.currentPlaylist) return;

    try {
        await playlistAPI.addItem(state.currentPlaylist.id, parseInt(mediaId, 10));
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
        // Fetch clients and the latest telemetry snapshot in parallel.
        // Telemetry is best-effort: if the endpoint fails (e.g. older clients
        // never reported), the badges simply won't render.
        const [clients, latestTelemetry] = await Promise.all([
            clientAPI.list(),
            apiCall('/telemetry/clients/latest').catch(() => ({})),
        ]);
        state.clients = clients || [];
        state.latestTelemetry = latestTelemetry || {};
        renderClientsGrid(clients || []);
        updateClientStats(clients || []);
        loadPreviews(clients || []);
    } catch (error) {
        console.error('Failed to load clients:', error);
        showToast('Failed to load clients', 'error');
        gridEl.innerHTML = '<div class="empty-state"><p>Failed to load clients</p></div>';
    }
}

// ===== Telemetry helpers (shared between badges and detail modal) =====

const TELEMETRY_THRESHOLDS = {
    diskWarnPctFree: 10,
    diskCritPctFree: 5,
    cpuWarn: 90,
    tempWarn: 85,
};

function diskPctFree(disk) {
    if (!disk || !disk.total_bytes) return 100;
    return ((disk.total_bytes - disk.used_bytes) / disk.total_bytes) * 100;
}

function maxDiskUsedPct(disks) {
    if (!disks || !disks.length) return null;
    let max = 0;
    for (const d of disks) {
        if (!d.total_bytes) continue;
        const used = (d.used_bytes / d.total_bytes) * 100;
        if (used > max) max = used;
    }
    return max;
}

function maxTempCelsius(temps) {
    if (!temps || !temps.length) return null;
    return temps.reduce((m, t) => (t.celsius > m ? t.celsius : m), -Infinity);
}

function diskBadgeClass(disks) {
    if (!disks || !disks.length) return 'normal';
    const minFree = disks.reduce((m, d) => Math.min(m, diskPctFree(d)), 100);
    if (minFree <= TELEMETRY_THRESHOLDS.diskCritPctFree) return 'critical';
    if (minFree <= TELEMETRY_THRESHOLDS.diskWarnPctFree) return 'warning';
    return 'normal';
}

function cpuBadgeClass(cpu_pct) {
    if (cpu_pct >= TELEMETRY_THRESHOLDS.cpuWarn) return 'warning';
    return 'normal';
}

function tempBadgeClass(temps) {
    const max = maxTempCelsius(temps);
    if (max === null) return 'normal';
    if (max >= TELEMETRY_THRESHOLDS.tempWarn) return 'warning';
    return 'normal';
}

function renderTelemetryBadges(t) {
    if (!t) return '';
    const usedPct = maxDiskUsedPct(t.disks);
    const maxTemp = maxTempCelsius(t.temps);
    const badges = [];
    badges.push(
        `<span class="telemetry-badge ${diskBadgeClass(t.disks)}" title="Highest disk usage across mounts">DSK ${usedPct !== null ? usedPct.toFixed(0) + '%' : '–'}</span>`
    );
    badges.push(
        `<span class="telemetry-badge ${cpuBadgeClass(t.cpu_pct)}" title="Most recent CPU usage">CPU ${(t.cpu_pct || 0).toFixed(0)}%</span>`
    );
    if (maxTemp !== null) {
        badges.push(
            `<span class="telemetry-badge ${tempBadgeClass(t.temps)}" title="Highest reported sensor temp">${maxTemp.toFixed(0)}°C</span>`
        );
    }
    if (t.mpv && t.mpv.alive === false) {
        badges.push(`<span class="telemetry-badge critical" title="mpv not responding">mpv✗</span>`);
    }
    return `<div class="telemetry-badges">${badges.join('')}</div>`;
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
        emptyEl.style.display = '';
        return;
    }

    emptyEl.style.display = 'none';

    gridEl.innerHTML = clients.map(client => {
        const statusClass = client.status || 'offline';
        const assignedPlaylist = state.playlists.find(p => p.id === client.assigned_playlist_id);
        const telemetry = state.latestTelemetry ? state.latestTelemetry[client.id] : null;

        return `
            <div class="client-card">
                <div class="client-header">
                    <h3 class="client-name clickable" data-client-id="${client.id}" data-client-name="${client.name || client.id}">${client.name || client.id}</h3>
                    <div class="client-status">
                        <span class="status-indicator ${statusClass}"></span>
                        <span>${statusClass}</span>
                    </div>
                </div>
                ${renderTelemetryBadges(telemetry)}
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
                        <span>${client.last_seen ? formatRelativeTime(client.last_seen) : 'Never'}</span>
                    </div>
                </div>
                <div class="client-actions">
                    <button class="btn btn-sm btn-secondary client-detail-btn" data-client-id="${client.id}" data-client-name="${client.name || client.id}">
                        Details
                    </button>
                    <button class="btn btn-sm btn-secondary client-control-btn" data-client-id="${client.id}">
                        Controls
                    </button>
                    <button class="btn btn-sm btn-primary client-assign-btn" data-client-id="${client.id}" data-client-name="${client.name || client.id}">
                        Assign Playlist
                    </button>
                </div>
            </div>
        `;
    }).join('');

    gridEl.querySelectorAll('.client-control-btn').forEach(btn => {
        btn.addEventListener('click', () => openClientControl(btn.dataset.clientId));
    });
    gridEl.querySelectorAll('.client-assign-btn').forEach(btn => {
        btn.addEventListener('click', () => openAssignPlaylistModal(btn.dataset.clientId, btn.dataset.clientName));
    });
    gridEl.querySelectorAll('.client-detail-btn').forEach(btn => {
        btn.addEventListener('click', () => openClientDetailModal(btn.dataset.clientId, btn.dataset.clientName));
    });
    gridEl.querySelectorAll('.client-name.clickable').forEach(el => {
        el.addEventListener('click', () => openClientDetailModal(el.dataset.clientId, el.dataset.clientName));
    });
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
            await clientAPI.assignPlaylist(clientId, parseInt(playlistId, 10));
            showToast('Playlist assigned successfully', 'success');
            closeModal('assignPlaylistModal');
            loadClients();
        } catch (error) {
            console.error('Failed to assign playlist:', error);
            showToast('Failed to assign playlist', 'error');
        }
    });
}

// ===== Client Detail Modal (telemetry charts + log events) =====

const clientDetailState = {
    clientId: null,
    clientName: null,
    charts: {},  // canvasId -> Chart instance
};

function destroyDetailCharts() {
    for (const id of Object.keys(clientDetailState.charts)) {
        try { clientDetailState.charts[id].destroy(); } catch (e) { /* noop */ }
    }
    clientDetailState.charts = {};
}

function makeLineChart(canvasId, label, points, color) {
    const ctx = document.getElementById(canvasId);
    if (!ctx) return;
    if (clientDetailState.charts[canvasId]) {
        clientDetailState.charts[canvasId].destroy();
    }
    clientDetailState.charts[canvasId] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: points.map(p => new Date(p.x).toLocaleTimeString()),
            datasets: [{
                label,
                data: points.map(p => p.y),
                borderColor: color,
                backgroundColor: color + '22',
                tension: 0.2,
                pointRadius: 0,
                fill: true,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: { legend: { display: true, position: 'top' } },
            scales: {
                y: { beginAtZero: true },
                x: { ticks: { maxTicksLimit: 6 } },
            },
        },
    });
}

async function openClientDetailModal(clientId, clientName) {
    clientDetailState.clientId = clientId;
    clientDetailState.clientName = clientName;

    document.getElementById('clientDetailTitle').textContent = `${clientName} – telemetry`;

    // Render summary section using the freshest data we have on hand.
    const client = state.clients.find(c => c.id === clientId);
    const telemetry = state.latestTelemetry ? state.latestTelemetry[clientId] : null;
    document.getElementById('clientDetailSummary').innerHTML = renderClientDetailSummary(client, telemetry);

    openModal('clientDetailModal');
    destroyDetailCharts();

    // Load 1h of time-series in parallel with the recent log events.
    const fromMs = Date.now() - 3600 * 1000;
    const toMs = Date.now();

    try {
        const [rangeRows, logEvents] = await Promise.all([
            apiCall(`/telemetry/clients/${clientId}/range?from=${fromMs}&to=${toMs}&limit=2000`).catch(() => []),
            // Logs endpoint is admin-only; viewers will get a 403 — render empty in that case.
            apiCall(`/telemetry/clients/${clientId}/logs?limit=50`).catch(() => []),
        ]);

        renderTelemetryCharts(rangeRows || []);
        renderRecentLogEvents(logEvents || []);
    } catch (err) {
        console.error('Failed to load client telemetry:', err);
        showToast('Failed to load telemetry', 'error');
    }
}

function renderClientDetailSummary(client, t) {
    if (!client) return '<p>Client not found.</p>';
    const playlist = state.playlists.find(p => p.id === client.assigned_playlist_id);
    const memUsedPct = t && t.mem_total_mb
        ? ((t.mem_used_mb / t.mem_total_mb) * 100).toFixed(0) + '%'
        : '–';
    const uptime = t && t.process ? t.process.client_uptime_s : null;
    return `
        <div class="info-row"><span class="info-label">Status:</span> <span>${client.status}</span></div>
        <div class="info-row"><span class="info-label">Version:</span> <span>${client.version || '–'}</span></div>
        <div class="info-row"><span class="info-label">Playlist:</span> <span>${playlist ? playlist.name : 'None'}</span></div>
        <div class="info-row"><span class="info-label">Last seen:</span> <span>${client.last_seen ? formatRelativeTime(client.last_seen) : 'Never'}</span></div>
        ${t ? `
            <div class="info-row"><span class="info-label">CPU:</span> <span>${t.cpu_pct.toFixed(0)}%</span></div>
            <div class="info-row"><span class="info-label">Memory:</span> <span>${t.mem_used_mb}/${t.mem_total_mb} MB (${memUsedPct})</span></div>
            <div class="info-row"><span class="info-label">Uptime:</span> <span>${uptime !== null ? formatDuration(uptime) : '–'}</span></div>
        ` : '<div class="info-row"><em>No telemetry yet.</em></div>'}
    `;
}

function formatDuration(seconds) {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function renderTelemetryCharts(rows) {
    const emptyEl = document.getElementById('clientDetailChartsEmpty');
    const chartsEl = document.getElementById('clientDetailCharts');
    if (!rows || rows.length === 0) {
        emptyEl.style.display = '';
        chartsEl.style.display = 'none';
        return;
    }
    emptyEl.style.display = 'none';
    chartsEl.style.display = '';

    const cpuPoints = rows.map(r => ({ x: new Date(r.recorded_at).getTime(), y: r.cpu_pct }));
    const memPoints = rows.map(r => ({
        x: new Date(r.recorded_at).getTime(),
        y: r.mem_total_mb ? (r.mem_used_mb / r.mem_total_mb) * 100 : 0,
    }));
    const diskPoints = rows.map(r => ({
        x: new Date(r.recorded_at).getTime(),
        y: maxDiskUsedPct(r.disks) || 0,
    }));
    const tempPoints = rows
        .map(r => {
            const max = maxTempCelsius(r.temps);
            return max === null ? null : { x: new Date(r.recorded_at).getTime(), y: max };
        })
        .filter(p => p !== null);

    makeLineChart('cpuChart', 'CPU %', cpuPoints, '#3b82f6');
    makeLineChart('memChart', 'Memory %', memPoints, '#10b981');
    makeLineChart('diskChart', 'Disk used %', diskPoints, '#f59e0b');
    if (tempPoints.length) {
        makeLineChart('tempChart', 'Max temp °C', tempPoints, '#ef4444');
    } else {
        // No temperature sensors — destroy any leftover chart and label the canvas.
        if (clientDetailState.charts.tempChart) {
            clientDetailState.charts.tempChart.destroy();
            delete clientDetailState.charts.tempChart;
        }
        const canvas = document.getElementById('tempChart');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#94a3b8';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('No temperature sensors reported', canvas.width / 2, canvas.height / 2);
        }
    }
}

function escapeHtml(s) {
    return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function renderRecentLogEvents(events) {
    const el = document.getElementById('recentLogEvents');
    if (!events || events.length === 0) {
        el.innerHTML = '<div class="errors-list-empty">No recent log events.</div>';
        return;
    }
    el.innerHTML = events.map(ev => `
        <div class="error-row ${ev.level}">
            <span class="ts">${new Date(ev.recorded_at).toLocaleString()}</span>
            <span class="target">[${escapeHtml(ev.target)}]</span>
            ${escapeHtml(ev.message)}
        </div>
    `).join('');
}

function initClientDetailModal() {
    document.getElementById('closeClientDetailModal').addEventListener('click', () => {
        destroyDetailCharts();
        closeModal('clientDetailModal');
    });
    document.getElementById('closeClientDetailBtn').addEventListener('click', () => {
        destroyDetailCharts();
        closeModal('clientDetailModal');
    });
    document.getElementById('openFetchLogsBtn').addEventListener('click', () => {
        document.getElementById('logTailViewer').textContent = '';
        openModal('fetchLogsModal');
    });
}

// ===== Fetch Logs Modal (admin-only) =====

function initFetchLogsModal() {
    document.getElementById('closeFetchLogsModal').addEventListener('click', () => closeModal('fetchLogsModal'));
    document.getElementById('closeFetchLogsBtn').addEventListener('click', () => closeModal('fetchLogsModal'));
    document.getElementById('confirmFetchLogs').addEventListener('click', async () => {
        const sizeEl = document.getElementById('logTailSize');
        const viewer = document.getElementById('logTailViewer');
        const maxBytes = parseInt(sizeEl.value, 10);
        const clientId = clientDetailState.clientId;
        if (!clientId) {
            showToast('No client selected', 'error');
            return;
        }
        viewer.textContent = 'Fetching logs from client…';
        try {
            const result = await apiCall(`/telemetry/clients/${clientId}/logs/fetch`, {
                method: 'POST',
                body: JSON.stringify({ max_bytes: maxBytes }),
            });
            viewer.textContent = (result && result.bytes) || '(no log data returned)';
        } catch (err) {
            console.error('Fetch logs failed:', err);
            viewer.textContent = `Failed to fetch logs: ${err.message}`;
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
            emptyEl.style.display = '';
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
                <div class="card-body group-detail-link" style="cursor:pointer" data-group-id="${group.id}">
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

        gridEl.querySelectorAll('.group-detail-link').forEach(el => {
            el.addEventListener('click', () => openGroupDetail(parseInt(el.dataset.groupId)));
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

let _scheduleViewMode = 'cards'; // 'cards' or 'calendar'

async function loadSchedules() {
    const gridEl = document.getElementById('schedulesGrid');
    const emptyEl = document.getElementById('schedulesEmpty');
    const calendarEl = document.getElementById('schedulesCalendar');

    if (_scheduleViewMode === 'cards') {
        gridEl.innerHTML = '<div class="loading">Loading schedules...</div>';
    }
    emptyEl.style.display = 'none';

    try {
        const schedules = await schedulesAPI.list();
        state.schedules = schedules;

        const filtered = filterSchedules(schedules);

        if (filtered.length === 0) {
            gridEl.innerHTML = '';
            calendarEl.innerHTML = '';
            emptyEl.style.display = '';
            return;
        }

        if (_scheduleViewMode === 'calendar') {
            renderScheduleCalendar(filtered);
            return;
        }

        gridEl.innerHTML = filtered.map(schedule => {
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

// ===== Schedule Calendar =====

const SCHEDULE_COLORS = [
    '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
    '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1'
];

// Map data day numbers (0=Sun) to Mon-Sun column order
const DAY_COL_MAP = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 0: 6 };
const CAL_DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function parseTime(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + (m || 0);
}

function filterSchedules(schedules) {
    const filterType = document.getElementById('scheduleViewFilter').value;
    const targetId = document.getElementById('scheduleTargetFilter').value;

    if (filterType === 'all') return schedules;

    return schedules.filter(s => {
        if (filterType === 'client') {
            return targetId ? s.client_id === targetId : !!s.client_id;
        }
        if (filterType === 'group') {
            return targetId ? s.group_id === parseInt(targetId) : !!s.group_id;
        }
        return true;
    });
}

function renderScheduleCalendar(schedules) {
    const container = document.getElementById('schedulesCalendar');
    const ROW_HEIGHT = 60; // px per hour

    // Build header
    let html = '<div class="calendar-scroll"><div class="calendar-grid">';
    html += '<div class="calendar-header-cell"></div>';
    for (const day of CAL_DAY_NAMES) {
        html += `<div class="calendar-header-cell">${day}</div>`;
    }

    // Build hour rows
    for (let hour = 0; hour < 24; hour++) {
        const label = String(hour).padStart(2, '0') + ':00';
        html += `<div class="calendar-time-label">${label}</div>`;
        for (let col = 0; col < 7; col++) {
            html += `<div class="calendar-day-cell" data-hour="${hour}" data-col="${col}"></div>`;
        }
    }
    html += '</div></div>';
    container.innerHTML = html;

    // Place schedule blocks
    const dayColumns = {};
    for (let col = 0; col < 7; col++) {
        dayColumns[col] = container.querySelectorAll(`.calendar-day-cell[data-col="${col}"]`);
    }

    schedules.forEach(schedule => {
        const startMin = parseTime(schedule.start_time);
        const endMin = schedule.end_time ? parseTime(schedule.end_time) : startMin + 60;
        const duration = Math.max(endMin - startMin, 1);
        const topPx = (startMin / 60) * ROW_HEIGHT;
        const heightPx = Math.max((duration / 60) * ROW_HEIGHT, 16);
        const color = SCHEDULE_COLORS[schedule.playlist_id % SCHEDULE_COLORS.length];
        const timeLabel = schedule.end_time
            ? `${schedule.start_time} - ${schedule.end_time}`
            : schedule.start_time;

        const days = schedule.days_of_week.split(',').map(d => parseInt(d));

        days.forEach(day => {
            const col = DAY_COL_MAP[day];
            if (col === undefined) return;

            // Find the cell for the starting hour to use as anchor
            const startHour = Math.floor(startMin / 60);
            const cell = dayColumns[col]?.[startHour];
            if (!cell) return;

            const offsetInCell = (startMin - startHour * 60) / 60 * ROW_HEIGHT;

            const block = document.createElement('div');
            block.className = 'calendar-block' + (schedule.enabled ? '' : ' disabled');
            block.style.backgroundColor = color;
            block.style.top = offsetInCell + 'px';
            block.style.height = heightPx + 'px';
            block.dataset.scheduleId = schedule.id;
            block.innerHTML = `<div class="calendar-block-name">${escapeHtml(schedule.name)}</div>` +
                (heightPx >= 28 ? `<div class="calendar-block-time">${timeLabel}</div>` : '');
            block.addEventListener('click', () => openEditSchedule(schedule.id));
            cell.appendChild(block);
        });
    });
}

function initScheduleCalendarView() {
    const cardBtn = document.getElementById('scheduleCardViewBtn');
    const calBtn = document.getElementById('scheduleCalendarViewBtn');
    const gridEl = document.getElementById('schedulesGrid');
    const calendarEl = document.getElementById('schedulesCalendar');
    const emptyEl = document.getElementById('schedulesEmpty');

    cardBtn.addEventListener('click', () => {
        _scheduleViewMode = 'cards';
        cardBtn.classList.add('active');
        calBtn.classList.remove('active');
        gridEl.style.display = '';
        calendarEl.style.display = 'none';
        loadSchedules();
    });

    calBtn.addEventListener('click', () => {
        _scheduleViewMode = 'calendar';
        calBtn.classList.add('active');
        cardBtn.classList.remove('active');
        gridEl.style.display = 'none';
        calendarEl.style.display = '';
        emptyEl.style.display = 'none';
        loadSchedules();
    });

    // Target filter
    const viewFilter = document.getElementById('scheduleViewFilter');
    const targetFilter = document.getElementById('scheduleTargetFilter');

    viewFilter.addEventListener('change', async () => {
        const type = viewFilter.value;
        if (type === 'all') {
            targetFilter.style.display = 'none';
            targetFilter.value = '';
            loadSchedules();
        } else {
            targetFilter.style.display = '';
            try {
                if (type === 'client') {
                    const clients = await clientAPI.list();
                    targetFilter.innerHTML = '<option value="">All Clients</option>' +
                        clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
                } else if (type === 'group') {
                    const groups = await groupsAPI.list();
                    targetFilter.innerHTML = '<option value="">All Groups</option>' +
                        groups.map(g => `<option value="${g.id}">${escapeHtml(g.name)}</option>`).join('');
                }
            } catch (e) {
                console.error('Failed to populate filter:', e);
            }
            loadSchedules();
        }
    });

    targetFilter.addEventListener('change', () => loadSchedules());
}

// ===== Live Previews =====

async function loadPreviews(clients) {
    const grid = document.getElementById('previewsGrid');
    if (!clients || clients.length === 0) {
        grid.innerHTML = '<p class="text-muted">No clients to preview</p>';
        return;
    }

    grid.innerHTML = clients.map(client => `
        <div class="preview-card" data-client-id="${client.id}" data-client-name="${escapeHtml(client.name || client.id)}">
            <img class="preview-img" data-preview-client="${client.id}" alt="${escapeHtml(client.name || client.id)}">
            <div class="preview-label">${escapeHtml(client.name || client.id.substring(0, 8))}</div>
        </div>
    `).join('');

    // Load preview images with auth
    for (const client of clients) {
        const img = grid.querySelector(`img[data-preview-client="${client.id}"]`);
        if (!img) continue;
        try {
            const headers = {};
            if (auth.token) headers['Authorization'] = 'Bearer ' + auth.token;
            const resp = await fetch(API_BASE + `/clients/${client.id}/preview?t=${Date.now()}`, { headers });
            if (!resp.ok) continue;
            const blob = await resp.blob();
            img.src = URL.createObjectURL(blob);
        } catch { /* keep empty */ }
    }

    grid.querySelectorAll('.preview-card').forEach(card => {
        card.addEventListener('click', () => enlargePreview(card.dataset.clientId, card.dataset.clientName));
    });
    grid.querySelectorAll('.preview-img').forEach(img => {
        img.addEventListener('error', () => {
            img.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 140"><rect fill="#222" width="200" height="140"/><text fill="#666" x="50%" y="50%" text-anchor="middle" dy=".3em" font-size="14">No Preview</text></svg>');
        });
    });
}

async function enlargePreview(clientId, clientName) {
    const modal = document.getElementById('previewEnlargeModal');
    document.getElementById('previewEnlargeTitle').textContent = clientName;
    try {
        const headers = {};
        if (auth.token) headers['Authorization'] = 'Bearer ' + auth.token;
        const resp = await fetch(API_BASE + `/clients/${clientId}/preview?t=${Date.now()}`, { headers });
        if (resp.ok) {
            const blob = await resp.blob();
            document.getElementById('previewEnlargeImg').src = URL.createObjectURL(blob);
        }
    } catch { /* ignore */ }
    modal.style.display = 'flex';
}

// ===== Notifications View =====

async function loadNotifications() {
    await Promise.all([loadNotificationRules(), loadNotificationHistory()]);
}

async function loadNotificationRules() {
    const el = document.getElementById('notificationRulesList');
    try {
        const rules = await apiCall('/notifications/rules');
        if (rules.length === 0) {
            el.innerHTML = '<p class="text-muted">No notification rules configured</p>';
            return;
        }
        el.innerHTML = rules.map(rule => `
            <div class="card">
                <div class="card-header">
                    <h3 class="card-title">
                        ${escapeHtml(rule.name)}
                        <span class="badge badge-${rule.enabled ? 'success' : 'secondary'}">${rule.enabled ? 'Active' : 'Disabled'}</span>
                    </h3>
                    <div class="card-actions">
                        <button class="btn btn-sm btn-danger delete-rule-btn" data-id="${rule.id}">Delete</button>
                    </div>
                </div>
                <div class="card-body">
                    <div class="card-meta">
                        <span>Event: ${rule.event_type}</span>
                        <span>Channel: ${rule.channel}</span>
                    </div>
                    <div class="card-meta">
                        <span>Destination: ${escapeHtml(rule.destination)}</span>
                    </div>
                </div>
            </div>
        `).join('');

        el.querySelectorAll('.delete-rule-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (confirm('Delete this notification rule?')) {
                    try {
                        await apiCall(`/notifications/rules/${btn.dataset.id}`, { method: 'DELETE' });
                        showToast('Rule deleted', 'success');
                        loadNotifications();
                    } catch (error) {
                        showToast('Failed to delete rule', 'error');
                    }
                }
            });
        });
    } catch (error) {
        el.innerHTML = '<p class="text-muted">Failed to load rules</p>';
    }
}

async function loadNotificationHistory() {
    const el = document.getElementById('notificationHistoryList');
    try {
        const history = await apiCall('/notifications/history?limit=20');
        if (history.length === 0) {
            el.innerHTML = '<p class="text-muted">No notifications sent yet</p>';
            return;
        }
        el.innerHTML = `<table class="analytics-table">
            <thead><tr><th>Event</th><th>Channel</th><th>Destination</th><th>Status</th><th>When</th></tr></thead>
            <tbody>${history.map(h => `<tr>
                <td>${h.event_type}</td>
                <td>${h.channel}</td>
                <td>${escapeHtml(h.destination).substring(0, 30)}${h.destination.length > 30 ? '...' : ''}</td>
                <td><span class="badge badge-${h.status === 'sent' ? 'success' : 'danger'}">${h.status}</span></td>
                <td>${formatRelativeTime(h.sent_at)}</td>
            </tr>`).join('')}</tbody>
        </table>`;
    } catch (error) {
        el.innerHTML = '<p class="text-muted">Failed to load history</p>';
    }
}

function initNotifications() {
    const modal = document.getElementById('createRuleModal');

    document.getElementById('createRuleBtn').addEventListener('click', () => {
        document.getElementById('ruleName').value = '';
        document.getElementById('ruleDestination').value = '';
        modal.style.display = 'flex';
    });

    document.getElementById('closeRuleModal').addEventListener('click', () => { modal.style.display = 'none'; });
    document.getElementById('cancelRuleModal').addEventListener('click', () => { modal.style.display = 'none'; });

    document.getElementById('saveRuleBtn').addEventListener('click', async () => {
        const name = document.getElementById('ruleName').value.trim();
        const event_type = document.getElementById('ruleEventType').value;
        const channel = document.getElementById('ruleChannel').value;
        const destination = document.getElementById('ruleDestination').value.trim();

        if (!name || !destination) {
            showToast('Name and destination are required', 'error');
            return;
        }

        try {
            await apiCall('/notifications/rules', {
                method: 'POST',
                body: JSON.stringify({ name, event_type, channel, destination })
            });
            showToast('Rule created', 'success');
            modal.style.display = 'none';
            loadNotifications();
        } catch (error) {
            showToast(error.message || 'Failed to create rule', 'error');
        }
    });
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

// ===== Authentication =====

function showAuthScreen(type) {
    document.body.classList.add('auth-active');
    document.getElementById('login-view').style.display = type === 'login' ? '' : 'none';
    document.getElementById('setup-view').style.display = type === 'setup' ? '' : 'none';
}

function hideAuthScreens() {
    document.body.classList.remove('auth-active');
    document.getElementById('login-view').style.display = 'none';
    document.getElementById('setup-view').style.display = 'none';
}

async function checkAuthStatus() {
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (auth.token) headers['Authorization'] = 'Bearer ' + auth.token;

        const response = await fetch(API_BASE + '/auth/me', { headers });

        if (response.status === 401) {
            auth.token = null;
            localStorage.removeItem('montr_token');
            showAuthScreen('login');
            return false;
        }

        const data = await response.json();

        if (data.data === null) {
            // Bootstrap mode — no users exist
            showAuthScreen('setup');
            return false;
        }

        // Authenticated
        auth.user = data.data;
        hideAuthScreens();
        return true;
    } catch {
        showAuthScreen('login');
        return false;
    }
}

function initAuthForms() {
    const loginForm = document.getElementById('loginForm');
    const setupForm = document.getElementById('setupForm');

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorEl = document.getElementById('loginError');
        errorEl.style.display = 'none';

        const username = document.getElementById('loginUsername').value;
        const password = document.getElementById('loginPassword').value;

        try {
            const response = await fetch(API_BASE + '/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await response.json();

            if (!response.ok) {
                errorEl.textContent = data.error?.message || 'Login failed';
                errorEl.style.display = 'block';
                return;
            }

            auth.token = data.data.token;
            auth.user = data.data.user;
            localStorage.setItem('montr_token', auth.token);
            hideAuthScreens();
            initApp();
        } catch (err) {
            errorEl.textContent = 'Connection failed';
            errorEl.style.display = 'block';
        }
    });

    setupForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorEl = document.getElementById('setupError');
        errorEl.style.display = 'none';

        const username = document.getElementById('setupUsername').value;
        const email = document.getElementById('setupEmail').value;
        const password = document.getElementById('setupPassword').value;
        const confirmPassword = document.getElementById('setupConfirmPassword').value;

        if (password !== confirmPassword) {
            errorEl.textContent = 'Passwords do not match';
            errorEl.style.display = 'block';
            return;
        }

        try {
            const response = await fetch(API_BASE + '/auth/setup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, email, password })
            });
            const data = await response.json();

            if (!response.ok) {
                errorEl.textContent = data.error?.message || 'Setup failed';
                errorEl.style.display = 'block';
                return;
            }

            auth.token = data.data.token;
            auth.user = data.data.user;
            localStorage.setItem('montr_token', auth.token);
            hideAuthScreens();
            initApp();
        } catch (err) {
            errorEl.textContent = 'Connection failed';
            errorEl.style.display = 'block';
        }
    });
}

function logout() {
    auth.token = null;
    auth.user = null;
    localStorage.removeItem('montr_token');
    showAuthScreen('login');
    document.getElementById('navUser').style.display = 'none';
}

function applyRolePermissions() {
    const role = auth.user?.role;

    // Admin-only elements
    document.querySelectorAll('.admin-only').forEach(el => {
        el.style.display = role === 'admin' ? '' : 'none';
    });

    // Editor+ elements (hidden from viewers)
    document.querySelectorAll('.editor-action').forEach(el => {
        el.style.display = (role === 'admin' || role === 'editor') ? '' : 'none';
    });

    // Show user menu
    const navUser = document.getElementById('navUser');
    if (auth.user) {
        document.getElementById('navUsername').textContent = auth.user.username;
        document.getElementById('navUserRole').textContent = auth.user.role;
        navUser.style.display = '';
    }
}

function initUserMenu() {
    const btn = document.getElementById('navUserBtn');
    const dropdown = document.getElementById('navUserDropdown');

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('active');
    });

    document.addEventListener('click', () => {
        dropdown.classList.remove('active');
    });

    document.getElementById('logoutLink').addEventListener('click', (e) => {
        e.preventDefault();
        logout();
    });

    document.getElementById('changePasswordLink').addEventListener('click', (e) => {
        e.preventDefault();
        dropdown.classList.remove('active');
        openModal('changePasswordModal');
    });
}

function initChangePasswordModal() {
    const closeBtn = document.getElementById('closeChangePasswordModal');
    const cancelBtn = document.getElementById('cancelChangePassword');
    const saveBtn = document.getElementById('saveChangePassword');

    closeBtn.addEventListener('click', () => closeModal('changePasswordModal'));
    cancelBtn.addEventListener('click', () => closeModal('changePasswordModal'));

    saveBtn.addEventListener('click', async () => {
        const currentPassword = document.getElementById('currentPassword').value;
        const newPassword = document.getElementById('newPassword').value;
        const confirmNewPassword = document.getElementById('confirmNewPassword').value;

        if (!currentPassword || !newPassword) {
            showToast('Please fill in all fields', 'error');
            return;
        }

        if (newPassword !== confirmNewPassword) {
            showToast('New passwords do not match', 'error');
            return;
        }

        if (newPassword.length < 8) {
            showToast('Password must be at least 8 characters', 'error');
            return;
        }

        try {
            await apiCall('/auth/password', {
                method: 'PUT',
                body: JSON.stringify({ currentPassword, newPassword })
            });
            showToast('Password changed successfully', 'success');
            closeModal('changePasswordModal');
            document.getElementById('changePasswordForm').reset();
        } catch (error) {
            showToast(error.message || 'Failed to change password', 'error');
        }
    });
}

// ===== User Management (Admin) =====

const usersAPI = {
    async list() {
        return await apiCall('/users');
    },
    async create(data) {
        return await apiCall('/users', {
            method: 'POST',
            body: JSON.stringify(data)
        });
    },
    async delete(id) {
        return await apiCall(`/users/${id}`, { method: 'DELETE' });
    }
};

// ===== Approvals View =====

let _rejectMediaId = null;

async function loadApprovals() {
    const grid = document.getElementById('approvalsGrid');
    const empty = document.getElementById('approvalsEmpty');
    grid.innerHTML = '<div class="loading">Loading approvals...</div>';
    empty.style.display = 'none';

    try {
        const filter = document.getElementById('approvalStatusFilter').value;
        let media;
        if (filter === 'pending') {
            media = await approvalsAPI.listPending();
        } else {
            const all = await mediaAPI.list();
            media = filter === 'all' ? all : all.filter(m => m.approval_status === filter);
        }

        if (!media || media.length === 0) {
            grid.innerHTML = '';
            empty.style.display = '';
            return;
        }

        grid.innerHTML = media.map(m => renderApprovalCard(m)).join('');
        attachApprovalHandlers();
    } catch (error) {
        console.error('Failed to load approvals:', error);
        grid.innerHTML = '<div class="empty-state"><p>Failed to load approvals</p></div>';
    }
}

function renderApprovalCard(media) {
    const statusBadge = {
        pending: 'badge-warning',
        approved: 'badge-success',
        rejected: 'badge-danger'
    }[media.approval_status] || 'badge-info';

    const typeBadge = media.type === 'video'
        ? '<span class="badge badge-info">Video</span>'
        : '<span class="badge badge-secondary">Image</span>';

    const size = media.file_size ? formatFileSize(media.file_size) : 'Unknown size';
    const date = formatDate(media.created_at);
    const isPending = media.approval_status === 'pending';

    return `
        <div class="card approval-card">
            <div class="card-body" style="display:flex; align-items:center; gap:1rem;">
                <div style="flex:1; min-width:0;">
                    <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.25rem;">
                        <strong style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${media.original_filename || media.filename}</strong>
                        ${typeBadge}
                        <span class="badge ${statusBadge}">${media.approval_status}</span>
                    </div>
                    <div class="text-muted" style="font-size:0.85rem;">${size} &middot; Uploaded ${date}</div>
                </div>
                <div style="display:flex; gap:0.5rem; flex-shrink:0;">
                    ${isPending ? `
                        <button class="btn btn-sm btn-success approve-btn" data-id="${media.id}">Approve</button>
                        <button class="btn btn-sm btn-danger reject-btn" data-id="${media.id}" data-name="${media.original_filename || media.filename}">Reject</button>
                    ` : ''}
                    <button class="btn btn-sm btn-secondary history-btn" data-id="${media.id}">History</button>
                </div>
            </div>
        </div>
    `;
}

function attachApprovalHandlers() {
    document.querySelectorAll('.approve-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            try {
                await approvalsAPI.approve(parseInt(btn.dataset.id));
                showToast('Media approved', 'success');
                loadApprovals();
            } catch (error) {
                showToast(error.message || 'Failed to approve', 'error');
            }
        });
    });

    document.querySelectorAll('.reject-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            _rejectMediaId = parseInt(btn.dataset.id);
            document.getElementById('rejectMediaName').textContent = btn.dataset.name;
            document.getElementById('rejectComment').value = '';
            openModal('rejectModal');
        });
    });

    document.querySelectorAll('.history-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            try {
                const logs = await approvalsAPI.getLogs(parseInt(btn.dataset.id));
                renderApprovalHistory(logs || []);
                openModal('approvalHistoryModal');
            } catch (error) {
                showToast(error.message || 'Failed to load history', 'error');
            }
        });
    });
}

function renderApprovalHistory(logs) {
    const container = document.getElementById('approvalHistoryContent');
    if (!logs || logs.length === 0) {
        container.innerHTML = '<p class="text-muted">No approval history for this file.</p>';
        return;
    }

    container.innerHTML = `
        <table class="data-table">
            <thead>
                <tr>
                    <th>Action</th>
                    <th>Comment</th>
                    <th>Date</th>
                </tr>
            </thead>
            <tbody>
                ${logs.map(log => `
                    <tr>
                        <td><span class="badge badge-${log.action === 'approved' ? 'success' : log.action === 'rejected' ? 'danger' : 'warning'}">${log.action}</span></td>
                        <td>${log.comment || '<span class="text-muted">-</span>'}</td>
                        <td>${formatDate(log.timestamp)}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

function initApprovals() {
    // Filter change
    document.getElementById('approvalStatusFilter').addEventListener('change', loadApprovals);

    // Reject modal
    document.getElementById('closeRejectModal').addEventListener('click', () => closeModal('rejectModal'));
    document.getElementById('cancelRejectModal').addEventListener('click', () => closeModal('rejectModal'));
    document.getElementById('confirmRejectBtn').addEventListener('click', async () => {
        if (!_rejectMediaId) return;
        const comment = document.getElementById('rejectComment').value.trim();
        try {
            await approvalsAPI.reject(_rejectMediaId, comment);
            showToast('Media rejected', 'success');
            closeModal('rejectModal');
            _rejectMediaId = null;
            loadApprovals();
        } catch (error) {
            showToast(error.message || 'Failed to reject', 'error');
        }
    });

    // History modal
    document.getElementById('closeApprovalHistoryModal').addEventListener('click', () => closeModal('approvalHistoryModal'));
    document.getElementById('closeApprovalHistoryBtn').addEventListener('click', () => closeModal('approvalHistoryModal'));
}

// ===== User Management =====

async function loadUsers() {
    const grid = document.getElementById('usersGrid');
    grid.innerHTML = '<div class="loading">Loading users...</div>';

    try {
        const users = await usersAPI.list();
        renderUsersGrid(users || []);
    } catch (error) {
        console.error('Failed to load users:', error);
        grid.innerHTML = '<div class="empty-state"><p>Failed to load users</p></div>';
    }
}

function renderUsersGrid(users) {
    const grid = document.getElementById('usersGrid');

    if (!users || users.length === 0) {
        grid.innerHTML = '<div class="empty-state"><p>No users found</p></div>';
        return;
    }

    grid.innerHTML = `
        <table class="data-table">
            <thead>
                <tr>
                    <th>Username</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Created</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${users.map(user => `
                    <tr>
                        <td><strong>${user.username}</strong>${user.id === auth.user?.id ? ' <span class="badge badge-info">you</span>' : ''}</td>
                        <td>${user.email}</td>
                        <td><span class="badge badge-${user.role === 'admin' ? 'danger' : user.role === 'editor' ? 'warning' : 'info'}">${user.role}</span></td>
                        <td>${formatDate(user.created_at)}</td>
                        <td>
                            ${user.id !== auth.user?.id
                                ? `<button class="btn btn-sm btn-danger delete-user-btn" data-id="${user.id}" data-username="${user.username}">Delete</button>`
                                : ''}
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;

    grid.querySelectorAll('.delete-user-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const username = btn.dataset.username;
            if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
            try {
                await usersAPI.delete(parseInt(btn.dataset.id));
                showToast(`User "${username}" deleted`, 'success');
                loadUsers();
            } catch (error) {
                showToast(error.message || 'Failed to delete user', 'error');
            }
        });
    });
}

function initCreateUserModal() {
    const createBtn = document.getElementById('createUserBtn');
    const closeBtn = document.getElementById('closeCreateUserModal');
    const cancelBtn = document.getElementById('cancelCreateUserModal');
    const saveBtn = document.getElementById('saveCreateUserBtn');

    createBtn.addEventListener('click', () => openModal('createUserModal'));
    closeBtn.addEventListener('click', () => closeModal('createUserModal'));
    cancelBtn.addEventListener('click', () => closeModal('createUserModal'));

    saveBtn.addEventListener('click', async () => {
        const username = document.getElementById('newUserUsername').value;
        const email = document.getElementById('newUserEmail').value;
        const password = document.getElementById('newUserPassword').value;
        const role = document.getElementById('newUserRole').value;

        if (!username || !email || !password) {
            showToast('Please fill in all fields', 'error');
            return;
        }

        try {
            await usersAPI.create({ username, email, password, role });
            showToast(`User "${username}" created`, 'success');
            closeModal('createUserModal');
            document.getElementById('createUserForm').reset();
            loadUsers();
        } catch (error) {
            showToast(error.message || 'Failed to create user', 'error');
        }
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

    // Initialize auth forms (always needed)
    initAuthForms();
    initUserMenu();
    initChangePasswordModal();

    // Check auth status
    const authenticated = await checkAuthStatus();
    if (!authenticated) {
        console.log('Auth required — showing login/setup');
        return;
    }

    // User is authenticated — initialize the app
    initApp();
}

function initApp() {
    // Apply role-based visibility
    applyRolePermissions();

    // Initialize navigation
    initNavigation();

    // Initialize media functionality
    initMediaSearch();
    initMediaUpload();
    initMediaPreviewModal();

    // Initialize playlist functionality
    initCreatePlaylist();
    initPlaylistDetailModal();

    // Initialize client functionality
    initRefreshClients();
    initAssignPlaylistModal();
    initClientDetailModal();
    initFetchLogsModal();

    // Initialize group functionality
    initGroupModals();

    // Initialize schedule functionality
    initScheduleModal();
    initScheduleCalendarView();

    // Initialize client control modal
    initClientControlModal();

    // Initialize analytics
    initAnalytics();

    // Initialize notifications
    initNotifications();

    // Initialize approvals (admin only)
    initApprovals();

    // Initialize user management (admin only)
    initCreateUserModal();

    // Wire up empty state buttons
    document.getElementById('emptyUploadBtn')?.addEventListener('click', () => {
        document.getElementById('uploadBtn').click();
    });
    document.getElementById('emptyCreatePlaylistBtn')?.addEventListener('click', () => {
        document.getElementById('createPlaylistBtn').click();
    });

    // Wire up preview enlarge modal
    const previewModal = document.getElementById('previewEnlargeModal');
    previewModal?.addEventListener('click', () => { previewModal.style.display = 'none'; });
    previewModal?.querySelector('.modal-content')?.addEventListener('click', (e) => e.stopPropagation());
    document.getElementById('closePreviewEnlarge')?.addEventListener('click', () => { previewModal.style.display = 'none'; });

    // Load initial view
    loadDashboard();

    // Start auto-refresh for the current view
    startAutoRefresh();

    // Pause refresh when tab is hidden, resume when visible
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            stopAutoRefresh();
        } else {
            startAutoRefresh();
        }
    });

    // Connect admin WebSocket for real-time updates
    connectAdminWebSocket();

    console.log('Montr Web UI initialized successfully');
}

// ===== Admin WebSocket for Real-Time Updates =====

let adminWs = null;

function connectAdminWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    try {
        adminWs = new WebSocket(wsUrl);

        adminWs.onopen = () => {
            adminWs.send(JSON.stringify({ type: 'admin_register' }));
            console.log('Admin WebSocket connected');
        };

        adminWs.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                handleAdminMessage(msg);
            } catch (e) {
                // Ignore parse errors
            }
        };

        adminWs.onclose = () => {
            console.log('Admin WebSocket disconnected, reconnecting in 5s...');
            setTimeout(connectAdminWebSocket, 5000);
        };

        adminWs.onerror = () => {
            // onclose will fire after onerror
        };
    } catch (e) {
        setTimeout(connectAdminWebSocket, 5000);
    }
}

function handleAdminMessage(msg) {
    if (msg.type === 'client_status_update') {
        // Update client card in-place if on clients page
        updateClientCardStatus(msg.clientId, msg);

        // Update detail modal if open for this client
        if (window.montrDashboard && window.montrDashboard.updateClientStatus) {
            window.montrDashboard.updateClientStatus(msg.clientId, msg);
        }
    } else if (msg.type === 'client_state_change') {
        // Client went online/offline — update badge in-place
        updateClientCardState(msg.clientId, msg.status);

        // Notify dashboard if open
        if (window.montrDashboard && window.montrDashboard.updateClientState) {
            window.montrDashboard.updateClientState(msg.clientId, msg.status);
        }
    }
}

function updateClientCardStatus(clientId, status) {
    // Find the client card's status section and update in-place
    const card = document.querySelector(`[data-client-id-card="${clientId}"]`);
    if (!card) return;

    const posEl = card.querySelector('.live-position');
    if (posEl && status.position !== null && status.position !== undefined) {
        posEl.textContent = formatDuration(status.position);
    }

    const stateEl = card.querySelector('.live-state');
    if (stateEl) {
        stateEl.textContent = status.isPlaying ? 'Playing' : 'Paused';
    }

    const mediaEl = card.querySelector('.live-media');
    if (mediaEl && status.currentMedia) {
        mediaEl.textContent = status.currentMedia.filename;
    }
}

function updateClientCardState(clientId, newStatus) {
    // Update the status badge on the client card
    const card = document.querySelector(`[data-client-id-card="${clientId}"]`);
    if (!card) return;

    const badge = card.querySelector('.status-badge');
    if (badge) {
        badge.textContent = newStatus;
        badge.className = `badge status-badge badge-${newStatus === 'online' ? 'success' : 'secondary'}`;
    }
}

// Start the application when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
