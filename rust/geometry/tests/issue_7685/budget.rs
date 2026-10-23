// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Review of #7747 (B1): composite regions are a fan-out walk. A composite
//! that lists one sub-composite `k` times, `d` levels deep, is `k^d` areas
//! from a file of about a kilobyte, and every area becomes a solid. The
//! leaf-region work budget refuses that before doing the work, while a real
//! multi-level composite still builds every area.

use super::{assert_closed_outward, assert_volume, ifc, mesh_of, signed_volume};
use ifc_lite_core::{build_entity_index, EntityDecoder, IfcSchema};
use ifc_lite_geometry::{GeometryRouter, ProfileProcessor, TessellationQuality};
use std::fmt::Write;
use std::time::{Duration, Instant};

/// `#1` is a unit square; `#(10 + i)` lists `#(10 + i - 1)` (or the square)
/// `k` times; `#99` extrudes the outermost composite by 1.
fn fan_out(k: usize, d: usize) -> String {
    let mut data = String::from(
        "#1=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);\n\
         #2=IFCCARTESIANPOINT((0.,0.,0.));\n#3=IFCAXIS2PLACEMENT3D(#2,$,$);\n\
         #4=IFCDIRECTION((0.,0.,1.));\n",
    );
    for level in 1..=d {
        let child = if level == 1 { 1 } else { 10 + level - 1 };
        let list = vec![format!("#{child}"); k].join(",");
        writeln!(data, "#{}=IFCCOMPOSITEPROFILEDEF(.AREA.,$,({list}),$);", 10 + level).unwrap();
    }
    writeln!(data, "#99=IFCEXTRUDEDAREASOLID(#{},#3,#4,1.);", 10 + d).unwrap();
    ifc("IFC4", &data)
}

#[test]
fn b1_a_nested_composite_fan_out_is_refused_quickly() {
    // 10^6 leaf areas. Base built (and flattened) every one of them.
    let content = fan_out(10, 6);
    let index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, index);
    let started = Instant::now();
    let router = GeometryRouter::new();
    let solid = decoder.decode_by_id(99).expect("decode solid");
    let err = router
        .process_representation_item(&solid, &mut decoder)
        .expect_err("a 10^6-area composite must be refused, not built");
    assert!(err.to_string().contains("regions"), "refusal names the budget: {err}");
    // The single-profile entry point walks the same composite.
    let composite = decoder.decode_by_id(16).expect("decode composite");
    let err = ProfileProcessor::new(IfcSchema::new())
        .process(&composite, &mut decoder, TessellationQuality::Medium)
        .expect_err("process() must refuse the same fan-out");
    assert!(err.to_string().contains("regions"), "refusal names the budget: {err}");
    // Refused at the budget (4096 leaves), not after 10^6.
    assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
}

#[test]
fn b1_a_real_two_level_composite_builds_every_area() {
    // Ten disjoint unit squares, translated into ten disjoint rows: 100 areas.
    let mut data = String::from(
        "#2=IFCCARTESIANPOINT((0.,0.,0.));\n#3=IFCAXIS2PLACEMENT3D(#2,$,$);\n\
         #4=IFCDIRECTION((0.,0.,1.));\n",
    );
    let mut squares = Vec::new();
    for j in 0..10 {
        let id = 100 + 2 * j;
        writeln!(data, "#{id}=IFCCARTESIANPOINT(({}.,0.));", 2 * j).unwrap();
        writeln!(data, "#{}=IFCAXIS2PLACEMENT2D(#{id},$);", id + 1).unwrap();
        writeln!(data, "#{}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#{},1.,1.);", 200 + j, id + 1).unwrap();
        squares.push(format!("#{}", 200 + j));
    }
    writeln!(data, "#300=IFCCOMPOSITEPROFILEDEF(.AREA.,$,({}),$);", squares.join(",")).unwrap();
    let mut rows = Vec::new();
    for i in 0..10 {
        writeln!(data, "#{}=IFCCARTESIANPOINT((0.,{}.));", 400 + i, 3 * i).unwrap();
        writeln!(data, "#{}=IFCCARTESIANTRANSFORMATIONOPERATOR2D($,$,#{},$);", 500 + i, 400 + i).unwrap();
        writeln!(data, "#{}=IFCDERIVEDPROFILEDEF(.AREA.,$,#300,#{},$);", 600 + i, 500 + i).unwrap();
        rows.push(format!("#{}", 600 + i));
    }
    writeln!(data, "#700=IFCCOMPOSITEPROFILEDEF(.AREA.,$,({}),$);", rows.join(",")).unwrap();
    data.push_str("#701=IFCEXTRUDEDAREASOLID(#700,#3,#4,1.);\n");
    let mesh = mesh_of(&ifc("IFC4", &data), 701);
    assert_volume("#701 100 unit cubes", signed_volume(&mesh), 100.0, 1e-4);
    assert_closed_outward("#701", &mesh, 100);
}

// --- Round 3 (B1-bis): the budget bounds WORK per SOLID, and the builders'
// multipliers are capped before the mesh is built. ---------------------------

/// A hollow circle (72 ring points) 5 m off the Y axis, nested `k` wide and
/// `d` deep as `#101..`, plus the shared placement entities.
fn hollow_fan(k: usize, d: usize) -> (String, u32) {
    let mut data = String::from(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCDIRECTION((0.,0.,1.));\n\
         #6=IFCAXIS2PLACEMENT3D(#1,$,$);\n#20=IFCCARTESIANPOINT((5.,0.));\n\
         #21=IFCAXIS2PLACEMENT2D(#20,$);\n#22=IFCCIRCLEHOLLOWPROFILEDEF(.AREA.,$,#21,1.,0.25);\n\
         #30=IFCDIRECTION((0.,1.,0.));\n#31=IFCAXIS1PLACEMENT(#1,#30);\n",
    );
    let mut prev = 22;
    for level in 0..d {
        let id = 101 + level as u32;
        let list = vec![format!("#{prev}"); k].join(",");
        writeln!(data, "#{id}=IFCCOMPOSITEPROFILEDEF(.AREA.,$,({list}),$);").unwrap();
        prev = id;
    }
    (data, prev)
}

/// `stations` copies of `section` lofted along a straight 20 m IFC4x1 directrix.
fn sectioned(data: &mut String, id: u32, section: u32, stations: usize) {
    data.push_str("#40=IFCCARTESIANPOINT((0.,0.,0.));\n#41=IFCCARTESIANPOINT((0.,20.,0.));\n#42=IFCPOLYLINE((#40,#41));\n");
    let positions: Vec<String> = (0..stations)
        .map(|i| {
            let pid = 1000 + i;
            let station = 20.0 * i as f64 / (stations - 1) as f64;
            writeln!(data, "#{pid}=IFCDISTANCEEXPRESSION({station:?},0.,0.,0.,.T.);").unwrap();
            format!("#{pid}")
        })
        .collect();
    let sections = vec![format!("#{section}"); stations].join(",");
    writeln!(data, "#{id}=IFCSECTIONEDSOLIDHORIZONTAL(#42,({sections}),({}),.T.);", positions.join(",")).unwrap();
}

fn refused_fast(content: &str, id: u32, what: &str) {
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index);
    let started = Instant::now();
    let entity = decoder.decode_by_id(id).expect("decode");
    let result = GeometryRouter::new().process_representation_item(&entity, &mut decoder);
    let Err(err) = result else {
        panic!("{what}: must be refused, built {} triangles", result.map(|m| m.indices.len() / 3).unwrap_or(0));
    };
    // The refusal is the budget or the output cap, not an unrelated failure.
    let msg = err.to_string();
    assert!(msg.contains("regions") || msg.contains("points") || msg.contains("ring vertices"), "{what}: {msg}");
    assert!(started.elapsed() < Duration::from_secs(5), "{what}: took {:?}", started.elapsed());
}

#[test]
fn b1_bis_a_revolved_fan_out_is_refused_before_it_is_built() {
    // 8^4 = 4096 hollow circles (the region cap exactly), 2π: 14 M triangles
    // and 2.8 GB on 9c8889dbf3.
    let (mut data, top) = hollow_fan(8, 4);
    writeln!(data, "#200=IFCREVOLVEDAREASOLID(#{top},#6,#31,6.283185307179586);").unwrap();
    refused_fast(&ifc("IFC4", &data), 200, "revolved 2π");
}

#[test]
fn b1_bis_sectioned_stations_share_one_budget() {
    // The same composite at 200 stations: 200 budgets on 9c8889dbf3 (an
    // allocation abort). One budget per solid now.
    let (mut data, top) = hollow_fan(8, 4);
    sectioned(&mut data, 200, top, 200);
    refused_fast(&ifc("IFC4X3_ADD2", &data), 200, "sectioned ×200");
}

#[test]
fn b1_bis_an_item_listed_fifty_times_is_refused_fifty_times_fast() {
    let (mut data, top) = hollow_fan(8, 4);
    writeln!(data, "#200=IFCREVOLVEDAREASOLID(#{top},#6,#31,6.283185307179586);").unwrap();
    data.push_str("#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#6,$);\n#10=IFCLOCALPLACEMENT($,#6);\n");
    writeln!(data, "#300=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',({}));", vec!["#200"; 50].join(",")).unwrap();
    data.push_str("#301=IFCPRODUCTDEFINITIONSHAPE($,$,(#300));\n#302=IFCBUILDINGELEMENTPROXY('1kTvXnbbzCWw8lcMd1dR4o',$,'p',$,$,#10,#301,$,$);\n");
    let content = ifc("IFC4", &data);
    let index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, index);
    let started = Instant::now();
    let proxy = decoder.decode_by_id(302).expect("decode proxy");
    let built = GeometryRouter::new()
        .process_element(&proxy, &mut decoder)
        .map(|m| m.indices.len() / 3)
        .unwrap_or(0);
    assert_eq!(built, 0, "every copy of the refused item is dropped");
    assert!(started.elapsed() < Duration::from_secs(10), "took {:?}", started.elapsed());
}

#[test]
fn b1_bis_the_budget_is_armed_per_solid() {
    // 512 hollow circles = 36 864 ring points: more than half the per-solid
    // point budget, so a budget that leaked across solids refuses the second.
    let (mut data, top) = hollow_fan(8, 3);
    writeln!(data, "#200=IFCEXTRUDEDAREASOLID(#{top},#6,#2,1.);\n#201=IFCEXTRUDEDAREASOLID(#{top},#6,#2,2.);").unwrap();
    let content = ifc("IFC4", &data);
    let index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, index);
    let router = GeometryRouter::new();
    for id in [200, 201] {
        let entity = decoder.decode_by_id(id).expect("decode");
        let mesh = router.process_representation_item(&entity, &mut decoder);
        assert!(mesh.is_ok_and(|m| !m.indices.is_empty()), "#{id} must build");
    }
}

/// Hollow circle area (r = 1, wall 0.25).
const TUBE: f64 = std::f64::consts::PI * (1.0 - 0.75 * 0.75);

#[test]
fn b1_bis_a_realistic_revolved_composite_still_builds() {
    // Three hollow circles at r = 4, 8, 12 revolved a quarter turn.
    let mut data = String::from(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));\n#6=IFCAXIS2PLACEMENT3D(#1,$,$);\n\
         #30=IFCDIRECTION((0.,1.,0.));\n#31=IFCAXIS1PLACEMENT(#1,#30);\n",
    );
    for (i, r) in [4, 8, 12].iter().enumerate() {
        let id = 50 + 3 * i;
        writeln!(data, "#{id}=IFCCARTESIANPOINT(({r}.,0.));\n#{}=IFCAXIS2PLACEMENT2D(#{id},$);", id + 1).unwrap();
        writeln!(data, "#{}=IFCCIRCLEHOLLOWPROFILEDEF(.AREA.,$,#{},1.,0.25);", id + 2, id + 1).unwrap();
    }
    data.push_str("#70=IFCCOMPOSITEPROFILEDEF(.AREA.,$,(#52,#55,#58),$);\n#71=IFCREVOLVEDAREASOLID(#70,#6,#31,1.5707963267949);\n");
    let mesh = mesh_of(&ifc("IFC4", &data), 71);
    let expected = TUBE * (4.0 + 8.0 + 12.0) * std::f64::consts::FRAC_PI_2;
    assert_volume("#71 three quarter-turn tubes", signed_volume(&mesh), expected, 0.03);
    assert_closed_outward("#71", &mesh, 3);
}

#[test]
fn b1_bis_a_realistic_sectioned_composite_still_builds() {
    // Two hollow circles lofted over 30 stations along 20 m.
    let mut data = String::from(
        "#20=IFCCARTESIANPOINT((-3.,0.5));\n#21=IFCAXIS2PLACEMENT2D(#20,$);\n\
         #22=IFCCIRCLEHOLLOWPROFILEDEF(.AREA.,$,#21,1.,0.25);\n#23=IFCCARTESIANPOINT((3.,0.5));\n\
         #24=IFCAXIS2PLACEMENT2D(#23,$);\n#25=IFCCIRCLEHOLLOWPROFILEDEF(.AREA.,$,#24,1.,0.25);\n\
         #26=IFCCOMPOSITEPROFILEDEF(.AREA.,$,(#22,#25),$);\n",
    );
    sectioned(&mut data, 200, 26, 30);
    let mesh = mesh_of(&ifc("IFC4X3_ADD2", &data), 200);
    assert_volume("#200 two tubes × 20 m", signed_volume(&mesh), 2.0 * TUBE * 20.0, 0.02);
    assert_closed_outward("#200", &mesh, 2);
}

// --- Round 4 (B1-ter): a plain profile's holes are rings base never swept in
// a revolve or loft, so they are capped too. --------------------------------

/// An `IfcArbitraryProfileDefWithVoids` at (6, 0): an outer circle r = 2 and
/// one r = 0.5 circle listed `voids` times as its voids (a few bytes each).
fn repeated_voids(voids: usize) -> String {
    let mut data = String::from(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));\n#6=IFCAXIS2PLACEMENT3D(#1,$,$);\n\
         #20=IFCCARTESIANPOINT((6.,0.));\n#21=IFCAXIS2PLACEMENT2D(#20,$);\n\
         #22=IFCCIRCLE(#21,2.);\n#23=IFCCIRCLE(#21,0.5);\n\
         #30=IFCDIRECTION((0.,1.,0.));\n#31=IFCAXIS1PLACEMENT(#1,#30);\n",
    );
    writeln!(data, "#24=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#22,({}));", vec!["#23"; voids].join(",")).unwrap();
    data
}

#[test]
fn b1_ter_a_revolve_of_repeated_voids_is_refused_fast() {
    // 20 000 voids, 2π: 19.2 M triangles and 3.2 GB on 8ac564904d.
    let mut data = repeated_voids(20_000);
    data.push_str("#200=IFCREVOLVEDAREASOLID(#24,#6,#31,6.283185307179586);\n");
    refused_fast(&ifc("IFC4", &data), 200, "revolved 20 000 voids");
}

#[test]
fn b1_ter_a_loft_of_repeated_voids_is_refused_before_its_caps_are_triangulated() {
    // 2 000 voids at 20 stations: over 900 s on 8ac564904d.
    let mut data = repeated_voids(2_000);
    sectioned(&mut data, 200, 24, 20);
    refused_fast(&ifc("IFC4X3_ADD2", &data), 200, "sectioned 2 000 voids × 20");
}
