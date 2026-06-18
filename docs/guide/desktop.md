# Building for Desktop

IFClite's primary product is the **web viewer** (plus the headless CLI/MCP/server). On top of the published `@ifc-lite/*` packages you can also build a native desktop app (e.g. with [Tauri v2](https://v2.tauri.app/)) with a **native-Rust geometry fast path** that bypasses WebAssembly for multi-threaded performance on very large models.

A working **reference implementation** lives in [`apps/desktop`](https://github.com/LTplus-AG/ifc-lite/tree/main/apps/desktop): a Tauri v2 shell whose `#[tauri::command]` layer drives the [`ifc-lite-desktop-engine`](https://github.com/LTplus-AG/ifc-lite/tree/main/rust/desktop) crate (a thin wrapper over the shared `ifc-lite-processing` pipeline). It is a standalone project — not part of the monorepo workspace — so it doubles as a copy-paste starting point for your own shell.

This page describes the extension points the packages expose and the host-side contract your desktop shell needs to implement.

## Why build a desktop app?

| Feature | Web (WASM) | Desktop (Native) |
|---------|-----------|------------------|
| **Parsing** | Single-threaded | Multi-threaded (Rayon) |
| **Memory** | WASM 4GB limit | System RAM |
| **File Access** | User upload only | Direct filesystem |
| **Startup** | Download WASM | Instant |
| **Large Files** | ~100MB practical limit | 500MB+ supported |

A desktop shell reuses the same Rust crates (`ifc-lite-core`, `ifc-lite-geometry`) as the WASM build, but compiled natively with full multi-threading.

## Native speed without a desktop install: the WebSocket backend

You don't have to ship a desktop binary to get native parsing. [`ifc-lite-desktop-server`](https://github.com/LTplus-AG/ifc-lite/tree/main/rust/desktop-server) is a tiny localhost server (built on the same `ifc-lite-desktop-engine`) that a **plain browser tab** talks to over WebSocket: the page sends the IFC file, the server parses it with native Rayon, and streams the geometry back as binary **packed shards** (the exact format `packed-geometry-decoder.ts` reads).

```text
browser tab (any web viewer)
  └─ WebSocket ws://127.0.0.1:8082/geometry
       └─ ifc-lite-desktop-server   (loopback only)
            └─ ifc-lite-desktop-engine → ifc-lite-processing (native Rayon)
```

This is the "local native accelerator → web viewer" deployment: native CPU/memory headroom, no WASM 4 GB cap, but no install ceremony beyond running one local binary. The `apps/desktop` reference frontend uses this path automatically when it is *not* running inside Tauri. Bind it to loopback only — it is a local accelerator, not a public service — and build it with `--profile server-release` so a parser panic becomes a per-connection error rather than a process abort.

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

The `apps/desktop` reference shell implements the first three (`get_geometry`, `get_geometry_from_path`, `get_geometry_streaming`) plus a native file picker — enough to drive the `NativeBridge` `processGeometry` / `processGeometryPath` / `processGeometryStreaming` paths end-to-end. The `get_native_geometry_cache_*` / `get_geometry_streaming_from_path` commands back the optional on-disk cache (see below) and are left to production shells.

**Events (`listen`):**

| Event | Payload |
|-------|---------|
| `geometry-packed-batch` | A packed batch of mesh data |
| `geometry-color-update` | Per-element color updates |

The native commands wrap the shared `ifc-lite-processing` pipeline (via `ifc-lite-desktop-engine`) — the exact crate the HTTP server and the C FFI use, so colour/coordinate/geometry resolution can't drift from the web build. They add only the IFC Z-up → WebGL Y-up boundary swap (mirroring the WASM path's `zero_copy.rs`) so meshes arrive renderer-ready. Your shell is also free to add its own commands for native file dialogs, filesystem access, preferences, and on-disk caching.

## Binary caching (optional)

A typical desktop shell stores parsed results on disk so reopening a previously loaded file is near-instant:

1. Hash the source file.
2. Check the cache for a matching key (`get_native_geometry_cache_manifest`).
3. If present, stream the cached geometry shards back (`get_native_geometry_cache_packed_shard`); if not, parse natively and write the result for next time.

`ifc-lite-desktop-engine::encode_shard` already produces the exact binary packed-shard layout that `@ifc-lite/geometry`'s `packed-geometry-decoder.ts` reads, so the only work left for the cache is writing those buffers to disk and serving them through these commands.

## Frontend reuse

The web viewer UI (`apps/viewer`) is a standard browser app. A desktop shell can embed it (or its own UI) and rely on the same `@ifc-lite/*` packages; the only desktop-specific surface is the `GeometryProcessor` native path and any host commands you add. ifc-lite no longer maintains a viewer "override contract" — build your desktop UI as an ordinary consumer of the packages.

## Differences from the web build

- **Parsing backend**: native Rust vs WASM
- **Threading**: Rayon thread pool vs single-threaded WASM
- **File access**: direct filesystem vs browser upload
- **Memory**: no WASM 4GB limit
- **Caching**: disk-based binary cache vs browser IndexedDB
- **Startup**: no WASM download needed
