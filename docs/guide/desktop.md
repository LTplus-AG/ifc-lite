# Building for Desktop

IFClite itself ships a **web viewer** (and the headless CLI/MCP/server) — it does **not** ship a desktop application. However, the published `@ifc-lite/*` packages are designed so you can build **your own** native desktop app (e.g. with [Tauri v2](https://v2.tauri.app/)) on top of them, including an optional **native-Rust geometry fast path** that bypasses WebAssembly for multi-threaded performance on very large models.

This page describes the extension points the packages expose and the host-side contract your desktop shell needs to implement.

## Why build a desktop app?

| Feature | Web (WASM) | Desktop (Native) |
|---------|-----------|------------------|
| **Parallelism** | Pool of single-threaded WASM workers | In-process Rayon thread pool |
| **Memory** | wasm32 4GB address space per instance, plus browser limits | System RAM |
| **File Access** | User upload only | Direct filesystem (path-based commands) |
| **Startup** | Download WASM bundle | No WASM download |

A desktop shell reuses the same Rust crates (`ifc-lite-core`, `ifc-lite-geometry`) as the WASM build, but compiled natively with full multi-threading.

## The geometry platform bridge

`@ifc-lite/geometry` implements a **platform-bridge** pattern. In the browser, geometry runs through WebAssembly. When running inside a desktop host, it can instead route geometry generation to **native Rust over the host's IPC**:

```ts
import { GeometryProcessor, isTauri, type IPlatformBridge } from '@ifc-lite/geometry';

// preferNative defaults to true; the native path activates only when isTauri()
// is true. On the web it is always false and the WASM path is used.
const processor = new GeometryProcessor({ preferNative: true });
```

- `isTauri()` — detects a Tauri host (`window.__TAURI_INTERNALS__`).
- `IPlatformBridge` — the generic contract a native bridge implements. **This is the stable extension point**: you can supply your own implementation for a non-Tauri host.
- `NativeBridge` — the bundled Tauri implementation of `IPlatformBridge`, loaded lazily via `createPlatformBridge()` only when `isTauri()` is true.

`@tauri-apps/api` is an **optional dependency** of `@ifc-lite/geometry`, so web consumers never pull it in. Your desktop shell provides it (and the matching native commands below).

## Host command contract (Tauri)

If you use the bundled `NativeBridge`, your Tauri shell must register these Rust commands and emit these events. (For a different host, implement `IPlatformBridge` directly and this contract does not apply.)

**Commands (`invoke`):**

| Command | Description |
|---------|-------------|
| `get_geometry` | Process geometry in parallel batches from in-memory bytes (native Rayon) |
| `get_geometry_from_path` | Same, reading the file directly from disk |
| `get_geometry_streaming` | Stream geometry progressively from in-memory bytes |
| `get_geometry_streaming_from_path` | Stream geometry progressively from a file path |
| `get_native_geometry_cache_manifest` | Look up a cached parse/geometry result by key |
| `get_native_geometry_cache_packed_shard` | Fetch a packed geometry shard from the cache |
| `get_native_geometry_cache_stream_status` | Report cache streaming status |

**Events (`listen`):**

| Event | Payload |
|-------|---------|
| `geometry-packed-batch` | A packed batch of mesh data |
| `geometry-color-update` | Per-element color updates |

The native commands wrap the `ifc-lite-core` / `ifc-lite-geometry` Rust crates directly (no WASM overhead). Your shell is also free to add its own commands for native file dialogs, filesystem access, preferences, and on-disk caching.

## Binary caching (optional)

A typical desktop shell stores parsed results on disk so reopening a previously loaded file is near-instant:

1. Hash the source file.
2. Check the cache for a matching key (`get_native_geometry_cache_manifest`).
3. If present, stream the cached geometry shards back (`get_native_geometry_cache_packed_shard`); if not, parse natively and write the result for next time.

## Frontend reuse

The web viewer UI (`apps/viewer`) is a standard browser app. A desktop shell can embed it (or its own UI) and rely on the same `@ifc-lite/*` packages; the only desktop-specific surface is the `GeometryProcessor` native path and any host commands you add. ifc-lite no longer maintains a viewer "override contract" — build your desktop UI as an ordinary consumer of the packages.

## Differences from the web build

- **Parsing backend**: native Rust vs WASM
- **Threading**: one in-process Rayon pool vs a pool of single-threaded WASM workers
- **File access**: direct filesystem vs browser upload
- **Memory**: no wasm32 4GB address-space limit
- **Caching**: disk-based binary cache vs browser IndexedDB
- **Startup**: no WASM download needed
- **Tessellation quality**: the `tessellationQuality` level currently applies
  to the WASM paths only; the native pipeline does not consume it yet
