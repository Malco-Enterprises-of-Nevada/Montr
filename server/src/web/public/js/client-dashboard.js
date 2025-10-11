/**
 * Montr Web UI - Client Dashboard Module
 * Handles client management, status display, and playlist assignment
 */

(function () {
  'use strict';

  const {
    api,
    notifications,
    modal,
    LoadingIndicator,
    formatDate,
    handleApiError,
    getClientStatusClass,
  } = window.MontrUtils;

  /**
   * Client Dashboard Class
   */
  class ClientDashboard {
    constructor(containerId) {
      this.container = document.getElementById(containerId);
      if (!this.container) {
        console.error(\`Container #\${containerId} not found\`);
        return;
      }

      this.clients = [];
      this.playlists = [];
      this.filters = {
        status: '',
      };
      this.refreshInterval = null;

      this.initialize();
    }

    /**
     * Initialize the client dashboard
     */
    initialize() {
      this.render();
      this.attachEventListeners();
      this.loadPlaylists();
      this.loadClients();

      // Auto-refresh every 30 seconds
      this.startAutoRefresh();
    }

    /**
     * Render the client dashboard UI
     */
    render() {
      this.container.innerHTML = \`
        <div class="client-dashboard">
          <!-- Header -->
          <div class="client-dashboard-header">
            <h2>Client Dashboard</h2>
            <div class="dashboard-actions">
              <button class="btn btn-secondary" id="refresh-clients-btn">
                🔄 Refresh
              </button>
            </div>
          </div>

          <!-- Filters -->
          <div class="client-filters">
            <div class="filter-group">
              <label>Filter by Status:</label>
              <select id="client-status-filter" class="form-control">
                <option value="">All Clients</option>
                <option value="online">Online</option>
                <option value="offline">Offline</option>
                <option value="error">Error</option>
              </select>
            </div>
            <div class="filter-stats" id="client-stats">
              <!-- Stats will be inserted here -->
            </div>
          </div>

          <!-- Client Grid -->
          <div class="client-grid" id="client-grid">
            <!-- Client cards will be inserted here -->
          </div>
        </div>
      \`;
    }

    /**
     * Attach event listeners
     */
    attachEventListeners() {
      // Refresh button
      const refreshBtn = document.getElementById('refresh-clients-btn');
      refreshBtn.addEventListener('click', () => {
        this.loadClients();
        notifications.info('Refreshing clients...');
      });

      // Status filter
      const statusFilter = document.getElementById('client-status-filter');
      statusFilter.addEventListener('change', (e) => {
        this.filters.status = e.target.value;
        this.renderClientGrid();
      });
    }

    /**
     * Start auto-refresh timer
     */
    startAutoRefresh() {
      // Clear existing interval
      if (this.refreshInterval) {
        clearInterval(this.refreshInterval);
      }

      // Refresh every 30 seconds
      this.refreshInterval = setInterval(() => {
        this.loadClients(true); // Silent refresh
      }, 30000);
    }

    /**
     * Stop auto-refresh timer
     */
    stopAutoRefresh() {
      if (this.refreshInterval) {
        clearInterval(this.refreshInterval);
        this.refreshInterval = null;
      }
    }

    /**
     * Load playlists for assignment dropdown
     */
    async loadPlaylists() {
      try {
        const response = await api.get('/playlists');
        this.playlists = response.data || [];
      } catch (error) {
        console.error('Failed to load playlists:', error);
        this.playlists = [];
      }
    }

    /**
     * Load clients from server
     */
    async loadClients(silent = false) {
      const clientGrid = document.getElementById('client-grid');

      try {
        if (!silent) {
          LoadingIndicator.show(clientGrid, 'Loading clients...');
        }

        const response = await api.get('/clients');
        this.clients = response.data || [];

        this.renderClientGrid();
        this.renderClientStats();
      } catch (error) {
        if (!silent) {
          clientGrid.innerHTML = '<p class="error-message">Failed to load clients</p>';
          handleApiError(error, 'Failed to load clients');
        }
      }
    }

    /**
     * Render client statistics
     */
    renderClientStats() {
      const statsContainer = document.getElementById('client-stats');

      const total = this.clients.length;
      const online = this.clients.filter((c) => c.status === 'online').length;
      const offline = this.clients.filter((c) => c.status === 'offline').length;
      const error = this.clients.filter((c) => c.status === 'error').length;

      statsContainer.innerHTML = \`
        <div class="stat-badge">
          <span class="stat-label">Total:</span>
          <span class="stat-value">\${total}</span>
        </div>
        <div class="stat-badge stat-badge-online">
          <span class="stat-label">Online:</span>
          <span class="stat-value">\${online}</span>
        </div>
        <div class="stat-badge stat-badge-offline">
          <span class="stat-label">Offline:</span>
          <span class="stat-value">\${offline}</span>
        </div>
        \${error > 0 ? \`
        <div class="stat-badge stat-badge-error">
          <span class="stat-label">Error:</span>
          <span class="stat-value">\${error}</span>
        </div>
        \` : ''}
      \`;
    }

    /**
     * Render client grid
     */
    renderClientGrid() {
      const clientGrid = document.getElementById('client-grid');

      // Apply filters
      let filteredClients = this.clients;
      if (this.filters.status) {
        filteredClients = this.clients.filter((c) => c.status === this.filters.status);
      }

      if (filteredClients.length === 0) {
        clientGrid.innerHTML = '<p class="empty-message">No clients found</p>';
        return;
      }

      const html = filteredClients
        .map((client) => this.renderClientCard(client))
        .join('');

      clientGrid.innerHTML = html;

      // Attach action buttons
      this.attachClientCardListeners();
    }

    /**
     * Render individual client card
     */
    renderClientCard(client) {
      const statusClass = getClientStatusClass(client.status);
      const assignedPlaylist = this.playlists.find(
        (p) => p.id === client.assigned_playlist_id
      );

      return \`
        <div class="client-card" data-id="\${client.id}">
          <div class="client-card-header">
            <h3>\${client.name || client.id}</h3>
            <span class="badge \${statusClass}">
              \${this.getStatusIcon(client.status)} \${client.status}
            </span>
          </div>

          <div class="client-card-body">
            <div class="client-info-group">
              <label>Client ID:</label>
              <code class="client-id">\${client.id}</code>
            </div>

            <div class="client-info-group">
              <label>Assigned Playlist:</label>
              <div class="playlist-assignment">
                \${assignedPlaylist ? \`<span class="assigned-playlist">\${assignedPlaylist.name}</span>\` : '<span class="no-playlist">No playlist assigned</span>'}
                <button
                  class="btn btn-sm btn-secondary"
                  data-action="assign-playlist"
                  data-client-id="\${client.id}"
                >
                  \${assignedPlaylist ? 'Change' : 'Assign'}
                </button>
              </div>
            </div>

            <div class="client-info-group">
              <label>Last Seen:</label>
              <span>\${client.last_seen ? formatDate(client.last_seen, true) : 'Never'}</span>
            </div>

            \${client.current_status ? this.renderClientStatus(client.current_status) : ''}
          </div>

          <div class="client-card-actions">
            <button
              class="btn btn-sm btn-secondary"
              data-action="view-details"
              data-client-id="\${client.id}"
            >
              View Details
            </button>
            <button
              class="btn btn-sm btn-secondary"
              data-action="rename"
              data-client-id="\${client.id}"
            >
              Rename
            </button>
            <button
              class="btn btn-sm btn-danger"
              data-action="unregister"
              data-client-id="\${client.id}"
            >
              Unregister
            </button>
          </div>
        </div>
      \`;
    }

    /**
     * Render client status details
     */
    renderClientStatus(status) {
      if (!status) return '';

      return \`
        <div class="client-status-details">
          <h4>Current Status</h4>
          \${status.current_media_id ? \`
            <div class="status-item">
              <label>Playing:</label>
              <span>\${status.media_filename || \`Media #\${status.current_media_id}\`}</span>
            </div>
          \` : ''}
          \${status.position ? \`
            <div class="status-item">
              <label>Position:</label>
              <span>\${Math.floor(status.position)}s</span>
            </div>
          \` : ''}
          <div class="status-item">
            <label>State:</label>
            <span>\${status.is_playing ? '▶️ Playing' : '⏸️ Paused'}</span>
          </div>
          \${status.error_message ? \`
            <div class="status-item status-error">
              <label>Error:</label>
              <span>\${status.error_message}</span>
            </div>
          \` : ''}
        </div>
      \`;
    }

    /**
     * Get status icon
     */
    getStatusIcon(status) {
      const icons = {
        online: '🟢',
        offline: '⚫',
        error: '🔴',
        playing: '▶️',
      };
      return icons[status] || '⚪';
    }

    /**
     * Attach client card event listeners
     */
    attachClientCardListeners() {
      const clientGrid = document.getElementById('client-grid');

      // Assign playlist
      clientGrid.querySelectorAll('[data-action="assign-playlist"]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const clientId = e.target.dataset.clientId;
          this.assignPlaylist(clientId);
        });
      });

      // View details
      clientGrid.querySelectorAll('[data-action="view-details"]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const clientId = e.target.dataset.clientId;
          this.viewClientDetails(clientId);
        });
      });

      // Rename client
      clientGrid.querySelectorAll('[data-action="rename"]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const clientId = e.target.dataset.clientId;
          this.renameClient(clientId);
        });
      });

      // Unregister client
      clientGrid.querySelectorAll('[data-action="unregister"]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const clientId = e.target.dataset.clientId;
          this.unregisterClient(clientId);
        });
      });
    }

    /**
     * Assign playlist to client
     */
    async assignPlaylist(clientId) {
      const client = this.clients.find((c) => c.id === clientId);
      if (!client) return;

      const content = \`
        <form id="assign-playlist-form">
          <div class="form-group">
            <label for="playlist-select">Select Playlist</label>
            <select id="playlist-select" class="form-control" required>
              <option value="">-- No Playlist --</option>
              \${this.playlists
                .map(
                  (p) => \`
                <option value="\${p.id}" \${p.id === client.assigned_playlist_id ? 'selected' : ''}>
                  \${p.name}
                </option>
              \`
                )
                .join('')}
            </select>
          </div>
          <div class="modal-buttons">
            <button type="button" class="btn btn-secondary" data-action="cancel">Cancel</button>
            <button type="submit" class="btn btn-primary">Assign Playlist</button>
          </div>
        </form>
      \`;

      modal.show(\`Assign Playlist - \${client.name || client.id}\`, content);

      const form = document.getElementById('assign-playlist-form');
      const cancelBtn = form.querySelector('[data-action="cancel"]');

      cancelBtn.addEventListener('click', () => modal.hide());

      form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const playlistId = document.getElementById('playlist-select').value;

        try {
          await api.put(\`/clients/\${clientId}\`, {
            assigned_playlist_id: playlistId ? parseInt(playlistId) : null,
          });

          notifications.success('Playlist assigned successfully');
          modal.hide();
          this.loadClients();
        } catch (error) {
          handleApiError(error, 'Failed to assign playlist');
        }
      });
    }

    /**
     * View client details
     */
    async viewClientDetails(clientId) {
      try {
        LoadingIndicator.showOverlay('Loading client details...');

        const response = await api.get(\`/clients/\${clientId}/status\`);
        const client = response.data;

        LoadingIndicator.hideOverlay();

        const assignedPlaylist = this.playlists.find(
          (p) => p.id === client.assigned_playlist_id
        );

        const content = \`
          <div class="client-details">
            <div class="detail-group">
              <label>Client Name:</label>
              <span>\${client.name || 'Unnamed'}</span>
            </div>
            <div class="detail-group">
              <label>Client ID:</label>
              <code>\${client.id}</code>
            </div>
            <div class="detail-group">
              <label>Status:</label>
              <span class="badge \${getClientStatusClass(client.status)}">
                \${this.getStatusIcon(client.status)} \${client.status}
              </span>
            </div>
            <div class="detail-group">
              <label>Assigned Playlist:</label>
              <span>\${assignedPlaylist ? assignedPlaylist.name : 'None'}</span>
            </div>
            <div class="detail-group">
              <label>Registered:</label>
              <span>\${formatDate(client.created_at)}</span>
            </div>
            <div class="detail-group">
              <label>Last Seen:</label>
              <span>\${client.last_seen ? formatDate(client.last_seen) : 'Never'}</span>
            </div>

            \${client.current_status ? \`
              <hr/>
              <h4>Playback Status</h4>
              \${client.current_status.current_media_id ? \`
                <div class="detail-group">
                  <label>Current Media:</label>
                  <span>\${client.current_status.media_filename || \`Media #\${client.current_status.current_media_id}\`}</span>
                </div>
              \` : ''}
              \${client.current_status.position !== null && client.current_status.position !== undefined ? \`
                <div class="detail-group">
                  <label>Position:</label>
                  <span>\${Math.floor(client.current_status.position)} seconds</span>
                </div>
              \` : ''}
              <div class="detail-group">
                <label>Playing:</label>
                <span>\${client.current_status.is_playing ? 'Yes ▶️' : 'No ⏸️'}</span>
              </div>
              \${client.current_status.error_message ? \`
                <div class="detail-group">
                  <label>Error:</label>
                  <span class="error-text">\${client.current_status.error_message}</span>
                </div>
              \` : ''}
              <div class="detail-group">
                <label>Last Updated:</label>
                <span>\${formatDate(client.current_status.updated_at)}</span>
              </div>
            \` : '<p>No playback status available</p>'}
          </div>
          <div class="modal-buttons">
            <button class="btn btn-primary" data-action="close">Close</button>
          </div>
        \`;

        modal.show('Client Details', content);

        const closeBtn = document.querySelector('[data-action="close"]');
        closeBtn.addEventListener('click', () => modal.hide());
      } catch (error) {
        LoadingIndicator.hideOverlay();
        handleApiError(error, 'Failed to load client details');
      }
    }

    /**
     * Rename client
     */
    async renameClient(clientId) {
      const client = this.clients.find((c) => c.id === clientId);
      if (!client) return;

      const content = \`
        <form id="rename-client-form">
          <div class="form-group">
            <label for="client-name">Client Name</label>
            <input
              type="text"
              id="client-name"
              class="form-control"
              value="\${client.name || ''}"
              placeholder="Enter client name"
              required
            />
          </div>
          <div class="modal-buttons">
            <button type="button" class="btn btn-secondary" data-action="cancel">Cancel</button>
            <button type="submit" class="btn btn-primary">Rename Client</button>
          </div>
        </form>
      \`;

      modal.show('Rename Client', content);

      const form = document.getElementById('rename-client-form');
      const cancelBtn = form.querySelector('[data-action="cancel"]');

      cancelBtn.addEventListener('click', () => modal.hide());

      form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const name = document.getElementById('client-name').value.trim();

        if (!name) {
          notifications.error('Client name is required');
          return;
        }

        try {
          await api.put(\`/clients/\${clientId}\`, { name });
          notifications.success('Client renamed successfully');
          modal.hide();
          this.loadClients();
        } catch (error) {
          handleApiError(error, 'Failed to rename client');
        }
      });
    }

    /**
     * Unregister client
     */
    async unregisterClient(clientId) {
      const client = this.clients.find((c) => c.id === clientId);
      if (!client) return;

      const confirmed = await modal.confirm(
        'Unregister Client',
        \`Are you sure you want to unregister "\${client.name || client.id}"? The client will need to re-register to connect again.\`,
        { type: 'danger', confirmText: 'Unregister' }
      );

      if (!confirmed) return;

      try {
        await api.delete(\`/clients/\${clientId}\`);
        notifications.success('Client unregistered successfully');
        this.loadClients();
      } catch (error) {
        handleApiError(error, 'Failed to unregister client');
      }
    }

    /**
     * Cleanup when dashboard is closed
     */
    destroy() {
      this.stopAutoRefresh();
    }
  }

  // Export ClientDashboard to global scope
  window.ClientDashboard = ClientDashboard;
})();
