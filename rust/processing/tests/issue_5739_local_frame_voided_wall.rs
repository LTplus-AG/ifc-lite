// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #5739: with per-element local frames on (the wasm and viewer
//! default), a plan-rotated voided wall came back open while the native
//! world path was closed. The analytic prism cut's closure verdict, and the
//! wall-frame snap tolerance, read the vertices at their stored precision,
//! so the same wall took a different route in each vertex frame.
//!
//! The wall is #5635's (`common::wall_frame_seams`). Every angle is asserted
//! in BOTH vertex frames, each chosen by an explicit router policy rather
//! than the process-global env/override.

mod common;

use common::wall_frame_seams::{
    authored_volume, signed_volume, unpaired_directed_edges, wall_ifc, WINDOWS,
};
use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_processing::element::{
    produce_element_meshes, ElementJobKind, ElementMeshJob, MeshProductionContext,
    MeshProductionOptions,
};
use ifc_lite_processing::MeshData;
use rustc_hash::FxHashMap;

/// The leaf through the single production path (`produce_element_meshes`)
/// with an explicit vertex-frame policy: `false` stores world coordinates (the
/// native default), `true` stores them relative to a per-element origin (the
/// wasm default).
fn leaf_in_frame(plan_deg: f64, local_frame: bool) -> MeshData {
    let content = wall_ifc(plan_deg);
    let index = std::sync::Arc::new(build_entity_index(&content));
    let mut decoder = EntityDecoder::with_arc_index(content.as_bytes(), index);
    let router = GeometryRouter::with_scale_and_local_frame(1e-3, local_frame);
    decoder.seed_unit_scales(router.unit_scale(), 1.0);
    let openings: Vec<u32> = (0..WINDOWS as u32).map(|i| 1012 + 20 * i).collect();
    let void_index: FxHashMap<u32, Vec<u32>> = [(100, openings)].into_iter().collect();
    let (styles, colours, materials, textures) =
        (FxHashMap::default(), FxHashMap::default(), FxHashMap::default(), FxHashMap::default());
    let ctx = MeshProductionContext {
        void_index: &void_index,
        geometry_style_index: &styles,
        indexed_colour_full: &colours,
        element_material_colors: &materials,
        texture_index: &textures,
        site_local_rotation: None,
    };
    let entity = decoder.decode_by_id(100).expect("wall entity decodes");
    let job = ElementMeshJob {
        id: 100,
        ifc_type: entity.ifc_type.clone(),
        entity: &entity,
        kind: ElementJobKind::Product,
        element_color: None,
        metadata: None,
    };
    let opts = MeshProductionOptions::default();
    let mut meshes = produce_element_meshes(&job, &ctx, &opts, &mut decoder, &router).meshes;
    assert_eq!(meshes.len(), 1, "{plan_deg}°: one leaf mesh");
    meshes.pop().expect("wall mesh")
}

fn assert_leaf_closed(leaf: &MeshData, what: &str) {
    let open = unpaired_directed_edges(&leaf.positions, &leaf.indices);
    let volume = signed_volume(&leaf.positions, &leaf.indices);
    let expected = authored_volume();
    assert_eq!(
        open,
        0,
        "{what}: redundant openings must leave the rotated leaf closed ({} tris, {volume:.6} m^3)",
        leaf.indices.len() / 3
    );
    assert!(
        (volume - expected).abs() / expected < 5e-4,
        "{what}: the openings only re-cut the voids; expected {expected:.6} m^3, got {volume:.6} m^3"
    );
}

const PLAN_ANGLES: [f64; 8] = [-34.3, -12.0, 17.0, 29.0, 41.0, 61.0, 73.3, 133.0];

#[test]
fn leaf_stays_closed_in_world_and_local_vertex_frames_5739() {
    for local_frame in [false, true] {
        for deg in std::iter::once(0.0).chain(PLAN_ANGLES) {
            let leaf = leaf_in_frame(deg, local_frame);
            assert_leaf_closed(&leaf, &format!("{deg}°, local_frame={local_frame} (#5739)"));
        }
    }
}

