import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { createServer, Server as HTTPServer } from 'http';
import { createServer as createHTTPSServer, Server as HTTPSServer } from 'https';
import { config } from './config/config';
import { initLogger, getLogger } from './utils/logger';
import { errorHandler, notFoundHandler, successResponse } from './api/middleware/error-handler';
import { getDatabase, closeDatabase } from './database/connection';
import mediaRoutes from './api/routes/media.routes';
import subtitleRoutes from './api/routes/subtitle.routes';
import foldersRoutes from './api/routes/folders.routes';
import playlistRoutes from './api/routes/playlist.routes';
import clientRoutes from './api/routes/client.routes';
import groupRoutes from './api/routes/group.routes';
import scheduleRoutes from './api/routes/schedule.routes';
import scheduleTemplateRoutes from './api/routes/schedule-template.routes';
import analyticsRoutes from './api/routes/analytics.routes';
import telemetryRoutes from './api/routes/telemetry.routes';
import notificationRoutes from './api/routes/notification.routes';
import adminLogsRoutes from './api/routes/admin-logs.routes';
import authRoutes from './api/routes/auth.routes';
import { createMontrEntraRouter } from './api/routes/entra.routes';
import { requireAuth } from './api/middleware/jwt-auth';
import { webSocketServer } from './websocket/server';
import { scheduleService } from './services/schedule.service';
import { notificationService } from './services/notification.service';
import { chunkedUploadService } from './services/chunked-upload.service';
import { thumbnailQueueService } from './services/thumbnail-queue.service';
import { uploadCompletionQueueService } from './services/upload-completion-queue.service';
import { storageService } from './services/storage.service';
import { getNodeHealth } from './cluster/health';

/**
 * Best-effort filesystem free-space lookup. Returns null on any error so the
 * memory logger can keep going even if statfs is unavailable (older Node, or
 * a filesystem that doesn't report stats).
 *
 * Node 18.15+ / 20+ ships `fs.statfs`; the production container runs Node 20.
 */
async function getDiskStats(
  targetPath: string
): Promise<{ freeMB: number; totalMB: number; freePct: number } | null> {
  try {
    // fs.promises.statfs is typed loosely in older @types/node; cast through
    // unknown so we don't depend on a specific @types version.
    const statfs = (
      fs.promises as unknown as {
        statfs?: (p: string) => Promise<{ bsize: number; blocks: number; bavail: number }>;
      }
    ).statfs;
    if (!statfs) return null;
    const s = await statfs(targetPath);
    const freeBytes = s.bavail * s.bsize;
    const totalBytes = s.blocks * s.bsize;
    return {
      freeMB: Math.round(freeBytes / 1024 / 1024),
      totalMB: Math.round(totalBytes / 1024 / 1024),
      freePct: totalBytes > 0 ? (freeBytes / totalBytes) * 100 : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Montr Server Application
 * Entry point for the media playlist system server
 */
class MontrServer {
  private app: Application;

  private server: HTTPServer | HTTPSServer | null = null;

  private logger = getLogger();

  constructor() {
    // Initialize logger first
    initLogger({
      level: config.logging.level,
      logFile: config.logging.logFile,
    });

    this.logger = getLogger();
    this.app = express();
    this.configureMiddleware();
    this.configureRoutes();
    this.configureErrorHandling();
  }

  /**
   * Configures Express middleware
   */
  private configureMiddleware(): void {
    // Behind Caddy + Cloudflare: trust the first proxy hop so req.protocol /
    // secure-cookie / req.ip reflect the real client, not the proxy.
    this.app.set('trust proxy', 1);

    // Security middleware - configure helmet to allow inline scripts for web UI
    this.app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", 'https://static.cloudflareinsights.com'],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'blob:'],
            mediaSrc: ["'self'", 'blob:'],
            connectSrc: ["'self'", 'https://cloudflareinsights.com'],
          },
        },
      })
    );
    this.app.use(
      cors({
        origin: config.security.allowedOrigins,
        credentials: true,
      })
    );

    // Body parsing middleware
    this.app.use(express.json({ limit: `${config.storage.maxUploadSizeMB}mb` }));
    this.app.use(
      express.urlencoded({ extended: true, limit: `${config.storage.maxUploadSizeMB}mb` })
    );

    // Cookie parsing — required by the Entra signed-state cookie (stateless PKCE).
    this.app.use(cookieParser());

    // Serve static files from web/public directory
    const publicPath = path.join(__dirname, 'web', 'public');
    this.app.use(express.static(publicPath));

    // Request logging middleware
    this.app.use((req, _res, next) => {
      this.logger.info(`${req.method} ${req.path}`, {
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      next();
    });
  }

  /**
   * Configures application routes
   */
  private configureRoutes(): void {
    // Health check endpoint
    this.app.get('/api/health', (_req: Request, res: Response) => {
      res.json(
        successResponse({
          status: 'ok',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          environment: config.server.environment,
          websocket: webSocketServer.getStats(),
          node: getNodeHealth(),
        })
      );
    });

    // API version endpoint
    this.app.get('/api/version', (_req: Request, res: Response) => {
      res.json(
        successResponse({
          version: '1.0.0',
          name: 'Montr Server',
        })
      );
    });

    // UI configuration endpoint (no auth required)
    this.app.get('/api/ui-config', (_req: Request, res: Response) => {
      res.json(
        successResponse({
          dashboardRefreshInterval: parseInt(process.env.UI_DASHBOARD_REFRESH_MS || '30000', 10),
          toastDisplayDuration: parseInt(process.env.UI_TOAST_DURATION_MS || '3000', 10),
          mediaUploadConcurrency: Math.max(
            1,
            Math.min(10, parseInt(process.env.UI_MEDIA_UPLOAD_CONCURRENCY || '2', 10))
          ),
          // Drives the login screen: show the "Sign in with Microsoft" button
          // and/or the local password form.
          ssoEnabled: config.auth.entra.enabled,
          localLoginEnabled: config.auth.localLoginEnabled,
        })
      );
    });

    // Root endpoint - serve web UI
    this.app.get('/', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, 'web', 'public', 'index.html'));
    });

    // API routes (JWT auth required — passes through in bootstrap mode when 0 users)
    this.app.use('/api/media', requireAuth(), mediaRoutes);
    this.app.use('/api/subtitles', requireAuth(), subtitleRoutes);
    this.app.use('/api/folders', requireAuth(), foldersRoutes);
    this.app.use('/api/playlists', requireAuth(), playlistRoutes);
    this.app.use('/api/clients', requireAuth(), clientRoutes);
    this.app.use('/api/groups', requireAuth(), groupRoutes);
    this.app.use('/api/schedules', requireAuth(), scheduleRoutes);
    this.app.use('/api/schedule-templates', requireAuth(), scheduleTemplateRoutes);
    this.app.use('/api/analytics', requireAuth(), analyticsRoutes);
    this.app.use('/api/telemetry', requireAuth(), telemetryRoutes);
    this.app.use('/api/notifications', requireAuth(), notificationRoutes);
    this.app.use('/api/admin/logs', requireAuth(), adminLogsRoutes);

    // Microsoft Entra SSO routes — mounted only when SSO is configured
    // (inert-by-default). Mounted before authRoutes so /api/auth/microsoft/*
    // resolves to the Entra router, not the user-management routes.
    if (config.auth.entra.enabled) {
      this.app.use('/api/auth/microsoft', createMontrEntraRouter());
      this.logger.info('Microsoft Entra SSO enabled at /api/auth/microsoft');
    }

    // Auth routes (no API key required)
    this.app.use('/api/auth', authRoutes);
    this.app.use('/api/users', authRoutes);
  }

  /**
   * Configures error handling middleware
   */
  private configureErrorHandling(): void {
    // 404 handler - must be after all routes
    this.app.use(notFoundHandler);

    // Global error handler - must be last
    this.app.use(errorHandler);
  }

  /**
   * Starts the HTTP server
   */
  public async start(): Promise<void> {
    try {
      // Initialize database connection
      const db = await getDatabase();
      this.logger.info('Database connection established');

      // If the previous process died mid-thumbnail (OOM, SIGKILL, crash),
      // any media stuck at thumbnail_status='generating' will never progress.
      // Flip them to 'failed' so the UI shows the retry button instead of
      // hammering /thumbnail and re-triggering the expensive generator.
      // Direct SQL UPDATE scans all rows in one statement — the previous
      // paginated approach silently missed anything past page 1 (limit 1000).
      try {
        const count = await db.resetStuckThumbnails();
        if (count > 0) {
          this.logger.warn(
            `Reset ${count} stuck thumbnail_status='generating' rows to 'failed' on startup`
          );
        }
      } catch (err) {
        this.logger.warn('Failed to reset stuck thumbnail statuses on startup:', err);
      }

      // Create HTTP or HTTPS server
      const tlsEnabled = process.env.TLS_ENABLED === 'true';
      const tlsCertPath = process.env.TLS_CERT_PATH;
      const tlsKeyPath = process.env.TLS_KEY_PATH;

      if (tlsEnabled && tlsCertPath && tlsKeyPath) {
        const cert = fs.readFileSync(tlsCertPath);
        const key = fs.readFileSync(tlsKeyPath);
        this.server = createHTTPSServer({ cert, key }, this.app);
        this.logger.info('HTTPS/TLS enabled');

        // Start HTTP redirect server
        const redirectApp = express();
        redirectApp.use((req: Request, res: Response) => {
          res.redirect(`https://${req.hostname}:${config.server.port}${req.url}`);
        });
        const redirectServer = createServer(redirectApp);
        const httpPort = parseInt(process.env.TLS_HTTP_PORT || '80', 10);
        redirectServer.listen(httpPort, config.server.host, () => {
          this.logger.info(`HTTP→HTTPS redirect listening on port ${httpPort}`);
        });
      } else {
        this.server = createServer(this.app);
      }

      // Initialize WebSocket server
      webSocketServer.initialize(this.server);
      this.logger.info('WebSocket server initialized');

      // Start schedule evaluation
      scheduleService.startEvaluation();
      this.logger.info('Schedule evaluation started');

      // Initialize notification email transport
      notificationService.initializeEmail();

      // Start thumbnail job queue poller. Pairs with resetStuckThumbnails
      // above: any media row stuck at 'generating' became 'failed', and
      // the queue service then resurrects still-queued jobs from the
      // thumbnail_jobs table (state='running' → 'queued' on its own).
      await thumbnailQueueService.start();

      // Start the upload-completion queue. Picks up slow post-/complete
      // work (checksum, ffprobe, dedup, createMedia) so /complete itself
      // can return 202 within Cloudflare's 100 s origin timeout even for
      // 100 GB uploads. Flips stranded 'running' jobs back to 'queued' on
      // startup for crash recovery.
      await uploadCompletionQueueService.start();

      // Purge chunk dirs orphaned by a previous crash/restart. Sessions live
      // only in memory, so once the process dies, those folders can never be
      // resumed — leaving them on disk is a slow leak. Fire-and-forget.
      // Age-gated (1h) so crash-loop restarts don't wipe an in-flight upload.
      void chunkedUploadService.cleanupOrphanedChunks().catch((err) => {
        this.logger.warn(`Orphan chunk cleanup failed: ${String(err)}`);
      });

      // Periodic memory + disk snapshot so we can tell an OOM kill from a
      // code crash next time this process disappears without logging an
      // error, and catch an ENOSPC-in-the-making before uploads start 500ing.
      // Kernel SIGKILL leaves no footprint; a steady RSS climb or a disk
      // dropping toward 0 right before the last line logged is our smoking
      // gun.
      let diskLowWarned = false;
      const memLogInterval = setInterval(async () => {
        const m = process.memoryUsage();
        const disk = await getDiskStats(config.storage.path);
        const diskStr = disk
          ? ` disk=${disk.freeMB}/${disk.totalMB}MB(${disk.freePct.toFixed(1)}%free)`
          : '';
        this.logger.info(
          `mem rss=${Math.round(m.rss / 1024 / 1024)}MB heap=${Math.round(
            m.heapUsed / 1024 / 1024
          )}/${Math.round(m.heapTotal / 1024 / 1024)}MB external=${Math.round(
            m.external / 1024 / 1024
          )}MB${diskStr}`
        );

        // Once free space drops under 10%, yell every interval so nobody
        // misses it. Reset the one-shot warn flag once we're back above 15%
        // (hysteresis so normal fluctuation doesn't re-trigger).
        if (disk) {
          if (disk.freePct < 10) {
            this.logger.warn(
              `LOW DISK: only ${disk.freePct.toFixed(1)}% free (${disk.freeMB}/${disk.totalMB}MB) on ${config.storage.path} — uploads will 500 with ENOSPC soon`
            );
            diskLowWarned = true;
          } else if (diskLowWarned && disk.freePct > 15) {
            this.logger.info(`Disk pressure recovered: ${disk.freePct.toFixed(1)}% free`);
            diskLowWarned = false;
          }
        }
      }, 30_000);
      memLogInterval.unref();

      // Purge temp files older than 1h every hour. `downloadToTemp` usually
      // cleans up after itself, but a crashed request mid-download leaves
      // the file behind — those accumulated into a disk-full event on
      // 2026-04-22 that 500'd every upload. Age-gated at 1h so we never
      // clobber an in-flight download.
      const tempCleanupInterval = setInterval(
        () => {
          void storageService.cleanupTempFiles(60 * 60 * 1000).catch((err) => {
            this.logger.warn(`Periodic temp cleanup failed: ${String(err)}`);
          });
        },
        60 * 60 * 1000
      );
      tempCleanupInterval.unref();

      // Start listening
      await new Promise<void>((resolve, reject) => {
        this.server!.listen(config.server.port, config.server.host, () => {
          resolve();
        });

        this.server!.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE') {
            this.logger.error(
              `Port ${config.server.port} is already in use. Please choose a different port.`
            );
          } else {
            this.logger.error('Server error:', error);
          }
          reject(error);
        });
      });

      this.logger.info(
        `Montr Server started successfully on ${config.server.host}:${config.server.port}`
      );
      this.logger.info(`Environment: ${config.server.environment}`);
      this.logger.info(`Database type: ${config.database.type}`);
      this.logger.info(`Storage path: ${config.storage.path}`);
      const proto = tlsEnabled ? 'https' : 'http';
      const wsProto = tlsEnabled ? 'wss' : 'ws';
      this.logger.info(
        `Health check: ${proto}://${config.server.host}:${config.server.port}/api/health`
      );
      this.logger.info(
        `WebSocket endpoint: ${wsProto}://${config.server.host}:${config.server.port}/ws`
      );

      // Warn about API key misconfiguration
      if (config.security.apiKeyRequired && !config.security.apiKey) {
        this.logger.warn(
          'API_KEY_REQUIRED is true but API_KEY is empty. All authenticated API requests will be rejected.'
        );
      }
    } catch (error) {
      this.logger.error('Failed to start server:', error);
      throw error;
    }
  }

  /**
   * Gracefully shuts down the server
   */
  public async shutdown(): Promise<void> {
    this.logger.info('Shutting down server gracefully...');

    // Stop schedule evaluation
    scheduleService.stopEvaluation();

    // Stop thumbnail queue so we don't claim new jobs during shutdown.
    try {
      await thumbnailQueueService.stop();
    } catch (error) {
      this.logger.error('Error shutting down thumbnail queue:', error);
    }

    // Stop upload-completion queue (same reasoning as thumbnail queue).
    try {
      await uploadCompletionQueueService.stop();
    } catch (error) {
      this.logger.error('Error shutting down upload-completion queue:', error);
    }

    // Shutdown WebSocket server first
    try {
      await webSocketServer.shutdown();
    } catch (error) {
      this.logger.error('Error shutting down WebSocket server:', error);
    }

    if (this.server) {
      await new Promise<void>((resolve, reject) => {
        this.server!.close((error) => {
          if (error) {
            this.logger.error('Error during server shutdown:', error);
            reject(error);
          } else {
            this.logger.info('Server shut down successfully');
            resolve();
          }
        });
      });
    }

    // Close database connection
    await closeDatabase();
  }

  /**
   * Gets the Express application instance
   */
  public getApp(): Application {
    return this.app;
  }
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
  const server = new MontrServer();

  // Handle graceful shutdown
  const shutdownHandler = async (signal: string): Promise<void> => {
    const logger = getLogger();
    logger.info(`Received ${signal} signal, shutting down...`);
    try {
      await server.shutdown();
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => {
    shutdownHandler('SIGTERM').catch((err) => {
      const logger = getLogger();
      logger.error('Error in SIGTERM handler:', err);
    });
  });
  process.on('SIGINT', () => {
    shutdownHandler('SIGINT').catch((err) => {
      const logger = getLogger();
      logger.error('Error in SIGINT handler:', err);
    });
  });

  // Handle uncaught errors.
  //
  // uncaughtException: the process state is unpredictable after one, so we
  // still exit — systemd/docker will restart us. (It's a real bug; the signal
  // is worth the restart.)
  //
  // unhandledRejection: exiting used to take the whole server down whenever
  // any stray async op (thumbnail gen, notification send, cleanup) threw an
  // unexpected error. Node's default is now "warn, don't exit", which matches
  // what we want for a long-running API server. Log it loudly so we can fix
  // the source, but keep serving traffic.
  process.on('uncaughtException', (error: Error) => {
    const logger = getLogger();
    logger.error('Uncaught exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const logger = getLogger();
    logger.error('Unhandled rejection (keeping process alive):', reason);
  });

  // Start the server
  try {
    await server.start();
  } catch (error) {
    const logger = getLogger();
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the application if this file is executed directly
if (require.main === module) {
  main().catch((err) => {
    const logger = getLogger();
    logger.error('Fatal error starting application:', err);
    process.exit(1);
  });
}

export default MontrServer;
