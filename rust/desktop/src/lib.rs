// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Native desktop geometry engine for ifc-lite.
//!
//! This crate is the **native counterpart of the browser WASM geometry path**.
//! It exists to let a desktop shell (e.g. a Tauri v2 app) process IFC files with
//! a real Rayon thread pool over a single shared-memory heap — escaping the two
//! ceilings the in-browser pipeline hits on large models:
//!
//! 1. **Memory bandwidth.** The browser runs N single-thread WASM instances, each
//!    streaming a ~1.5×-file private heap over the same bus, so geometry wall-time
//!    is bandwidth-bound rather than core-bound (see PR #1159). Native Rayon shares
//!    one heap, so the duplication traffic disappears and cores scale again.
//! 2. **The wasm32 4 GB address-space cap**, which large georeferenced models
//!    already brush against in the browser. Native is bounded only by system RAM.
//!
//! ## What it is (and is not)
//!
//! It is a **thin wrapper** over [`ifc_lite_processing`], the same pipeline the
//! HTTP server and the C FFI (`ifc-lite-ffi`) use. Colour, style, void, unit and
//! coordinate resolution all live in that shared crate and are **not re-forked
//! here** — per the repository's anti-drift rule. This crate adds exactly two
//! things on top of the pipeline output:
//!
//! - [`convert`]: the IFC **Z-up → WebGL Y-up** boundary conversion (positions,
//!   normals, winding, and the per-mesh `origin` fold), mirroring
//!   `wasm-bindings/src/zero_copy.rs::MeshDataJs::new` — the browser applies the
//!   identical swap at *its* FFI boundary, so the native bridge must too.
//! - [`packed`]: the **packed geometry shard** binary encoder whose layout is
//!   byte-for-byte the format
//!   `packages/geometry/src/packed-geometry-decoder.ts` already decodes. This is
//!   the zero-copy-friendly wire format the surviving `NativeBridge` consumes.
//!
//! A Tauri shell wires [`stream_packed_shards`] / [`process_mesh_array`] to the
//! `get_geometry*` commands documented in `docs/guide/desktop.md`.

pub mod convert;
pub mod engine;
pub mod packed;

pub use convert::{prepare_wire_mesh, WireMesh};
pub use engine::{
    process_mesh_array, stream_packed_shards, stream_wire_batches, EngineStats,
};
pub use packed::{encode_shard, SHARD_MAGIC, SHARD_VERSION};
