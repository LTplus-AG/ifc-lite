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
//!
//! ## Zero-Copy Memory Access
//!
//! For optimal performance, mesh data can be accessed directly from WASM memory:
//!
//! ```javascript
//! const positions = api.getPositionsBuffer(expressId);
//! const view = positions.asFloat32Array();
//!
//! // Upload directly to GPU without copying
//! device.queue.writeBuffer(gpuBuffer, 0, view);
//! ```

use wasm_bindgen::prelude::*;

// wasm-bindgen-rayon removed — incompatible with Vite production builds

#[cfg(feature = "console_error_panic_hook")]
pub use console_error_panic_hook::set_once as set_panic_hook;

mod api;
mod gpu_geometry;
mod quantized_scene;
mod utils;
mod zero_copy;

pub use api::IfcAPI;
pub use gpu_geometry::{
    GpuGeometry, GpuInstancedGeometry, GpuInstancedGeometryCollection, GpuInstancedGeometryRef,
    GpuMeshMetadata,
};
pub use quantized_scene::QuantizedScene;
pub use utils::set_panic_hook as init_panic_hook;
pub use zero_copy::{
    get_memory, InstanceData, InstancedGeometry, InstancedMeshCollection, MeshCollection,
    MeshDataJs, SymbolicCircle, SymbolicPolyline, SymbolicRepresentationCollection, ZeroCopyMesh,
};

/// Initialize the WASM module.
///
/// This function is called automatically when the WASM module is loaded.
/// It sets up panic hooks for better error messages in the browser console.
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
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
