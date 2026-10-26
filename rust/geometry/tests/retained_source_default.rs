// SPDX-License-Identifier: MPL-2.0
//! #7955: the budget feature must preserve existing native source capture.
#![cfg(not(target_arch = "wasm32"))]
use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::analytic::{extract_analytic_extrusion, with_source_capture};

#[test]
fn issue_7955_default_native_capture_preserves_authored_source_records() {
    // Integration test: geometry is compiled without cfg(test), so the normal
    // feature-off library is exercised as well as the opt-in configuration.
    let mut decoder = EntityDecoder::new("#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCDIRECTION((0.,0.,1.));#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);#5=IFCEXTRUDEDAREASOLID(#4,#2,#3,3.);");
    let solid = decoder.decode_by_id(5).unwrap();
    let plain = extract_analytic_extrusion(&solid, &mut decoder);
    assert!(plain.source.is_none(), "capture remains explicit");
    let captured = with_source_capture(|| extract_analytic_extrusion(&solid, &mut decoder));
    let source = captured
        .source
        .expect("native capture works with retained-runtime off");
    assert_eq!(source.root_entity_id, 5);
    assert_eq!(source.records[&5].ifc_type_name, "IfcExtrudedAreaSolid");
    assert!(
        source.records.contains_key(&2),
        "authored placement is retained"
    );
    assert_eq!(plain.depth, captured.depth);
    assert_eq!(plain.direction_ratios, captured.direction_ratios);
}
