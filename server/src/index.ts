import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer, Server as HTTPServer } from 'http';
import { config } from './config/config';
import { initLogger, getLogger } from './utils/logger';
import { errorHandler, notFoundHandler, successResponse } from './api/middleware/error-handler';

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
    // Security middleware
    this.app.use(helmet());
    this.app.use(
      cors({
        origin: true, // Allow all origins for now
        credentials: true,
      })
    );

    // Body parsing middleware
    this.app.use(express.json({ limit: `${config.storage.maxUploadSizeMB}mb` }));
    this.app.use(
      express.urlencoded({ extended: true, limit: `${config.storage.maxUploadSizeMB}mb` })
    );

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

    // Root endpoint
    this.app.get('/', (_req: Request, res: Response) => {
      res.json(
        successResponse({
          message: 'Montr Media Playlist Server',
          version: '1.0.0',
          endpoints: {
            health: '/api/health',
            version: '/api/version',
          },
        })
      );
    });

    // Future route registrations will go here:
    // this.app.use('/api/media', mediaRoutes);
    // this.app.use('/api/playlists', playlistRoutes);
    // this.app.use('/api/clients', clientRoutes);
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
      this.server = createServer(this.app);

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

    // Close database connections, WebSocket connections, etc.
    // await this.database?.close();
    // await this.websocketServer?.close();
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
