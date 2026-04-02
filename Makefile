.PHONY: build build-server build-client test test-server test-client \
       lint lint-server lint-client docker docker-server docker-client \
       package package-server package-client \
       package-arch package-arch-server package-arch-client \
       package-windows package-windows-server package-windows-client \
       clean help

VERSION ?= 1.0.0

# ── Build ───────────────────────────────────────────────────
build: build-server build-client

build-server:
	@scripts/build/build-server.sh

build-client:
	@scripts/build/build-client-linux.sh

# ── Test ────────────────────────────────────────────────────
test: test-server test-client

test-server:
	cd server && npm test

test-client:
	cd client && cargo test

# ── Lint ────────────────────────────────────────────────────
lint: lint-server lint-client

lint-server:
	cd server && npm run lint
	cd server && npm run format:check
	cd server && npm run typecheck

lint-client:
	cd client && cargo clippy -- -D warnings

# ── Docker ──────────────────────────────────────────────────
docker: docker-server docker-client

docker-server:
	docker build -f docker/server.Dockerfile -t montr-server:$(VERSION) .

docker-client:
	docker build -f docker/client.Dockerfile -t montr-client:$(VERSION) .

# ── Packaging (Debian) ──────────────────────────────────────
package: package-server package-client

package-server: build-server
	@scripts/packaging/build-deb.sh server

package-client: build-client
	@scripts/packaging/build-deb.sh client

# ── Packaging (Arch Linux) ─────────────────────────────────
package-arch: package-arch-server package-arch-client

package-arch-server: build-server
	cd scripts/packaging/arch && makepkg -p PKGBUILD-server

package-arch-client:
	cd scripts/packaging/arch && makepkg -p PKGBUILD-client

# ── Packaging (Windows) ────────────────────────────────────
package-windows: package-windows-server package-windows-client

package-windows-server: build-server
	makensis scripts/packaging/windows/server-installer.nsi

package-windows-client:
	makensis scripts/packaging/windows/client-installer.nsi

# ── Clean ───────────────────────────────────────────────────
clean:
	rm -rf server/dist
	rm -rf build/

# ── Help ────────────────────────────────────────────────────
help:
	@echo "Montr Build System"
	@echo ""
	@echo "  make build            Build server + client"
	@echo "  make build-server     Build server (npm + tsc)"
	@echo "  make build-client     Cross-compile client via Docker"
	@echo "  make test             Run all tests"
	@echo "  make lint             Lint both components"
	@echo "  make docker           Build Docker images"
	@echo "  make package          Build .deb packages"
	@echo "  make package-arch     Build Arch Linux packages"
	@echo "  make package-windows  Build Windows NSIS installers"
	@echo "  make clean            Remove build artifacts"
