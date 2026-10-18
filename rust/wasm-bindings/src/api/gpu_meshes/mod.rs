// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! GPU mesh parsing methods for IFC-Lite API
//!
//! Includes synchronous and async mesh parsing, instanced geometry,
//! and GPU-ready geometry generation.

mod affinity_chunks;
mod batch;
mod batch_entry_points;
pub(super) use batch::StyleMaps;
mod partitioned_batch;
mod batch_from_source;
pub(super) mod batch_partition;
mod batch_partitioned_output;
mod instancing;
pub(crate) mod prepass;
mod prepass_discovery;
mod prepass_owned_columns;
mod prepass_sharded;
mod source_fingerprint;
mod style_finishes;
mod prepass_from_source;
mod void_index;
mod prepass_affinity;
mod source_fingerprint_prepass;

/// Scan `content` into the compact columnar index. Its one refusal is a span
/// past `u32::MAX` (#7675, CORE-24), which a wasm32 `&[u8]` cannot reach: the
/// linear memory it lives in is itself 32-bit addressed. These entry points
/// have no `Result` to return it through, so the bound is stated here instead.
pub(super) fn scan_columnar_index(content: &[u8]) -> ifc_lite_core::ColumnarEntityIndex {
    ifc_lite_core::ColumnarEntityIndex::from_scan(content)
        .expect("a wasm32 source is below 4 GiB, so every span fits u32")
}
