// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use wasm_bindgen::prelude::*;

/// Execute source-independent imported tessellation using the same packet ABI
/// as the small synchronous IFCX artifact. Errors are encoded in the packet.
#[wasm_bindgen(js_name = processImportedGeometryPacket)]
pub fn process_imported_geometry_packet(input: &[u8]) -> Vec<u8> {
    ifc_lite_geometry::imported::process_packet(input)
}
