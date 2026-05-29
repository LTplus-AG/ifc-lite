# Desktop App

IFClite includes a native desktop application built with [Tauri v2](https://v2.tauri.app/), providing enhanced performance over the web version by using native Rust code instead of WebAssembly.

## Why Desktop?

| Feature | Web (WASM) | Desktop (Native) |
|---------|-----------|------------------|
| **Parsing** | Single-threaded | Multi-threaded (Rayon) |
| **Memory** | WASM 4GB limit | System RAM |
| **File Access** | User upload only | Direct filesystem |
| **Startup** | Download WASM | Instant |
| **Large Files** | ~100MB practical limit | 500MB+ supported |

The desktop app reuses the same Rust crates (`ifc-lite-core`, `ifc-lite-geometry`) as the WASM build, but compiled natively with full multi-threading support.

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/) 8+
- [Rust toolchain](https://rustup.rs/) (stable)
- Platform-specific dependencies: see [Tauri Prerequisites](https://v2.tauri.app/start/prerequisites/)

### Development

```bash
cd apps/desktop
pnpm install
pnpm dev          # Start in development mode
```

### Building Releases

```bash
cd apps/desktop

# Build for current platform
pnpm build

# Platform-specific builds
pnpm build:windows   # Windows (.exe, .msi)
pnpm build:macos     # macOS (.app, .dmg) - Universal (Intel + Apple Silicon)
pnpm build:linux     # Linux (.deb, .AppImage)
```

Output binaries are placed in `apps/desktop/src-tauri/target/release/bundle/`.

## Architecture

```
apps/desktop/
├── src/                    # React frontend (shared with web viewer)
├── src-tauri/
│   ├── src/
│   │   ├── commands/       # Tauri IPC commands
│   │   │   ├── ifc.rs      # get_geometry, get_geometry_streaming
│   │   │   ├── cache.rs    # Binary caching system
│   │   │   └── file_dialog.rs
│   │   └── lib.rs          # Tauri app setup
│   └── Cargo.toml          # Native dependencies
└── package.json
```

The frontend React code is shared between web and desktop. The desktop version uses Tauri IPC commands instead of WASM calls for parsing and geometry processing.

## Native Commands

The desktop app exposes these Tauri commands to the frontend:

| Command | Description |
|---------|-------------|
| `get_geometry` | Process geometry in parallel batches (native Rayon multi-threading) |
| `get_geometry_streaming` | Stream geometry progressively to the renderer |
| `open_ifc_file` | Native file dialog for opening IFC files |
| `get_cached` / `set_cached` | Binary cache for instant reload of previously opened files |

## Binary Caching

The desktop app includes a binary caching system that stores parsed results on disk. When reopening a previously loaded file:

1. File hash is computed (SHA-256)
2. Cache is checked for matching hash
3. If cached, geometry and data model are loaded instantly (no re-parsing)
4. If not cached, file is parsed and result is cached for next time

This makes reopening large files nearly instantaneous.

## Differences from Web Version

The desktop and web versions share the same React UI, but differ in:

- **Parsing backend**: Native Rust vs WASM
- **Threading**: Rayon thread pool vs single-threaded WASM
- **File access**: Direct filesystem vs browser upload
- **Memory**: No WASM 4GB limit
- **Caching**: Disk-based binary cache vs browser cache/IndexedDB
- **Startup**: No WASM download needed

## Current Fast Path Status

For the current large-file desktop fast-path state, latest 1 GB cold harness numbers, and the remaining gap to full-under-5s cold completion, see [Desktop Fast Path Status](./desktop-fastpath-status.md).
