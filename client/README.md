# Montr Client

Rust native client for Montr media playlist system.

## Features

- Reliable media playback (video and images)
- Automatic connection management with server
- Local media caching
- Playlist looping
- Auto-start on system boot
- Cross-platform support (Linux, Windows)

## Quick Start

### Installation

**Debian/Ubuntu:**
```bash
sudo dpkg -i montr-client_1.0.0_amd64.deb
```

**Arch Linux:**
```bash
yay -S montr-client
```

**Windows:**
```
Run MontrClientSetup.msi
```

### Configuration

Edit the configuration file:

**Linux:**
```bash
sudo nano /etc/montr-client/config.toml
```

**Windows:**
```
C:\ProgramData\Montr\config.toml
```

Set the server URL:
```toml
[server]
url = "http://your-server-ip:3000"
```

### Running

**Linux:**
```bash
# Start service
sudo systemctl start montr-client

# Enable auto-start
sudo systemctl enable montr-client

# Check status
sudo systemctl status montr-client

# View logs
journalctl -u montr-client -f
```

**Windows:**
```
Services → Montr Client → Start
```

## Development

### Prerequisites

- Rust (stable) - Install from https://rustup.rs/
- libmpv development libraries

**Debian/Ubuntu:**
```bash
sudo apt install libmpv-dev
```

**Arch Linux:**
```bash
sudo pacman -S mpv
```

**Windows:**
Download mpv development libraries from https://mpv.io/

### Build

```bash
cd client
cargo build
```

### Run in Development

```bash
cargo run -- --config config.example.toml
```

### Release Build

```bash
cargo build --release
```

Binary will be in `target/release/montr-client`

## Project Structure

```
src/
├── main.rs               # Entry point
├── lib.rs                # Library root
├── config/               # Configuration management
│   ├── mod.rs
│   ├── settings.rs       # Config file handling
│   └── args.rs           # CLI arguments
├── network/              # Network communication
│   ├── mod.rs
│   ├── http_client.rs    # REST API client
│   ├── websocket.rs      # WebSocket connection
│   └── reconnect.rs      # Reconnection logic
├── playback/             # Media playback
│   ├── mod.rs
│   ├── engine.rs         # mpv wrapper
│   ├── playlist.rs       # Queue management
│   └── media_cache.rs    # Local caching
├── system/               # System integration
│   ├── mod.rs
│   ├── autostart.rs      # Auto-start setup
│   └── health.rs         # Health monitoring
├── status/               # Status reporting
│   ├── mod.rs
│   └── reporter.rs       # Server status updates
└── error.rs              # Error types
```

## Configuration

See `config.example.toml` for all available options.

### Key Configuration Options

**Server Connection:**
```toml
[server]
url = "http://server-ip:3000"
reconnect_interval = 5
```

**Playback Settings:**
```toml
[playback]
default_image_duration = 5
loop_playlist = true
max_cache_size_mb = 5000
```

**Display Settings:**
```toml
[display]
fullscreen = true
screen_index = 0
```

## Command Line Arguments

```bash
montr-client [OPTIONS]

Options:
  -c, --config <FILE>    Config file path [default: config.toml]
  -s, --server <URL>     Override server URL
  -n, --name <NAME>      Override client name
  -v, --verbose          Verbose logging
  -h, --help             Print help
  -V, --version          Print version
```

## Client State Flow

1. **STARTING** - Load configuration
2. **CONNECTING** - Connect to server via WebSocket
3. **REGISTERING** - Register client with server
4. **WAITING_PLAYLIST** - Wait for playlist assignment
5. **DOWNLOADING** - Download media files
6. **READY** - Ready to play
7. **PLAYING** - Active playback (loops)
8. **ERROR** - Error state (will retry connection)

## Logging

Logs are written to:
- **Linux**: `/var/log/montr-client/client.log`
- **Windows**: `C:\ProgramData\Montr\logs\client.log`
- **Development**: `./client.log`

Log levels: `error`, `warn`, `info`, `debug`, `trace`

Set in config.toml:
```toml
[system]
log_level = "info"
```

## Caching

Media files are cached locally to:
- **Linux**: `/var/lib/montr-client/cache`
- **Windows**: `C:\ProgramData\Montr\cache`
- **Development**: `./cache`

Cache is automatically managed based on `max_cache_size_mb` setting.

## Auto-start

### Linux (systemd)

Service file installed to `/etc/systemd/system/montr-client.service`

```bash
# Enable auto-start
sudo systemctl enable montr-client

# Disable auto-start
sudo systemctl disable montr-client
```

### Windows

Installed as Windows Service that starts automatically.

```
Services → Montr Client → Startup type: Automatic
```

## Troubleshooting

### Can't connect to server

1. Check server URL in config.toml
2. Verify server is running: `curl http://server:3000/api/health`
3. Check firewall settings
4. Check logs for errors

### Playback not working

1. Verify mpv is installed: `mpv --version`
2. Check media file permissions
3. Check display configuration
4. Review logs for playback errors

### High CPU usage

1. Check video codec (hardware acceleration)
2. Reduce cache size
3. Check for playback errors causing retries

### Service won't start

**Linux:**
```bash
# Check service status
sudo systemctl status montr-client

# View logs
journalctl -u montr-client -n 50
```

**Windows:**
```
Event Viewer → Application Logs
```

## Testing

```bash
# Run tests
cargo test

# Run with output
cargo test -- --nocapture

# Run specific test
cargo test test_name
```

## Cross-compilation

### Build for Linux from Windows/Mac

```bash
cargo install cross
cross build --target x86_64-unknown-linux-gnu --release
```

### Build for Windows from Linux/Mac

```bash
cross build --target x86_64-pc-windows-gnu --release
```

## Documentation

See [../docs/](../docs/) for complete documentation.

## License

MIT
