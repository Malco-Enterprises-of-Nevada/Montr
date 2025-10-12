# E2E Integration Tests - Setup Checklist

Use this checklist to verify your environment is ready for E2E integration testing.

## Prerequisites Checklist

### System Requirements

- [ ] **Node.js 20+** installed
  ```bash
  node --version  # Should be v20.x.x or higher
  ```

- [ ] **npm** installed
  ```bash
  npm --version
  ```

- [ ] **Rust/Cargo** installed
  ```bash
  cargo --version
  rustc --version
  ```

- [ ] **libmpv** installed (for client playback)
  ```bash
  # Ubuntu/Debian
  sudo apt-get install libmpv-dev

  # Arch Linux
  sudo pacman -S mpv

  # macOS
  brew install mpv
  ```

- [ ] **ffmpeg** installed (optional, for realistic test media)
  ```bash
  ffmpeg -version
  ```

## Build Checklist

### Server Build

- [ ] **Server dependencies installed**
  ```bash
  cd server
  npm install
  ```

- [ ] **Server built successfully**
  ```bash
  cd server
  npm run build
  ```

- [ ] **Server build artifacts present**
  ```bash
  ls server/dist/index.js  # Should exist
  ```

### Client Build

- [ ] **Client dependencies resolved**
  ```bash
  cd client
  cargo check
  ```

- [ ] **Client built successfully**
  ```bash
  cd client
  cargo build  # Or: cargo build --release
  ```

- [ ] **Client binary present**
  ```bash
  ls client/target/debug/montr-client  # Should exist
  # Or for release: ls client/target/release/montr-client
  ```

## Test Infrastructure Setup

### Install Test Dependencies

- [ ] **Test dependencies installed**
  ```bash
  cd tests/integration
  npm install
  ```

- [ ] **node_modules directory created**
  ```bash
  ls tests/integration/node_modules  # Should exist
  ```

### Verify File Structure

- [ ] **All helper files present**
  ```bash
  cd tests/integration
  ls helpers/server-process.ts
  ls helpers/client-process.ts
  ls helpers/wait-for.ts
  ls helpers/fixtures.ts
  ls helpers/index.ts
  ```

- [ ] **Configuration files present**
  ```bash
  cd tests/integration
  ls package.json
  ls tsconfig.json
  ls jest.config.js
  ```

- [ ] **Documentation present**
  ```bash
  cd tests/integration
  ls README.md
  ls HELPERS_REFERENCE.md
  ```

### Run Validation

- [ ] **Validation script passes**
  ```bash
  cd tests/integration
  ./validate.sh
  ```

## Pre-Test Verification

### Port Availability

- [ ] **Port 3001 is available** (or choose another port)
  ```bash
  # Check if port is in use
  lsof -i :3001
  # Should return nothing, or use a different port in tests
  ```

### Permissions

- [ ] **Write access to /tmp**
  ```bash
  touch /tmp/test-write && rm /tmp/test-write
  ```

- [ ] **Execute permissions on binaries**
  ```bash
  test -x client/target/debug/montr-client && echo "OK"
  ```

## Running Tests

### Basic Test Run

- [ ] **Can run example test**
  ```bash
  cd tests/integration
  npm test e2e-example.test.ts
  ```

### Test Output

- [ ] **Tests produce output**
- [ ] **No unexpected errors**
- [ ] **Processes start and stop cleanly**

## Troubleshooting

If any checks fail:

### Node.js/npm Issues

- Install Node.js from https://nodejs.org/
- Use nvm for version management
- Clear npm cache: `npm cache clean --force`

### Rust/Cargo Issues

- Install Rust from https://rustup.rs/
- Update Rust: `rustup update`
- Clear build cache: `cargo clean`

### Build Issues

**Server won't build:**
```bash
cd server
rm -rf node_modules package-lock.json
npm install
npm run build
```

**Client won't build:**
```bash
cd client
cargo clean
cargo build
```

### Port Conflicts

**Port in use:**
```bash
# Find process using port
lsof -i :3001
# Kill process
kill -9 <PID>
# Or use different port in tests
```

### Permission Issues

**Binary not executable:**
```bash
chmod +x client/target/debug/montr-client
```

**Can't write to /tmp:**
```bash
# Check permissions
ls -la /tmp
# Should show drwxrwxrwt
```

## Quick Setup (All-in-One)

If all prerequisites are met, run:

```bash
# From project root
cd tests/integration
./setup.sh
```

This will:
1. ✓ Verify prerequisites
2. ✓ Install dependencies
3. ✓ Build server
4. ✓ Build client
5. ✓ Create fixtures directory
6. ✓ Run validation

## CI/CD Checklist

For running tests in CI/CD:

- [ ] **All prerequisites installed** (Node, Rust, libmpv, ffmpeg)
- [ ] **Server built** before test run
- [ ] **Client built** before test run
- [ ] **Test dependencies installed**
- [ ] **Timeout configured** (tests can take 5-15 minutes)
- [ ] **Parallel execution disabled** (or use unique ports)
- [ ] **Cleanup on exit** (kill stray processes)

Example GitHub Actions:
```yaml
- name: Install dependencies
  run: |
    sudo apt-get update
    sudo apt-get install -y libmpv-dev ffmpeg

- name: Build server
  run: cd server && npm install && npm run build

- name: Build client
  run: cd client && cargo build

- name: Run tests
  run: cd tests/integration && npm install && npm test
```

## Support

If you encounter issues:

1. Check this checklist carefully
2. Review [README.md](./README.md) for detailed documentation
3. Run `./validate.sh` to identify missing components
4. Check logs in `/tmp/montr-client-*.log`
5. Use `npm run test:verbose` for detailed output

## Quick Reference

### Essential Commands

```bash
# Setup
cd tests/integration && ./setup.sh

# Validate
cd tests/integration && ./validate.sh

# Run all tests
cd tests/integration && npm test

# Run specific test
cd tests/integration && npm test e2e-example.test.ts

# Debug
cd tests/integration && npm run test:debug

# Verbose output
cd tests/integration && npm run test:verbose
```

### Essential Paths

- Server binary: `server/dist/index.js`
- Client binary: `client/target/debug/montr-client`
- Test helpers: `tests/integration/helpers/`
- Test fixtures: `tests/integration/fixtures/`
- Temp configs: `/tmp/montr-test-configs/`
- Temp caches: `/tmp/montr-test-cache-{id}/`
- Client logs: `/tmp/montr-client-{id}.log`

---

**Status**:
- ✅ All prerequisites met
- ✅ Builds successful
- ✅ Tests passing
- 🚀 Ready to write tests!
