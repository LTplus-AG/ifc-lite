// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression tests for the 2D symbolic path's reading of a conic's
//! (`IfcCircle` / `IfcEllipse`) `Position`, pinned by the September 2026
//! Rust review of `processing/symbolic` (findings G1, G2, G5, G6: "the 2D
//! symbolic path reads curve inputs with a different rule than its sibling,
//! or fabricates a value where the input is absent").
//!
//! Every assertion is on an emitted coordinate or elevation, never on a
//! flag, so a fixture that shares the defect's blind spot cannot pass it.

use ifc_lite_processing::extract_symbolic_data;

/// One `IfcAnnotation` at the world origin whose single representation item
/// is `#60`. `items` supplies `#60` and everything it references.
fn fixture(items: &str) -> String {
    fixture_with_angle_unit(".RADIAN.", items)
}

fn fixture_with_angle_unit(plane_angle_unit: &str, items: &str) -> String {
    format!(
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('symbolic conic basis fixture'),'2;1');
FILE_NAME('t.ifc','2026-09-12T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6,#7));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,{plane_angle_unit});
#40=IFCLOCALPLACEMENT($,#5);
{items}
#61=IFCSHAPEREPRESENTATION(#2,'Annotation','Annotation2D',(#60));
#62=IFCPRODUCTDEFINITIONSHAPE($,$,(#61));
#63=IFCANNOTATION('2xScRe4drECQ4DMSqUjd6d',$,'Note',$,$,#40,#62);
ENDSEC;
END-ISO-10303-21;
"#
    )
}

// ---------------------------------------------------------------------------
// G5: a conic whose mandatory `Position` is absent, dangling or of the wrong
// type has NO centre. `circle_center` answered `(0, 0, 0)` for all three and
// read attribute 0 -> 0 -> coords off whatever entity was wired in, so the
// curve drew at the model origin at elevation 0.0 and nothing downstream could
// tell it from a circle authored there. The basis now comes from
// `parse_axis2_placement_2d`, whose failure value is `unresolved()`
// (`tz = NaN`), which `world_y` carries as `null`.
//
// MUTATION that fails every test in this block: make `conic_basis` return
// `Transform2D::identity()` instead of `unresolved()` on its two failure arms
// (the old `(0,0,0)` behaviour): `world_y` is then a finite 0.0.
// ---------------------------------------------------------------------------

#[test]
fn g5_circle_with_dangling_position_has_unresolved_elevation() {
    // #52 is referenced and absent from the file.
    let ifc = fixture("#60=IFCCIRCLE(#52,2.);");
    let data = extract_symbolic_data(&ifc);
    assert_eq!(data.circles.len(), 1, "{:?}", data.circles);
    let c = &data.circles[0];
    assert!((c.radius - 2.0).abs() < 1e-6);
    assert!(
        c.world_y.is_nan(),
        "a dangling mandatory Position is unresolved, not elevation 0.0: got {}",
        c.world_y
    );
}

#[test]
fn g5_ellipse_with_dangling_position_has_unresolved_elevation() {
    let ifc = fixture("#60=IFCELLIPSE(#52,3.,1.5);");
    let data = extract_symbolic_data(&ifc);
    assert_eq!(data.polylines.len(), 1, "{:?}", data.polylines);
    assert!(
        data.polylines[0].world_y.is_nan(),
        "got {}",
        data.polylines[0].world_y
    );
}

/// A non-placement entity wired into `Position`. `IfcAxis1Placement` is
/// attribute-count compatible with `IfcAxis2Placement2D` (a point, then a
/// direction), so the untyped attribute-0 walk read (5, 6, 7) as the centre
/// and elevation and the circle drew there. That is a fabricated position,
/// distinct from the dangling case above because a plausible non-origin
/// coordinate came out of it.
#[test]
fn g5_circle_with_non_placement_position_is_not_read_as_a_centre() {
    let ifc = fixture(
        "#52=IFCAXIS1PLACEMENT(#50,#51);\n\
         #50=IFCCARTESIANPOINT((5.,6.,7.));\n\
         #51=IFCDIRECTION((0.,0.,1.));\n\
         #60=IFCCIRCLE(#52,2.);",
    );
    let data = extract_symbolic_data(&ifc);
    assert_eq!(data.circles.len(), 1, "{:?}", data.circles);
    let c = &data.circles[0];
    assert!(
        c.center_x.abs() < 1e-6 && c.center_y.abs() < 1e-6,
        "the wrong-type placement's Location (5, 6) must not become the centre: got ({}, {})",
        c.center_x,
        c.center_y
    );
    assert!(c.world_y.is_nan(), "got {}", c.world_y);
}

/// The fill path reads the same conic through the same reader: a fill whose
/// outer boundary is a circle with a dangling Position gets an unresolved
/// elevation from `sample_curve_world_y`, not 0.0.
#[test]
fn g5_fill_bounded_by_a_circle_with_dangling_position_has_unresolved_elevation() {
    let ifc = fixture(
        "#59=IFCCIRCLE(#52,2.);\n\
         #60=IFCANNOTATIONFILLAREA(#59,$);",
    );
    let data = extract_symbolic_data(&ifc);
    assert_eq!(data.fills.len(), 1, "{:?}", data.fills);
    assert!(data.fills[0].world_y.is_nan(), "got {}", data.fills[0].world_y);
}

/// BOUNDING CONTROL: a well-formed 3D placement still resolves to its
/// authored centre and elevation, on both the item and the fill path.
#[test]
fn g5_control_well_formed_position_keeps_its_centre_and_elevation() {
    let ifc = fixture(
        "#50=IFCCARTESIANPOINT((5.,3.,4.));\n\
         #52=IFCAXIS2PLACEMENT3D(#50,$,$);\n\
         #60=IFCCIRCLE(#52,2.);",
    );
    let data = extract_symbolic_data(&ifc);
    assert_eq!(data.circles.len(), 1);
    let c = &data.circles[0];
    assert!((c.center_x - 5.0).abs() < 1e-5 && (c.center_y + 3.0).abs() < 1e-5, "{c:?}");
    assert!((c.world_y - 4.0).abs() < 1e-5, "{c:?}");
}
