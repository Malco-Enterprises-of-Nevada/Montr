# Development Guide

**Status**: To be implemented

This document will cover:
- Setting up development environment
- Running server in development mode
- Running client in development mode
- Testing strategies
- Contributing guidelines

## Prerequisites

- Node.js 20 LTS
- Rust (stable)
- Git

## Server Development

```bash
cd server
npm install
npm run dev
```

## Client Development

```bash
cd client
cargo build
cargo run
```

## Testing

```bash
# Server tests
cd server
npm test

# Client tests
cd client
cargo test
```

---

*This document will be completed during Phase 1 implementation.*
