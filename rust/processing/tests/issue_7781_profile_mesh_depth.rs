// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7781 / #7887: a shallow mapped sibling used to make submesh production
//! succeed while silently omitting the depth-32 leaf the drawing extracted.
//! Exercise ordinary production, including the nonempty-submesh early return.

#[path = "../../geometry/tests/support/profile_walk_model.rs"]
mod model;

use ifc_lite_core::{EntityDecoder, MAX_MAPPED_ITEM_DEPTH};
use ifc_lite_geometry::{extract_profiles_with_diagnostics, GeometryRouter};
use ifc_lite_processing::process_geometry;

fn mixed_chain(levels: u32) -> String {
    model::chain(levels)
        .replace("(#1000)", "(#2000,#1000)")
        .replace("ENDSEC;\nEND-ISO", &format!("{}ENDSEC;\nEND-ISO", model::mapped(2000, "#140")))
}

fn check(levels: u32, expected: usize, refusals: usize) {
    assert_eq!(MAX_MAPPED_ITEM_DEPTH, 32, "#7887 keeps the shared 32-map policy");
    let content = mixed_chain(levels);
    let (profiles, skipped) = extract_profiles_with_diagnostics(&content, 0);
    assert_eq!(profiles.len(), expected, "drawing: {skipped:?}");
    let mut depths: Vec<_> = profiles.iter().map(|p| p.extrusion_depth).collect();
    depths.sort_by(f32::total_cmp);
    let expected_depths = if expected == 2 { vec![1.0, 2.5] } else { vec![2.5] };
    assert_eq!(depths, expected_depths, "drawing keeps each distinct solid");
    assert_eq!(skipped.len(), refusals, "drawing refusals: {skipped:?}");
    if refusals > 0 {
        assert!(skipped[0].reason.contains("maximum depth"), "{skipped:?}");
    }

    let produced = process_geometry(&content);
    let wall_meshes: Vec<_> = produced.meshes.iter().filter(|m| m.express_id == 100).collect();
    assert_eq!(wall_meshes.len(), expected, "ordinary element production disagrees with drawing");
    let triangles: usize = wall_meshes.iter().map(|m| m.indices.len() / 3).sum();
    assert_eq!(triangles, 12 * expected, "each reachable extrusion is a closed box");
    // Distinct profile dimensions identify each solid independently of the
    // number of mesh records. Native MeshData is IFC Z-up; the WASM
    // boundary applies the viewer Y-up conversion later.
    let mut heights: Vec<_> = wall_meshes.iter().map(|m| {
        let min = m.positions.chunks_exact(3).map(|p| p[2]).fold(f32::INFINITY, f32::min);
        let max = m.positions.chunks_exact(3).map(|p| p[2]).fold(f32::NEG_INFINITY, f32::max);
        max - min
    }).collect();
    heights.sort_by(f32::total_cmp);
    let expected_heights = if expected == 2 { vec![1.0, 2.5] } else { vec![2.5] };
    assert_eq!(heights, expected_heights, "both distinct solids must survive");

    // Check the router's report separately: process_geometry consumes its
    // diagnostics. Counting output alone would miss a silently truncated walk.
    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let wall = decoder.decode_by_id(100).unwrap();
    let submeshes = router.process_element_with_submeshes(&wall, &mut decoder).unwrap();
    assert_eq!(submeshes.len(), expected, "shallow sibling must not hide a deep drop");
    let drops = router.take_unsupported_items();
    assert_eq!(drops.get("IfcMappedItem").copied().unwrap_or(0), refusals as u64, "{drops:?}");
    assert_eq!(drops.len(), usize::from(refusals > 0), "{drops:?}");
}

#[test]
fn issue_7781_shallow_plus_exact_depth_chain_meshes_every_drawn_solid() {
    check(MAX_MAPPED_ITEM_DEPTH, 2, 0);
}

#[test]
fn issue_7781_shallower_chain_is_a_positive_control() {
    check(MAX_MAPPED_ITEM_DEPTH - 1, 2, 0);
}

#[test]
fn issue_7781_map_past_the_cap_is_reported_and_shallow_sibling_survives() {
    check(MAX_MAPPED_ITEM_DEPTH + 1, 1, 1);
}

#[test]
fn issue_7887_repeated_dag_occurrences_are_not_cycles() {
    // The same child occurs twice down separate paths. Both are geometry;
    // a global visited set would silently drop the second occurrence.
    let entities = format!(
        "{}\n#160=IFCSHAPEREPRESENTATION(#13,'Body','MappedRepresentation',(#1000));\n{}{}",
        model::TARGET, model::mapped(1000, "#1003,#1003"), model::mapped(1003, "#240")
    );
    let content = model::wall("#160", &entities);
    let (profiles, skipped) = extract_profiles_with_diagnostics(&content, 0);
    assert_eq!(profiles.len(), 2);
    assert!(skipped.is_empty(), "{skipped:?}");
    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let wall = decoder.decode_by_id(100).unwrap();
    let meshes = router.process_element_with_submeshes(&wall, &mut decoder).unwrap();
    assert_eq!(meshes.len(), 2);
    assert!(meshes.sub_meshes.iter().all(|sub| sub.mesh.triangle_count() == 12));
    assert!(router.take_unsupported_items().is_empty());
}

#[test]
fn issue_7887_mapping_origin_target_and_units_match_ordinary_mesh() {
    // Each map contributes Target(10,20) * Origin(2,3), in millimetres.
    // Two levels put the unit cube at (24,46,0) mm in IFC Z-up space.
    let content = model::chain(2)
        .replace(".LENGTHUNIT.,$,.METRE.", ".LENGTHUNIT.,.MILLI.,.METRE.")
        .replace("IFCREPRESENTATIONMAP(#11,", "IFCREPRESENTATIONMAP(#92,")
        .replace("OPERATOR3D($,$,#12,", "OPERATOR3D($,$,#90,")
        .replace("ENDSEC;\nEND-ISO", "#90=IFCCARTESIANPOINT((10.,20.,0.));\n#91=IFCCARTESIANPOINT((2.,3.,0.));\n#92=IFCAXIS2PLACEMENT3D(#91,$,$);\nENDSEC;\nEND-ISO");
    let (profiles, skipped) = extract_profiles_with_diagnostics(&content, 0);
    assert!(skipped.is_empty(), "{skipped:?}");
    assert_eq!(profiles.len(), 1);
    let profile = &profiles[0];
    assert!((profile.transform[12] - 0.024).abs() < 1e-12);
    assert!((profile.transform[13]).abs() < 1e-12);
    assert!((profile.transform[14] + 0.046).abs() < 1e-12); // WebGL -Y
    assert!((profile.extrusion_depth - 0.001).abs() < 1e-9);

    let produced = process_geometry(&content);
    let meshes: Vec<_> = produced.meshes.iter().filter(|m| m.express_id == 100).collect();
    assert_eq!(meshes.len(), 1);
    assert_eq!(meshes[0].indices.len() / 3, 12);
    for (axis, lo, hi) in [(0, 0.0235, 0.0245), (1, 0.0455, 0.0465), (2, 0.0, 0.001)] {
        let min = meshes[0].positions.chunks_exact(3).map(|p| p[axis]).fold(f32::INFINITY, f32::min);
        let max = meshes[0].positions.chunks_exact(3).map(|p| p[axis]).fold(f32::NEG_INFINITY, f32::max);
        assert!((min - lo).abs() < 1e-7, "axis {axis}: min {min}");
        assert!((max - hi).abs() < 1e-7, "axis {axis}: max {max}");
    }
}
