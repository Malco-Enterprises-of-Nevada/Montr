// ===== Montr Web UI Application =====

// Configuration
const API_BASE = window.location.origin + '/api';
const WS_URL = `ws://${window.location.host}/ws`;

// UI configuration (loaded from server, with fallback defaults)
let UI_CONFIG = {
    dashboardRefreshInterval: 30000,
    toastDisplayDuration: 3000,
    mediaUploadConcurrency: 2,
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
    folders: [],           // flat list from GET /api/folders
    currentFolderId: null, // null = All media (no folder filter), 'root' = folder_id IS NULL, or number
    selectedMediaIds: new Set(),
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

// Per-chunk upload with retry + abort support. Called by mediaAPI.upload for
// chunked uploads; lives here so it's close to the XHR code it drives.
function _uploadChunkWithRetry({ uploadId, chunkIndex, chunk, fileSize, alreadyUploaded, onProgress, signal, totalChunks }) {
    const MAX_ATTEMPTS = 3;
    const BACKOFFS_MS = [1000, 3000, 8000];

    return new Promise((resolve, reject) => {
        let attempt = 0;
        let currentXhr = null;
        const onAbort = () => {
            if (currentXhr) currentXhr.abort();
        };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });

        const attemptUpload = () => {
            if (signal?.aborted) return reject(new Error('Upload cancelled'));
            attempt += 1;
            const xhr = new XMLHttpRequest();
            currentXhr = xhr;

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable && onProgress) {
                    onProgress(((alreadyUploaded + e.loaded) / fileSize) * 100);
                }
            });

            xhr.addEventListener('load', () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve();
                } else if (attempt < MAX_ATTEMPTS && xhr.status >= 500) {
                    setTimeout(attemptUpload, BACKOFFS_MS[attempt - 1] || 8000);
                } else {
                    reject(new Error(`Chunk ${chunkIndex + 1}/${totalChunks} failed (HTTP ${xhr.status})`));
                }
            });

            xhr.addEventListener('error', () => {
                if (attempt < MAX_ATTEMPTS && !signal?.aborted) {
                    setTimeout(attemptUpload, BACKOFFS_MS[attempt - 1] || 8000);
                } else {
                    reject(new Error(`Chunk ${chunkIndex + 1}/${totalChunks} failed`));
                }
            });

            xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

            xhr.open('POST', `${API_BASE}/media/upload/${uploadId}/chunk/${chunkIndex}`);
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            if (auth.token) xhr.setRequestHeader('Authorization', 'Bearer ' + auth.token);
            xhr.send(chunk);
        };

        attemptUpload();
    });
}

// Folders API
const foldersAPI = {
    async list() {
        return await apiCall('/folders');
    },
    async create(name, parentId) {
        return await apiCall('/folders', {
            method: 'POST',
            body: JSON.stringify({ name, parent_id: parentId ?? null }),
        });
    },
    async update(id, updates) {
        return await apiCall(`/folders/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(updates),
        });
    },
    async remove(id, { recursive = false } = {}) {
        const qs = recursive ? '?recursive=true' : '';
        return await apiCall(`/folders/${id}${qs}`, { method: 'DELETE' });
    },
};

// Media API
const mediaAPI = {
    async list(params = {}) {
        const query = new URLSearchParams();
        if (params.folderId !== undefined && params.folderId !== null) {
            query.set('folder_id', String(params.folderId));
        }
        if (params.type) query.set('type', params.type);
        if (params.search) query.set('search', params.search);
        if (params.page) query.set('page', String(params.page));
        if (params.limit) query.set('limit', String(params.limit));
        const qs = query.toString();
        return await apiCall(`/media${qs ? '?' + qs : ''}`);
    },

    // upload() is called per-file. Parallelism is controlled by the UploadQueue.
    // opts: { folderId?: number|'root'|null, onProgress?: fn, signal?: AbortSignal }
    async upload(file, opts = {}) {
        const CHUNK_SIZE = 50 * 1024 * 1024; // 50MB
        const { folderId, onProgress, signal } = opts;
        const folderPayload = (folderId === 'root' || folderId == null) ? null : Number(folderId);

        // Small files: use simple upload
        if (file.size <= CHUNK_SIZE) {
            return this._simpleUpload(file, { folderId: folderPayload, onProgress, signal });
        }

        // Large files: chunked upload
        const { uploadId, chunkSize, totalChunks } = await apiCall('/media/upload/init', {
            method: 'POST',
            body: JSON.stringify({
                filename: file.name,
                mimeType: file.type || 'application/octet-stream',
                totalSize: file.size,
                folder_id: folderPayload,
            }),
        });

        // Track the uploadId so the caller can abort us if needed
        if (signal) {
            signal.addEventListener('abort', () => {
                // Best-effort server-side cleanup; failure is non-fatal
                apiCall(`/media/upload/${uploadId}`, { method: 'DELETE' }).catch(() => {});
            }, { once: true });
        }

        let totalUploaded = 0;

        for (let i = 0; i < totalChunks; i++) {
            if (signal?.aborted) throw new Error('Upload cancelled');

            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, file.size);
            const chunk = file.slice(start, end);

            // Per-chunk retry (3 attempts, exponential backoff). Server tracks
            // receivedChunks per uploadId so re-POSTing is idempotent.
            await _uploadChunkWithRetry({
                uploadId,
                chunkIndex: i,
                chunk,
                fileSize: file.size,
                alreadyUploaded: totalUploaded,
                onProgress,
                signal,
                totalChunks,
            });

            totalUploaded += (end - start);
        }

        return await apiCall(`/media/upload/${uploadId}/complete`, { method: 'POST' });
    },

    _simpleUpload(file, opts = {}) {
        const { folderId, onProgress, signal } = opts;
        const formData = new FormData();
        formData.append('files', file);
        if (folderId != null) formData.append('folder_id', String(folderId));

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
                    let msg = 'Upload failed';
                    try {
                        const parsed = JSON.parse(xhr.responseText);
                        if (parsed?.error?.message) msg = parsed.error.message;
                    } catch {}
                    reject(new Error(msg));
                }
            });

            xhr.addEventListener('error', () => reject(new Error('Upload failed')));
            xhr.addEventListener('abort', () => reject(new Error('Upload cancelled')));

            if (signal) {
                if (signal.aborted) {
                    xhr.abort();
                    return;
                }
                signal.addEventListener('abort', () => xhr.abort(), { once: true });
            }

            xhr.open('POST', API_BASE + '/media/upload');
            if (auth.token) xhr.setRequestHeader('Authorization', 'Bearer ' + auth.token);
            xhr.send(formData);
        });
    },

    async delete(id) {
        return await apiCall(`/media/${id}`, { method: 'DELETE' });
    },

    async update(id, updates) {
        return await apiCall(`/media/${id}`, {
            method: 'PATCH',
            body: JSON.stringify(updates),
        });
    },

    async bulkMove(mediaIds, folderId) {
        return await apiCall('/media/bulk/move', {
            method: 'POST',
            body: JSON.stringify({
                media_ids: mediaIds,
                folder_id: folderId === 'root' || folderId == null ? null : Number(folderId),
            }),
        });
    },

    async bulkDelete(mediaIds) {
        return await apiCall('/media/bulk/delete', {
            method: 'POST',
            body: JSON.stringify({ media_ids: mediaIds }),
        });
    },

    async retryThumbnail(id) {
        return await apiCall(`/media/${id}/thumbnail/retry`, { method: 'POST' });
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
    },

    async remove(id) {
        return await apiCall(`/clients/${id}`, { method: 'DELETE' });
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

const scheduleTemplatesAPI = {
    async list() {
        return await apiCall('/schedule-templates');
    },
    async instantiate(id, body) {
        return await apiCall(`/schedule-templates/${id}/instantiate`, {
            method: 'POST',
            body: JSON.stringify(body),
        });
    },
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

    async simulate(id, from, to) {
        const q = new URLSearchParams();
        if (from) q.set('from', from);
        if (to) q.set('to', to);
        return await apiCall(`/schedules/${id}/simulate?${q.toString()}`, { method: 'POST' });
    },

    async simulateAll(from, to, client_id, group_id) {
        const q = new URLSearchParams();
        if (from) q.set('from', from);
        if (to) q.set('to', to);
        if (client_id) q.set('client_id', client_id);
        if (group_id) q.set('group_id', String(group_id));
        return await apiCall(`/schedules/simulate?${q.toString()}`);
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

    // Load folders in parallel with media so the tree stays fresh.
    const folderPromise = loadFolders();

    try {
        const params = { limit: 100 };
        // currentFolderId: null = show all media, 'root' = only root, number = that folder
        if (state.currentFolderId === 'root') params.folderId = 'root';
        else if (typeof state.currentFolderId === 'number') params.folderId = state.currentFolderId;
        // apiCall unwraps .data, so response is either an array (old shape)
        // or { data: [...], pagination: {...} } (paginated shape).
        const response = await mediaAPI.list(params);
        const media = Array.isArray(response) ? response : (response?.data || []);
        state.media = media;
        renderMediaGrid(media);
    } catch (error) {
        console.error('Failed to load media:', error);
        showToast('Failed to load media files', 'error');
        gridEl.innerHTML = '<div class="empty-state"><p>Failed to load media files</p></div>';
    }

    await folderPromise;
    renderFolderTree();
    renderFolderBreadcrumb();
}

async function loadFolders() {
    try {
        // apiCall unwraps to the `data` field — /api/folders returns an array.
        const resp = await foldersAPI.list();
        state.folders = Array.isArray(resp) ? resp : [];
    } catch (err) {
        console.warn('Failed to load folders:', err);
        state.folders = [];
    }
}

function renderMediaGrid(media) {
    const gridEl = document.getElementById('mediaGrid');
    const emptyEl = document.getElementById('mediaEmpty');

    if (!media || media.length === 0) {
        gridEl.innerHTML = '';
        emptyEl.style.display = '';
        updateBulkActionBar();
        return;
    }

    emptyEl.style.display = 'none';

    const videoIcon = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
    const imageIcon = `<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>`;
    const canEdit = auth.user?.role !== 'viewer';

    gridEl.innerHTML = media.map(item => {
        const displayName = item.original_filename || item.filename;
        const isSelected = state.selectedMediaIds.has(item.id);
        const thumbFailed = item.thumbnail_status === 'failed';
        return `
        <div class="media-item${isSelected ? ' selected' : ''}" data-id="${item.id}">
            ${canEdit ? `<label class="media-select"><input type="checkbox" class="media-select-cb" data-id="${item.id}"${isSelected ? ' checked' : ''}></label>` : ''}
            <div class="media-thumbnail" data-id="${item.id}">
                <img class="thumb-img" data-thumb-id="${item.id}" alt="" style="display:none">
                <div class="thumb-fallback">${item.type === 'video' ? videoIcon : imageIcon}</div>
                ${item.type === 'video' ? '<div class="thumb-play-badge">&#9654;</div>' : ''}
                ${thumbFailed ? `<button class="thumb-retry-btn" data-retry-id="${item.id}" title="Thumbnail failed — click to retry">&#8634;</button>` : ''}
            </div>
            <div class="media-info">
                <div class="media-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
                <div class="media-meta">
                    <span class="badge badge-info">${item.type}</span>
                    <span>${item.file_size ? formatFileSize(item.file_size) : 'N/A'}${item.duration ? ' / ' + formatDuration(item.duration) : ''}</span>
                </div>
            </div>
            <div class="media-actions">
                <button class="btn btn-sm btn-secondary media-download-btn" data-id="${item.id}">
                    Download
                </button>
                ${canEdit ? `<button class="btn btn-sm btn-danger media-delete-btn" data-id="${item.id}">
                    Delete
                </button>` : ''}
            </div>
        </div>`;
    }).join('');

    // Click media item to open preview (but not when clicking checkbox/buttons)
    gridEl.querySelectorAll('.media-item').forEach(el => {
        el.addEventListener('click', (e) => {
            if (e.target.closest('.media-select') ||
                e.target.closest('.media-actions') ||
                e.target.closest('.thumb-retry-btn')) return;
            openMediaPreview(parseInt(el.dataset.id));
        });
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
    gridEl.querySelectorAll('.media-select-cb').forEach((cb) => {
        cb.addEventListener('change', (e) => {
            const id = parseInt(e.target.dataset.id);
            if (e.target.checked) state.selectedMediaIds.add(id);
            else state.selectedMediaIds.delete(id);
            // Re-render the selected highlight only
            const card = gridEl.querySelector(`.media-item[data-id="${id}"]`);
            if (card) card.classList.toggle('selected', e.target.checked);
            updateBulkActionBar();
        });
    });
    gridEl.querySelectorAll('.thumb-retry-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = parseInt(btn.dataset.retryId);
            btn.disabled = true;
            try {
                await mediaAPI.retryThumbnail(id);
                showToast('Thumbnail retry queued', 'success');
                setTimeout(loadMedia, 1500);
            } catch (err) {
                console.error('Thumbnail retry failed:', err);
                showToast('Thumbnail retry failed', 'error');
                btn.disabled = false;
            }
        });
    });

    // Load thumbnails asynchronously
    loadThumbnails(media);
    updateBulkActionBar();
}

// ===== Folder Tree =====

function renderFolderTree() {
    const tree = document.getElementById('folderTree');
    if (!tree) return;

    const roots = state.folders.filter((f) => f.parent_id == null);
    const byParent = new Map();
    for (const f of state.folders) {
        const p = f.parent_id ?? 'root';
        if (!byParent.has(p)) byParent.set(p, []);
        byParent.get(p).push(f);
    }

    const renderLevel = (parentKey, depth) =>
        (byParent.get(parentKey) || [])
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((f) => {
                const active = state.currentFolderId === f.id ? ' active' : '';
                const childrenHtml = renderLevel(f.id, depth + 1);
                return `
                    <li class="folder-node${active}" data-folder-id="${f.id}" style="padding-left:${depth * 14}px">
                        <span class="folder-label" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
                        ${canEditFolders() ? `<span class="folder-node-actions">
                            <button class="folder-rename" data-folder-id="${f.id}" title="Rename">&#9998;</button>
                            <button class="folder-delete" data-folder-id="${f.id}" title="Delete">&times;</button>
                        </span>` : ''}
                    </li>
                    ${childrenHtml}
                `;
            })
            .join('');

    const allActive = state.currentFolderId == null ? ' active' : '';
    const rootActive = state.currentFolderId === 'root' ? ' active' : '';
    tree.innerHTML = `
        <li class="folder-node folder-node-root${allActive}" data-folder-id=""><span class="folder-label">All media</span></li>
        <li class="folder-node folder-node-root${rootActive}" data-folder-id="root"><span class="folder-label">&#128193; Root</span></li>
        ${renderLevel('root', 0)}
    `;

    tree.querySelectorAll('.folder-node').forEach((li) => {
        li.addEventListener('click', (e) => {
            if (e.target.closest('.folder-node-actions')) return;
            const raw = li.dataset.folderId;
            if (raw === '') state.currentFolderId = null;
            else if (raw === 'root') state.currentFolderId = 'root';
            else state.currentFolderId = Number(raw);
            state.selectedMediaIds.clear();
            loadMedia();
        });
    });
    tree.querySelectorAll('.folder-rename').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = Number(btn.dataset.folderId);
            const folder = state.folders.find((f) => f.id === id);
            const name = prompt('Rename folder', folder?.name || '');
            if (!name || name === folder?.name) return;
            try {
                await foldersAPI.update(id, { name: name.trim() });
                showToast('Folder renamed', 'success');
                loadMedia();
            } catch (err) {
                showToast(err.message || 'Rename failed', 'error');
            }
        });
    });
    tree.querySelectorAll('.folder-delete').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = Number(btn.dataset.folderId);
            await deleteFolderFlow(id);
        });
    });
}

async function deleteFolderFlow(id) {
    const folder = state.folders.find((f) => f.id === id);
    if (!folder) return;
    if (!confirm(`Delete folder "${folder.name}"?`)) return;
    try {
        await foldersAPI.remove(id);
        showToast('Folder deleted', 'success');
        if (state.currentFolderId === id) state.currentFolderId = null;
        loadMedia();
    } catch (err) {
        if (err?.code === 'FOLDER_NOT_EMPTY' || /not empty/i.test(err.message || '')) {
            if (confirm(`"${folder.name}" is not empty. Delete it and move its media to Root?`)) {
                try {
                    await foldersAPI.remove(id, { recursive: true });
                    showToast('Folder deleted', 'success');
                    if (state.currentFolderId === id) state.currentFolderId = null;
                    loadMedia();
                } catch (err2) {
                    showToast(err2.message || 'Delete failed', 'error');
                }
            }
        } else {
            showToast(err.message || 'Delete failed', 'error');
        }
    }
}

function renderFolderBreadcrumb() {
    const crumb = document.getElementById('folderBreadcrumb');
    if (!crumb) return;

    const byId = new Map(state.folders.map((f) => [f.id, f]));
    const parts = [{ label: state.currentFolderId == null ? 'All media' : 'Root', id: null }];
    if (typeof state.currentFolderId === 'number') {
        const chain = [];
        let cur = byId.get(state.currentFolderId);
        while (cur) {
            chain.unshift(cur);
            cur = cur.parent_id != null ? byId.get(cur.parent_id) : null;
        }
        for (const f of chain) parts.push({ label: f.name, id: f.id });
    } else if (state.currentFolderId === 'root') {
        parts[0] = { label: 'Root', id: 'root' };
    }

    crumb.innerHTML = parts
        .map((p, i) => {
            const cls = i === parts.length - 1 ? 'breadcrumb-item current' : 'breadcrumb-item';
            const attr = p.id == null ? '' : `data-folder-id="${p.id}"`;
            return `<a href="#" class="${cls}" ${attr}>${escapeHtml(p.label)}</a>`;
        })
        .join(`<span class="breadcrumb-sep">/</span>`);

    crumb.querySelectorAll('.breadcrumb-item').forEach((a) => {
        a.addEventListener('click', (e) => {
            e.preventDefault();
            const raw = a.dataset.folderId;
            if (raw == null || raw === '') state.currentFolderId = null;
            else if (raw === 'root') state.currentFolderId = 'root';
            else state.currentFolderId = Number(raw);
            state.selectedMediaIds.clear();
            loadMedia();
        });
    });
}

function canEditFolders() {
    return auth.user?.role !== 'viewer';
}

function populateFolderSelect(selectEl, { includeRoot = true, defaultValue = null } = {}) {
    if (!selectEl) return;
    const options = [];
    if (includeRoot) options.push(`<option value="root">Root (no folder)</option>`);

    const byParent = new Map();
    for (const f of state.folders) {
        const p = f.parent_id ?? 'root';
        if (!byParent.has(p)) byParent.set(p, []);
        byParent.get(p).push(f);
    }
    const walk = (parentKey, prefix) => {
        for (const f of (byParent.get(parentKey) || []).sort((a, b) => a.name.localeCompare(b.name))) {
            options.push(`<option value="${f.id}">${prefix}${escapeHtml(f.name)}</option>`);
            walk(f.id, prefix + '— ');
        }
    };
    walk('root', '');

    selectEl.innerHTML = options.join('');
    if (defaultValue != null) selectEl.value = String(defaultValue);
}

// ===== Bulk Action Bar =====

function updateBulkActionBar() {
    const bar = document.getElementById('bulkActionBar');
    const countEl = document.getElementById('bulkSelectionCount');
    if (!bar || !countEl) return;
    const n = state.selectedMediaIds.size;
    if (n === 0) {
        bar.style.display = 'none';
        return;
    }
    bar.style.display = '';
    countEl.textContent = `${n} selected`;
}

function initBulkActions() {
    const selectAllBtn = document.getElementById('bulkSelectAllBtn');
    const moveBtn = document.getElementById('bulkMoveBtn');
    const deleteBtn = document.getElementById('bulkDeleteBtn');
    const clearBtn = document.getElementById('bulkClearBtn');

    selectAllBtn?.addEventListener('click', () => {
        for (const m of state.media) state.selectedMediaIds.add(m.id);
        renderMediaGrid(state.media);
    });
    clearBtn?.addEventListener('click', () => {
        state.selectedMediaIds.clear();
        renderMediaGrid(state.media);
    });
    deleteBtn?.addEventListener('click', async () => {
        const ids = Array.from(state.selectedMediaIds);
        if (ids.length === 0) return;
        if (!confirm(`Delete ${ids.length} media file(s)?`)) return;
        try {
            const resp = await mediaAPI.bulkDelete(ids);
            showToast(`Deleted ${resp?.deleted ?? ids.length} file(s)`, 'success');
            state.selectedMediaIds.clear();
            loadMedia();
        } catch (err) {
            showToast(err.message || 'Bulk delete failed', 'error');
        }
    });
    moveBtn?.addEventListener('click', () => {
        const ids = Array.from(state.selectedMediaIds);
        if (ids.length === 0) return;
        const modal = document.getElementById('moveMediaModal');
        const countEl = document.getElementById('moveMediaCount');
        const select = document.getElementById('moveMediaDest');
        if (!modal || !select) return;
        countEl.textContent = String(ids.length);
        populateFolderSelect(select);
        openModal('moveMediaModal');
    });

    document.getElementById('confirmMoveMediaBtn')?.addEventListener('click', async () => {
        const select = document.getElementById('moveMediaDest');
        const target = select?.value ?? 'root';
        const ids = Array.from(state.selectedMediaIds);
        if (ids.length === 0) return closeModal('moveMediaModal');
        try {
            const folderId = target === 'root' ? null : Number(target);
            await mediaAPI.bulkMove(ids, folderId);
            showToast(`Moved ${ids.length} file(s)`, 'success');
            state.selectedMediaIds.clear();
            closeModal('moveMediaModal');
            loadMedia();
        } catch (err) {
            showToast(err.message || 'Bulk move failed', 'error');
        }
    });
    document.getElementById('cancelMoveMediaBtn')?.addEventListener('click', () => closeModal('moveMediaModal'));
    document.getElementById('closeMoveMediaModal')?.addEventListener('click', () => closeModal('moveMediaModal'));
}

function initFolderActions() {
    document.getElementById('newFolderBtn')?.addEventListener('click', () => {
        const parentSel = document.getElementById('newFolderParent');
        populateFolderSelect(parentSel, { includeRoot: false, defaultValue: null });
        // Prepend a "Root" option manually since includeRoot: false above omitted it
        if (parentSel && !parentSel.querySelector('option[value="root"]')) {
            parentSel.insertAdjacentHTML('afterbegin', `<option value="root">Root</option>`);
        }
        if (parentSel) {
            parentSel.value = typeof state.currentFolderId === 'number'
                ? String(state.currentFolderId)
                : 'root';
        }
        const nameEl = document.getElementById('newFolderName');
        if (nameEl) nameEl.value = '';
        openModal('newFolderModal');
        nameEl?.focus();
    });
    document.getElementById('cancelNewFolderBtn')?.addEventListener('click', () => closeModal('newFolderModal'));
    document.getElementById('closeNewFolderModal')?.addEventListener('click', () => closeModal('newFolderModal'));
    document.getElementById('createNewFolderBtn')?.addEventListener('click', async () => {
        const name = document.getElementById('newFolderName')?.value?.trim();
        if (!name) return showToast('Folder name is required', 'error');
        const parentVal = document.getElementById('newFolderParent')?.value ?? 'root';
        const parentId = parentVal === 'root' ? null : Number(parentVal);
        try {
            const folder = await foldersAPI.create(name, parentId);
            showToast('Folder created', 'success');
            closeModal('newFolderModal');
            if (folder?.id) state.currentFolderId = folder.id;
            loadMedia();
        } catch (err) {
            showToast(err.message || 'Create folder failed', 'error');
        }
    });
}

function initUploadQueueUI() {
    document.getElementById('uploadQueueToggle')?.addEventListener('click', () => {
        const panel = document.getElementById('uploadQueuePanel');
        panel?.classList.toggle('collapsed');
    });
    document.getElementById('uploadQueueClose')?.addEventListener('click', () => {
        UploadQueue.clearFinished();
    });
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

    uploadBtn.addEventListener('click', () => {
        const select = document.getElementById('uploadDestFolder');
        populateFolderSelect(select, {
            includeRoot: true,
            defaultValue: typeof state.currentFolderId === 'number' ? state.currentFolderId : 'root',
        });
        openModal('uploadModal');
    });
    closeModalBtn.addEventListener('click', () => closeModal('uploadModal'));
    browseBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
        handleFileSelection(e.target.files);
        // Allow selecting the same file again (e.g., after a failed upload + retry)
        e.target.value = '';
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

    // Also accept drops directly onto the library when no modal is open
    const mediaLayout = document.querySelector('.media-layout');
    if (mediaLayout) {
        mediaLayout.addEventListener('dragover', (e) => {
            // Only handle file drags
            if (Array.from(e.dataTransfer?.types || []).includes('Files')) {
                e.preventDefault();
                mediaLayout.classList.add('dragover');
            }
        });
        mediaLayout.addEventListener('dragleave', () => mediaLayout.classList.remove('dragover'));
        mediaLayout.addEventListener('drop', (e) => {
            if (!e.dataTransfer?.files?.length) return;
            e.preventDefault();
            mediaLayout.classList.remove('dragover');
            // Use the currently-viewed folder as the implicit destination.
            // Mirror what the modal path would do.
            const select = document.getElementById('uploadDestFolder');
            if (select) {
                populateFolderSelect(select, {
                    includeRoot: true,
                    defaultValue: typeof state.currentFolderId === 'number' ? state.currentFolderId : 'root',
                });
            }
            handleFileSelection(e.dataTransfer.files);
        });
    }
}

// ===== Upload Queue =====
//
// Bounded-concurrency upload queue. Replaces the previous sequential
// `for (file of files) { await upload(file) }` loop so the UI can show
// multiple files uploading in parallel with per-file progress/cancel/retry.
//
// Concurrency is delivered by /api/ui-config (mediaUploadConcurrency, default 3).
// Each queue entry owns an AbortController so cancel + bulk-cancel work.
const UploadQueue = {
    entries: new Map(), // queueId -> { file, folderId, state, percent, error, controller }
    nextId: 1,
    activeCount: 0,
    concurrency: 3,
    panelOpen: false,

    setConcurrency(n) {
        const clamped = Math.max(1, Math.min(10, Number(n) || 3));
        this.concurrency = clamped;
    },

    enqueue(files, folderId) {
        for (const file of files) {
            const id = this.nextId++;
            this.entries.set(id, {
                id,
                file,
                folderId,
                state: 'queued',   // queued | uploading | done | failed | cancelled
                percent: 0,
                error: null,
                controller: new AbortController(),
            });
        }
        this.renderPanel();
        this.pump();
    },

    pump() {
        if (this.activeCount >= this.concurrency) return;
        const next = this.pickNext();
        if (!next) {
            // Nothing left queued. If nothing active either, trigger a refresh.
            if (this.activeCount === 0 && this.anyDoneRecently()) {
                loadMedia();
            }
            return;
        }
        this.startUpload(next);
        // Fire more in parallel up to the limit
        this.pump();
    },

    pickNext() {
        for (const e of this.entries.values()) {
            if (e.state === 'queued') return e;
        }
        return null;
    },

    anyDoneRecently() {
        for (const e of this.entries.values()) {
            if (e.state === 'done' || e.state === 'failed' || e.state === 'cancelled') return true;
        }
        return false;
    },

    async startUpload(entry) {
        entry.state = 'uploading';
        this.activeCount += 1;
        this.renderPanel();

        const MAX_RETRIES = 2;
        const BACKOFFS_MS = [1000, 4000];
        let attempt = 0;

        while (true) {
            try {
                await mediaAPI.upload(entry.file, {
                    folderId: entry.folderId,
                    signal: entry.controller.signal,
                    onProgress: (percent) => {
                        entry.percent = percent;
                        this.renderPanel();
                    },
                });
                entry.state = 'done';
                entry.percent = 100;
                break;
            } catch (err) {
                if (entry.controller.signal.aborted) {
                    entry.state = 'cancelled';
                    break;
                }
                if (attempt < MAX_RETRIES) {
                    attempt += 1;
                    entry.error = `Retry ${attempt}/${MAX_RETRIES}…`;
                    this.renderPanel();
                    await new Promise((r) => setTimeout(r, BACKOFFS_MS[attempt - 1] || 4000));
                    continue;
                }
                entry.state = 'failed';
                entry.error = err?.message || 'Upload failed';
                break;
            }
        }

        this.activeCount -= 1;
        this.renderPanel();
        this.pump();
    },

    cancel(id) {
        const entry = this.entries.get(id);
        if (!entry) return;
        entry.controller.abort();
        if (entry.state === 'queued') {
            entry.state = 'cancelled';
        }
        this.renderPanel();
        this.pump();
    },

    retry(id) {
        const entry = this.entries.get(id);
        if (!entry || (entry.state !== 'failed' && entry.state !== 'cancelled')) return;
        entry.state = 'queued';
        entry.percent = 0;
        entry.error = null;
        entry.controller = new AbortController();
        this.renderPanel();
        this.pump();
    },

    clearFinished() {
        for (const [id, e] of Array.from(this.entries.entries())) {
            if (e.state === 'done' || e.state === 'failed' || e.state === 'cancelled') {
                this.entries.delete(id);
            }
        }
        this.renderPanel();
    },

    renderPanel() {
        const panel = document.getElementById('uploadQueuePanel');
        const list = document.getElementById('uploadQueueList');
        const title = document.getElementById('uploadQueueTitle');
        const closeBtn = document.getElementById('uploadQueueClose');
        if (!panel || !list || !title) return;

        if (this.entries.size === 0) {
            panel.style.display = 'none';
            return;
        }

        panel.style.display = '';
        const counts = { total: this.entries.size, active: 0, done: 0, failed: 0 };
        for (const e of this.entries.values()) {
            if (e.state === 'uploading' || e.state === 'queued') counts.active += 1;
            else if (e.state === 'done') counts.done += 1;
            else if (e.state === 'failed' || e.state === 'cancelled') counts.failed += 1;
        }
        if (counts.active > 0) {
            title.textContent = `Uploading ${counts.active} of ${counts.total}…`;
            if (closeBtn) closeBtn.style.display = 'none';
        } else {
            title.textContent = `${counts.done} uploaded${counts.failed ? `, ${counts.failed} failed` : ''}`;
            if (closeBtn) closeBtn.style.display = '';
        }

        list.innerHTML = Array.from(this.entries.values()).map((e) => {
            const pct = Math.round(e.percent);
            let statusLabel = '';
            let actions = '';
            switch (e.state) {
                case 'queued':
                    statusLabel = 'Queued';
                    actions = `<button class="upload-queue-cancel" data-qid="${e.id}">Cancel</button>`;
                    break;
                case 'uploading':
                    statusLabel = `${pct}%`;
                    actions = `<button class="upload-queue-cancel" data-qid="${e.id}">Cancel</button>`;
                    break;
                case 'done':
                    statusLabel = 'Done';
                    break;
                case 'failed':
                    statusLabel = e.error || 'Failed';
                    actions = `<button class="upload-queue-retry" data-qid="${e.id}">Retry</button>`;
                    break;
                case 'cancelled':
                    statusLabel = 'Cancelled';
                    actions = `<button class="upload-queue-retry" data-qid="${e.id}">Retry</button>`;
                    break;
            }
            const safeName = escapeHtml(e.file.name);
            return `
                <li class="upload-queue-item upload-queue-${e.state}">
                    <div class="upload-queue-name" title="${safeName}">${safeName}</div>
                    <div class="upload-queue-progress"><div class="upload-queue-progress-fill" style="width:${pct}%"></div></div>
                    <div class="upload-queue-status">${statusLabel}</div>
                    <div class="upload-queue-actions">${actions}</div>
                </li>`;
        }).join('');

        list.querySelectorAll('.upload-queue-cancel').forEach((btn) => {
            btn.addEventListener('click', () => this.cancel(Number(btn.dataset.qid)));
        });
        list.querySelectorAll('.upload-queue-retry').forEach((btn) => {
            btn.addEventListener('click', () => this.retry(Number(btn.dataset.qid)));
        });
    },
};

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function handleFileSelection(files) {
    if (!files || files.length === 0) return;

    // Determine destination folder from the modal selector (falls back to
    // the currently-viewed folder if the modal wasn't used — e.g. drag-drop
    // onto the library when we wire that up).
    const destEl = document.getElementById('uploadDestFolder');
    let folderId = 'root';
    if (destEl && destEl.value) folderId = destEl.value;

    UploadQueue.enqueue(Array.from(files), folderId);
    closeModal('uploadModal');
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
                    ${auth.user?.role !== 'viewer' ? `<button class="btn btn-sm btn-danger client-remove-btn" data-client-id="${client.id}" data-client-name="${client.name || client.id}">
                        Remove
                    </button>` : ''}
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
    gridEl.querySelectorAll('.client-remove-btn').forEach(btn => {
        btn.addEventListener('click', () => handleClientRemove(btn.dataset.clientId, btn.dataset.clientName));
    });
}

function initRefreshClients() {
    const refreshBtn = document.getElementById('refreshClientsBtn');
    refreshBtn.addEventListener('click', loadClients);
}

async function handleClientRemove(clientId, clientName) {
    if (!confirm(`Are you sure you want to remove "${clientName}"? The client will need to re-register to connect again.`)) return;

    try {
        await clientAPI.remove(clientId);
        showToast('Client removed successfully', 'success');
        loadClients();
    } catch (error) {
        console.error('Failed to remove client:', error);
        showToast('Failed to remove client', 'error');
    }
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
    selectedRangeMs: 3600000,  // default 1h
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
            labels: points.map(p => {
                const d = new Date(p.x);
                const rangeMs = clientDetailState.selectedRangeMs || 3600000;
                if (rangeMs <= 86400000) {
                    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                }
                return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
                       d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            }),
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
                x: { ticks: { maxTicksLimit: (clientDetailState.selectedRangeMs || 3600000) > 86400000 ? 8 : 6 } },
            },
        },
    });
}

async function loadTelemetryForRange(rangeMs) {
    const clientId = clientDetailState.clientId;
    if (!clientId) return;

    clientDetailState.selectedRangeMs = rangeMs;
    destroyDetailCharts();

    const fromMs = Date.now() - rangeMs;
    const toMs = Date.now();
    const limit = rangeMs <= 86400000 ? 2000 : 3000;

    try {
        const rangeRows = await apiCall(
            `/telemetry/clients/${clientId}/range?from=${fromMs}&to=${toMs}&limit=${limit}`
        ).catch(() => []);
        renderTelemetryCharts(rangeRows || []);
    } catch (err) {
        console.error('Failed to load client telemetry:', err);
        showToast('Failed to load telemetry', 'error');
    }
}

async function openClientDetailModal(clientId, clientName) {
    clientDetailState.clientId = clientId;
    clientDetailState.clientName = clientName;
    clientDetailState.selectedRangeMs = 3600000;

    document.getElementById('clientDetailTitle').textContent = `${clientName} – telemetry`;

    // Render summary section using the freshest data we have on hand.
    const client = state.clients.find(c => c.id === clientId);
    const telemetry = state.latestTelemetry ? state.latestTelemetry[clientId] : null;
    document.getElementById('clientDetailSummary').innerHTML = renderClientDetailSummary(client, telemetry);

    openModal('clientDetailModal');
    destroyDetailCharts();

    // Reset range selector to 1h
    document.querySelectorAll('#telemetryRangeSelector .btn').forEach(b => {
        b.classList.toggle('active', b.dataset.range === '3600000');
    });

    // Load telemetry and logs in parallel.
    try {
        const [_, logEvents] = await Promise.all([
            loadTelemetryForRange(3600000),
            // Logs endpoint is admin-only; viewers will get a 403 — render empty in that case.
            apiCall(`/telemetry/clients/${clientId}/logs?limit=50`).catch(() => []),
        ]);

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
    document.querySelectorAll('#telemetryRangeSelector .btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#telemetryRangeSelector .btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            loadTelemetryForRange(parseInt(btn.dataset.range, 10));
        });
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

function getScheduleMode() {
    const checked = document.querySelector('input[name="scheduleMode"]:checked');
    return checked ? checked.value : 'simple';
}

function setScheduleMode(mode) {
    document.querySelectorAll('input[name="scheduleMode"]').forEach(r => { r.checked = r.value === mode; });
    document.getElementById('scheduleSimpleFields').style.display = mode === 'simple' ? '' : 'none';
    document.getElementById('scheduleAdvancedFields').style.display = mode === 'advanced' ? '' : 'none';
    document.getElementById('scheduleEventFields').style.display = mode === 'event' ? '' : 'none';
}

function collectScheduleConditions(mode) {
    const country = document.getElementById('scheduleHolidayCountry').value.trim();
    const match = document.getElementById('scheduleHolidayMatch').value;
    const datesRaw = document.getElementById('scheduleSpecialDates').value.trim();

    const conditions = {};
    if (country && match) {
        conditions.holidays = { country: country.toUpperCase(), match };
    }
    if (datesRaw) {
        const dates = datesRaw.split(',').map(d => d.trim()).filter(Boolean);
        if (dates.length > 0) conditions.special_dates = dates;
    }
    if (mode === 'event') {
        conditions.event_trigger = { event_type: document.getElementById('scheduleEventType').value };
    }
    return Object.keys(conditions).length > 0 ? conditions : null;
}

function buildSchedulePayload() {
    const mode = getScheduleMode();
    const name = document.getElementById('scheduleName').value.trim();
    const playlist_id = parseInt(document.getElementById('schedulePlaylist').value);
    const priority = parseInt(document.getElementById('schedulePriority').value) || 50;
    const enabled = document.getElementById('scheduleEnabled').checked;

    const targetSelect = document.getElementById('scheduleTarget');
    const target = targetSelect.value;
    let client_id, group_id;
    if (target === 'client') client_id = document.getElementById('scheduleTargetId').value || undefined;
    if (target === 'group') group_id = parseInt(document.getElementById('scheduleTargetId').value) || undefined;

    const payload = { name, playlist_id, client_id, group_id, priority, enabled };

    if (mode === 'simple') {
        payload.start_time = document.getElementById('scheduleStartTime').value;
        payload.end_time = document.getElementById('scheduleEndTime').value || undefined;
        const dayCheckboxes = document.querySelectorAll('#daysPicker input[type="checkbox"]:checked');
        payload.days_of_week = Array.from(dayCheckboxes).map(cb => cb.value).join(',');
        payload.interrupt_mode = 'assign';
    } else if (mode === 'advanced') {
        payload.cron_expression = document.getElementById('scheduleCronExpression').value.trim();
        const tz = document.getElementById('scheduleTimezone').value.trim();
        if (tz) payload.timezone = tz;
        const dur = parseInt(document.getElementById('scheduleDurationSeconds').value);
        if (dur > 0) payload.duration_seconds = dur;
        payload.interrupt_mode = document.getElementById('scheduleInterruptMode').value;
    } else if (mode === 'event') {
        const dur = parseInt(document.getElementById('scheduleEventDuration').value) || 60;
        payload.duration_seconds = dur;
        payload.interrupt_mode = document.getElementById('scheduleEventInterruptMode').value;
    }

    const conditions = collectScheduleConditions(mode);
    if (conditions) payload.conditions = conditions;

    return { payload, mode };
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

    document.querySelectorAll('input[name="scheduleMode"]').forEach(r => {
        r.addEventListener('change', () => setScheduleMode(r.value));
    });

    document.getElementById('fromTemplateBtn').addEventListener('click', openTemplatePicker);
    document.getElementById('previewScheduleBtn').addEventListener('click', previewCurrentSchedule);

    document.getElementById('saveScheduleBtn').addEventListener('click', async () => {
        const editId = document.getElementById('scheduleEditId').value;
        const { payload, mode } = buildSchedulePayload();

        if (!payload.name || !payload.playlist_id) {
            showToast('Name and playlist are required', 'error');
            return;
        }
        if (mode === 'simple' && !payload.start_time) {
            showToast('Start time is required for simple schedules', 'error');
            return;
        }
        if (mode === 'advanced' && !payload.cron_expression) {
            showToast('Cron expression is required for advanced schedules', 'error');
            return;
        }

        try {
            if (editId) {
                await schedulesAPI.update(parseInt(editId), payload);
                showToast('Schedule updated', 'success');
            } else {
                await schedulesAPI.create(payload);
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
    document.getElementById('scheduleCronExpression').value = '';
    document.getElementById('scheduleTimezone').value = '';
    document.getElementById('scheduleDurationSeconds').value = '';
    document.getElementById('scheduleInterruptMode').value = 'assign';
    document.getElementById('scheduleEventType').value = 'client_offline';
    document.getElementById('scheduleEventDuration').value = '60';
    document.getElementById('scheduleEventInterruptMode').value = 'interrupt';
    document.getElementById('scheduleHolidayCountry').value = '';
    document.getElementById('scheduleHolidayMatch').value = '';
    document.getElementById('scheduleSpecialDates').value = '';
    setScheduleMode('simple');
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
        resetScheduleForm();
        const schedule = await schedulesAPI.get(id);
        await populateScheduleSelects();

        document.getElementById('scheduleEditId').value = id;
        document.getElementById('scheduleName').value = schedule.name;
        document.getElementById('schedulePlaylist').value = schedule.playlist_id;
        document.getElementById('schedulePriority').value = schedule.priority;
        document.getElementById('scheduleEnabled').checked = schedule.enabled;

        // Determine mode
        const isEvent = !!(schedule.conditions && schedule.conditions.event_trigger);
        const mode = isEvent ? 'event' : (schedule.cron_expression ? 'advanced' : 'simple');
        setScheduleMode(mode);

        if (mode === 'simple') {
            document.getElementById('scheduleStartTime').value = schedule.start_time || '';
            document.getElementById('scheduleEndTime').value = schedule.end_time || '';
            const activeDays = new Set((schedule.days_of_week || '').split(','));
            document.querySelectorAll('#daysPicker input[type="checkbox"]').forEach(cb => {
                cb.checked = activeDays.has(cb.value);
            });
        } else if (mode === 'advanced') {
            document.getElementById('scheduleCronExpression').value = schedule.cron_expression || '';
            document.getElementById('scheduleTimezone').value = schedule.timezone || '';
            document.getElementById('scheduleDurationSeconds').value = schedule.duration_seconds || '';
            document.getElementById('scheduleInterruptMode').value = schedule.interrupt_mode || 'assign';
        } else if (mode === 'event') {
            document.getElementById('scheduleEventType').value = schedule.conditions.event_trigger.event_type;
            document.getElementById('scheduleEventDuration').value = schedule.duration_seconds || 60;
            document.getElementById('scheduleEventInterruptMode').value = schedule.interrupt_mode || 'interrupt';
        }

        // Conditions — holidays, special dates
        if (schedule.conditions && schedule.conditions.holidays) {
            document.getElementById('scheduleHolidayCountry').value = schedule.conditions.holidays.country || '';
            document.getElementById('scheduleHolidayMatch').value = schedule.conditions.holidays.match || '';
        }
        if (schedule.conditions && Array.isArray(schedule.conditions.special_dates)) {
            document.getElementById('scheduleSpecialDates').value = schedule.conditions.special_dates.join(', ');
        }

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

// ===== Template Picker & Preview =====

async function openTemplatePicker() {
    const modal = document.getElementById('templatePickerModal');
    const list = document.getElementById('templatePickerList');
    list.innerHTML = 'Loading templates…';
    modal.style.display = 'flex';
    try {
        const templates = await scheduleTemplatesAPI.list();
        if (!templates || templates.length === 0) {
            list.innerHTML = '<p class="text-muted">No templates available.</p>';
            return;
        }
        list.innerHTML = templates.map(t => {
            const def = t.definition || {};
            const summary = def.mode === 'advanced'
                ? `cron <code>${escapeHtml(def.cron_expression || '')}</code>`
                : def.mode === 'simple'
                    ? `${escapeHtml(def.start_time || '')} – ${escapeHtml(def.end_time || '')}`
                    : 'event-triggered';
            return `<div class="template-row" data-id="${t.id}">
                <div>
                    <strong>${escapeHtml(t.name)}</strong> ${t.is_builtin ? '<span class="badge">built-in</span>' : ''}
                    <div class="text-muted">${escapeHtml(t.description || '')}</div>
                    <div class="text-muted">${summary}</div>
                </div>
                <button class="btn btn-primary template-apply-btn" data-id="${t.id}">Apply</button>
            </div>`;
        }).join('');
        list.querySelectorAll('.template-apply-btn').forEach(btn => {
            btn.addEventListener('click', () => applyTemplateToForm(parseInt(btn.dataset.id), templates));
        });
    } catch (err) {
        list.innerHTML = '<p class="error">Failed to load templates</p>';
    }
}

function applyTemplateToForm(id, templates) {
    const tpl = templates.find(t => t.id === id);
    if (!tpl) return;
    const def = tpl.definition || {};

    // Mode
    const mode = def.conditions && def.conditions.event_trigger
        ? 'event'
        : def.mode || 'simple';
    setScheduleMode(mode);

    if (mode === 'simple') {
        if (def.start_time) document.getElementById('scheduleStartTime').value = def.start_time;
        if (def.end_time) document.getElementById('scheduleEndTime').value = def.end_time;
        if (def.days_of_week) {
            const active = new Set(def.days_of_week.split(','));
            document.querySelectorAll('#daysPicker input[type="checkbox"]').forEach(cb => {
                cb.checked = active.has(cb.value);
            });
        }
    } else if (mode === 'advanced') {
        if (def.cron_expression) document.getElementById('scheduleCronExpression').value = def.cron_expression;
        if (def.timezone) document.getElementById('scheduleTimezone').value = def.timezone;
        if (def.duration_seconds) document.getElementById('scheduleDurationSeconds').value = def.duration_seconds;
        if (def.interrupt_mode) document.getElementById('scheduleInterruptMode').value = def.interrupt_mode;
    } else if (mode === 'event') {
        if (def.conditions?.event_trigger?.event_type) {
            document.getElementById('scheduleEventType').value = def.conditions.event_trigger.event_type;
        }
        if (def.duration_seconds) document.getElementById('scheduleEventDuration').value = def.duration_seconds;
        if (def.interrupt_mode) document.getElementById('scheduleEventInterruptMode').value = def.interrupt_mode;
    }

    if (def.conditions && def.conditions.holidays) {
        document.getElementById('scheduleHolidayCountry').value = def.conditions.holidays.country || '';
        document.getElementById('scheduleHolidayMatch').value = def.conditions.holidays.match || '';
    }
    if (def.conditions && Array.isArray(def.conditions.special_dates)) {
        document.getElementById('scheduleSpecialDates').value = def.conditions.special_dates.join(', ');
    }
    if (def.priority) document.getElementById('schedulePriority').value = def.priority;

    document.getElementById('templatePickerModal').style.display = 'none';
    showToast(`Applied template "${tpl.name}"`, 'success');
}

async function previewCurrentSchedule() {
    const modal = document.getElementById('schedulePreviewModal');
    const body = document.getElementById('schedulePreviewBody');
    body.innerHTML = 'Loading…';
    modal.style.display = 'flex';

    try {
        const editId = document.getElementById('scheduleEditId').value;
        const from = new Date().toISOString();
        const to = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
        let occurrences = [];

        if (editId) {
            const res = await schedulesAPI.simulate(parseInt(editId), from, to);
            occurrences = res.occurrences || [];
        } else {
            // Preview an unsaved schedule by first creating a temp sim: just call /schedules/simulate
            // with no target — not helpful for unsaved. Instead, require save.
            body.innerHTML = '<p class="text-muted">Save the schedule first to preview its upcoming occurrences.</p>';
            return;
        }

        if (occurrences.length === 0) {
            body.innerHTML = '<p class="text-muted">No occurrences in the next 7 days.</p>';
            return;
        }

        body.innerHTML = '<ul class="preview-list">' +
            occurrences.map(iso => `<li>${new Date(iso).toLocaleString()}</li>`).join('') +
            '</ul>';
    } catch (err) {
        body.innerHTML = `<p class="error">Preview failed: ${escapeHtml(err.message || String(err))}</p>`;
    }
}

function initTemplateAndPreviewModals() {
    document.getElementById('closeTemplatePickerModal').addEventListener('click', () => {
        document.getElementById('templatePickerModal').style.display = 'none';
    });
    document.getElementById('cancelTemplatePickerModal').addEventListener('click', () => {
        document.getElementById('templatePickerModal').style.display = 'none';
    });
    document.getElementById('closeSchedulePreviewModal').addEventListener('click', () => {
        document.getElementById('schedulePreviewModal').style.display = 'none';
    });
    document.getElementById('cancelSchedulePreviewModal').addEventListener('click', () => {
        document.getElementById('schedulePreviewModal').style.display = 'none';
    });
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
        // Calendar view only visualizes HH:MM schedules. Cron/event rows would need
        // occurrence simulation; for now we show a small footer note below the grid.
        if (!schedule.start_time) return;
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
    async update(id, data) {
        return await apiCall(`/users/${id}`, {
            method: 'PUT',
            body: JSON.stringify(data)
        });
    },
    async resetPassword(id, data) {
        return await apiCall(`/users/${id}/reset-password`, {
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
const APPROVAL_PAGE_SIZE = 50;
let _approvalCurrentItems = [];
let _approvalPage = 0;
const _approvalSelection = new Set();

async function loadApprovals() {
    const grid = document.getElementById('approvalsGrid');
    const empty = document.getElementById('approvalsEmpty');
    grid.innerHTML = '<div class="loading">Loading approvals...</div>';
    empty.style.display = 'none';
    _approvalSelection.clear();
    _approvalPage = 0;

    try {
        const filter = document.getElementById('approvalStatusFilter').value;
        let media;
        if (filter === 'pending') {
            media = await approvalsAPI.listPending();
        } else {
            const all = await mediaAPI.list();
            media = filter === 'all' ? all : all.filter(m => m.approval_status === filter);
        }

        _approvalCurrentItems = media || [];
        renderApprovalPage();
    } catch (error) {
        console.error('Failed to load approvals:', error);
        grid.innerHTML = '<div class="empty-state"><p>Failed to load approvals</p></div>';
    }
}

function renderApprovalPage() {
    const grid = document.getElementById('approvalsGrid');
    const empty = document.getElementById('approvalsEmpty');
    const items = _approvalCurrentItems;

    if (!items.length) {
        grid.innerHTML = '';
        empty.style.display = '';
        updateApprovalToolbar();
        return;
    }
    empty.style.display = 'none';

    const totalPages = Math.max(1, Math.ceil(items.length / APPROVAL_PAGE_SIZE));
    if (_approvalPage >= totalPages) _approvalPage = totalPages - 1;
    const start = _approvalPage * APPROVAL_PAGE_SIZE;
    const pageItems = items.slice(start, start + APPROVAL_PAGE_SIZE);

    grid.innerHTML = pageItems.map(m => renderApprovalCard(m)).join('');
    attachApprovalHandlers();
    updateApprovalToolbar();
}

function updateApprovalToolbar() {
    const items = _approvalCurrentItems;
    const totalPages = Math.max(1, Math.ceil(items.length / APPROVAL_PAGE_SIZE));
    const prevBtn = document.getElementById('approvalPrevPageBtn');
    const nextBtn = document.getElementById('approvalNextPageBtn');
    const indicator = document.getElementById('approvalPageIndicator');
    const countEl = document.getElementById('approvalSelectedCount');
    const bulkApprove = document.getElementById('bulkApproveBtn');
    const bulkReject = document.getElementById('bulkRejectBtn');
    const selectAll = document.getElementById('approvalSelectAll');

    if (indicator) indicator.textContent = `Page ${_approvalPage + 1} of ${totalPages} (${items.length} total)`;
    if (prevBtn) prevBtn.disabled = _approvalPage <= 0;
    if (nextBtn) nextBtn.disabled = _approvalPage >= totalPages - 1;

    const selectedCount = _approvalSelection.size;
    if (countEl) countEl.textContent = `${selectedCount} selected`;
    if (bulkApprove) bulkApprove.disabled = selectedCount === 0;
    if (bulkReject) bulkReject.disabled = selectedCount === 0;

    if (selectAll) {
        const start = _approvalPage * APPROVAL_PAGE_SIZE;
        const pageItems = items.slice(start, start + APPROVAL_PAGE_SIZE);
        const pageIds = pageItems.map(m => m.id);
        selectAll.checked = pageIds.length > 0 && pageIds.every(id => _approvalSelection.has(id));
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
    const checked = _approvalSelection.has(media.id) ? 'checked' : '';

    return `
        <div class="card approval-card">
            <div class="card-body" style="display:flex; align-items:center; gap:1rem;">
                <input type="checkbox" class="approval-select" data-id="${media.id}" ${checked}>
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

    document.querySelectorAll('.approval-select').forEach(cb => {
        cb.addEventListener('change', () => {
            const id = parseInt(cb.dataset.id);
            if (cb.checked) _approvalSelection.add(id);
            else _approvalSelection.delete(id);
            updateApprovalToolbar();
        });
    });
}

async function bulkApprovalAction(action, comment) {
    const ids = Array.from(_approvalSelection);
    if (!ids.length) return;
    let ok = 0, fail = 0;
    for (const id of ids) {
        try {
            if (action === 'approve') await approvalsAPI.approve(id);
            else await approvalsAPI.reject(id, comment);
            ok++;
        } catch (e) {
            fail++;
        }
    }
    showToast(`Bulk ${action}: ${ok} succeeded${fail ? `, ${fail} failed` : ''}`, fail ? 'error' : 'success');
    loadApprovals();
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

    // Pagination
    document.getElementById('approvalPrevPageBtn')?.addEventListener('click', () => {
        if (_approvalPage > 0) {
            _approvalPage--;
            renderApprovalPage();
        }
    });
    document.getElementById('approvalNextPageBtn')?.addEventListener('click', () => {
        const totalPages = Math.ceil(_approvalCurrentItems.length / APPROVAL_PAGE_SIZE);
        if (_approvalPage < totalPages - 1) {
            _approvalPage++;
            renderApprovalPage();
        }
    });

    // Select-all on page
    document.getElementById('approvalSelectAll')?.addEventListener('change', (e) => {
        const start = _approvalPage * APPROVAL_PAGE_SIZE;
        const pageItems = _approvalCurrentItems.slice(start, start + APPROVAL_PAGE_SIZE);
        if (e.target.checked) {
            pageItems.forEach(m => _approvalSelection.add(m.id));
        } else {
            pageItems.forEach(m => _approvalSelection.delete(m.id));
        }
        renderApprovalPage();
    });

    // Bulk actions
    document.getElementById('bulkApproveBtn')?.addEventListener('click', async () => {
        if (_approvalSelection.size === 0) return;
        if (!confirm(`Approve ${_approvalSelection.size} selected file(s)?`)) return;
        await bulkApprovalAction('approve');
    });
    document.getElementById('bulkRejectBtn')?.addEventListener('click', async () => {
        if (_approvalSelection.size === 0) return;
        const comment = prompt(`Reject ${_approvalSelection.size} selected file(s). Optional comment:`);
        if (comment === null) return; // cancelled
        await bulkApprovalAction('reject', comment);
    });
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
                        <td style="display:flex; gap:0.25rem; flex-wrap:wrap;">
                            <button class="btn btn-sm btn-secondary edit-user-btn" data-id="${user.id}" data-username="${user.username}" data-email="${user.email}" data-role="${user.role}">Edit</button>
                            ${user.id !== auth.user?.id
                                ? `<button class="btn btn-sm btn-secondary reset-user-pw-btn" data-id="${user.id}" data-username="${user.username}">Reset Password</button>
                                   <button class="btn btn-sm btn-danger delete-user-btn" data-id="${user.id}" data-username="${user.username}">Delete</button>`
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

    grid.querySelectorAll('.edit-user-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('editUserId').value = btn.dataset.id;
            document.getElementById('editUserUsername').value = btn.dataset.username;
            document.getElementById('editUserEmail').value = btn.dataset.email;
            document.getElementById('editUserRole').value = btn.dataset.role;
            openModal('editUserModal');
        });
    });

    grid.querySelectorAll('.reset-user-pw-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('adminResetUserId').value = btn.dataset.id;
            document.getElementById('adminResetUsername').textContent = btn.dataset.username;
            document.getElementById('adminResetPasswordForm').reset();
            document.getElementById('adminResetUserId').value = btn.dataset.id;
            openModal('adminResetPasswordModal');
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

function initEditUserModal() {
    const closeBtn = document.getElementById('closeEditUserModal');
    const cancelBtn = document.getElementById('cancelEditUserModal');
    const saveBtn = document.getElementById('saveEditUserBtn');
    if (!saveBtn) return;

    closeBtn.addEventListener('click', () => closeModal('editUserModal'));
    cancelBtn.addEventListener('click', () => closeModal('editUserModal'));

    saveBtn.addEventListener('click', async () => {
        const id = parseInt(document.getElementById('editUserId').value);
        const email = document.getElementById('editUserEmail').value.trim();
        const role = document.getElementById('editUserRole').value;

        if (!email) {
            showToast('Email is required', 'error');
            return;
        }

        try {
            await usersAPI.update(id, { email, role });
            showToast('User updated', 'success');
            closeModal('editUserModal');
            loadUsers();
        } catch (error) {
            showToast(error.message || 'Failed to update user', 'error');
        }
    });
}

function initAdminResetPasswordModal() {
    const closeBtn = document.getElementById('closeAdminResetPasswordModal');
    const cancelBtn = document.getElementById('cancelAdminResetPassword');
    const saveBtn = document.getElementById('saveAdminResetPassword');
    if (!saveBtn) return;

    closeBtn.addEventListener('click', () => closeModal('adminResetPasswordModal'));
    cancelBtn.addEventListener('click', () => closeModal('adminResetPasswordModal'));

    saveBtn.addEventListener('click', async () => {
        const id = parseInt(document.getElementById('adminResetUserId').value);
        const newPassword = document.getElementById('adminResetNewPassword').value;
        const confirmPw = document.getElementById('adminResetConfirmNewPassword').value;
        const adminPassword = document.getElementById('adminResetAdminPassword').value;

        if (newPassword.length < 8) {
            showToast('New password must be at least 8 characters', 'error');
            return;
        }
        if (newPassword !== confirmPw) {
            showToast('Passwords do not match', 'error');
            return;
        }
        if (!adminPassword) {
            showToast('Confirm your admin password', 'error');
            return;
        }

        try {
            await usersAPI.resetPassword(id, { newPassword, adminPassword });
            showToast('Password reset', 'success');
            closeModal('adminResetPasswordModal');
            document.getElementById('adminResetPasswordForm').reset();
        } catch (error) {
            showToast(error.message || 'Failed to reset password', 'error');
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

    UploadQueue.setConcurrency(UI_CONFIG.mediaUploadConcurrency);

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
    initBulkActions();
    initFolderActions();
    initUploadQueueUI();

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
    initTemplateAndPreviewModals();

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
    initEditUserModal();
    initAdminResetPasswordModal();

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
