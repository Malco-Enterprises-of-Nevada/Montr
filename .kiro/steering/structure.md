# Project Structure

## Root Directory Organization

```
├── src/                    # Source code (TypeScript)
├── dist/                   # Compiled JavaScript output
├── data/                   # SQLite database files
├── uploads/                # Media file storage
├── test-media/             # Sample media for testing
├── temp/                   # Temporary files
└── .kiro/                  # Kiro configuration and specs
```

## Source Code Structure (`src/`)

### Server (`src/server/`)
- **index.ts**: Main server entry point
- **database/**: Database schema, migrations, and CLI tools
- **middleware/**: Express middleware (auth, validation, error handling)
- **models/**: Data models and database interfaces
- **routes/**: REST API endpoint handlers
- **services/**: Business logic and external integrations
- **utils/**: Shared utility functions
- **websocket/**: Socket.IO event handlers and real-time communication

### Client (`src/client/`)
- **index.html**: Client player application entry point
- **js/**: Client-side TypeScript for media playback
- **css/**: Client application styles
- **tsconfig.json**: Client-specific TypeScript configuration
- **__tests__/**: Client-side unit tests

### Web Interface (`src/web/`)
- **index.html**: Web management interface
- **js/**: Management UI TypeScript code
- **css/**: Web interface styles
- **test-runner.html**: Test runner for web components

### Shared (`src/shared/`)
- **types/**: TypeScript interfaces and type definitions
- **constants/**: Application constants and configuration

## File Storage Structure

### Uploads Directory (`uploads/`)
- **images/**: Uploaded image files
- **videos/**: Uploaded video files
- **thumbnails/**: Generated video thumbnails
- **.gitkeep**: Preserve empty directories in git

## Path Aliases

Use TypeScript path mapping for clean imports:
- `@shared/*` → `src/shared/*`
- `@server/*` → `src/server/*`
- `@client/*` → `src/client/*`

## Naming Conventions

- **Files**: kebab-case for HTML/CSS, camelCase for TypeScript
- **Directories**: lowercase with hyphens or underscores
- **Classes**: PascalCase
- **Functions/Variables**: camelCase
- **Constants**: UPPER_SNAKE_CASE
- **Interfaces**: PascalCase with descriptive names

## Test Organization

- Unit tests: `**/*.test.ts` or `**/__tests__/**/*.ts`
- Integration tests: Separate test directories per component
- Test files mirror source structure