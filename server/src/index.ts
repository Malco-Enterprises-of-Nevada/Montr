import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { createServer, Server as HTTPServer } from 'http';
import { config } from './config/config';
import { initLogger, getLogger } from './utils/logger';
import { errorHandler, notFoundHandler, successResponse } from './api/middleware/error-handler';
import { getDatabase, closeDatabase } from './database/connection';
import mediaRoutes from './api/routes/media.routes';
import playlistRoutes from './api/routes/playlist.routes';
import clientRoutes from './api/routes/client.routes';
import groupRoutes from './api/routes/group.routes';
import scheduleRoutes from './api/routes/schedule.routes';
import analyticsRoutes from './api/routes/analytics.routes';
import notificationRoutes from './api/routes/notification.routes';
import authRoutes from './api/routes/auth.routes';
import { apiKeyAuth } from './api/middleware/auth';
import { webSocketServer } from './websocket/server';
import { scheduleService } from './services/schedule.service';
import { notificationService } from './services/notification.service';

/**
 * Montr Server Application
 * Entry point for the media playlist system server
 */
class MontrServer {
  private app: Application;

  private server: HTTPServer | null = null;

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
    // Security middleware - configure helmet to allow inline scripts for web UI
    this.app.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'blob:'],
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
        })
      );
    });

    // Root endpoint - serve web UI
    this.app.get('/', (_req: Request, res: Response) => {
      res.sendFile(path.join(__dirname, 'web', 'public', 'index.html'));
    });

    // API routes (with optional API key auth)
    this.app.use('/api/media', apiKeyAuth(), mediaRoutes);
    this.app.use('/api/playlists', apiKeyAuth(), playlistRoutes);
    this.app.use('/api/clients', apiKeyAuth(), clientRoutes);
    this.app.use('/api/groups', apiKeyAuth(), groupRoutes);
    this.app.use('/api/schedules', apiKeyAuth(), scheduleRoutes);
    this.app.use('/api/analytics', apiKeyAuth(), analyticsRoutes);
    this.app.use('/api/notifications', apiKeyAuth(), notificationRoutes);

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
      await getDatabase();
      this.logger.info('Database connection established');

      // Create HTTP server
      this.server = createServer(this.app);

      // Initialize WebSocket server
      webSocketServer.initialize(this.server);
      this.logger.info('WebSocket server initialized');

      // Start schedule evaluation
      scheduleService.startEvaluation();
      this.logger.info('Schedule evaluation started');

      // Initialize notification email transport
      notificationService.initializeEmail();

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
      this.logger.info(
        `Health check: http://${config.server.host}:${config.server.port}/api/health`
      );
      this.logger.info(`WebSocket endpoint: ws://${config.server.host}:${config.server.port}/ws`);

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

  // Handle uncaught errors
  process.on('uncaughtException', (error: Error) => {
    const logger = getLogger();
    logger.error('Uncaught exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const logger = getLogger();
    logger.error('Unhandled rejection:', reason);
    process.exit(1);
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
