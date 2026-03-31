#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="$PROJECT_ROOT/build/client"

echo "=== Building Montr Client (Linux x86_64 via Docker) ==="

# Ensure Docker is available
if ! command -v docker &>/dev/null; then
    echo "Error: Docker is required for cross-compilation" >&2
    exit 1
fi

mkdir -p "$OUTPUT_DIR"

# Build using Docker and extract binary
DOCKER_BUILDKIT=1 docker build \
    -f "$PROJECT_ROOT/docker/client.Dockerfile" \
    --target binary-export \
    --output "type=local,dest=$OUTPUT_DIR" \
    "$PROJECT_ROOT"

# Verify
if [ -f "$OUTPUT_DIR/montr-client" ]; then
    echo "=== Client build complete: $OUTPUT_DIR/montr-client ==="
    ls -lh "$OUTPUT_DIR/montr-client"
    file "$OUTPUT_DIR/montr-client"
else
    echo "Error: Binary not found after build" >&2
    exit 1
fi
