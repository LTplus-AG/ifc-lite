// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The native streaming/batch engine over the shared processing pipeline.
//!
//! Both entry points delegate geometry, colour, style, void and coordinate
//! resolution to [`ifc_lite_processing`] — the same crate the HTTP server and
//! the C FFI use — and only add the [`crate::convert`] Y-up boundary swap and
//! the [`crate::packed`] wire encoding on top.

use ifc_lite_processing::{
    process_geometry_filtered, process_geometry_streaming_filtered_with_options, OpeningFilterMode,
    ProcessingResult, ProcessingStats, StreamingOptions,
};
#[cfg(test)]
use ifc_lite_processing::MeshData;

use crate::convert::{prepare_wire_mesh, WireMesh};
use crate::packed::encode_shard;

/// Aggregate timing/size stats returned to the desktop host after a parse.
///
/// Field names mirror the camelCase keys the `NativeBridge` reads from the
/// `get_geometry_streaming` command result; the Tauri shell serializes this with
/// `#[serde(rename_all = "camelCase")]`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EngineStats {
    pub total_meshes: usize,
    pub total_vertices: usize,
    pub total_triangles: usize,
    pub parse_time_ms: u64,
    pub entity_scan_time_ms: u64,
    pub lookup_time_ms: u64,
    pub preprocess_time_ms: u64,
    pub geometry_time_ms: u64,
    pub total_time_ms: u64,
}

impl EngineStats {
    fn from_processing(stats: &ProcessingStats) -> Self {
        Self {
            total_meshes: stats.total_meshes,
            total_vertices: stats.total_vertices,
            total_triangles: stats.total_triangles,
            parse_time_ms: stats.parse_time_ms,
            entity_scan_time_ms: stats.entity_scan_time_ms,
            lookup_time_ms: stats.lookup_time_ms,
            preprocess_time_ms: stats.preprocess_time_ms,
            geometry_time_ms: stats.geometry_time_ms,
            total_time_ms: stats.total_time_ms,
        }
    }
}

/// Threshold (metres) below which a site translation is treated as identity.
/// Matches `ifc-lite-ffi`'s `LARGE_COORD_THRESHOLD`.
const LARGE_COORD_THRESHOLD: f64 = 1000.0;
const RAW_IFC_MESH_COORDINATE_SPACE: &str = "raw_ifc";

/// Re-anchor world-space (`raw_ifc`) meshes to the IfcSite so absolute
/// coordinates stay small enough for f32 once the origin is folded in. This
/// mirrors `ifc-lite-ffi`'s `normalize_to_site_local`: only `raw_ifc` output is
/// shifted, and only when the site sits far (>1 km) from the origin; already
/// site-anchored tiers are left untouched.
fn normalize_to_site_local(result: &mut ProcessingResult) {
    if result.mesh_coordinate_space.as_deref() != Some(RAW_IFC_MESH_COORDINATE_SPACE) {
        return;
    }
    let (tx, ty, tz) = match result.site_transform {
        Some(ref st) if st.len() >= 16 => (st[12], st[13], st[14]),
        _ => return,
    };
    if tx.abs() < LARGE_COORD_THRESHOLD
        && ty.abs() < LARGE_COORD_THRESHOLD
        && tz.abs() < LARGE_COORD_THRESHOLD
    {
        return;
    }
    for mesh in &mut result.meshes {
        // Positions are stored relative to `origin`; shifting the origin shifts
        // the world point without touching the (small) relative positions, which
        // keeps f32 precision. raw_ifc meshes with a zero origin fall back to
        // shifting positions directly.
        if mesh.origin != [0.0, 0.0, 0.0] {
            mesh.origin[0] -= tx;
            mesh.origin[1] -= ty;
            mesh.origin[2] -= tz;
        } else {
            for chunk in mesh.positions.chunks_exact_mut(3) {
                chunk[0] = (chunk[0] as f64 - tx) as f32;
                chunk[1] = (chunk[1] as f64 - ty) as f32;
                chunk[2] = (chunk[2] as f64 - tz) as f32;
            }
        }
    }
    result.mesh_coordinate_space = Some("site_local".to_string());
}

/// Process IFC bytes and stream **wire-ready mesh batches** ([`WireMesh`],
/// already WebGL Y-up with origins folded) to `on_batch` as each batch
/// completes, plus deferred colour updates to `on_color_update`. Returns the
/// aggregate [`EngineStats`] once processing finishes.
///
/// This is the core streaming primitive: a Tauri shell can turn each batch into
/// whichever transport the `NativeBridge` expects — the struct `geometry-packed-batch`
/// event (pooled arrays + ranges, via the shell's own serde types) or the binary
/// disk-cache shard ([`crate::packed::encode_shard`]).
///
/// The streaming callbacks fire before the final [`ProcessingResult`] (and thus
/// the site transform) is known, so this path folds each mesh's local `origin`
/// into its positions but does not re-anchor `raw_ifc` world coordinates — for
/// very large georeferenced models prefer the batch [`process_mesh_array`] path
/// (or a host-side RTC offset). Ordinary building models are emitted in their
/// native `site_local` frame and need no re-anchoring.
pub fn stream_wire_batches(
    content: &[u8],
    initial_batch_size: usize,
    throughput_batch_size: usize,
    mut on_batch: impl FnMut(&[WireMesh], usize, usize),
    mut on_color_update: impl FnMut(&[(u32, [f32; 4])]),
) -> EngineStats {
    let options = StreamingOptions {
        initial_batch_size,
        throughput_batch_size,
        ..StreamingOptions::default()
    };

    let result = process_geometry_streaming_filtered_with_options(
        content,
        OpeningFilterMode::Default,
        options,
        |meshes, processed, total| {
            let wire: Vec<WireMesh> = meshes.iter().map(prepare_wire_mesh).collect();
            on_batch(&wire, processed, total);
        },
        |updates| on_color_update(updates),
        |_bootstrap| {},
    );

    EngineStats::from_processing(&result.stats)
}

/// Convenience wrapper over [`stream_wire_batches`] that emits each batch as a
/// binary [`crate::packed`] shard — the format the disk-cache shard commands
/// (`get_native_geometry_cache_packed_shard`) serve and
/// `packed-geometry-decoder.ts` reads.
pub fn stream_packed_shards(
    content: &[u8],
    initial_batch_size: usize,
    throughput_batch_size: usize,
    mut on_shard: impl FnMut(Vec<u8>),
    on_color_update: impl FnMut(&[(u32, [f32; 4])]),
) -> EngineStats {
    stream_wire_batches(
        content,
        initial_batch_size,
        throughput_batch_size,
        |wire, processed, total| on_shard(encode_shard(wire, processed, total)),
        on_color_update,
    )
}

/// Process IFC bytes and return every mesh at once as [`WireMesh`] (WebGL Y-up,
/// origin folded), for the non-streaming `get_geometry` / `get_geometry_from_path`
/// commands. Unlike the streaming path this has the full [`ProcessingResult`], so
/// it re-anchors large `raw_ifc` models to the site before folding origins.
pub fn process_mesh_array(content: &[u8]) -> (Vec<WireMesh>, EngineStats) {
    let mut result = process_geometry_filtered(content, OpeningFilterMode::Default);
    normalize_to_site_local(&mut result);
    let stats = EngineStats::from_processing(&result.stats);
    let wire = result.meshes.iter().map(prepare_wire_mesh).collect();
    (wire, stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw_ifc_result(origin: [f64; 3], positions: Vec<f32>) -> ProcessingResult {
        let mut site = vec![0.0; 16];
        // Column-major translation at 12,13,14 — a 5,000 km site (georef class).
        site[0] = 1.0;
        site[5] = 1.0;
        site[10] = 1.0;
        site[15] = 1.0;
        site[12] = 5_000_000.0;
        site[13] = 0.0;
        site[14] = 0.0;

        let mut mesh = MeshData::new(1, "IfcWall".into(), positions, vec![], vec![], [1.0; 4]);
        mesh.origin = origin;

        ProcessingResult {
            meshes: vec![mesh],
            mesh_coordinate_space: Some("raw_ifc".to_string()),
            site_transform: Some(site),
            building_transform: None,
            metadata: Default::default(),
            stats: Default::default(),
        }
    }

    #[test]
    fn site_local_tier_is_left_untouched() {
        let mut result = raw_ifc_result([0.0, 0.0, 0.0], vec![1.0, 2.0, 3.0]);
        result.mesh_coordinate_space = Some("site_local".to_string());
        let before = result.meshes[0].positions.clone();
        normalize_to_site_local(&mut result);
        assert_eq!(result.meshes[0].positions, before);
        assert_eq!(result.meshes[0].origin, [0.0, 0.0, 0.0]);
    }

    #[test]
    fn raw_ifc_with_origin_shifts_the_origin() {
        let mut result = raw_ifc_result([5_000_000.0, 0.0, 0.0], vec![1.0, 2.0, 3.0]);
        normalize_to_site_local(&mut result);
        // Origin re-anchored to the site; relative positions preserved exactly.
        assert_eq!(result.meshes[0].origin, [0.0, 0.0, 0.0]);
        assert_eq!(result.meshes[0].positions, vec![1.0, 2.0, 3.0]);
        assert_eq!(result.mesh_coordinate_space.as_deref(), Some("site_local"));
    }

    #[test]
    fn raw_ifc_zero_origin_shifts_positions() {
        let mut result = raw_ifc_result([0.0, 0.0, 0.0], vec![5_000_001.0, 2.0, 3.0]);
        normalize_to_site_local(&mut result);
        assert_eq!(result.meshes[0].positions[0], 1.0);
    }

    #[test]
    fn near_origin_site_is_not_shifted() {
        // A site within 1 km of the origin is identity — nothing to subtract.
        let mut result = raw_ifc_result([0.0, 0.0, 0.0], vec![1.0, 2.0, 3.0]);
        if let Some(st) = result.site_transform.as_mut() {
            st[12] = 10.0;
        }
        normalize_to_site_local(&mut result);
        assert_eq!(result.meshes[0].positions, vec![1.0, 2.0, 3.0]);
        // Tier unchanged because no shift was applied.
        assert_eq!(result.mesh_coordinate_space.as_deref(), Some("raw_ifc"));
    }
}
