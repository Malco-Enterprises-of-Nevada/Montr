import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load .env file
dotenv.config();

/**
 * Database type enumeration
 */
export enum DatabaseType {
  SQLITE = 'sqlite',
  MYSQL = 'mysql',
  MSSQL = 'mssql',
  MONGODB = 'mongodb',
}

/**
 * Application configuration interface
 */
export interface Config {
  // Server configuration
  server: {
    port: number;
    host: string;
    environment: string;
    publicUrl?: string;
  };

  // Database configuration
  database: {
    type: DatabaseType;
    sqlite?: {
      path: string;
    };
    mysql?: {
      host: string;
      port: number;
      user: string;
      password: string;
      database: string;
    };
    mssql?: {
      server: string;
      port: number;
      user: string;
      password: string;
      database: string;
    };
    mongodb?: {
      uri: string;
    };
  };

  // Storage configuration
  storage: {
    backend: 'local' | 'spaces';
    path: string;
    maxUploadSizeMB: number;
    chunkSizeMB: number;
    spaces?: {
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      cdnEndpoint?: string;
    };
  };

  // Security configuration
  security: {
    apiKeyRequired: boolean;
    apiKey?: string;
    allowedOrigins: string[];
  };

  // Logging configuration
  logging: {
    level: string;
    logFile?: string;
  };

  // WebSocket configuration
  websocket: {
    healthCheckInterval: number;
    staleTimeout: number;
    heartbeatTimeout: number;
  };

  // Content configuration
  content: {
    requireMediaApproval: boolean;
  };

  // Authentication configuration (Microsoft Entra ID SSO + local break-glass)
  auth: {
    entra: {
      /** Routes mount only when an Entra client id is set (inert-by-default). */
      enabled: boolean;
      tenantId?: string;
      clientId?: string;
      clientSecret?: string;
      redirectUri?: string;
      postLogoutRedirectUri?: string;
      allowedDomains: string[];
      /** Signing secret for the stateless PKCE-state cookie (distinct from the JWT bearer secret). */
      stateSecret: string;
      /** Lifetime of an SSO-minted JWT (short, for offboarding — SSO_MASTER_PLAN.md §G). */
      jwtExpiry: string;
    };
    /**
     * Local password login. Fails OPEN (stays enabled) until an operator both
     * sets ENTRA_CLIENT_ID and explicitly sets AUTH_LOCAL_ENABLED=false — this
     * prevents a prod lockout when SSO env isn't fully wired yet (§D).
     */
    localLoginEnabled: boolean;
  };
}

/**
 * Validates required environment variables
 * @throws Error if required variables are missing
 */
function validateConfig(): void {
  const dbType = process.env.DB_TYPE?.toLowerCase() as DatabaseType;

  if (!dbType) {
    throw new Error('DB_TYPE environment variable is required');
  }

  if (!Object.values(DatabaseType).includes(dbType)) {
    throw new Error(
      `Invalid DB_TYPE: ${dbType}. Must be one of: ${Object.values(DatabaseType).join(', ')}`
    );
  }

  // Validate database-specific configuration
  switch (dbType) {
    case DatabaseType.SQLITE:
      if (!process.env.DB_PATH) {
        throw new Error('DB_PATH is required for SQLite');
      }
      break;
    case DatabaseType.MYSQL:
      if (!process.env.MYSQL_HOST || !process.env.MYSQL_USER || !process.env.MYSQL_DATABASE) {
        throw new Error('MYSQL_HOST, MYSQL_USER, and MYSQL_DATABASE are required for MySQL');
      }
      break;
    case DatabaseType.MSSQL:
      if (!process.env.MSSQL_SERVER || !process.env.MSSQL_USER || !process.env.MSSQL_DATABASE) {
        throw new Error('MSSQL_SERVER, MSSQL_USER, and MSSQL_DATABASE are required for MSSQL');
      }
      break;
    case DatabaseType.MONGODB:
      if (!process.env.MONGO_URI) {
        throw new Error('MONGO_URI is required for MongoDB');
      }
      break;
    default:
      // This should never happen due to earlier validation
      throw new Error(`Unsupported database type: ${String(dbType)}`);
  }

  // Validate storage path
  const storagePath = process.env.STORAGE_PATH || './storage';
  if (!fs.existsSync(storagePath)) {
    fs.mkdirSync(storagePath, { recursive: true });
  }
}

/**
 * Loads and returns the application configuration
 * @returns Application configuration object
 */
function loadConfig(): Config {
  validateConfig();

  const dbType = process.env.DB_TYPE?.toLowerCase() as DatabaseType;

  const config: Config = {
    server: {
      port: parseInt(process.env.PORT || '3000', 10),
      host: process.env.HOST || '0.0.0.0',
      environment: process.env.NODE_ENV || 'development',
      publicUrl: process.env.PUBLIC_URL,
    },

    database: {
      type: dbType,
    },

    storage: {
      backend: (process.env.STORAGE_BACKEND as 'local' | 'spaces') || 'local',
      path: process.env.STORAGE_PATH || './storage',
      maxUploadSizeMB: parseInt(process.env.MAX_UPLOAD_SIZE_MB || '2048', 10),
      chunkSizeMB: parseInt(process.env.CHUNK_SIZE_MB || '50', 10),
    },

    security: {
      apiKeyRequired: process.env.API_KEY_REQUIRED === 'true',
      apiKey: process.env.API_KEY,
      allowedOrigins: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : ['http://localhost:3000'],
    },

    logging: {
      level: process.env.LOG_LEVEL || 'info',
      logFile: process.env.LOG_FILE,
    },

    websocket: {
      healthCheckInterval: parseInt(process.env.WS_HEALTH_CHECK_INTERVAL || '30000', 10),
      staleTimeout: parseInt(process.env.WS_STALE_TIMEOUT || '300000', 10),
      heartbeatTimeout: parseInt(process.env.WS_HEARTBEAT_TIMEOUT || '60000', 10),
    },

    content: {
      requireMediaApproval: process.env.REQUIRE_MEDIA_APPROVAL === 'true',
    },

    auth: {
      entra: {
        // Inert-by-default: mount Entra routes only when a client id is present
        // (and SSO not explicitly switched off). Matches the fleet gate.
        enabled: process.env.ENTRA_SSO_ENABLED !== 'false' && Boolean(process.env.ENTRA_CLIENT_ID),
        tenantId: process.env.ENTRA_TENANT_ID,
        clientId: process.env.ENTRA_CLIENT_ID,
        clientSecret: process.env.ENTRA_CLIENT_SECRET,
        redirectUri: process.env.ENTRA_REDIRECT_URI,
        postLogoutRedirectUri: process.env.ENTRA_POST_LOGOUT_REDIRECT_URI || process.env.BASE_URL,
        allowedDomains: (process.env.ENTRA_ALLOWED_DOMAINS || 'budgetlasvegas.com')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        // The stateless PKCE-state cookie is signed with its own secret; fall
        // back to JWT_SECRET so a single secret works in simple deployments.
        stateSecret:
          process.env.ENTRA_STATE_SECRET ||
          process.env.JWT_SECRET ||
          'montr-dev-only-insecure-secret',
        jwtExpiry: process.env.SSO_JWT_EXPIRY || '1h',
      },
      // Fail OPEN: on unless explicitly turned off AND SSO is actually configured.
      localLoginEnabled: process.env.AUTH_LOCAL_ENABLED !== 'false' || !process.env.ENTRA_CLIENT_ID,
    },
  };

  // Add Spaces configuration if backend is spaces
  if (config.storage.backend === 'spaces') {
    const endpoint = process.env.SPACES_ENDPOINT;
    const region = process.env.SPACES_REGION;
    const bucket = process.env.SPACES_BUCKET;
    const accessKeyId = process.env.SPACES_ACCESS_KEY_ID;
    const secretAccessKey = process.env.SPACES_SECRET_ACCESS_KEY;

    if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error(
        'STORAGE_BACKEND=spaces requires: SPACES_ENDPOINT, SPACES_REGION, SPACES_BUCKET, SPACES_ACCESS_KEY_ID, SPACES_SECRET_ACCESS_KEY'
      );
    }

    config.storage.spaces = {
      endpoint,
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
      cdnEndpoint: process.env.SPACES_CDN_ENDPOINT,
    };
  }

  // Add database-specific configuration
  switch (dbType) {
    case DatabaseType.SQLITE: {
      const dbPath = process.env.DB_PATH!;
      const dbDir = path.dirname(dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
      config.database.sqlite = { path: dbPath };
      break;
    }
    case DatabaseType.MYSQL:
      config.database.mysql = {
        host: process.env.MYSQL_HOST!,
        port: parseInt(process.env.MYSQL_PORT || '3306', 10),
        user: process.env.MYSQL_USER!,
        password: process.env.MYSQL_PASSWORD || '',
        database: process.env.MYSQL_DATABASE!,
      };
      break;
    case DatabaseType.MSSQL:
      config.database.mssql = {
        server: process.env.MSSQL_SERVER!,
        port: parseInt(process.env.MSSQL_PORT || '1433', 10),
        user: process.env.MSSQL_USER!,
        password: process.env.MSSQL_PASSWORD || '',
        database: process.env.MSSQL_DATABASE!,
      };
      break;
    case DatabaseType.MONGODB:
      config.database.mongodb = {
        uri: process.env.MONGO_URI!,
      };
      break;
    default:
      // This should never happen due to earlier validation
      throw new Error(`Unsupported database type: ${String(dbType)}`);
  }

  return config;
}

// Export singleton configuration instance
export const config: Config = loadConfig();

export default config;
