// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for #8276: two openings of the same authored size whose ring
//! coordinates differ below the f32 position ULP must keep their own normals.
//! `ifc_lite_geometry`'s `meshes_equal` says why that pair exists and what
//! served one for the other.
//!
//! The swap is reachable from either side, an element's own job or the host
//! wall's job meshing it as a cutter, so in the pipeline it followed the
//! thread schedule. Driving `produce_element_meshes` with ONE router over
//! both openings in sequence is the single-threaded shape of the same cache,
//! so it is deterministic here.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_processing::element::{
    produce_element_meshes, ElementJobKind, ElementMeshJob, MeshProductionContext,
    MeshProductionOptions,
};
use rustc_hash::FxHashMap;

const FIXTURE: &str = "tests/fixtures/issue_8276_two_openings_f32_identical.ifc";
/// Ring exactly axis-aligned.
const OPENING_A: u32 = 60;
/// Same ring with its top edge 1e-15 off — invisible in f32 positions. Shares
/// `OPENING_A`'s `ObjectPlacement`, so the two shipped meshes differ in their
/// normals and in nothing else, which is what the fixture guard below pins.
const OPENING_B: u32 = 80;

/// One element's shipped vertex and index buffers.
struct Buffers {
    positions: Vec<f32>,
    normals: Vec<f32>,
    indices: Vec<u32>,
}

/// Mesh every id in `ids` through `produce_element_meshes` on ONE router, in
/// order, and return each id's buffers.
fn mesh_on_one_router(content: &str, ids: &[u32]) -> Vec<Buffers> {
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
            let produced = produce_element_meshes(
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
            let mesh = produced
                .meshes
                .first()
                .unwrap_or_else(|| panic!("#{id} produced no mesh"));
            Buffers {
                positions: mesh.positions.clone(),
                normals: mesh.normals.clone(),
                indices: mesh.indices.clone(),
            }
        })
        .collect()
}

/// Guards the collision the regression below relies on: the two openings
/// still ship byte-identical positions and indices. Nothing else covers that,
/// and without it the regression could pass because the pair stopped
/// colliding rather than because the cache stopped confusing it. A failure
/// here means re-authoring the fixture, not relaxing the assertion.
#[test]
fn fixture_still_ships_identical_positions() {
    let content = std::fs::read_to_string(FIXTURE)
        .unwrap_or_else(|e| panic!("failed to read fixture {FIXTURE}: {e}"));
    // One router per opening, so neither can be served the other's mesh.
    let a = mesh_on_one_router(&content, &[OPENING_A]).pop().expect("A meshes");
    let b = mesh_on_one_router(&content, &[OPENING_B]).pop().expect("B meshes");

    assert_eq!(a.positions, b.positions, "fixture rot: the openings no longer share f32 positions");
    assert_eq!(a.indices, b.indices, "fixture rot: the openings no longer share indices");
}

/// THE REGRESSION. Meshed in sequence on one router, the second opening must
/// come back with its OWN normals, not the first's.
#[test]
fn an_f32_identical_neighbour_does_not_supply_its_normals() {
    let content = std::fs::read_to_string(FIXTURE)
        .unwrap_or_else(|e| panic!("failed to read fixture {FIXTURE}: {e}"));

    let alone = mesh_on_one_router(&content, &[OPENING_B]).pop().expect("B meshes");
    let shared = mesh_on_one_router(&content, &[OPENING_A, OPENING_B]);
    let (a, b) = (&shared[0], &shared[1]);

    assert_eq!(
        b.normals, alone.normals,
        "#{OPENING_B} came back with different normals depending on whether \
         #{OPENING_A} had been meshed on the same router first (#8276)"
    );
    assert_ne!(
        a.normals, b.normals,
        "the two openings' normals are equal after sharing a router, so one \
         was served for the other (#8276)"
    );
}
