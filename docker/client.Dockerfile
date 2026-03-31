# Montr Client — Multi-stage Docker build
# Usage:
#   Full image:     docker build -f docker/client.Dockerfile -t montr-client .
#   Extract binary: docker build -f docker/client.Dockerfile --target binary-export --output type=local,dest=build/client .

# ── Stage 1: Build ──────────────────────────────────────────
FROM rust:1.75-bookworm AS builder

# Install libmpv and pkg-config for linking
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libmpv-dev \
        pkg-config \
        && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Copy manifests first for dependency caching
COPY client/Cargo.toml client/Cargo.lock* ./

# Create dummy src to pre-build dependencies
RUN mkdir src && \
    echo "fn main() {}" > src/main.rs && \
    echo "" > src/lib.rs && \
    cargo build --release 2>/dev/null || true && \
    rm -rf src

# Copy actual source and build
COPY client/src ./src
RUN cargo build --release

# ── Stage 2: Binary export (for cross-compile extraction) ──
FROM scratch AS binary-export
COPY --from=builder /build/target/release/montr-client /montr-client

# ── Stage 3: Runtime ────────────────────────────────────────
FROM debian:bookworm-slim AS runtime

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        libmpv2 \
        ca-certificates \
        && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/montr-client /usr/bin/montr-client

# Create directories
RUN mkdir -p /etc/montr-client /var/cache/montr-client /var/log/montr-client

# Copy example config
COPY client/config.example.toml /etc/montr-client/config.toml

ENTRYPOINT ["/usr/bin/montr-client"]
CMD ["--config", "/etc/montr-client/config.toml"]
