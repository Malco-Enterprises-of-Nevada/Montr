/**
 * Migration 001: Initial Schema
 * Creates all base tables, indexes, triggers, and views.
 * This is the baseline migration matching schema.sql v1.0.0
 */

import { Migration, MigrationContext } from './types';

// ─── SQLite DDL ─────────────────────────────────────────────────────────────

const SQLITE_STATEMENTS = [
  // Tables
  `CREATE TABLE IF NOT EXISTS media_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('video', 'image')),
    mime_type TEXT,
    file_size INTEGER,
    duration REAL,
    width INTEGER,
    height INTEGER,
    checksum TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS playlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL,
    media_id INTEGER NOT NULL,
    order_index INTEGER NOT NULL,
    image_duration INTEGER DEFAULT 5,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE,
    UNIQUE(playlist_id, order_index)
  )`,

  `CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    assigned_playlist_id INTEGER,
    status TEXT DEFAULT 'offline' CHECK(status IN ('online', 'offline', 'error')),
    last_seen DATETIME,
    version TEXT,
    capabilities TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (assigned_playlist_id) REFERENCES playlists(id) ON DELETE SET NULL
  )`,

  `CREATE TABLE IF NOT EXISTS client_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    current_media_id INTEGER,
    position REAL,
    is_playing BOOLEAN DEFAULT 0,
    error_message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    FOREIGN KEY (current_media_id) REFERENCES media_files(id) ON DELETE SET NULL
  )`,

  `CREATE TABLE IF NOT EXISTS system_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // Indexes
  `CREATE INDEX IF NOT EXISTS idx_media_type ON media_files(type)`,
  `CREATE INDEX IF NOT EXISTS idx_media_created ON media_files(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_media_checksum ON media_files(checksum)`,
  `CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist ON playlist_items(playlist_id, order_index)`,
  `CREATE INDEX IF NOT EXISTS idx_playlist_items_media ON playlist_items(media_id)`,
  `CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status)`,
  `CREATE INDEX IF NOT EXISTS idx_clients_last_seen ON clients(last_seen DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_clients_playlist ON clients(assigned_playlist_id)`,
  `CREATE INDEX IF NOT EXISTS idx_client_status_client ON client_status(client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_client_status_timestamp ON client_status(timestamp DESC)`,

  // Triggers
  `CREATE TRIGGER IF NOT EXISTS update_media_files_timestamp
   AFTER UPDATE ON media_files
   BEGIN
     UPDATE media_files SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
   END`,

  `CREATE TRIGGER IF NOT EXISTS update_playlists_timestamp
   AFTER UPDATE ON playlists
   BEGIN
     UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
   END`,

  `CREATE TRIGGER IF NOT EXISTS update_playlists_on_item_change
   AFTER INSERT ON playlist_items
   BEGIN
     UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.playlist_id;
   END`,

  `CREATE TRIGGER IF NOT EXISTS update_playlists_on_item_update
   AFTER UPDATE ON playlist_items
   BEGIN
     UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.playlist_id;
   END`,

  `CREATE TRIGGER IF NOT EXISTS update_playlists_on_item_delete
   AFTER DELETE ON playlist_items
   BEGIN
     UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.playlist_id;
   END`,

  `CREATE TRIGGER IF NOT EXISTS update_clients_timestamp
   AFTER UPDATE ON clients
   BEGIN
     UPDATE clients SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
   END`,

  // Views
  `CREATE VIEW IF NOT EXISTS playlists_with_counts AS
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
   GROUP BY p.id`,

  `CREATE VIEW IF NOT EXISTS clients_latest_status AS
   SELECT
     c.id, c.name, c.status, c.assigned_playlist_id, c.last_seen,
     cs.current_media_id, cs.position, cs.is_playing, cs.error_message,
     cs.timestamp as status_timestamp,
     mf.filename as current_media_filename, mf.type as current_media_type,
     p.name as assigned_playlist_name
   FROM clients c
   LEFT JOIN (
     SELECT DISTINCT client_id,
       FIRST_VALUE(current_media_id) OVER (PARTITION BY client_id ORDER BY timestamp DESC) as current_media_id,
       FIRST_VALUE(position) OVER (PARTITION BY client_id ORDER BY timestamp DESC) as position,
       FIRST_VALUE(is_playing) OVER (PARTITION BY client_id ORDER BY timestamp DESC) as is_playing,
       FIRST_VALUE(error_message) OVER (PARTITION BY client_id ORDER BY timestamp DESC) as error_message,
       FIRST_VALUE(timestamp) OVER (PARTITION BY client_id ORDER BY timestamp DESC) as timestamp
     FROM client_status
   ) cs ON c.id = cs.client_id
   LEFT JOIN media_files mf ON cs.current_media_id = mf.id
   LEFT JOIN playlists p ON c.assigned_playlist_id = p.id`,

  `CREATE VIEW IF NOT EXISTS media_usage_stats AS
   SELECT
     mf.id, mf.filename, mf.original_filename, mf.type,
     COUNT(DISTINCT pi.playlist_id) as playlist_count,
     COUNT(DISTINCT cs.client_id) as client_playback_count,
     MAX(cs.timestamp) as last_played_at
   FROM media_files mf
   LEFT JOIN playlist_items pi ON mf.id = pi.media_id
   LEFT JOIN client_status cs ON mf.id = cs.current_media_id
   GROUP BY mf.id`,

  // Initial system state
  `INSERT OR IGNORE INTO system_state (key, value) VALUES ('schema_version', '1.0.0')`,
  `INSERT OR IGNORE INTO system_state (key, value) VALUES ('initialized_at', datetime('now'))`,
];

// ─── MySQL DDL ──────────────────────────────────────────────────────────────

const MYSQL_STATEMENTS = [
  // Tables
  `CREATE TABLE IF NOT EXISTS media_files (
    id INT AUTO_INCREMENT PRIMARY KEY,
    filename VARCHAR(255) NOT NULL,
    original_filename VARCHAR(255) NOT NULL,
    filepath VARCHAR(512) NOT NULL,
    type VARCHAR(10) NOT NULL,
    mime_type VARCHAR(100),
    file_size BIGINT,
    duration DOUBLE,
    width INT,
    height INT,
    checksum VARCHAR(64) UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    CHECK(type IN ('video', 'image'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS playlists (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS playlist_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    playlist_id INT NOT NULL,
    media_id INT NOT NULL,
    order_index INT NOT NULL,
    image_duration INT DEFAULT 5,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE,
    UNIQUE KEY uq_playlist_order (playlist_id, order_index)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS clients (
    id VARCHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    assigned_playlist_id INT,
    status VARCHAR(10) DEFAULT 'offline',
    last_seen DATETIME,
    version VARCHAR(50),
    capabilities TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (assigned_playlist_id) REFERENCES playlists(id) ON DELETE SET NULL,
    CHECK(status IN ('online', 'offline', 'error'))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS client_status (
    id INT AUTO_INCREMENT PRIMARY KEY,
    client_id VARCHAR(36) NOT NULL,
    current_media_id INT,
    position DOUBLE,
    is_playing TINYINT(1) DEFAULT 0,
    error_message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    FOREIGN KEY (current_media_id) REFERENCES media_files(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS system_state (
    \`key\` VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Indexes
  `CREATE INDEX idx_media_type ON media_files(type)`,
  `CREATE INDEX idx_media_created ON media_files(created_at DESC)`,
  `CREATE INDEX idx_playlist_items_playlist ON playlist_items(playlist_id, order_index)`,
  `CREATE INDEX idx_playlist_items_media ON playlist_items(media_id)`,
  `CREATE INDEX idx_clients_status ON clients(status)`,
  `CREATE INDEX idx_clients_last_seen ON clients(last_seen DESC)`,
  `CREATE INDEX idx_clients_playlist ON clients(assigned_playlist_id)`,
  `CREATE INDEX idx_client_status_client ON client_status(client_id)`,
  `CREATE INDEX idx_client_status_timestamp ON client_status(timestamp DESC)`,

  // Triggers
  `CREATE TRIGGER update_media_files_timestamp
   AFTER UPDATE ON media_files
   FOR EACH ROW
   UPDATE media_files SET updated_at = NOW() WHERE id = NEW.id`,

  `CREATE TRIGGER update_playlists_timestamp
   AFTER UPDATE ON playlists
   FOR EACH ROW
   UPDATE playlists SET updated_at = NOW() WHERE id = NEW.id`,

  `CREATE TRIGGER update_playlists_on_item_change
   AFTER INSERT ON playlist_items
   FOR EACH ROW
   UPDATE playlists SET updated_at = NOW() WHERE id = NEW.playlist_id`,

  `CREATE TRIGGER update_playlists_on_item_update
   AFTER UPDATE ON playlist_items
   FOR EACH ROW
   UPDATE playlists SET updated_at = NOW() WHERE id = NEW.playlist_id`,

  `CREATE TRIGGER update_playlists_on_item_delete
   AFTER DELETE ON playlist_items
   FOR EACH ROW
   UPDATE playlists SET updated_at = NOW() WHERE id = OLD.playlist_id`,

  `CREATE TRIGGER update_clients_timestamp
   AFTER UPDATE ON clients
   FOR EACH ROW
   UPDATE clients SET updated_at = NOW() WHERE id = NEW.id`,

  // Views
  `CREATE OR REPLACE VIEW playlists_with_counts AS
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
   GROUP BY p.id`,

  `CREATE OR REPLACE VIEW clients_latest_status AS
   SELECT
     c.id, c.name, c.status, c.assigned_playlist_id, c.last_seen,
     cs.current_media_id, cs.position, cs.is_playing, cs.error_message,
     cs.timestamp as status_timestamp,
     mf.filename as current_media_filename, mf.type as current_media_type,
     p.name as assigned_playlist_name
   FROM clients c
   LEFT JOIN (
     SELECT DISTINCT client_id,
       FIRST_VALUE(current_media_id) OVER (PARTITION BY client_id ORDER BY timestamp DESC) as current_media_id,
       FIRST_VALUE(position) OVER (PARTITION BY client_id ORDER BY timestamp DESC) as position,
       FIRST_VALUE(is_playing) OVER (PARTITION BY client_id ORDER BY timestamp DESC) as is_playing,
       FIRST_VALUE(error_message) OVER (PARTITION BY client_id ORDER BY timestamp DESC) as error_message,
       FIRST_VALUE(timestamp) OVER (PARTITION BY client_id ORDER BY timestamp DESC) as timestamp
     FROM client_status
   ) cs ON c.id = cs.client_id
   LEFT JOIN media_files mf ON cs.current_media_id = mf.id
   LEFT JOIN playlists p ON c.assigned_playlist_id = p.id`,

  `CREATE OR REPLACE VIEW media_usage_stats AS
   SELECT
     mf.id, mf.filename, mf.original_filename, mf.type,
     COUNT(DISTINCT pi.playlist_id) as playlist_count,
     COUNT(DISTINCT cs.client_id) as client_playback_count,
     MAX(cs.timestamp) as last_played_at
   FROM media_files mf
   LEFT JOIN playlist_items pi ON mf.id = pi.media_id
   LEFT JOIN client_status cs ON mf.id = cs.current_media_id
   GROUP BY mf.id`,

  // Initial system state
  `INSERT IGNORE INTO system_state (\`key\`, value) VALUES ('schema_version', '1.0.0')`,
  `INSERT IGNORE INTO system_state (\`key\`, value) VALUES ('initialized_at', NOW())`,
];

// ─── MSSQL DDL ──────────────────────────────────────────────────────────────

const MSSQL_STATEMENTS = [
  // Tables
  `IF OBJECT_ID('media_files', 'U') IS NULL
   CREATE TABLE media_files (
     id INT IDENTITY(1,1) PRIMARY KEY,
     filename NVARCHAR(255) NOT NULL,
     original_filename NVARCHAR(255) NOT NULL,
     filepath NVARCHAR(512) NOT NULL,
     type NVARCHAR(10) NOT NULL CHECK(type IN ('video', 'image')),
     mime_type NVARCHAR(100),
     file_size BIGINT,
     duration FLOAT,
     width INT,
     height INT,
     checksum NVARCHAR(64) UNIQUE,
     created_at DATETIME2 DEFAULT GETUTCDATE(),
     updated_at DATETIME2 DEFAULT GETUTCDATE()
   )`,

  `IF OBJECT_ID('playlists', 'U') IS NULL
   CREATE TABLE playlists (
     id INT IDENTITY(1,1) PRIMARY KEY,
     name NVARCHAR(255) NOT NULL,
     description NVARCHAR(MAX),
     created_at DATETIME2 DEFAULT GETUTCDATE(),
     updated_at DATETIME2 DEFAULT GETUTCDATE()
   )`,

  `IF OBJECT_ID('playlist_items', 'U') IS NULL
   CREATE TABLE playlist_items (
     id INT IDENTITY(1,1) PRIMARY KEY,
     playlist_id INT NOT NULL,
     media_id INT NOT NULL,
     order_index INT NOT NULL,
     image_duration INT DEFAULT 5,
     created_at DATETIME2 DEFAULT GETUTCDATE(),
     FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
     FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE CASCADE,
     UNIQUE(playlist_id, order_index)
   )`,

  `IF OBJECT_ID('clients', 'U') IS NULL
   CREATE TABLE clients (
     id NVARCHAR(36) PRIMARY KEY,
     name NVARCHAR(255) NOT NULL,
     assigned_playlist_id INT,
     status NVARCHAR(10) DEFAULT 'offline' CHECK(status IN ('online', 'offline', 'error')),
     last_seen DATETIME2,
     version NVARCHAR(50),
     capabilities NVARCHAR(MAX),
     created_at DATETIME2 DEFAULT GETUTCDATE(),
     updated_at DATETIME2 DEFAULT GETUTCDATE(),
     FOREIGN KEY (assigned_playlist_id) REFERENCES playlists(id) ON DELETE SET NULL
   )`,

  `IF OBJECT_ID('client_status', 'U') IS NULL
   CREATE TABLE client_status (
     id INT IDENTITY(1,1) PRIMARY KEY,
     client_id NVARCHAR(36) NOT NULL,
     current_media_id INT,
     position FLOAT,
     is_playing BIT DEFAULT 0,
     error_message NVARCHAR(MAX),
     timestamp DATETIME2 DEFAULT GETUTCDATE(),
     FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
     FOREIGN KEY (current_media_id) REFERENCES media_files(id) ON DELETE SET NULL
   )`,

  `IF OBJECT_ID('system_state', 'U') IS NULL
   CREATE TABLE system_state (
     [key] NVARCHAR(100) PRIMARY KEY,
     value NVARCHAR(MAX),
     updated_at DATETIME2 DEFAULT GETUTCDATE()
   )`,

  // Indexes (conditional creation for MSSQL)
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_media_type')
   CREATE INDEX idx_media_type ON media_files(type)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_media_created')
   CREATE INDEX idx_media_created ON media_files(created_at DESC)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_playlist_items_playlist')
   CREATE INDEX idx_playlist_items_playlist ON playlist_items(playlist_id, order_index)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_playlist_items_media')
   CREATE INDEX idx_playlist_items_media ON playlist_items(media_id)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_clients_status')
   CREATE INDEX idx_clients_status ON clients(status)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_clients_last_seen')
   CREATE INDEX idx_clients_last_seen ON clients(last_seen DESC)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_clients_playlist')
   CREATE INDEX idx_clients_playlist ON clients(assigned_playlist_id)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_client_status_client')
   CREATE INDEX idx_client_status_client ON client_status(client_id)`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_client_status_timestamp')
   CREATE INDEX idx_client_status_timestamp ON client_status(timestamp DESC)`,

  // Triggers
  `CREATE OR ALTER TRIGGER update_media_files_timestamp ON media_files
   AFTER UPDATE AS
   BEGIN
     SET NOCOUNT ON;
     UPDATE media_files SET updated_at = GETUTCDATE()
     FROM media_files INNER JOIN inserted ON media_files.id = inserted.id;
   END`,

  `CREATE OR ALTER TRIGGER update_playlists_timestamp ON playlists
   AFTER UPDATE AS
   BEGIN
     SET NOCOUNT ON;
     UPDATE playlists SET updated_at = GETUTCDATE()
     FROM playlists INNER JOIN inserted ON playlists.id = inserted.id;
   END`,

  `CREATE OR ALTER TRIGGER update_playlists_on_item_change ON playlist_items
   AFTER INSERT AS
   BEGIN
     SET NOCOUNT ON;
     UPDATE playlists SET updated_at = GETUTCDATE()
     FROM playlists INNER JOIN inserted ON playlists.id = inserted.playlist_id;
   END`,

  `CREATE OR ALTER TRIGGER update_playlists_on_item_update ON playlist_items
   AFTER UPDATE AS
   BEGIN
     SET NOCOUNT ON;
     UPDATE playlists SET updated_at = GETUTCDATE()
     FROM playlists INNER JOIN inserted ON playlists.id = inserted.playlist_id;
   END`,

  `CREATE OR ALTER TRIGGER update_playlists_on_item_delete ON playlist_items
   AFTER DELETE AS
   BEGIN
     SET NOCOUNT ON;
     UPDATE playlists SET updated_at = GETUTCDATE()
     FROM playlists INNER JOIN deleted ON playlists.id = deleted.playlist_id;
   END`,

  `CREATE OR ALTER TRIGGER update_clients_timestamp ON clients
   AFTER UPDATE AS
   BEGIN
     SET NOCOUNT ON;
     UPDATE clients SET updated_at = GETUTCDATE()
     FROM clients INNER JOIN inserted ON clients.id = inserted.id;
   END`,

  // Views
  `CREATE OR ALTER VIEW playlists_with_counts AS
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
   GROUP BY p.id, p.name, p.description, p.created_at, p.updated_at`,

  `CREATE OR ALTER VIEW clients_latest_status AS
   SELECT
     c.id, c.name, c.status, c.assigned_playlist_id, c.last_seen,
     cs.current_media_id, cs.position, cs.is_playing, cs.error_message,
     cs.timestamp as status_timestamp,
     mf.filename as current_media_filename, mf.type as current_media_type,
     p.name as assigned_playlist_name
   FROM clients c
   LEFT JOIN (
     SELECT DISTINCT client_id,
       FIRST_VALUE(current_media_id) OVER (PARTITION BY client_id ORDER BY timestamp DESC) as current_media_id,
       FIRST_VALUE(position) OVER (PARTITION BY client_id ORDER BY timestamp DESC) as position,
       FIRST_VALUE(is_playing) OVER (PARTITION BY client_id ORDER BY timestamp DESC) as is_playing,
       FIRST_VALUE(error_message) OVER (PARTITION BY client_id ORDER BY timestamp DESC) as error_message,
       FIRST_VALUE(timestamp) OVER (PARTITION BY client_id ORDER BY timestamp DESC) as timestamp
     FROM client_status
   ) cs ON c.id = cs.client_id
   LEFT JOIN media_files mf ON cs.current_media_id = mf.id
   LEFT JOIN playlists p ON c.assigned_playlist_id = p.id`,

  `CREATE OR ALTER VIEW media_usage_stats AS
   SELECT
     mf.id, mf.filename, mf.original_filename, mf.type,
     COUNT(DISTINCT pi.playlist_id) as playlist_count,
     COUNT(DISTINCT cs.client_id) as client_playback_count,
     MAX(cs.timestamp) as last_played_at
   FROM media_files mf
   LEFT JOIN playlist_items pi ON mf.id = pi.media_id
   LEFT JOIN client_status cs ON mf.id = cs.current_media_id
   GROUP BY mf.id, mf.filename, mf.original_filename, mf.type`,

  // Initial system state
  `IF NOT EXISTS (SELECT 1 FROM system_state WHERE [key] = 'schema_version')
   INSERT INTO system_state ([key], value) VALUES ('schema_version', '1.0.0')`,
  `IF NOT EXISTS (SELECT 1 FROM system_state WHERE [key] = 'initialized_at')
   INSERT INTO system_state ([key], value) VALUES ('initialized_at', CONVERT(NVARCHAR, GETUTCDATE(), 126))`,
];

// ─── MongoDB Setup ──────────────────────────────────────────────────────────

async function setupMongoDB(ctx: MigrationContext): Promise<void> {
  const db = ctx.getMongoDb!();

  // Create collections explicitly (they'd be auto-created on first insert,
  // but explicit creation lets us set up indexes upfront)
  const collections = await db.listCollections().toArray();
  const existing = new Set(collections.map((c) => c.name));

  for (const name of [
    'media_files',
    'playlists',
    'playlist_items',
    'clients',
    'client_status',
    'system_state',
    'counters',
  ]) {
    if (!existing.has(name)) {
      await db.createCollection(name);
    }
  }

  // Indexes
  await db.collection('media_files').createIndex({ checksum: 1 }, { unique: true, sparse: true });
  await db.collection('media_files').createIndex({ type: 1 });
  await db.collection('media_files').createIndex({ created_at: -1 });

  await db
    .collection('playlist_items')
    .createIndex({ playlist_id: 1, order_index: 1 }, { unique: true });
  await db.collection('playlist_items').createIndex({ playlist_id: 1 });
  await db.collection('playlist_items').createIndex({ media_id: 1 });

  await db.collection('clients').createIndex({ status: 1 });
  await db.collection('clients').createIndex({ last_seen: -1 });
  await db.collection('clients').createIndex({ assigned_playlist_id: 1 });

  await db.collection('client_status').createIndex({ client_id: 1 });
  await db.collection('client_status').createIndex({ timestamp: -1 });

  // Initialize auto-increment counters (using string _id, not ObjectId)
  for (const name of ['media_files', 'playlists', 'playlist_items', 'client_status']) {
    await db
      .collection('counters')
      .updateOne(
        { _id: name as unknown as import('mongodb').ObjectId },
        { $setOnInsert: { seq: 0 } },
        { upsert: true }
      );
  }

  // Initialize system state
  await db.collection('system_state').updateOne(
    { key: 'schema_version' },
    {
      $setOnInsert: {
        key: 'schema_version',
        value: '1.0.0',
        updated_at: new Date().toISOString(),
      },
    },
    { upsert: true }
  );
  await db.collection('system_state').updateOne(
    { key: 'initialized_at' },
    {
      $setOnInsert: {
        key: 'initialized_at',
        value: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    },
    { upsert: true }
  );
}

async function teardownMongoDB(ctx: MigrationContext): Promise<void> {
  const db = ctx.getMongoDb!();
  for (const name of [
    'client_status',
    'clients',
    'playlist_items',
    'playlists',
    'media_files',
    'system_state',
    'counters',
    'schema_migrations',
  ]) {
    await db
      .collection(name)
      .drop()
      .catch(() => {});
  }
}

// ─── Migration Export ───────────────────────────────────────────────────────

async function executeStatements(ctx: MigrationContext, statements: string[]): Promise<void> {
  for (const stmt of statements) {
    await ctx.executeSql!(stmt);
  }
}

export const migration: Migration = {
  version: '1.0.0',
  description: 'Initial schema — tables, indexes, triggers, views',

  async up(ctx: MigrationContext): Promise<void> {
    switch (ctx.adapterType) {
      case 'sqlite':
        await executeStatements(ctx, SQLITE_STATEMENTS);
        break;
      case 'mysql':
        await executeStatements(ctx, MYSQL_STATEMENTS);
        break;
      case 'mssql':
        await executeStatements(ctx, MSSQL_STATEMENTS);
        break;
      case 'mongodb':
        await setupMongoDB(ctx);
        break;
      default:
        throw new Error(`Unsupported adapter type: ${ctx.adapterType}`);
    }
  },

  async down(ctx: MigrationContext): Promise<void> {
    if (ctx.adapterType === 'mongodb') {
      await teardownMongoDB(ctx);
      return;
    }

    // SQL adapters: drop in reverse dependency order
    const dropStatements = [
      'DROP VIEW IF EXISTS media_usage_stats',
      'DROP VIEW IF EXISTS clients_latest_status',
      'DROP VIEW IF EXISTS playlists_with_counts',
      'DROP TABLE IF EXISTS client_status',
      'DROP TABLE IF EXISTS clients',
      'DROP TABLE IF EXISTS playlist_items',
      'DROP TABLE IF EXISTS playlists',
      'DROP TABLE IF EXISTS media_files',
      'DROP TABLE IF EXISTS system_state',
    ];

    await executeStatements(ctx, dropStatements);
  },
};
