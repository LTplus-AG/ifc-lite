// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Sub-mesh void matrix (split out of the former `voids_matrix_test.rs`;
//! shared fixtures live in `voids_common`).
//!
//! [`submesh_void_matrix`] asserts that
//! `process_element_with_submeshes_and_voids` preserves per-item geometry
//! IDs (per-layer `IfcStyledItem` colors) while still cutting openings
//! through every material layer. Preserves every input configuration and
//! assertion from the former `submesh_voids_test.rs`.

mod voids_common;

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{GeometryRouter, SubMeshCollection};
use rustc_hash::FxHashMap;
use voids_common::fixtures::multi_layer_wall_with_opening_ifc;

struct SubmeshCase {
    name: &'static str,
    /// Openings to register for wall #100 (empty = no voids apply).
    opening_ids: &'static [u32],
    check: fn(name: &str, uncut: &SubMeshCollection, cut: &SubMeshCollection),
}

/// Former `submeshes_with_voids_preserves_one_mesh_per_extrusion_item` +
/// `submeshes_with_voids_actually_removes_triangles`.
fn check_submesh_ids_preserved_and_triangles_removed(
    name: &str,
    uncut: &SubMeshCollection,
    cut: &SubMeshCollection,
) {
    // All three extrusion items must survive — the opening only removes a
    // local block, not an entire layer.
    assert_eq!(
        cut.sub_meshes.len(),
        3,
        "[{name}] expected 3 sub-meshes (one per extrusion layer), got {}",
        cut.sub_meshes.len()
    );

    // Each sub-mesh must carry the original IfcExtrudedAreaSolid express ID
    // so that callers can look up the per-item IfcStyledItem color. This is
    // the entire point of the per-sub-mesh void path: layer colors survive.
    let mut ids: Vec<u32> = cut.sub_meshes.iter().map(|s| s.geometry_id).collect();
    ids.sort();
    assert_eq!(
        ids,
        vec![40, 60, 80],
        "[{name}] sub-mesh geometry_ids must match extrusion IDs"
    );

    for sub in &cut.sub_meshes {
        assert!(
            !sub.mesh.is_empty(),
            "[{name}] sub-mesh #{} should not be empty after void subtraction",
            sub.geometry_id
        );
    }

    // At least one layer must lose triangles to the opening — otherwise CSG
    // never ran, which would indicate the void path silently no-ops.
    let uncut_tris: usize = uncut
        .sub_meshes
        .iter()
        .map(|s| s.mesh.triangle_count())
        .sum();
    let cut_tris: usize = cut.sub_meshes.iter().map(|s| s.mesh.triangle_count()).sum();
    assert!(
        cut_tris != uncut_tris,
        "[{name}] void subtraction should change triangle count: uncut={uncut_tris} cut={cut_tris}"
    );
}

/// Former `submeshes_with_voids_returns_empty_without_opening_ids`.
fn check_submesh_empty_without_openings(
    name: &str,
    _uncut: &SubMeshCollection,
    cut: &SubMeshCollection,
) {
    // No openings → return empty so the caller can fall back to the
    // void-less sub-mesh path (or merged mesh path) without duplicating work.
    assert!(
        cut.is_empty(),
        "[{name}] expected empty collection when no openings apply"
    );
}

#[test]
fn submesh_void_matrix() {
    let cases = [
        SubmeshCase {
            name: "opening_through_all_layers",
            opening_ids: &[200],
            check: check_submesh_ids_preserved_and_triangles_removed,
        },
        SubmeshCase {
            name: "no_openings_registered",
            opening_ids: &[],
            check: check_submesh_empty_without_openings,
        },
    ];

    for case in &cases {
        let content = multi_layer_wall_with_opening_ifc();
        let mut decoder = EntityDecoder::new(&content);
        let router = GeometryRouter::with_units(&content, &mut decoder);

        let wall = decoder.decode_by_id(100).expect("decode wall");
        let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
        if !case.opening_ids.is_empty() {
            void_index.insert(100, case.opening_ids.to_vec());
        }

        let uncut = router
            .process_element_with_submeshes(&wall, &mut decoder)
            .expect("submesh uncut");
        let cut = router
            .process_element_with_submeshes_and_voids(&wall, &mut decoder, &void_index)
            .expect("submesh voids");

        (case.check)(case.name, &uncut, &cut);
    }
}
