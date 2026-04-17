# Montr - Media Playlist System

A distributed media playlist system for automated playback across multiple displays.

## Overview

Montr consists of two main components:

- **Server**: Node.js/TypeScript server with web-based management interface
- **Client**: Rust native application for reliable media playback

The system enables centralized management of media files and playlists, with automatic distribution and playback on remote client machines.

## Features

- 📺 **Multi-format Support**: Video and image playback
- 🔄 **Looping Playlists**: Continuous playback with seamless transitions
- 🌐 **Web Management**: User-friendly interface for media and playlist management
- 💻 **Cross-platform**: Runs on Debian, Arch Linux, and Windows
- 🔌 **Auto-start**: Configurable system startup integration
- 📊 **Real-time Monitoring**: Live client status dashboard
- 🗄️ **Flexible Database**: SQLite, MySQL, MS SQL Server, or MongoDB support
- 🚀 **Scalable**: Supports up to 25 concurrent clients

## Quick Start

### Server Installation

**Debian/Ubuntu:**
```bash
sudo dpkg -i montr-server_1.0.0_amd64.deb
sudo systemctl start montr-server
```

**Arch Linux:**
```bash
yay -S montr-server
sudo systemctl start montr-server
```

**Windows:**
```
Run MontrServerSetup.msi and follow the wizard
```

Access the web interface at `http://localhost:3000`

### Client Installation

**Debian/Ubuntu:**
```bash
sudo dpkg -i montr-client_1.0.0_amd64.deb
sudo nano /etc/montr-client/config.toml  # Configure server URL
sudo systemctl start montr-client
```

**Arch Linux:**
```bash
yay -S montr-client
sudo nano /etc/montr-client/config.toml
sudo systemctl start montr-client
```

**Windows:**
```
Run MontrClientSetup.msi
Enter server URL during installation
```

## Development

### Prerequisites

- Node.js 20 LTS
- Rust (stable)
- Git

### Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/montr.git
cd montr

# Server setup
cd server
npm install
cp .env.example .env
npm run dev

# Client setup (in a new terminal)
cd client
cargo build
cargo run
```

See [docs/development.md](docs/development.md) for detailed development instructions.

## Architecture

```
┌─────────────────────────────────────────────┐
│           Management Web Interface          │
└─────────────────┬───────────────────────────┘
                  │
┌─────────────────▼───────────────────────────┐
│               Server                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │   REST   │  │WebSocket │  │ Database │  │
│  │   API    │  │  Server  │  │          │  │
│  └──────────┘  └──────────┘  └──────────┘  │
└─────────────────┬───────────────────────────┘
                  │ WebSocket + HTTP
         ┌────────┼────────┬─────────┐
         │        │        │         │
    ┌────▼───┐ ┌─▼─────┐ ┌▼──────┐ ┌▼──────┐
    │Client 1│ │Client2│ │Client3│ │Client N│
    │  (Rust)│ │ (Rust)│ │ (Rust)│ │ (Rust)│
    └────────┘ └───────┘ └───────┘ └───────┘
         │        │        │         │
    ┌────▼───┐ ┌─▼─────┐ ┌▼──────┐ ┌▼──────┐
    │Display │ │Display│ │Display│ │Display│
    └────────┘ └───────┘ └───────┘ └───────┘
```

For detailed architecture information, see [docs/architecture.md](docs/architecture.md).

## Documentation

- [Project Plan](project.md) - Detailed implementation plan
- [Architecture](docs/architecture.md) - System design and components
- [API Specification](docs/api-specification.md) - REST API and WebSocket protocol
- [Database Schema](docs/database-schema.md) - Database design
- [Deployment Guide](docs/deployment.md) - Installation and configuration
- [Development Guide](docs/development.md) - Development environment setup
- [Troubleshooting](docs/troubleshooting.md) - Common issues and solutions

## Repository Structure

```
montr/
├── server/          # Node.js/TypeScript server
├── client/          # Rust native client
├── docs/            # Documentation
├── scripts/         # Build and packaging scripts
├── shared/          # Shared protocol definitions
└── project.md       # Detailed project plan
```

## Configuration

### Server

Edit `server/.env`:
```bash
PORT=3000
DB_TYPE=sqlite
STORAGE_PATH=./storage
```

### Client

Edit `/etc/montr-client/config.toml` (Linux) or `C:\ProgramData\Montr\config.toml` (Windows):
```toml
[server]
url = "http://server-ip:3000"

[client]
name = "Display-01"

[playback]
default_image_duration = 5
loop_playlist = true
```

See [docs/configuration.md](docs/configuration.md) for complete configuration reference.

## Usage

1. **Upload Media**: Access the web interface and upload video/image files
2. **Create Playlist**: Organize media into playlists with drag-and-drop
3. **Assign to Client**: Assign a playlist to one or more clients
4. **Monitor**: View real-time playback status on the dashboard

## Diagnostics / Accessing logs

A small CLI is bundled at `scripts/montr-logs.mjs` (also wired up as `npm run logs`) for pulling logs off a running server without SSH. It talks to the admin HTTP API using the server's static API key.

**Required environment** (either exported or in a `.env` file in the working directory):

```
MONTR_SERVER_URL=https://montr.example.com
MONTR_API_KEY=<matches the server's API_KEY env var>
```

The server must have `API_KEY` set; in prod set `API_KEY_REQUIRED=true` as well.

**Commands:**

```bash
# Tail the server's own Winston log file
npm run logs -- server --lines 500 --level error
npm run logs -- server --since 2026-04-17T00:00:00

# List registered clients (id / online|offline / last-seen / name)
npm run logs -- clients

# Recent WARN/ERROR events auto-pushed by a client (from the DB)
npm run logs -- client pi-lobby --lines 200

# On-demand live tail of a connected client's log file
npm run logs -- client pi-lobby --live --size 100k
```

Output is plain text on stdout so it pipes cleanly into `grep`, `less`, etc. Non-zero exit + stderr message on HTTP errors.

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

[MIT License](LICENSE)

## Support

For issues and questions:
- GitHub Issues: https://github.com/yourusername/montr/issues
- Documentation: [docs/](docs/)
- Troubleshooting: [docs/troubleshooting.md](docs/troubleshooting.md)

## Roadmap

### Version 1.0 (Current)
- ✅ Basic media management
- ✅ Playlist creation and assignment
- ✅ Looping playback
- ✅ Real-time client status

### Version 1.1
- ⏳ Time-based scheduling
- ⏳ Multiple playlists per client
- ⏳ Client grouping

### Version 1.2
- ⏳ Remote control (pause, skip)
- ⏳ Playback analytics
- ⏳ Advanced monitoring

See [project.md](project.md) for the complete roadmap.

---

Built with ❤️ for reliable digital signage
