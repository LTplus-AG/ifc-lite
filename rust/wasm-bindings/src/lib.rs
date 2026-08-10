// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! # IFC-Lite WebAssembly Bindings
//!
//! JavaScript/TypeScript API for IFC-Lite built with [wasm-bindgen](https://docs.rs/wasm-bindgen).
//!
//! ## Overview
//!
//! This crate provides WebAssembly bindings for IFC-Lite, enabling high-performance
//! IFC parsing and geometry processing in web browsers.
//!
//! ## Features
//!
//! - **Zero-Copy Buffers**: Direct GPU buffer access without data copying
//! - **Streaming Parse**: Event-based parsing with progress callbacks
//! - **Small Bundle**: ~60 KB WASM binary, ~20 KB gzipped
//!
//! ## JavaScript Usage
//!
//! ```javascript
//! import init, { IfcAPI, version } from 'ifc-lite-wasm';
//!
//! // Initialize WASM
//! await init();
//!
//! // Create API instance
//! const api = new IfcAPI();
//!
//! // Parse IFC file
//! const buffer = await fetch('model.ifc').then(r => r.arrayBuffer());
//! const result = api.parse(new Uint8Array(buffer));
//!
//! console.log(`Parsed ${result.entityCount} entities`);
//! console.log(`Version: ${version()}`);
//! ```
//!
//! ## Streaming Parse
//!
//! ```javascript
//! const result = await api.parseStreaming(data, (event) => {
//!   if (event.type === 'progress') {
//!     console.log(`Progress: ${event.percent}%`);
//!   }
//! });
//! ```

use wasm_bindgen::prelude::*;

// The crate's panic hook (console report + analytics location stash — see
// utils.rs). Kept as the ONLY way a hook is installed here: installing
// `console_error_panic_hook::set_once` directly would silently drop the
// location stash the viewer's error tracking relies on (#1196, #2527).
pub use utils::set_panic_hook;
// Observability seam for the wasm32 test leg only (tests/panic_stash.rs).
#[cfg(feature = "console_error_panic_hook")]
#[doc(hidden)]
pub use utils::stash_location_parts;

// Threaded build (off by default): exposes `initThreadPool(n)` to JS and makes
// the geometry crate's `par_iter` element loops parallel in WASM. Built as a
// SEPARATE bundle (atomics/shared-memory flags) via `build-wasm.sh BUILD_THREADED=1`;
// requires cross-origin isolation at runtime. See
// docs/architecture/csg-threading-design.md.
#[cfg(feature = "threads")]
pub use wasm_bindgen_rayon::init_thread_pool;

mod api;
#[cfg(feature = "console-tracing")]
mod tracing_console;
mod utils;
mod zero_copy;

pub use api::IfcAPI;
pub use utils::set_panic_hook as init_panic_hook;
pub use zero_copy::{
    get_memory, MeshCollection, MeshDataJs, SymbolicCircle, SymbolicFillArea, SymbolicPolyline,
    SymbolicRepresentationCollection, SymbolicText,
};

/// Initialize the WASM module.
///
/// This function is called automatically when the WASM module is loaded.
/// It sets up panic hooks for better error messages in the browser console.
#[wasm_bindgen(start)]
pub fn init() {
    utils::set_panic_hook();
}

/// Get the version of IFC-Lite.
///
/// # Returns
///
/// Version string (e.g., "0.1.0")
///
/// # Example
///
/// ```javascript
/// console.log(`IFC-Lite version: ${version()}`);
/// ```
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}
