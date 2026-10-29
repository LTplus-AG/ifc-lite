// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Driving the two-opening fixture whose rings differ below the f32 position
//! ULP. Shared by the #8276 regression (the geometry cache serving one
//! opening's normals for the other) and the #8287 one (the instancing
//! `rep_identity` grouping the pair into one template), which need the same
//! meshes out of the same router and differ only in what they assert about
//! them.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_processing::element::{
    produce_element_meshes, ElementJobKind, ElementMeshJob, MeshProductionContext,
    MeshProductionOptions,
};
use ifc_lite_processing::MeshData;
use rustc_hash::FxHashMap;

const FIXTURE: &str = "tests/fixtures/issue_8276_two_openings_f32_identical.ifc";
/// Ring exactly axis-aligned.
pub const OPENING_A: u32 = 60;
/// Same ring with its top edge 1e-15 off — invisible in f32 positions. Shares
/// `OPENING_A`'s `ObjectPlacement`, so the two shipped meshes differ in their
/// normals and in nothing else.
pub const OPENING_B: u32 = 80;

/// The fixture's text, read from the crate root.
pub fn fixture_content() -> String {
    std::fs::read_to_string(FIXTURE)
        .unwrap_or_else(|e| panic!("failed to read fixture {FIXTURE}: {e}"))
}

/// Mesh every id in `ids` through `produce_element_meshes` on ONE router, in
/// order, and return each id's first mesh.
///
/// One router is the point: both halves of this fixture's defect run through
/// per-router state (the geometry-hash cache for #8276, the `rep_identity`
/// stamped from it for #8287). In the pipeline the two openings are meshed by
/// whichever rayon worker gets them, so which one wins follows the thread
/// schedule; sequentially on one router it is deterministic.
pub fn mesh_on_one_router(content: &str, ids: &[u32]) -> Vec<MeshData> {
    let index = std::sync::Arc::new(build_entity_index(content));
    let mut decoder = EntityDecoder::with_arc_index(content.as_bytes(), index.clone());
    let router = GeometryRouter::with_units(content, &mut decoder);
    decoder.seed_unit_scales(router.unit_scale(), 1.0);

    let void_index = FxHashMap::default();
    let geometry_style_index = FxHashMap::default();
    let indexed_colour_full = FxHashMap::default();
    let element_material_colors = FxHashMap::default();
    let texture_index = FxHashMap::default();
    let ctx = MeshProductionContext {
        void_index: &void_index,
        geometry_style_index: &geometry_style_index,
        indexed_colour_full: &indexed_colour_full,
        element_material_colors: &element_material_colors,
        texture_index: &texture_index,
        site_local_rotation: None,
    };
    let opts = MeshProductionOptions::default();

    ids.iter()
        .map(|&id| {
            let entity = decoder.decode_by_id(id).expect("element decodes");
            let ifc_type = entity.ifc_type.clone();
            let mut produced = produce_element_meshes(
                &ElementMeshJob {
                    id,
                    ifc_type,
                    entity: &entity,
                    kind: ElementJobKind::Product,
                    element_color: None,
                    metadata: None,
                },
                &ctx,
                &opts,
                &mut decoder,
                &router,
            );
            if produced.meshes.is_empty() {
                panic!("#{id} produced no mesh");
            }
            produced.meshes.swap_remove(0)
        })
        .collect()
}
