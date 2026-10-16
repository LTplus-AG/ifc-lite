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
