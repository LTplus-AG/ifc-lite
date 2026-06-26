// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Zero-copy mesh data structures for WASM
//!
//! Enables direct access to WASM memory from JavaScript without copying.

use wasm_bindgen::prelude::*;

mod mesh;
mod symbolic;

pub use mesh::{MeshCollection, MeshDataJs};
pub use symbolic::{
    SymbolicCircle, SymbolicFillArea, SymbolicPolyline, SymbolicRepresentationCollection,
    SymbolicText,
};

/// Get WASM memory to allow JavaScript to create TypedArray views
#[wasm_bindgen]
pub fn get_memory() -> JsValue {
    wasm_bindgen::memory()
}
