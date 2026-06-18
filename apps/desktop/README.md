<!--
This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

# IFC-Lite Desktop (reference shell)

A **Tauri v2** desktop app that runs the ordinary web viewer in a webview while
processing IFC geometry with **native Rust** instead of WebAssembly. It is the
reference implementation of the desktop capability documented in
[`docs/guide/desktop.md`](../../docs/guide/desktop.md).

## Why it can be faster than the browser

The in-browser pipeline runs N single-thread WASM instances, each streaming a
~1.5×-file private heap over the same memory bus, so geometry wall-time is bound
by **memory bandwidth**, not CPU cores (see PR #1159), and large georeferenced
models brush the wasm32 **4 GB** address-space cap. This shell runs
[`ifc-lite-desktop-engine`](../../rust/desktop) — a thin wrapper over the same
shared `ifc-lite-processing` pipeline — with a real Rayon pool over **one**
shared-memory heap. No heap duplication, no 4 GB cap, full-width native SIMD.

## How it is wired

```
web viewer (this frontend, three.js)
  └─ GeometryProcessor({ preferNative: true })      @ifc-lite/geometry
       └─ isTauri() → NativeBridge                  (already shipped in the package)
            └─ invoke('get_geometry_streaming')     apps/desktop/src-tauri
                 └─ ifc-lite-desktop-engine         rust/desktop
                      └─ ifc-lite-processing        the shared pipeline (server + FFI + this)
```

The engine emits meshes already converted to **WebGL Y-up**, so they drop
straight into three.js. The geometry/colour/coordinate logic is **not** forked —
it is the same crate the HTTP server and the C FFI use.

## This is a standalone project

It is intentionally **not** part of the ifc-lite pnpm/cargo workspaces (the root
`pnpm-workspace.yaml` excludes it and the root `Cargo.toml` excludes
`src-tauri`). It consumes the **published** `@ifc-lite/geometry` package like any
third-party desktop shell would, and keeps its own lockfile and Tauri/GUI
dependencies out of the monorepo's CI lanes. The reusable engine
(`rust/desktop`) **is** a workspace member and is unit-tested by
`cargo test --workspace`.

## Build & run

Prerequisites: the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/)
(Rust toolchain + platform webview libs — e.g. `webkit2gtk` on Linux) and Node + pnpm.

```bash
cd apps/desktop
pnpm install
pnpm dev          # tauri dev — launches the window with hot-reload frontend
pnpm build        # tauri build — produces a bundled installer
```

Click **Open IFC…**, pick a file, and watch it stream in — processed natively.

## Host command contract

Implemented in `src-tauri/src/commands/`:

| Command | Purpose |
|---------|---------|
| `get_geometry` | Parse in-memory bytes, return all meshes |
| `get_geometry_from_path` | Parse a file by path (no bytes over IPC) |
| `get_geometry_streaming` | Stream `geometry-packed-batch` + `geometry-color-update` events |
| `open_ifc_file` | Native file picker → path + metadata |

The optional on-disk packed-shard cache (`get_native_geometry_cache_*`,
`get_geometry_streaming_from_path`) from the full `NativeBridge` contract is left
to production shells; `ifc-lite-desktop-engine::encode_shard` already produces
the exact binary shard format `packed-geometry-decoder.ts` reads, so wiring that
cache is mechanical.
