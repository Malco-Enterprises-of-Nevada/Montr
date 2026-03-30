# Platform Compatibility

## Supported Platforms

| Platform | Server | Client |
|----------|--------|--------|
| Debian/Ubuntu | Node.js 20+ | Rust binary + libmpv |
| Arch Linux | Node.js 20+ | Rust binary + libmpv |
| Windows | Node.js 20+ | Planned (v2.0) |

## Client: libmpv Requirements

The Montr client uses libmpv for media playback. It must be installed on the system where the client runs.

### Debian/Ubuntu

```bash
sudo apt install libmpv-dev mpv
```

Known working: mpv 0.35+, libmpv 2.0+

### Arch Linux

```bash
sudo pacman -S mpv
```

Arch ships the latest mpv. The `mpv` package includes libmpv.

### Display Server Notes

- **X11**: Set `DISPLAY=:0` (default in the systemd service file)
- **Wayland**: Set `WAYLAND_DISPLAY=wayland-0` instead. Edit the systemd service file or config accordingly.
- **Headless/testing**: Use mpv's null video output: add `--vo=null` or set `vo=null` in mpv config. Useful for CI or testing without a display.

## Fallback Strategy

If libmpv is not available, the client will fail at startup with an `MpvInit` error and log a clear message with installation instructions.

No alternative playback backend (gstreamer, ffmpeg) is planned for v1.0. This is a consideration for v2.0.

## Server: Node.js Requirements

The server requires Node.js 20 or later.

```bash
# Debian/Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install nodejs

# Arch Linux
sudo pacman -S nodejs npm
```

## Database Requirements

The server supports multiple database backends:

| Database | Package | Minimum Version |
|----------|---------|-----------------|
| SQLite | `better-sqlite3` (bundled) | SQLite 3.35+ |
| MySQL | `mysql2` | MySQL 8.0+ |
| SQL Server | `mssql` | SQL Server 2016 SP1+ |
| MongoDB | `mongodb` | MongoDB 5.0+ |

SQLite is the default and requires no external database server.
