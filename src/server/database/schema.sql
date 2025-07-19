-- Media Playlist System Database Schema

-- Table for storing playlists
CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Table for storing media files
CREATE TABLE IF NOT EXISTS media_files (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    file_type TEXT NOT NULL CHECK (file_type IN ('video', 'image')),
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    duration INTEGER, -- in seconds for videos, display time for images
    thumbnail_path TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Table for storing playlist items (many-to-many relationship)
CREATE TABLE IF NOT EXISTS playlist_items (
    id TEXT PRIMARY KEY,
    playlist_id TEXT NOT NULL,
    media_file_id TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    display_duration INTEGER, -- override duration for images
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (media_file_id) REFERENCES media_files(id) ON DELETE CASCADE,
    UNIQUE(playlist_id, order_index)
);

-- Table for storing system state
CREATE TABLE IF NOT EXISTS system_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert default system state
INSERT OR IGNORE INTO system_state (key, value) VALUES ('active_playlist_id', NULL);

-- Indexes for better performance
CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist_id ON playlist_items(playlist_id);
CREATE INDEX IF NOT EXISTS idx_playlist_items_order ON playlist_items(playlist_id, order_index);
CREATE INDEX IF NOT EXISTS idx_media_files_type ON media_files(file_type);
CREATE INDEX IF NOT EXISTS idx_playlists_updated ON playlists(updated_at);

-- Trigger to update updated_at timestamp for playlists
CREATE TRIGGER IF NOT EXISTS update_playlist_timestamp 
    AFTER UPDATE ON playlists
    FOR EACH ROW
BEGIN
    UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Trigger to update system_state timestamp
CREATE TRIGGER IF NOT EXISTS update_system_state_timestamp 
    AFTER UPDATE ON system_state
    FOR EACH ROW
BEGIN
    UPDATE system_state SET updated_at = CURRENT_TIMESTAMP WHERE key = NEW.key;
END;