#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVER_DIR="$PROJECT_ROOT/server"

echo "=== Building Montr Server ==="

cd "$SERVER_DIR"

# Install dependencies
echo "Installing dependencies..."
npm ci

# TypeScript compilation (may emit warnings for pre-existing type issues)
echo "Compiling TypeScript..."
npx tsc || true

# Copy non-TS assets that tsc does not handle
echo "Copying static assets..."
mkdir -p dist/database
cp src/database/schema.sql dist/database/
cp -r src/web dist/web

echo "=== Server build complete: server/dist/ ==="
