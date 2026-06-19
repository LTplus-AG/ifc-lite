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

    // Diagnostic (IFC_LITE_INSTANCING): tally how much GPU instancing would save
    // on this model — distinct representations vs total instanceable occurrences,
    // and the vertex-ingest reduction. Validates Phase-A capture on real files.
    let instancing_diag = std::env::var("IFC_LITE_INSTANCING").is_ok();
    let mut tally = InstancingTally::default();

    let result = process_geometry_streaming_filtered_with_options(
        content,
        OpeningFilterMode::Default,
        options,
        |meshes, processed, total| {
            if instancing_diag {
                tally.observe(meshes);
            }
            let wire: Vec<WireMesh> = meshes.iter().map(prepare_wire_mesh).collect();
            on_batch(&wire, processed, total);
        },
        |updates| on_color_update(updates),
        |_bootstrap| {},
    );

    if instancing_diag {
        tally.log();
    }

    // Phase-0 rigid-congruence dedup measurement (IFC_LITE_INSTANCING_ANALYSIS):
    // drain the retained pre-placement local meshes and report how much SAFE
    // rotation-normalized dedup is available beyond the exact-bit tier.
    if ifc_lite_geometry::congruence::analysis_enabled() {
        let locals = ifc_lite_geometry::congruence::take_locals();
        let occ_counts: std::collections::HashMap<u128, usize> =
            tally.groups.iter().map(|(&k, &(c, _))| (k, c)).collect();
        // Production POST-PASS validation: build the exact->rigid map over the
        // DISTINCT locals (the integration the inline attempt stalled on). Confirms
        // it is fast (off the parallel hot path) and yields the same grouping.
        let tmap = std::time::Instant::now();
        let rigid_map = ifc_lite_geometry::congruence::build_rigid_map(&locals);
        let distinct_rigid: std::collections::HashSet<u128> =
            rigid_map.values().map(|c| c.rigid_id).collect();
        let unmapped = locals.len() - rigid_map.len(); // un-weldable -> stay distinct
        let occ_after: usize = {
            // occurrences regrouped by rigid id (+ unmapped exact reps as-is)
            let mut by_rigid: std::collections::HashMap<u128, usize> =
                std::collections::HashMap::new();
            for (exact, &cnt) in &occ_counts {
                let rid = rigid_map.get(exact).map(|c| c.rigid_id).unwrap_or(*exact);
                *by_rigid.entry(rid).or_insert(0) += cnt;
            }
            by_rigid.len()
        };
        eprintln!(
            "[POST-PASS] exact_locals={} -> rigid_templates={} (+{} unmapped) | distinct reps {} -> {} | build {}ms",
            locals.len(),
            distinct_rigid.len(),
            unmapped,
            occ_counts.len(),
            occ_after,
            tmap.elapsed().as_millis(),
        );
        let t0 = std::time::Instant::now();
        let report =
            ifc_lite_geometry::congruence::analyze_rigid_dedup(locals, &occ_counts, 0);
        let report = ifc_lite_geometry::congruence::RigidDedupReport {
            wall_ms: t0.elapsed().as_millis(),
            ..report
        };
        eprintln!("{report}");
    }

    EngineStats::from_processing(&result.stats)
}

/// Streaming accumulator for the `IFC_LITE_INSTANCING` dedup diagnostic.
#[derive(Default)]
struct InstancingTally {
    total_meshes: usize,
    total_verts: usize,
    instanceable_meshes: usize,
    instanceable_verts: usize,
    /// rep_identity -> (occurrences, verts of the first occurrence seen).
    groups: std::collections::HashMap<u128, (usize, usize)>,
}

impl InstancingTally {
    fn observe(&mut self, meshes: &[MeshData]) {
        for m in meshes {
            self.total_meshes += 1;
            let verts = m.positions.len() / 3;
            self.total_verts += verts;
            if let Some(im) = &m.instance {
                if im.instanceable {
                    self.instanceable_meshes += 1;
                    self.instanceable_verts += verts;
                    let e = self.groups.entry(im.rep_identity).or_insert((0, verts));
                    e.0 += 1;
                }
            }
        }
    }

    fn log(&self) {
        let distinct = self.groups.len();
        // Unique verts = one copy per distinct rep (instanced) + every flat vert.
        let unique_instanceable_verts: usize = self.groups.values().map(|(_, v)| *v).sum();
        let flat_verts = self.total_verts.saturating_sub(self.instanceable_verts);
        let unique_verts = unique_instanceable_verts + flat_verts;
        let dedup = if distinct > 0 {
            self.instanceable_meshes as f64 / distinct as f64
        } else {
            0.0
        };
        let vert_reduction = if self.total_verts > 0 {
            100.0 * (1.0 - unique_verts as f64 / self.total_verts as f64)
        } else {
            0.0
        };
        let pct_instanceable =
            100.0 * self.instanceable_meshes as f64 / self.total_meshes.max(1) as f64;
        eprintln!(
            "[IFC_LITE_INSTANCING] total_meshes={} instanceable={} ({pct_instanceable:.1}%) \
             distinct_reps={distinct} dedup={dedup:.2}x | verts total={} unique={} reduction={vert_reduction:.1}%",
            self.total_meshes, self.instanceable_meshes, self.total_verts, unique_verts,
        );
    }
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

/// Process IFC bytes into a single INSTANCED ("IFNS") shard — unique template
/// geometry once + a per-occurrence instance table (transform, entity id,
/// colour), the format `decodeInstancedShard` reads.
///
/// This is the COLLECT-ALL emit path: collation needs the whole mesh set, so —
/// unlike [`stream_packed_shards`] — it is non-streaming. The shard is in the
/// IFC frame (same as [`MeshData`], positions relative to per-mesh origin); the
/// renderer applies the same Z-up→Y-up boundary swap [`prepare_wire_mesh`] does
/// to baked meshes, now to the template + instance transforms.
///
/// Requires `IFC_LITE_INSTANCING` (instance-metadata capture). With
/// `IFC_LITE_RIGID_INSTANCING` also set, the rotation-normalized tier is folded
/// in (rep_identity regrouped + per-occurrence canonical transform recovered).
/// Falls back to one singleton template per mesh when capture is off.
pub fn process_instanced_shard(content: &[u8]) -> (Vec<u8>, EngineStats) {
    let mut result = process_geometry_filtered(content, OpeningFilterMode::Default);
    normalize_to_site_local(&mut result);
    apply_rigid_map(&mut result.meshes);
    let stats = EngineStats::from_processing(&result.stats);
    let bytes = encode_instanced_shard(&result.meshes);
    (bytes, stats)
}

/// Fold the rotation-normalized rigid tier into the mesh instance metadata: run
/// the post-pass over the captured pre-placement local meshes, then for each mesh
/// remap rep_identity to its rigid template id + attach the recovered canonical
/// transform. No-op unless `IFC_LITE_RIGID_INSTANCING` is on.
fn apply_rigid_map(meshes: &mut [MeshData]) {
    if !ifc_lite_geometry::congruence::rigid_enabled() {
        return;
    }
    let locals = ifc_lite_geometry::congruence::take_locals();
    let map = ifc_lite_geometry::congruence::build_rigid_map(&locals);
    for m in meshes.iter_mut() {
        if let Some(im) = m.instance.as_mut() {
            if let Some(cls) = map.get(&im.rep_identity) {
                im.rep_identity = cls.rigid_id;
                im.canonical_transform = cls.canonical_transform;
            }
        }
    }
}

/// Collate `MeshData` into an instanced shard (IFC frame), borrowing each mesh's
/// geometry — no clone. Entity id = `express_id`; colour = the resolved mesh
/// colour. Meshes without instance metadata become singleton templates, so every
/// mesh is represented.
pub fn encode_instanced_shard(meshes: &[MeshData]) -> Vec<u8> {
    let refs: Vec<ifc_lite_geometry::InstanceMeshRef> = meshes
        .iter()
        .map(|m| ifc_lite_geometry::InstanceMeshRef {
            positions: &m.positions,
            normals: &m.normals,
            indices: &m.indices,
            origin: m.origin,
            instance_meta: m.instance.as_ref(),
            entity_id: m.express_id,
            color: m.color,
        })
        .collect();
    ifc_lite_geometry::collate_and_encode(&refs, 2)
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
    fn encode_instanced_shard_from_meshdata_roundtrips_and_expands() {
        use ifc_lite_geometry::{decode_instanced, InstanceMeta};
        // Row-major translation mat4.
        let tr = |tx: f64, ty: f64, tz: f64| {
            [1.0, 0.0, 0.0, tx, 0.0, 1.0, 0.0, ty, 0.0, 0.0, 1.0, tz, 0.0, 0.0, 0.0, 1.0]
        };
        let canon = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        let baked = |tx: f32, ty: f32, tz: f32| -> Vec<f32> {
            canon
                .chunks_exact(3)
                .flat_map(|c| [c[0] + tx, c[1] + ty, c[2] + tz])
                .collect()
        };
        let mk = |id: u32, pos: Vec<f32>, m: [f64; 16], rep: u128| {
            let n = pos.len() / 3;
            MeshData::new(id, "IfcBeam".into(), pos, vec![0.0; n * 3], (0..n as u32).collect(), [0.5; 4])
                .with_instance(Some(InstanceMeta {
                    transform: m,
                    local_transform: None,
                    canonical_transform: None,
                    rep_identity: rep,
                    instanceable: true,
                }))
        };
        // m0,m1 share rep 50 (same local geometry, different placement); m2 singleton.
        let meshes = vec![
            mk(1001, baked(1.0, 0.0, 0.0), tr(1.0, 0.0, 0.0), 50),
            mk(1002, baked(0.0, 2.0, 0.0), tr(0.0, 2.0, 0.0), 50),
            mk(1003, baked(5.0, 5.0, 5.0), tr(5.0, 5.0, 5.0), 60),
        ];
        let bytes = encode_instanced_shard(&meshes);
        let dec = decode_instanced(&bytes).expect("decodes");
        assert_eq!(dec.templates.len(), 2, "rep50 shared template + rep60 singleton");
        assert_eq!(dec.instances.len(), 3, "every mesh represented");
        let ids: Vec<u32> = dec.instances.iter().map(|i| i.entity_id).collect();
        assert!(ids.contains(&1001) && ids.contains(&1002) && ids.contains(&1003));

        // expand-to-flat: applying each instance transform to its template (IFC
        // frame, origin folded) reproduces the original MeshData's baked positions.
        let apply = |m: &[f32; 16], x: f32, y: f32, z: f32| {
            [
                m[0] * x + m[1] * y + m[2] * z + m[3],
                m[4] * x + m[5] * y + m[6] * z + m[7],
                m[8] * x + m[9] * y + m[10] * z + m[11],
            ]
        };
        for inst in &dec.instances {
            let tmpl = &dec.templates[inst.template_index as usize];
            let orig = meshes.iter().find(|m| m.express_id == inst.entity_id).unwrap();
            let t: [f32; 16] = inst.transform.as_slice().try_into().unwrap();
            let n = tmpl.positions.len() / 3;
            for v in 0..n {
                let w = apply(
                    &t,
                    tmpl.origin[0] as f32 + tmpl.positions[v * 3],
                    tmpl.origin[1] as f32 + tmpl.positions[v * 3 + 1],
                    tmpl.origin[2] as f32 + tmpl.positions[v * 3 + 2],
                );
                let gx = orig.origin[0] as f32 + orig.positions[v * 3];
                let gy = orig.origin[1] as f32 + orig.positions[v * 3 + 1];
                let gz = orig.origin[2] as f32 + orig.positions[v * 3 + 2];
                assert!((w[0] - gx).abs() < 1e-4 && (w[1] - gy).abs() < 1e-4 && (w[2] - gz).abs() < 1e-4);
            }
        }
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
