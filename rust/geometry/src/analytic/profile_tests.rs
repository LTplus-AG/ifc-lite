// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5784: exact profile geometry from IFC sources, never drawing polygons.

use super::{extract_analytic_profile, ProfileLoopKind};
use crate::analytic::{AnalyticCurveSegment, AnalyticStatus};
use ifc_lite_core::{build_entity_index, EntityDecoder};

fn read(bytes: &[u8], id: u32) -> super::AnalyticProfile {
    let mut decoder = EntityDecoder::with_index(bytes, build_entity_index(bytes));
    let source = decoder.decode_by_id(id).unwrap();
    extract_analytic_profile(&source, &mut decoder)
}

#[test]
fn rectangle_uses_four_exact_centered_edges_and_keeps_position_separate() {
    let bytes = include_bytes!("../../tests/fixtures/mapped_instances_synthetic.ifc");
    let profile = read(bytes, 8);
    assert_eq!(profile.status, AnalyticStatus::Complete);
    assert_eq!(profile.ifc_type_name, "IfcRectangleProfileDef");
    assert_eq!(profile.profile_type.as_deref(), Some("AREA"));
    assert_eq!(profile.position_id, Some(7));
    assert_eq!(profile.loops.len(), 1);
    assert_eq!(profile.loops[0].kind, ProfileLoopKind::Outer);
    assert_eq!(profile.loops[0].signed_area, 1.0);
    assert_eq!(profile.loops[0].perimeter, 4.0);
    assert_eq!(profile.loops[0].segments.len(), 4);
    assert_eq!(profile.loops[0].segments[0], AnalyticCurveSegment::Line {
        start: [-0.5, -0.5, 0.0], end: [0.5, -0.5, 0.0],
    });
}

#[test]
fn circle_is_one_exact_full_arc_with_unsampled_area() {
    let bytes = include_bytes!("../../tests/fixtures/issue_1985_scaled_kinds.ifc");
    let profile = read(bytes, 8);
    assert_eq!(profile.status, AnalyticStatus::Complete);
    assert_eq!(profile.loops.len(), 1);
    assert_eq!(profile.loops[0].segments.len(), 1);
    assert!(matches!(profile.loops[0].segments[0], AnalyticCurveSegment::Arc { .. }));
    assert!((profile.loops[0].signed_area - std::f64::consts::PI * 0.05_f64.powi(2)).abs() < 1e-14);
    assert!((profile.loops[0].perimeter - std::f64::consts::TAU * 0.05).abs() < 1e-14);
}

#[test]
fn real_revit_profile_preserves_outer_and_inner_winding() {
    let bytes = include_bytes!("../../tests/fixtures/issue_098_wall_W.ifc");
    let profile = read(bytes, 338102);
    assert_eq!(profile.status, AnalyticStatus::Complete);
    assert_eq!(profile.loops.len(), 2);
    assert_eq!(profile.loops[0].kind, ProfileLoopKind::Outer);
    assert_eq!(profile.loops[1].kind, ProfileLoopKind::Inner);
    assert!(profile.loops[0].signed_area > 0.0);
    assert!(profile.loops[1].signed_area < 0.0);
    assert!((profile.loops[0].signed_area - 2.0).abs() < 1e-10);
}

#[test]
fn malformed_circle_is_unsupported_with_no_partial_loop() {
    let source = String::from_utf8(include_bytes!("../../tests/fixtures/issue_1985_scaled_kinds.ifc").to_vec()).unwrap();
    let broken = source.replace("#8=IFCCIRCLEPROFILEDEF(.AREA.,'P',#7,0.05);",
        "#8=IFCCIRCLEPROFILEDEF(.AREA.,'P',#7,-0.05);");
    let profile = read(broken.as_bytes(), 8);
    assert!(matches!(profile.status, AnalyticStatus::Unsupported(ref reason) if reason.contains("Radius")));
    assert!(profile.loops.is_empty());
}

#[test]
fn indexed_arc_and_line_form_an_exact_closed_semicircle() {
    let source = String::from_utf8(include_bytes!("../../tests/fixtures/mapped_instances_synthetic.ifc").to_vec()).unwrap();
    let source = source.replace("ENDSEC;\nEND-ISO-10303-21;",
        "#100=IFCCARTESIANPOINTLIST2D(((1.,0.),(0.,1.),(-1.,0.)));\n#101=IFCINDEXEDPOLYCURVE(#100,(IFCARCINDEX((1,2,3)),IFCLINEINDEX((3,1))),.F.);\n#102=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#101);\nENDSEC;\nEND-ISO-10303-21;");
    let profile = read(source.as_bytes(), 102);
    assert_eq!(profile.status, AnalyticStatus::Complete);
    assert_eq!(profile.loops[0].segments.len(), 2);
    assert!(matches!(profile.loops[0].segments[0], AnalyticCurveSegment::Arc { sweep_angle, .. }
        if sweep_angle > 0.0));
    assert!((profile.loops[0].signed_area - std::f64::consts::FRAC_PI_2).abs() < 1e-10);
    assert!((profile.loops[0].perimeter - (std::f64::consts::PI + 2.0)).abs() < 1e-10);
}
