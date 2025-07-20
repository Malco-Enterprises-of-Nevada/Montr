# Technology Stack

## Core Technologies

- **Runtime**: Node.js with TypeScript
- **Server Framework**: Express.js with Socket.IO for WebSocket communication
- **Database**: SQLite3 for local data storage
- **File Handling**: Multer for media uploads
- **Testing**: Jest with ts-jest preset

## Build System

- **Compiler**: TypeScript with strict mode enabled
- **Build Tool**: Native TypeScript compiler (tsc)
- **Dev Server**: ts-node-dev with hot reload
- **Package Manager**: npm

## Common Commands

### Development
```bash
npm run dev          # Start development server with hot reload
npm run build        # Build both server and client TypeScript
npm run build:client # Build only client-side TypeScript
npm start           # Run production build
npm test            # Run Jest test suite
npm run clean       # Remove dist directory
```

### Database Management
```bash
npm run db:init           # Initialize database schema
npm run db:reset          # Reset database (drop and recreate)
npm run db:seed           # Populate with sample data
npm run db:clear          # Clear all data
npm run db:reset-and-seed # Reset and populate in one command
```

## TypeScript Configuration

- **Target**: ES2020 with CommonJS modules
- **Strict Mode**: Enabled with comprehensive type checking
- **Path Mapping**: `@shared/*`, `@server/*`, `@client/*` aliases
- **Output**: Compiled to `dist/` directory with source maps

## Dependencies

### Production
- Express.js, Socket.IO, CORS for server
- SQLite3 for database
- Multer for file uploads
- UUID for unique identifiers

### Development
- Jest for testing with Supertest for API testing
- ts-node-dev for development workflow
- TypeScript and type definitions