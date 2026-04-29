# @ifc-lite/server-bin

Pre-built native binary for the IFClite server. No Docker, no Rust toolchain — just `npx @ifc-lite/server-bin`. Auto-downloads the right binary for your platform on first run.

## Quick Start

```bash
# Run the server (downloads binary on first run, ~20 MB)
npx @ifc-lite/server-bin

# Or install once, run anywhere
npm install -g @ifc-lite/server-bin
ifc-lite-server
```

The server starts on `http://localhost:8080` by default. Point [`@ifc-lite/server-client`](../server-client/README.md) at it and you've got a parsing backend with caching, streaming, and parallel processing.

## CLI

```bash
npx @ifc-lite/server-bin                # start server on PORT (default 8080)
PORT=3001 npx @ifc-lite/server-bin       # custom port
npx @ifc-lite/server-bin download        # pre-fetch the binary (CI / pre-deploy)
npx @ifc-lite/server-bin info            # show platform target + cache state
npx @ifc-lite/server-bin help            # full help
```

## Configuration

```bash
PORT=8080 \
RUST_LOG=info \
MAX_FILE_SIZE_MB=500 \
WORKER_THREADS=8 \
CACHE_DIR=./.cache \
REQUEST_TIMEOUT_SECS=300 \
INITIAL_BATCH_SIZE=100 \
MAX_BATCH_SIZE=1000 \
CACHE_MAX_AGE_DAYS=7 \
npx @ifc-lite/server-bin
```

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server port |
| `RUST_LOG` | `info` | Log level — `error` / `warn` / `info` / `debug` |
| `MAX_FILE_SIZE_MB` | `500` | Max upload size |
| `WORKER_THREADS` | CPU cores | Parallel parse threads |
| `CACHE_DIR` | `./.cache` | Where to persist parsed-file cache |
| `REQUEST_TIMEOUT_SECS` | `300` | Per-request timeout |
| `INITIAL_BATCH_SIZE` | `100` | First streaming batch size (snappy first paint) |
| `MAX_BATCH_SIZE` | `1000` | Steady-state streaming batch size (throughput) |
| `CACHE_MAX_AGE_DAYS` | `7` | Cache retention before eviction |

## Programmatic usage

For embedding the server in a Node.js process or CI script:

```typescript
import { runBinary, ensureBinary, getBinaryInfo } from '@ifc-lite/server-bin';

// Make sure the binary is on disk (downloads if missing)
const path = await ensureBinary();
console.log(`Binary at ${path}`);

// Inspect the target
const info = getBinaryInfo();
console.log(`Platform: ${info.platform.targetTriple}, cached: ${info.isCached}`);

// Run the server with custom args; resolves with the exit code
const exitCode = await runBinary(['--config', './ifc-lite.toml']);
```

## Supported platforms

| Platform | Architecture |
|----------|--------------|
| macOS | x64 (Intel) ✅ &nbsp; arm64 (Apple Silicon) ✅ |
| Linux | x64 glibc ✅ &nbsp; arm64 glibc ✅ &nbsp; x64 musl (Alpine) ✅ |
| Windows | x64 ✅ |

## Skip auto-download

Useful for hermetic CI builds:

```bash
IFC_LITE_SKIP_DOWNLOAD=1 npm install @ifc-lite/server-bin
# Later, fetch on demand:
npx @ifc-lite/server-bin download
```

## Falling back

If pre-built binaries don't fit (unsupported platform, locked-down corp environment, custom config), fall back to:

```bash
# Docker-based server
npx create-ifc-lite my-server --template server
cd my-server && docker compose up -d

# Build from source
git clone https://github.com/louistrue/ifc-lite
cd ifc-lite/apps/server
cargo build --release
```

## API

| Function | Description |
|---|---|
| `runBinary(args?)` | Run the server with optional args — resolves with exit code |
| `ensureBinary(onProgress?)` | Download if missing — resolves with binary path |
| `downloadBinary(onProgress?)` | Force re-download — resolves with binary path |
| `getBinaryInfo()` | Returns `{ platform, version, isCached, cachePath }` |
| `isBinaryCached()` | Boolean — is the binary on disk? |

## License

[MPL-2.0](https://mozilla.org/MPL/2.0/)
