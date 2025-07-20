import express from 'express';
import cors from 'cors';
import path from 'path';
import { createServer } from 'http';
import apiRoutes from './routes';
import { 
  errorHandler, 
  notFoundHandler, 
  validateJsonBody, 
  rateLimit 
} from './middleware';
import { requestLogger, createGracefulShutdown } from './middleware/errorMiddleware.js';
import { initializeDatabase } from './database';
import { initializeWebSocket } from './websocket';
import logger, { createComponentLogger } from './utils/logger.js';

const serverLogger = createComponentLogger('server');

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3000;

// Track active connections for graceful shutdown
const connections = new Set<any>();

// Initialize database with error handling
initializeDatabase().catch((error) => {
  serverLogger.error('Database initialization failed', { error: error.message, stack: error.stack });
  process.exit(1);
});

// Initialize WebSocket server
const webSocketManager = initializeWebSocket(server);

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.ALLOWED_ORIGINS?.split(',') || []
    : true,
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
app.use(rateLimit(100, 15 * 60 * 1000)); // 100 requests per 15 minutes

// Enhanced request logging
app.use(requestLogger);

// Track connections for graceful shutdown
server.on('connection', (connection) => {
  connections.add(connection);
  connection.on('close', () => {
    connections.delete(connection);
  });
});

// Validate JSON content type for API routes
app.use('/api', validateJsonBody);

// API routes
app.use('/api', apiRoutes);

// Serve static files (for uploaded media)
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Serve web management interface
app.use('/web', express.static(path.join(process.cwd(), 'src/web')));

// Serve web interface at root
app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'src/web/index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0'
  });
});

// 404 handler
app.use(notFoundHandler);

// Global error handler
app.use(errorHandler);

// Start server
server.listen(PORT, () => {
  serverLogger.info('Server started successfully', {
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
    healthCheck: `http://localhost:${PORT}/health`,
    apiBaseUrl: `http://localhost:${PORT}/api`
  });
});

// Enhanced graceful shutdown
const gracefulShutdown = createGracefulShutdown(server, connections);

process.on('SIGTERM', () => {
  serverLogger.info('SIGTERM received, initiating graceful shutdown');
  webSocketManager.shutdown();
  gracefulShutdown('SIGTERM');
});

process.on('SIGINT', () => {
  serverLogger.info('SIGINT received, initiating graceful shutdown');
  webSocketManager.shutdown();
  gracefulShutdown('SIGINT');
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  serverLogger.error('Uncaught Exception', { error: error.message, stack: error.stack });
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  serverLogger.error('Unhandled Promise Rejection', { reason, promise });
  process.exit(1);
});

export default app;