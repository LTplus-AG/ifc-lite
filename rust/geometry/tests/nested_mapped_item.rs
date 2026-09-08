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

    // The reachable geometry is exact, not merely bounded: the cube of map A at
    // the occurrence, plus the one map-A cube the B->A hop reaches before the
    // visited set stops it, each hop shifting +100 mm in X. Two boxes, 12
    // triangles each, X 0..1.2 m. An upper bound alone would pass on an EMPTY
    // mesh — `bounds` returns NEG_INFINITY for max — and on any truncation
    // between 0 and the bound.
    assert_eq!(
        mesh.indices.len(),
        72,
        "cyclic chain produced {} indices, expected two boxes (72)",
        mesh.indices.len()
    );
    let (min, max) = bounds(&mesh);
    assert!((min[0] - 0.0).abs() < 1e-3, "min X {} != 0", min[0]);
    assert!(
        (max[0] - 1.2).abs() < 1e-3,
        "cyclic chain X extent is {min:?}..{max:?}, expected max X = 1.2 m"
    );
    assert!((max[1] - 1.0).abs() < 1e-3, "max Y {} != 1", max[1]);
    assert!((max[2] - 1.0).abs() < 1e-3, "max Z {} != 1", max[2]);
}

/// A straight chain of `IfcRepresentationMap`s, `n` links long. Link *i* holds
/// its own 1000 mm cube plus (unless it is the last) a nested `IfcMappedItem` on
/// link *i+1*, shifted +2000 mm in X, so a full walk from link *i* yields
/// `n - i + 1` cubes marching along X.
///
/// Two occurrences enter the chain at different depths: `#44` at link 1, `#49`
/// at link `entry_b`. Longer than `MAX_MAPPED_ITEM_DEPTH` (32), the walk from
/// `#44` runs out of depth part-way down, so the sources it meshed near the cap
/// are SHORT — which is the point.
fn deep_chain_model(n: usize, entry_b: usize) -> String {
    let map_id = |i: usize| 100 + i * 10;
    let rep_id = |i: usize| 100 + i * 10 + 1;
    let nested_id = |i: usize| 100 + i * 10 + 2;

    let mut s = String::from(
        "ISO-10303-21;\n\
         HEADER;\n\
         FILE_DESCRIPTION((''),'2;1');\n\
         FILE_NAME('deep_chain.ifc','2026-08-04T00:00:00',(''),(''),'ifc-lite','ifc-lite','');\n\
         FILE_SCHEMA(('IFC4'));\n\
         ENDSEC;\n\
         DATA;\n\
         #1=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #2=IFCAXIS2PLACEMENT3D(#1,$,$);\n\
         #3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);\n\
         #4=IFCUNITASSIGNMENT((#3));\n\
         #5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#2,$);\n\
         #6=IFCCARTESIANPOINT((0.,0.));\n\
         #7=IFCAXIS2PLACEMENT2D(#6,$);\n\
         #8=IFCRECTANGLEPROFILEDEF(.AREA.,'CUBE',#7,1000.,1000.);\n\
         #9=IFCDIRECTION((0.,0.,1.));\n\
         #10=IFCCARTESIANPOINT((500.,500.,0.));\n\
         #11=IFCAXIS2PLACEMENT3D(#10,$,$);\n\
         #12=IFCEXTRUDEDAREASOLID(#8,#11,#9,1000.);\n\
         #13=IFCCARTESIANPOINT((2000.,0.,0.));\n\
         #14=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#13,1.,$);\n\
         #22=IFCLOCALPLACEMENT($,#2);\n\
         #23=IFCSITE('0SITE56789ABCDEFGHIJKL',$,'Site',$,$,#22,$,$,.ELEMENT.,$,$,$,$,$);\n\
         #24=IFCLOCALPLACEMENT(#22,#2);\n\
         #25=IFCBUILDING('0BLDG56789ABCDEFGHIJKL',$,'Building',$,$,#24,$,$,.ELEMENT.,$,$,$);\n\
         #26=IFCLOCALPLACEMENT(#24,#2);\n\
         #27=IFCBUILDINGSTOREY('0STRY56789ABCDEFGHIJKL',$,'Storey',$,$,#26,$,$,.ELEMENT.,0.);\n\
         #28=IFCPROJECT('0PRJ456789ABCDEFGHIJKL',$,'Proj',$,$,$,$,(#5),#4);\n",
    );

    for i in 1..=n {
        if i < n {
            s.push_str(&format!(
                "#{}=IFCMAPPEDITEM(#{},#14);\n",
                nested_id(i),
                map_id(i + 1)
            ));
            s.push_str(&format!(
                "#{}=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#12,#{}));\n",
                rep_id(i),
                nested_id(i)
            ));
        } else {
            s.push_str(&format!(
                "#{}=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#12));\n",
                rep_id(i)
            ));
        }
        s.push_str(&format!(
            "#{}=IFCREPRESENTATIONMAP(#2,#{});\n",
            map_id(i),
            rep_id(i)
        ));
    }

    s.push_str(&format!(
        "#40=IFCMAPPEDITEM(#{},$);\n\
         #41=IFCSHAPEREPRESENTATION(#5,'Body','MappedRepresentation',(#40));\n\
         #42=IFCPRODUCTDEFINITIONSHAPE($,$,(#41));\n\
         #43=IFCLOCALPLACEMENT(#26,#2);\n\
         #44=IFCBUILDINGELEMENTPROXY('0PRXA56789ABCDEFGHIJKL',$,'ChainTop',$,$,#43,#42,$,$);\n\
         #45=IFCMAPPEDITEM(#{},$);\n\
         #46=IFCSHAPEREPRESENTATION(#5,'Body','MappedRepresentation',(#45));\n\
         #47=IFCPRODUCTDEFINITIONSHAPE($,$,(#46));\n\
         #48=IFCLOCALPLACEMENT(#26,#2);\n\
         #49=IFCBUILDINGELEMENTPROXY('0PRXB56789ABCDEFGHIJKL',$,'ChainMid',$,$,#48,#47,$,$);\n\
         #36=IFCRELAGGREGATES('0REL156789ABCDEFGHIJKL',$,$,$,#28,(#23));\n\
         #37=IFCRELAGGREGATES('0REL256789ABCDEFGHIJKL',$,$,$,#23,(#25));\n\
         #38=IFCRELAGGREGATES('0REL356789ABCDEFGHIJKL',$,$,$,#25,(#27));\n\
         #39=IFCRELCONTAINEDINSPATIALSTRUCTURE('0REL456789ABCDEFGHIJKL',$,$,$,(#44,#49),#27);\n\
         ENDSEC;\n\
         END-ISO-10303-21;\n",
        map_id(1),
        map_id(entry_b)
    ));
    s
}

/// The shared mapped-item cache is keyed on the `IfcRepresentationMap` id alone,
/// but with the recursion this fix adds, a source's mesh also depends on the
/// DEPTH at which the walk reached it. A source first met near
/// `MAX_MAPPED_ITEM_DEPTH` loses everything below the cap; caching that
/// model-wide would serve the short mesh to a later occurrence that entered the
/// chain at depth 0 and would otherwise walk the rest.
///
/// The #1257 guard cannot catch this: a depth-truncated mesh is non-empty and
/// trips no budget.
#[test]
fn depth_truncated_source_is_not_shared_cached() {
    // Chain of 40; `#49` enters at link 32 — the last link the walk from `#44`
    // reaches, and the one whose own nested item is refused by the depth cap.
    let content = deep_chain_model(40, 32);
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let shared = GeometryRouter::new_mapped_item_cache();

    // A fresh router per element, as the production per-element path does, with
    // the model-wide cache shared between them.
    let mut router_a = GeometryRouter::with_units(&content, &mut decoder);
    router_a.enable_shared_mapped_item_cache(shared.clone());
    let proxy_a = decoder.decode_by_id(44).expect("decode #44");
    let mesh_a = router_a
        .process_element(&proxy_a, &mut decoder)
        .expect("process #44");
    // 32 links reached (depth 0..=31), each a cube 2 m apart: X 0..63 m.
    assert_eq!(mesh_a.indices.len(), 32 * 36, "chain-top link count");

    let mut router_b = GeometryRouter::with_units(&content, &mut decoder);
    router_b.enable_shared_mapped_item_cache(shared.clone());
    let proxy_b = decoder.decode_by_id(49).expect("decode #49");
    let mesh_b = router_b
        .process_element(&proxy_b, &mut decoder)
        .expect("process #49");

    // Entering at link 32 with a fresh depth budget reaches links 32..=40.
    let (min, max) = bounds(&mesh_b);
    assert_eq!(
        mesh_b.indices.len(),
        9 * 36,
        "#49 got {} indices, expected 9 links — a truncated source was served \
         from the shared cache",
        mesh_b.indices.len()
    );
    assert!((min[0] - 0.0).abs() < 1e-3, "min X {} != 0", min[0]);
    assert!(
        (max[0] - 17.0).abs() < 1e-3,
        "#49 X extent is {min:?}..{max:?}, expected max X = 17 m"
    );

    // Nothing truncated was cached: only the links whose walk ran to the end of
    // the chain (32..=40) are in there, contributed by `#49`.
    let cached: Vec<u32> = {
        let guard = shared.lock().unwrap_or_else(|e| e.into_inner());
        let mut ids: Vec<u32> = guard.keys().copied().collect();
        ids.sort_unstable();
        ids
    };
    let expected: Vec<u32> = (32..=40).map(|i| 100 + i * 10).collect();
    assert_eq!(cached, expected, "shared cache holds a truncated source");
}

/// The negative half of `depth_truncated_source_is_not_shared_cached`: an
/// ordinary, fully-walked nested source must STILL be cached model-wide. A guard
/// that stopped caching everything would satisfy the test above and quietly
/// destroy the cache.
#[test]
fn fully_walked_source_is_still_shared_cached() {
    let content = read_fixture("nested_mapped_item.ifc");
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let shared = GeometryRouter::new_mapped_item_cache();
    let mut router = GeometryRouter::with_units(&content, &mut decoder);
    router.enable_shared_mapped_item_cache(shared.clone());

    let proxy = decoder.decode_by_id(35).expect("decode #35 proxy");
    let mesh = router
        .process_element(&proxy, &mut decoder)
        .expect("process the proxy");
    assert_eq!(mesh.indices.len(), 72, "expected two boxes worth of triangles");

    // Both the outer map `#21` and the nested `#14` it pulls in.
    let cached: Vec<u32> = {
        let guard = shared.lock().unwrap_or_else(|e| e.into_inner());
        let mut ids: Vec<u32> = guard.keys().copied().collect();
        ids.sort_unstable();
        ids
    };
    assert_eq!(cached, vec![14, 21], "clean nested sources must stay cached");
}
