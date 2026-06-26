// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! GPU mesh parsing methods for IFC-Lite API
//!
//! Includes synchronous and async mesh parsing, instanced geometry,
//! and GPU-ready geometry generation.

mod batch;
mod prepass;

fn decode_ifc_bytes<'a>(data: &'a [u8]) -> &'a str {
    match std::str::from_utf8(data) {
        Ok(content) => content,
        Err(error) => wasm_bindgen::throw_str(&format!("Invalid UTF-8 IFC data: {error}")),
    }
}
