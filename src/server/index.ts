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
import { initializeDatabase } from './database';
import { initializeWebSocket } from './websocket';

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3000;

// Initialize database
initializeDatabase().catch(console.error);

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

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Validate JSON content type for API routes
app.use('/api', validateJsonBody);

// API routes
app.use('/api', apiRoutes);

// Serve static files (for uploaded media)
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

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
  console.log(`Media Playlist System Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`API base URL: http://localhost:${PORT}/api`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  webSocketManager.shutdown();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  webSocketManager.shutdown();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

export default app;