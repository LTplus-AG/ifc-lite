// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! An `IfcMappedItem` whose mapped representation contains ANOTHER
//! `IfcMappedItem` must contribute its geometry.
//!
//! `process_mapped_item_cached` used to `continue` past every nested mapped
//! item as a stack-overflow guard, silently dropping the nested geometry. Its
//! sibling `collect_submeshes_from_item_inner` has always recursed, bounded by
//! `MAX_MAPPED_ITEM_DEPTH` plus a per-walk visited set — this pins the cached
//! path to the same behaviour, including termination on a cyclic chain.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::{GeometryRouter, Mesh};

fn read_fixture(name: &str) -> String {
    let path = format!("tests/fixtures/{name}");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read fixture {path}: {e}"))
}

fn bounds(mesh: &Mesh) -> ([f32; 3], [f32; 3]) {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for chunk in mesh.positions.chunks_exact(3) {
        for axis in 0..3 {
            min[axis] = min[axis].min(chunk[axis]);
            max[axis] = max[axis].max(chunk[axis]);
        }
    }
    (min, max)
}

/// `#35 IfcBuildingElementProxy` maps `#21`, whose representation holds its own
/// 1 m cube AND a nested mapped item on `#14` (2x scale, +10 m in X). The
/// occurrence's own MappingTarget lifts the pair +5 m in Y. File units are
/// millimetres; the router returns metres.
///
/// Expected world extent: X 0..12 m, Y 5..7 m, Z 0..2 m. Dropping the nested
/// item leaves only the outer cube, X 0..1 m.
#[test]
fn nested_mapped_item_contributes_its_geometry() {
    let content = read_fixture("nested_mapped_item.ifc");
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let proxy = decoder.decode_by_id(35).expect("decode #35 proxy");
    assert_eq!(proxy.ifc_type, IfcType::IfcBuildingElementProxy);

    let mesh = router
        .process_element(&proxy, &mut decoder)
        .expect("process the proxy");

    let (min, max) = bounds(&mesh);
    assert!(
        (max[0] - 12.0).abs() < 1e-3,
        "nested mapped item dropped: X extent is {min:?}..{max:?}, expected max X = 12 m"
    );
    assert!((min[0] - 0.0).abs() < 1e-3, "min X {} != 0", min[0]);
    assert!((min[1] - 5.0).abs() < 1e-3, "min Y {} != 5", min[1]);
    assert!((max[1] - 7.0).abs() < 1e-3, "max Y {} != 7", max[1]);
    assert!((max[2] - 2.0).abs() < 1e-3, "max Z {} != 2", max[2]);

    // Two boxes, 12 triangles each.
    assert_eq!(mesh.indices.len(), 72, "expected two boxes worth of triangles");
}

/// Map A embeds a mapped item on map B, which embeds one back on map A. The
/// walk must terminate (visited set + depth cap) and still return the geometry
/// it legitimately reached, rather than recursing until the stack blows.
#[test]
fn cyclic_mapped_item_chain_terminates() {
    let content = read_fixture("nested_mapped_item_cycle.ifc");
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let proxy = decoder.decode_by_id(35).expect("decode #35 proxy");

    // Bounded work, on a bounded stack: a runaway recursion here overflows
    // rather than failing, so reaching the assertion at all is the result.
    let mesh = router
        .process_element(&proxy, &mut decoder)
        .expect("process the cyclic proxy");

    let (_min, max) = bounds(&mesh);
    assert!(
        mesh.indices.len() < 1000,
        "cyclic chain produced {} indices — the depth guard is not bounding the walk",
        mesh.indices.len()
    );
    assert!(
        max[0] < 100.0,
        "cyclic chain accumulated an implausible X extent of {} m",
        max[0]
    );
}
