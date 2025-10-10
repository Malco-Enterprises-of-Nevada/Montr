# Montr Server

Node.js/TypeScript server for Montr media playlist system.

## Features

- REST API for media and playlist management
- WebSocket server for real-time client communication
- Web-based management interface
- Multiple database adapter support (SQLite, MySQL, MS SQL Server, MongoDB)
- File upload and storage management

## Quick Start

### Installation

```bash
npm install
```

### Configuration

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` to configure:
- Server port and host
- Database type and connection
- Storage path
- Security settings

### Development

```bash
npm run dev
```

Server will start at `http://localhost:3000` (or configured PORT).

### Build

```bash
npm run build
```

### Production

```bash
npm start
```

## Project Structure

```
src/
├── index.ts              # Entry point
├── config/               # Configuration management
├── api/                  # REST API routes
│   ├── middleware/       # Express middleware
│   ├── media.routes.ts
│   ├── playlist.routes.ts
│   └── client.routes.ts
├── database/             # Database layer
│   ├── adapters/         # Database adapters
│   ├── models/           # Data models
│   ├── migrations/       # Database migrations
│   └── seeds/            # Seed data
├── services/             # Business logic
│   ├── media.service.ts
│   ├── playlist.service.ts
│   └── client.service.ts
├── websocket/            # WebSocket server
│   ├── server.ts
│   ├── handlers.ts
│   └── types.ts
├── web/                  # Web UI
│   └── public/
└── utils/                # Utilities
```

## API Endpoints

### Media
- `POST /api/media/upload` - Upload media files
- `GET /api/media` - List all media
- `GET /api/media/:id` - Get media details
- `DELETE /api/media/:id` - Delete media
- `GET /api/media/:id/download` - Download media file

### Playlists
- `POST /api/playlists` - Create playlist
- `GET /api/playlists` - List all playlists
- `GET /api/playlists/:id` - Get playlist details
- `PUT /api/playlists/:id` - Update playlist
- `DELETE /api/playlists/:id` - Delete playlist
- `POST /api/playlists/:id/items` - Add items to playlist
- `PUT /api/playlists/:id/items/:itemId` - Update playlist item
- `DELETE /api/playlists/:id/items/:itemId` - Remove playlist item

### Clients
- `POST /api/clients/register` - Register new client
- `GET /api/clients` - List all clients
- `GET /api/clients/:id` - Get client details
- `PUT /api/clients/:id` - Update client
- `DELETE /api/clients/:id` - Unregister client

## WebSocket

Connect to `ws://server:3000/ws` for real-time communication.

See [../docs/websocket-protocol.md](../docs/websocket-protocol.md) for protocol details.

## Testing

```bash
# Run tests
npm test

# Watch mode
npm run test:watch
```

## Linting and Formatting

```bash
# Lint
npm run lint

# Fix linting issues
npm run lint:fix

# Format code
npm run format
```

## Database

### SQLite (Default)

No configuration needed. Database file created automatically at `DB_PATH`.

### MySQL

Set in `.env`:
```bash
DB_TYPE=mysql
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=montr
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=montr
```

### MS SQL Server

Set in `.env`:
```bash
DB_TYPE=mssql
MSSQL_SERVER=localhost
MSSQL_PORT=1433
MSSQL_USER=sa
MSSQL_PASSWORD=your_password
MSSQL_DATABASE=montr
```

### MongoDB

Set in `.env`:
```bash
DB_TYPE=mongodb
MONGO_URI=mongodb://localhost:27017/montr
```

## Environment Variables

See `.env.example` for all available configuration options.

## Logging

Logs are written to:
- Console (development)
- File specified in `LOG_FILE` (production)

Log levels: `error`, `warn`, `info`, `debug`

## Security

- Set `API_KEY_REQUIRED=true` to require API key authentication
- Configure `API_KEY` for authentication
- Use HTTPS in production (future feature)

## Troubleshooting

### Port already in use

Change `PORT` in `.env` to a different port.

### Database connection fails

Check database configuration in `.env` and ensure database server is running.

### Upload fails

Check `STORAGE_PATH` exists and is writable. Check `MAX_UPLOAD_SIZE_MB` setting.

## Documentation

See [../docs/](../docs/) for complete documentation.

## License

MIT
