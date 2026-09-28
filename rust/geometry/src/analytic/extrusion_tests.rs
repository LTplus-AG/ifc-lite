// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5784: authored extrusion parameters remain separate from occurrence placement.

use super::extract_analytic_extrusion;
use crate::analytic::AnalyticStatus;
use ifc_lite_core::{build_entity_index, EntityDecoder};

fn read(bytes: &[u8], id: u32) -> super::AnalyticExtrusion {
    let mut decoder = EntityDecoder::with_index(bytes, build_entity_index(bytes));
    let solid = decoder.decode_by_id(id).unwrap();
    extract_analytic_extrusion(&solid, &mut decoder)
}

#[test]
fn rectangle_extrusion_keeps_exact_profile_and_depth() {
    let bytes = include_bytes!("../../tests/fixtures/mapped_instances_synthetic.ifc");
    let extrusion = read(bytes, 12);
    assert_eq!(extrusion.status, AnalyticStatus::Complete);
    assert_eq!(extrusion.swept_area_id, Some(8));
    assert_eq!(extrusion.depth, Some(1.0));
    assert_eq!(extrusion.direction_ratios, Some([0.0, 0.0, 1.0]));
    assert_eq!(extrusion.profile.unwrap().loops[0].segments.len(), 4);
}

#[test]
fn issue_5784_serialized_source_references_keep_express_names() {
    let bytes = include_bytes!("../../tests/fixtures/mapped_instances_synthetic.ifc");
    let json = serde_json::to_value(read(bytes, 12)).unwrap();
    assert_eq!(json["SweptArea"], 8);
    assert_eq!(json["Position"], 11);
    assert_eq!(json["ExtrudedDirection"], 9);
    assert_eq!(json["Depth"], 1.0);
    assert_eq!(json["profile"]["ProfileType"], "AREA");
    assert_eq!(json["profile"]["Position"], 7);
    for alias in ["swept_area_id", "position_id", "extruded_direction_id", "depth"] {
        assert!(json.get(alias).is_none(), "unexpected extrusion alias {alias}");
    }
    assert!(json["profile"].get("position_id").is_none());
}

#[test]
fn authored_direction_ratios_and_unit_vector_are_distinct() {
    let source = String::from_utf8(include_bytes!("../../tests/fixtures/mapped_instances_synthetic.ifc").to_vec()).unwrap();
    let source = source.replace("#9=IFCDIRECTION((0.,0.,1.));", "#9=IFCDIRECTION((0.,0.,2.));");
    let extrusion = read(source.as_bytes(), 12);
    assert_eq!(extrusion.status, AnalyticStatus::Complete);
    assert_eq!(extrusion.direction_ratios, Some([0.0, 0.0, 2.0]));
    assert_eq!(extrusion.axis_unit_vector, Some([0.0, 0.0, 1.0]));
}

#[test]
fn invalid_depth_reports_unsupported_without_fabricating_depth() {
    let source = String::from_utf8(include_bytes!("../../tests/fixtures/mapped_instances_synthetic.ifc").to_vec()).unwrap();
    let source = source.replace("#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,1.0);",
        "#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,-1.0);");
    let extrusion = read(source.as_bytes(), 12);
    assert!(matches!(extrusion.status, AnalyticStatus::Unsupported(ref reason) if reason.contains("Depth")));
    assert_eq!(extrusion.depth, None);
}

#[test]
fn curve_profile_cannot_be_reported_as_a_solid_area() {
    let source = String::from_utf8(include_bytes!("../../tests/fixtures/mapped_instances_synthetic.ifc").to_vec()).unwrap();
    let source = source.replace("#8=IFCRECTANGLEPROFILEDEF(.AREA.,", "#8=IFCRECTANGLEPROFILEDEF(.CURVE.,");
    let extrusion = read(source.as_bytes(), 12);
    assert!(matches!(extrusion.status, AnalyticStatus::Unsupported(ref reason)
        if reason.contains("ProfileType CURVE")));
    assert_eq!(extrusion.profile.unwrap().profile_type.as_deref(), Some("CURVE"));
}

#[test]
fn pure_xy_extrusion_violates_valid_extrusion_direction() {
    let source = String::from_utf8(include_bytes!("../../tests/fixtures/mapped_instances_synthetic.ifc").to_vec()).unwrap();
    let source = source.replace("#9=IFCDIRECTION((0.,0.,1.));", "#9=IFCDIRECTION((1.,0.,0.));");
    let extrusion = read(source.as_bytes(), 12);
    assert!(matches!(extrusion.status, AnalyticStatus::Unsupported(ref reason)
        if reason.contains("perpendicular to local Z")));
    assert_eq!(extrusion.direction_ratios, Some([1.0, 0.0, 0.0]));
    assert_eq!(extrusion.axis_unit_vector, None);
}

#[test]
fn real_revit_extrusion_keeps_profile_hole_and_position() {
    let bytes = include_bytes!("../../tests/fixtures/issue_098_wall_W.ifc");
    let extrusion = read(bytes, 338107);
    assert_eq!(extrusion.status, AnalyticStatus::Complete);
    assert_eq!(extrusion.swept_area_id, Some(338102));
    assert_eq!(extrusion.profile.as_ref().unwrap().loops.len(), 2);
    assert!((extrusion.depth.unwrap() - 0.06).abs() < 1e-12);
    assert!(extrusion.position_matrix.is_some());
}
