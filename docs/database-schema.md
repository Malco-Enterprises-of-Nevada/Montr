# Database Schema

Montr uses a relational schema with 6 tables. SQLite is the default and reference implementation; MySQL, MSSQL, and MongoDB are also supported via database adapters (see `server/src/database/adapters/`).

Schema version: **1.0.0**

---

## Entity-Relationship Diagram

```
 ┌──────────────┐       ┌────────────────┐       ┌──────────────┐
 │ media_files  │       │ playlist_items │       │  playlists   │
 │──────────────│       │────────────────│       │──────────────│
 │ id (PK)      │◄──FK──│ media_id       │  FK──►│ id (PK)      │
 │ filename     │       │ playlist_id    │───────│ name         │
 │ type         │       │ order_index    │       │ description  │
 │ checksum (U) │       │ image_duration │       │ created_at   │
 │ ...          │       │ ...            │       │ updated_at   │
 └──────┬───────┘       └────────────────┘       └──────┬───────┘
        │                                                │
        │ FK (SET NULL)                          FK (SET NULL)
        │                                                │
 ┌──────┴───────┐                                ┌───────┴──────┐
 │client_status │       ┌──────────────┐         │   clients    │
 │──────────────│       │ system_state │         │──────────────│
 │ client_id ───│──FK──►│──────────────│         │ id (PK/UUID) │
 │ current_     │       │ key (PK)     │         │ name         │
 │   media_id   │       │ value        │         │ assigned_    │
 │ position     │       │ updated_at   │         │   playlist_id│
 │ is_playing   │       └──────────────┘         │ status       │
 │ ...          │                                │ last_seen    │
 └──────────────┘                                └──────────────┘
```

---

## Tables

### media_files

Stores metadata for uploaded media files (videos and images).

```sql
CREATE TABLE IF NOT EXISTS media_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,                    -- Generated unique filename
  original_filename TEXT NOT NULL,           -- Original uploaded filename
  filepath TEXT NOT NULL,                    -- Relative path in storage
  type TEXT NOT NULL CHECK(type IN ('video', 'image')),
  mime_type TEXT,                            -- e.g., video/mp4, image/jpeg
  file_size INTEGER,                         -- Size in bytes
  duration REAL,                             -- Duration in seconds (NULL for images)
  width INTEGER,                             -- Resolution width
  height INTEGER,                            -- Resolution height
  checksum TEXT UNIQUE,                      -- SHA-256 hash for duplicate detection
  thumbnail_status TEXT,                     -- pending|generating|generated|failed (added 002)
  approval_status TEXT,                      -- pending|approved|rejected (added 009)
  folder_id INTEGER REFERENCES media_folders(id) ON DELETE SET NULL, -- added 014
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PK, AUTO | Unique identifier |
| `filename` | TEXT | NOT NULL | Generated unique filename (UUID-based) |
| `original_filename` | TEXT | NOT NULL | Original name from upload |
| `filepath` | TEXT | NOT NULL | Path relative to `STORAGE_PATH` |
| `type` | TEXT | NOT NULL, CHECK | `'video'` or `'image'` |
| `mime_type` | TEXT | | MIME type (e.g., `video/mp4`, `image/jpeg`) |
| `file_size` | INTEGER | | Size in bytes |
| `duration` | REAL | | Duration in seconds; `NULL` for images |
| `width` | INTEGER | | Resolution width in pixels |
| `height` | INTEGER | | Resolution height in pixels |
| `checksum` | TEXT | UNIQUE | SHA-256 hash for duplicate detection |
| `thumbnail_status` | TEXT | | `pending` / `generating` / `generated` / `failed` |
| `approval_status` | TEXT | | `pending` / `approved` / `rejected` |
| `folder_id` | INTEGER | FK, nullable | References `media_folders(id)`. `NULL` = root. |
| `created_at` | DATETIME | DEFAULT NOW | Upload timestamp |
| `updated_at` | DATETIME | DEFAULT NOW | Auto-updated via trigger |

### media_folders

Nested (self-referential) folder hierarchy for organising media. Added in migration **014**. Folder identity is purely a DB concept — the on-disk layout under `STORAGE_PATH` is unchanged, so client-side downloads by media ID are unaffected by folder moves.

```sql
CREATE TABLE IF NOT EXISTS media_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES media_folders(id) ON DELETE CASCADE,
  path TEXT NOT NULL DEFAULT '/',             -- Materialised path like "/1/4/7"
  created_by INTEGER,                          -- FK to users(id), nullable
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(parent_id, name)
);
```

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PK, AUTO | Unique identifier |
| `name` | TEXT | NOT NULL | Display name (1-255 chars, no slashes) |
| `parent_id` | INTEGER | FK, nullable | `NULL` = top-level folder; CASCADE on delete |
| `path` | TEXT | NOT NULL | Slash-joined ancestor IDs (e.g. `/1/4`); maintained by the service on move |
| `created_by` | INTEGER | nullable | User that created the folder |
| `created_at` / `updated_at` | DATETIME | | Timestamps (trigger maintains updated_at) |

Uniqueness is enforced on `(parent_id, name)` so no two siblings share a name.

### playlists

Stores playlist metadata.

```sql
CREATE TABLE IF NOT EXISTS playlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PK, AUTO | Unique identifier |
| `name` | TEXT | NOT NULL | Display name (1-255 chars enforced by API) |
| `description` | TEXT | | Optional description (max 1000 chars) |
| `created_at` | DATETIME | DEFAULT NOW | Creation timestamp |
| `updated_at` | DATETIME | DEFAULT NOW | Auto-updated when playlist or its items change |

### playlist_items

Junction table linking playlists to media files with ordering.

```sql
CREATE TABLE IF NOT EXISTS playlist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  playlist_id INTEGER NOT NULL,
  media_id INTEGER NOT NULL,
  order_index INTEGER NOT NULL,             -- Position in playlist (0-indexed)
  image_duration INTEGER DEFAULT 5,         -- Display duration for images (seconds)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
  FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE,
  UNIQUE(playlist_id, order_index)
);
```

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PK, AUTO | Unique identifier |
| `playlist_id` | INTEGER | NOT NULL, FK | References `playlists(id)`, CASCADE delete |
| `media_id` | INTEGER | NOT NULL, FK | References `media_files(id)`, CASCADE delete |
| `order_index` | INTEGER | NOT NULL | 0-indexed position in playlist |
| `image_duration` | INTEGER | DEFAULT 5 | Display duration for images in seconds (1-3600) |
| `created_at` | DATETIME | DEFAULT NOW | When item was added |

**Constraints:**
- `UNIQUE(playlist_id, order_index)` ensures no duplicate positions within a playlist
- Deleting a playlist cascades to all its items
- Deleting a media file cascades to all playlist entries referencing it

### clients

Stores registered playback client information.

```sql
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,                       -- UUID generated by client
  name TEXT NOT NULL,                        -- Display name
  assigned_playlist_id INTEGER,              -- Currently assigned playlist
  status TEXT DEFAULT 'offline' CHECK(status IN ('online', 'offline', 'error')),
  last_seen DATETIME,                        -- Last heartbeat timestamp
  version TEXT,                              -- Client version
  capabilities TEXT,                         -- JSON string of capabilities
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (assigned_playlist_id) REFERENCES playlists(id) ON DELETE SET NULL
);
```

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | TEXT | PK | UUID generated by the client |
| `name` | TEXT | NOT NULL | Display name (1-255 chars) |
| `assigned_playlist_id` | INTEGER | FK, nullable | References `playlists(id)`, SET NULL on delete |
| `status` | TEXT | DEFAULT 'offline', CHECK | `'online'`, `'offline'`, or `'error'` |
| `last_seen` | DATETIME | | Updated on each heartbeat |
| `version` | TEXT | | Client software version string |
| `capabilities` | TEXT | | JSON string (e.g., `{"video":true,"image":true}`) |
| `created_at` | DATETIME | DEFAULT NOW | Registration timestamp |
| `updated_at` | DATETIME | DEFAULT NOW | Auto-updated via trigger |

### client_status

Time-series table storing real-time playback status snapshots.

```sql
CREATE TABLE IF NOT EXISTS client_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  current_media_id INTEGER,                  -- Currently playing media
  position REAL,                             -- Playback position in seconds
  is_playing BOOLEAN DEFAULT 0,             -- Playing state
  error_message TEXT,                        -- Last error if any
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (current_media_id) REFERENCES media_files(id) ON DELETE SET NULL
);
```

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PK, AUTO | Unique identifier |
| `client_id` | TEXT | NOT NULL, FK | References `clients(id)`, CASCADE delete |
| `current_media_id` | INTEGER | FK, nullable | References `media_files(id)`, SET NULL on delete |
| `position` | REAL | | Playback position in seconds |
| `is_playing` | BOOLEAN | DEFAULT 0 | Whether client is actively playing |
| `error_message` | TEXT | | Error description if client is in error state |
| `timestamp` | DATETIME | DEFAULT NOW | When this status was recorded |

A new row is inserted on each status update. Old rows can be cleaned up periodically (keep last N days).

### system_state

Key-value store for system-wide settings and metadata.

```sql
CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `key` | TEXT | PK | Setting name |
| `value` | TEXT | | Setting value |
| `updated_at` | DATETIME | DEFAULT NOW | Last modification time |

**Initial seed values:**
- `schema_version` = `'1.0.0'`
- `initialized_at` = current timestamp

---

## Indexes

| Index | Table | Columns | Purpose |
|-------|-------|---------|---------|
| `idx_media_type` | media_files | `type` | Filter media by video/image |
| `idx_media_created` | media_files | `created_at DESC` | List media by newest first |
| `idx_media_checksum` | media_files | `checksum` | Fast duplicate detection on upload |
| `idx_media_folder` | media_files | `folder_id` | Filter media by folder |
| `idx_media_folders_parent` | media_folders | `parent_id` | Tree traversal (children of a folder) |
| `idx_media_folders_path` | media_folders | `path` | Prefix matching for descendant queries |
| `idx_playlist_items_playlist` | playlist_items | `playlist_id, order_index` | Load playlist items in order |
| `idx_playlist_items_media` | playlist_items | `media_id` | Find which playlists contain a media file |
| `idx_clients_status` | clients | `status` | Filter clients by online/offline/error |
| `idx_clients_last_seen` | clients | `last_seen DESC` | Find most recently active clients |
| `idx_clients_playlist` | clients | `assigned_playlist_id` | Find all clients assigned to a playlist |
| `idx_client_status_client` | client_status | `client_id` | Get status history for a client |
| `idx_client_status_timestamp` | client_status | `timestamp DESC` | Get latest status entries |

---

## Triggers

| Trigger | Table | Event | Action |
|---------|-------|-------|--------|
| `update_media_files_timestamp` | media_files | AFTER UPDATE | Sets `updated_at = CURRENT_TIMESTAMP` |
| `update_playlists_timestamp` | playlists | AFTER UPDATE | Sets `updated_at = CURRENT_TIMESTAMP` |
| `update_playlists_on_item_change` | playlist_items | AFTER INSERT | Updates parent playlist's `updated_at` |
| `update_playlists_on_item_update` | playlist_items | AFTER UPDATE | Updates parent playlist's `updated_at` |
| `update_playlists_on_item_delete` | playlist_items | AFTER DELETE | Updates parent playlist's `updated_at` |
| `update_clients_timestamp` | clients | AFTER UPDATE | Sets `updated_at = CURRENT_TIMESTAMP` |

The playlist triggers ensure that adding, reordering, or removing items from a playlist updates the playlist's `updated_at` timestamp without requiring explicit updates in application code.

---

## Views

### playlists_with_counts

Returns each playlist with its item count and total duration.

```sql
SELECT
  p.id, p.name, p.description,
  COUNT(pi.id) as item_count,
  SUM(CASE
    WHEN mf.type = 'video' THEN COALESCE(mf.duration, 0)
    WHEN mf.type = 'image' THEN COALESCE(pi.image_duration, 5)
    ELSE 0
  END) as total_duration,
  p.created_at, p.updated_at
FROM playlists p
LEFT JOIN playlist_items pi ON p.id = pi.playlist_id
LEFT JOIN media_files mf ON pi.media_id = mf.id
GROUP BY p.id;
```

Total duration uses video file duration for videos and `image_duration` (or the default 5 seconds) for images.

### clients_latest_status

Joins each client with its most recent status entry, plus the currently assigned playlist name and playing media filename.

Uses `FIRST_VALUE` window function to get the latest status per client without a correlated subquery.

### media_usage_stats

Returns each media file with:
- `playlist_count` -- number of distinct playlists containing it
- `client_playback_count` -- number of distinct clients that have played it
- `last_played_at` -- most recent playback timestamp

---

## Design Notes

1. **Filepath** values in `media_files` are relative to the configured `STORAGE_PATH`, not absolute paths.
2. **Checksum** (SHA-256) on `media_files` prevents duplicate uploads. The UNIQUE constraint causes an insert failure if a file with the same hash already exists.
3. **Client IDs** are UUIDs generated by the client, not auto-incremented integers. This allows clients to self-identify across reconnections.
4. **Foreign key ON DELETE** behavior is intentional:
   - CASCADE: playlist items are deleted when their playlist or media is deleted
   - SET NULL: client's assigned playlist becomes NULL when the playlist is deleted; client status keeps its row but loses the media reference
5. **client_status** is append-only (time-series). The application should implement periodic cleanup of old records to prevent unbounded growth.
6. **system_state** stores `schema_version` for migration tracking. The migration runner (`server/src/database/migrations/`) checks this value to determine which migrations to apply.

---

*This document reflects the v1.0.0 schema. See `server/src/database/schema.sql` for the canonical DDL.*
