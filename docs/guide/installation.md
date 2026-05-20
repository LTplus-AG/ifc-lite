# Installation

This guide covers all installation options for IFClite.

## Quick Start with create-ifc-lite

The fastest way to get started is using the `create-ifc-lite` CLI:

=== "Basic Parser Project"

    ```bash
    npx create-ifc-lite my-app
    cd my-app
    npm install
    npm run parse sample.ifc
    ```

=== "React Viewer"

    ```bash
    npx create-ifc-lite my-viewer --template react
    cd my-viewer
    npm install
    npm run dev
    ```

=== "Three.js Viewer"

    ```bash
    npx create-ifc-lite my-viewer --template threejs
    cd my-viewer
    npm install
    npm run dev
    ```

=== "Babylon.js Viewer"

    ```bash
    npx create-ifc-lite my-viewer --template babylonjs
    cd my-viewer
    npm install
    npm run dev
    ```

=== "Server Backend (Docker)"

    ```bash
    npx create-ifc-lite my-backend --template server
    cd my-backend
    npm run server:start
    npm run example sample.ifc
    ```

=== "Server Backend (Native)"

    ```bash
    npx create-ifc-lite my-backend --template server-native
    cd my-backend
    npm install
    npm run server:start
    ```

### Available Templates

| Template | Description | Use Case |
|----------|-------------|----------|
| `basic` (default) | Minimal TypeScript parser project | CLI tools, data extraction |
| `threejs` | Three.js viewer (WebGL) | Three.js / react-three-fiber apps |
| `babylonjs` | Babylon.js viewer (WebGL) | Babylon.js apps |
| `react` | React + Vite + WebGPU viewer | Full-featured web applications |
| `server` | Docker-based Rust server | Production deployments |
| `server-native` | Native binary server | Non-Docker environments |

## Package Manager Installation

### npm / pnpm / yarn

=== "pnpm"

    ```bash
    # Core parsing (client-side)
    pnpm add @ifc-lite/parser

    # With rendering
    pnpm add @ifc-lite/parser @ifc-lite/geometry @ifc-lite/renderer

    # Server client SDK
    pnpm add @ifc-lite/server-client

    # IFC5 support
    pnpm add @ifc-lite/ifcx
    ```

=== "npm"

    ```bash
    # Core parsing (client-side)
    npm install @ifc-lite/parser

    # With rendering
    npm install @ifc-lite/parser @ifc-lite/geometry @ifc-lite/renderer

    # Server client SDK
    npm install @ifc-lite/server-client

    # IFC5 support
    npm install @ifc-lite/ifcx
    ```

=== "yarn"

    ```bash
    # Core parsing (client-side)
    yarn add @ifc-lite/parser

    # With rendering
    yarn add @ifc-lite/parser @ifc-lite/geometry @ifc-lite/renderer

    # Server client SDK
    yarn add @ifc-lite/server-client

    # IFC5 support
    yarn add @ifc-lite/ifcx
    ```

### Available Packages

#### Core Packages

| Package | Description | Size |
|---------|-------------|------|
| `@ifc-lite/parser` | IFC4 parsing, entity extraction, schema registry | ~45 KB |
| `@ifc-lite/ifcx` | IFC5 (IFCX) JSON format parser | ~20 KB |
| `@ifc-lite/geometry` | Geometry processing (WASM bridge) | ~30 KB |
| `@ifc-lite/renderer` | WebGPU rendering pipeline | ~25 KB |
| `@ifc-lite/data` | Columnar data structures | ~10 KB |

#### Server Packages

| Package | Description | Size |
|---------|-------------|------|
| `@ifc-lite/server-client` | Server SDK with caching & streaming | ~15 KB |
| `@ifc-lite/server-bin` | Native server binary wrapper | ~5 KB |

#### Additional Packages

| Package | Description | Size |
|---------|-------------|------|
| `@ifc-lite/query` | Fluent API & SQL queries | ~15 KB |
| `@ifc-lite/cache` | Binary cache format (.ifc-lite) | ~12 KB |
| `@ifc-lite/spatial` | Spatial indexing & culling | ~8 KB |
| `@ifc-lite/export` | Export (glTF, Parquet, CSV) | ~20 KB |

## Server Installation

### Option 1: Docker (Recommended for Production)

```bash
# Run the official container
docker run -p 3001:8080 ghcr.io/LTplus-AG/ifc-lite-server

# With persistent cache
docker run -p 3001:8080 -v ifc-cache:/app/cache ghcr.io/LTplus-AG/ifc-lite-server

# With environment configuration
docker run -p 3001:8080 \
  -e RUST_LOG=info \
  -e MAX_FILE_SIZE_MB=500 \
  -e WORKER_THREADS=8 \
  ghcr.io/LTplus-AG/ifc-lite-server
```

### Option 2: Native Binary

```bash
# Install the server-bin package
npm install -g @ifc-lite/server-bin

# Start the server (downloads binary on first run)
ifc-lite-server

# Or use npx
npx @ifc-lite/server-bin
```

**Environment Variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8080 | Server port |
| `RUST_LOG` | info | Log level (error, warn, info, debug) |
| `MAX_FILE_SIZE_MB` | 500 | Maximum upload size |
| `WORKER_THREADS` | CPU cores | Parallel processing threads |
| `CACHE_DIR` | ./.cache | Cache directory |
| `REQUEST_TIMEOUT_SECS` | 300 | Request timeout |
| `INITIAL_BATCH_SIZE` | 100 | Streaming initial batch |
| `MAX_BATCH_SIZE` | 1000 | Streaming max batch |
| `CACHE_MAX_AGE_DAYS` | 7 | Cache retention |

### Option 3: Build from Source

```bash
cd apps/server
cargo build --release
./target/release/ifc-lite-server
```

## Rust Installation

Add to your `Cargo.toml`:

```toml
[dependencies]
ifc-lite-core = "1.2"
ifc-lite-geometry = "1.2"
```

Or install via cargo:

```bash
cargo add ifc-lite-core ifc-lite-geometry
```

## Desktop App (Tauri)

Build and run the native desktop application:

```bash
# Clone the repository
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/LTplus-AG/ifc-lite.git
cd ifc-lite

# Install dependencies
pnpm install

# Development mode
cd apps/desktop
pnpm dev

# Build for current platform
pnpm build

# Build for specific platforms
pnpm build:windows   # Windows (.exe, .msi)
pnpm build:macos     # macOS (.app, .dmg)
pnpm build:linux     # Linux (.deb, .AppImage)
```

If you need large IFC benchmark fixtures, fetch only the specific files you plan to use:

```bash
git lfs pull --include="tests/models/ara3d/AC20-FZK-Haus.ifc"
```

!!! note "Prerequisites for Desktop Build"
    Building the desktop app requires the Rust toolchain. See [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/).

### Desktop vs Web Comparison

| Feature | Web (WASM) | Desktop (Native) |
|---------|-----------|------------------|
| **Parsing** | Single-threaded | Multi-threaded (Rayon) |
| **Memory** | WASM 4GB limit | System RAM |
| **File Access** | User upload only | Direct filesystem |
| **Startup** | Download WASM | Instant |
| **Large Files** | ~100MB practical limit | 500MB+ supported |

## Building from Source

### Prerequisites

- **Node.js** 18.0 or higher
- **pnpm** 8.0 or higher
- **Rust** toolchain (stable) - only for WASM/desktop builds

### Clone and Build

```bash
# Clone the repository
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/LTplus-AG/ifc-lite.git
cd ifc-lite

# Install dependencies
pnpm install

# Build all packages (uses pre-built WASM)
pnpm build

# Start the viewer
pnpm dev
```

!!! tip "No Rust Required for Development"
    WASM binaries are pre-built and committed to the repository. You only need Rust if you're modifying the core parsing/geometry code.

### Rebuilding WASM

If you modify Rust code:

```bash
# Install wasm-pack
cargo install wasm-pack

# Rebuild WASM
cd rust
wasm-pack build --target web --release

# Copy to packages/wasm
cp -r pkg/* ../packages/wasm/
```

## CDN Usage

For quick prototyping without a build step:

```html
<script type="module">
  import { IfcParser } from 'https://cdn.jsdelivr.net/npm/@ifc-lite/parser@1.2.1/+esm';

  const parser = new IfcParser();
  const response = await fetch('model.ifc');
  const buffer = await response.arrayBuffer();
  const store = await parser.parseColumnar(buffer);
  console.log('Entities:', store.entityCount);
</script>
```

For geometry processing with WASM, you must initialize the WASM module explicitly:

```html
<script type="module">
  import { GeometryProcessor } from 'https://cdn.jsdelivr.net/npm/@ifc-lite/geometry@1.2.1/+esm';
  import initWasm from 'https://cdn.jsdelivr.net/npm/@ifc-lite/wasm@1.2.1/+esm';

  // Initialize WASM with explicit path (required for CDN)
  const wasmUrl = 'https://cdn.jsdelivr.net/npm/@ifc-lite/wasm@1.2.1/pkg/ifc-lite_bg.wasm';
  await initWasm({ module_or_path: wasmUrl });

  const processor = new GeometryProcessor();
  await processor.init();
  // ... process geometry
</script>
```

!!! note "HTTP Server Required"
    CDN examples must be served from an HTTP server (not `file://`). Use `npx serve .` or `python -m http.server`.

!!! warning "Production Usage"
    For production applications, install packages locally rather than using CDN links.

## Verifying Installation

### Client-Side

```typescript
import { IfcParser } from '@ifc-lite/parser';

const parser = new IfcParser();
const buffer = await fetch('model.ifc').then(r => r.arrayBuffer());
const store = await parser.parseColumnar(buffer);

console.log('Schema:', store.schemaVersion);
console.log('Entities:', store.entityCount);
```

### Server Client

```typescript
import { IfcServerClient } from '@ifc-lite/server-client';

const client = new IfcServerClient({ baseUrl: 'http://localhost:8080' });
const health = await client.health();

console.log('Server status:', health.status);
```

### IFC5 Support

```typescript
import { parseIfcx, detectFormat } from '@ifc-lite/ifcx';

const format = detectFormat(buffer); // 'ifc', 'ifcx', or 'unknown'
if (format === 'ifcx') {
  const result = await parseIfcx(buffer);
  console.log('IFC5 entities:', result.entityCount);
}
```

## Project Structure

After cloning the repository:

```
ifc-lite/
├── rust/                      # Rust/WASM backend
│   ├── core/                  # IFC/STEP parsing
│   ├── geometry/              # Geometry processing
│   └── wasm-bindings/         # JavaScript API
│
├── packages/                  # TypeScript packages
│   ├── parser/                # High-level IFC parser
│   ├── ifcx/                  # IFC5 (IFCX) parser
│   ├── geometry/              # Geometry bridge (WASM)
│   ├── renderer/              # WebGPU rendering
│   ├── cache/                 # Binary cache format
│   ├── server-client/         # Server SDK
│   ├── server-bin/            # Native server binary
│   ├── query/                 # Query system
│   ├── data/                  # Columnar data structures
│   ├── spatial/               # Spatial indexing
│   ├── export/                # Export formats
│   └── create-ifc-lite/       # Project scaffolding CLI
│
├── apps/
│   ├── viewer/                # React web application
│   ├── server/                # Rust HTTP server
│   └── desktop/               # Tauri desktop application
│
└── docs/                      # Documentation (MkDocs)
```

## Next Steps

- [Quick Start Guide](quickstart.md) - Parse your first IFC file
- [Server Guide](server.md) - Set up server-based processing
- [Browser Requirements](browser-requirements.md) - Check WebGPU support
- [API Reference](../api/typescript.md) - Explore the API
