#!/usr/bin/env bash
set -euo pipefail

COMPONENT="${1:?Usage: build-deb.sh <server|client> [arch]}"
ARCH="${2:-amd64}"
VERSION="1.0.0"

case "$ARCH" in
    amd64|arm64) ;;
    *)
        echo "Unsupported arch: $ARCH (expected amd64 or arm64)" >&2
        exit 1
        ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PKG_NAME="montr-${COMPONENT}_${VERSION}_${ARCH}"
BUILD_DIR="$PROJECT_ROOT/build/deb/$PKG_NAME"
OUTPUT_DIR="$PROJECT_ROOT/build"

echo "=== Building Montr ${COMPONENT} .deb package (arch=${ARCH}) ==="

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/DEBIAN"

case "$COMPONENT" in
    server)
        if [ "$ARCH" != "amd64" ]; then
            echo "Server .deb is only built for amd64 (got: $ARCH)" >&2
            exit 1
        fi
        # Copy DEBIAN control files
        cp "$SCRIPT_DIR/debian/server/DEBIAN/"* "$BUILD_DIR/DEBIAN/"
        chmod 755 "$BUILD_DIR/DEBIAN/postinst" "$BUILD_DIR/DEBIAN/prerm" "$BUILD_DIR/DEBIAN/postrm"

        # Install application files
        mkdir -p "$BUILD_DIR/opt/montr-server"
        cp -r "$PROJECT_ROOT/server/dist" "$BUILD_DIR/opt/montr-server/"
        cp "$PROJECT_ROOT/server/package.json" "$BUILD_DIR/opt/montr-server/"

        # Install production dependencies
        cd "$BUILD_DIR/opt/montr-server"
        npm install --omit=dev --ignore-scripts 2>/dev/null || npm ci --omit=dev 2>/dev/null || true
        cd "$PROJECT_ROOT"

        # Config
        mkdir -p "$BUILD_DIR/etc/montr-server"
        cp "$PROJECT_ROOT/server/.env.example" "$BUILD_DIR/etc/montr-server/montr-server.env"

        # Systemd
        mkdir -p "$BUILD_DIR/lib/systemd/system"
        cp "$PROJECT_ROOT/deploy/systemd/montr-server.service" "$BUILD_DIR/lib/systemd/system/"
        ;;

    client)
        # Copy DEBIAN control files
        cp "$SCRIPT_DIR/debian/client/DEBIAN/"* "$BUILD_DIR/DEBIAN/"
        chmod 755 "$BUILD_DIR/DEBIAN/postinst" "$BUILD_DIR/DEBIAN/prerm" "$BUILD_DIR/DEBIAN/postrm"

        # Patch Architecture in control file to match the requested arch
        sed -i "s/^Architecture: .*/Architecture: ${ARCH}/" "$BUILD_DIR/DEBIAN/control"

        # Binary
        mkdir -p "$BUILD_DIR/usr/bin"
        if [ -f "$PROJECT_ROOT/build/client/montr-client" ]; then
            cp "$PROJECT_ROOT/build/client/montr-client" "$BUILD_DIR/usr/bin/"
        elif [ -f "$PROJECT_ROOT/client/target/release/montr-client" ]; then
            cp "$PROJECT_ROOT/client/target/release/montr-client" "$BUILD_DIR/usr/bin/"
        else
            echo "Error: montr-client binary not found. Run 'make build-client' first." >&2
            exit 1
        fi
        chmod 755 "$BUILD_DIR/usr/bin/montr-client"

        # Config
        mkdir -p "$BUILD_DIR/etc/montr-client"
        cp "$PROJECT_ROOT/client/config.example.toml" "$BUILD_DIR/etc/montr-client/config.toml"

        # Systemd
        mkdir -p "$BUILD_DIR/lib/systemd/system"
        cp "$PROJECT_ROOT/deploy/systemd/montr-client.service" "$BUILD_DIR/lib/systemd/system/"
        cp "$PROJECT_ROOT/deploy/systemd/montr-client-updater.path" "$BUILD_DIR/lib/systemd/system/"
        cp "$PROJECT_ROOT/deploy/systemd/montr-client-updater.service" "$BUILD_DIR/lib/systemd/system/"

        # Update apply script
        mkdir -p "$BUILD_DIR/usr/lib/montr-client"
        cp "$PROJECT_ROOT/deploy/scripts/apply-update.sh" "$BUILD_DIR/usr/lib/montr-client/"
        chmod 755 "$BUILD_DIR/usr/lib/montr-client/apply-update.sh"
        ;;

    *)
        echo "Unknown component: $COMPONENT" >&2
        echo "Usage: build-deb.sh <server|client>" >&2
        exit 1
        ;;
esac

# Build the .deb
mkdir -p "$OUTPUT_DIR"
dpkg-deb --build "$BUILD_DIR" "$OUTPUT_DIR/${PKG_NAME}.deb"
echo "=== Package built: $OUTPUT_DIR/${PKG_NAME}.deb ==="
