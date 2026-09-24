// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression tests for #5566: a swept solid's `StartParam`/`EndParam` are in
//! its directrix's own IFC parametrisation.
//!
//! - An `IfcCompositeCurve` parameter is the running sum of its segments'
//!   parameter spans (a trimmed line's length in `IfcVector` units, a trimmed
//!   circle's angle), not one unit per segment. The U-bar fixture's `EndParam`
//!   820.826726273522 is exactly 322 + π/2 + 245.685… + π/2 + 250.
//! - A bare `IfcCircle` parameter is an angle, so `StartParam 0, EndParam 0.79`
//!   sweeps a 0.79 rad arc, not the full circle.
//!
//! Both `IfcSweptDiskSolid` and `IfcSurfaceCurveSweptAreaSolid` read the
//! parameters through one sampler, so both are pinned.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::{GeometryRouter, Mesh};

const UBAR: &str = "tests/fixtures/swept_disk_composite_arc_ubar.ifc";
const UBAR_SOLID: &str = "#72=IFCSWEPTDISKSOLID(#71,14.5,$,0.,820.826726273522);";
const UBAR_BAR_ID: u32 = 125;
/// Parameter spans of the U-bar's five segments (mm, rad, mm, rad, mm).
const LEG: f64 = 322.0;
const BEND: f64 = 1.5707963267949;
const FLOOR: f64 = 245.685133619932;
const TUBE_R_M: f32 = 0.0145;
/// Tessellation slack: the end rings are square to a finite-difference tangent.
const TOL_M: f32 = 2e-3;

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

fn mesh_element(content: &str, id: u32) -> Mesh {
    let entity_index = ifc_lite_core::build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);
    let router = GeometryRouter::with_units(content, &mut decoder);
    let element = decoder.decode_by_id(id).expect("decode element");
    router
        .process_element(&element, &mut decoder)
        .expect("process element")
}

/// The U-bar with the solid's parameter range replaced.
fn ubar_with_params(start: f64, end: f64) -> Mesh {
    let content = std::fs::read_to_string(UBAR).expect("read U-bar fixture");
    assert!(content.contains(UBAR_SOLID), "fixture solid line changed");
    let content = content.replace(
        UBAR_SOLID,
        &format!("#72=IFCSWEPTDISKSOLID(#71,14.5,$,{start:?},{end:?});"),
    );
    mesh_element(&content, UBAR_BAR_ID)
}

fn assert_close(label: &str, got: f32, want: f32) {
    assert!(
        (got - want).abs() < TOL_M,
        "{label}: got {got:.4} m, want {want:.4} m (#5566)"
    );
}

#[test]
fn composite_end_param_on_first_leg_sweeps_only_that_leg() {
    // [0, 322] is exactly the first straight leg (0,0,0) -> (0,0,-322) mm.
    // Unit-per-segment clamped 322 to all five segments: the whole U-bar.
    let (min, max) = bounds(&ubar_with_params(0.0, LEG));
    assert_close("max x", max[0], TUBE_R_M);
    assert_close("min x", min[0], -TUBE_R_M);
    // The end cap is square to the leg: the tube stops at the leg's end.
    assert_close("min z", min[2], -0.322);
}

#[test]
fn composite_range_on_a_bend_sweeps_only_the_bend() {
    // [322, 322 + π/2] is exactly the first bend: a quarter circle of radius
    // 101.5 mm centred at (101.5, 0, -322), from (0,0,-322) to (101.5,0,-423.5).
    // Unit-per-segment put both bounds past the 5-segment domain: no mesh.
    let mesh = ubar_with_params(LEG, LEG + BEND);
    assert!(!mesh.indices.is_empty(), "the bend swept nothing (#5566)");
    let (min, max) = bounds(&mesh);
    assert_close("min x", min[0], -TUBE_R_M);
    assert_close("max z", max[2], -0.322);
    assert_close("min z", min[2], -0.4235 - TUBE_R_M);
    assert!(
        max[0] < 0.1015 + 2.0 * TUBE_R_M,
        "bend reached past its own end: max x {} m (#5566)",
        max[0]
    );
}

#[test]
fn composite_partial_range_cuts_inside_segments() {
    // Start half-way down the first leg, stop half-way along the floor.
    let mesh = ubar_with_params(LEG / 2.0, LEG + BEND + FLOOR / 2.0);
    let (min, max) = bounds(&mesh);
    assert_close("max z", max[2], -0.161);
    assert_close("max x", max[0], (101.5 + FLOOR / 2.0) as f32 / 1000.0);
    assert_close("min z", min[2], -0.4235 - TUBE_R_M);
}

#[test]
fn composite_full_authored_range_is_the_whole_bar() {
    // The authored EndParam is the exact span sum: the whole U-bar.
    let (min, max) = bounds(&ubar_with_params(0.0, 820.826726273522));
    assert_close("min x", min[0], -TUBE_R_M);
    assert_close("max x", max[0], 0.448685 + TUBE_R_M);
    assert_close("max z", max[2], 0.0);
    assert_close("min z", min[2], -0.4235 - TUBE_R_M);
}

/// A raw `IfcCircle` directrix (radius 1000 mm in the XY plane) with the
/// given solid, wrapped in a reinforcing bar. `angle_unit` is the project's
/// plane-angle unit entity.
fn raw_circle_bar(solid: &str, angle_unit: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n\
#1=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);\n\
#2=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);\n\
#3=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);\n\
#4=IFCMEASUREWITHUNIT(IFCPLANEANGLEMEASURE(0.0174532925199433),#2);\n\
#5=IFCCONVERSIONBASEDUNIT(#3,.PLANEANGLEUNIT.,'DEGREE',#4);\n\
#6=IFCUNITASSIGNMENT((#1,{angle_unit}));\n\
#10=IFCCARTESIANPOINT((0.,0.,0.));\n\
#11=IFCDIRECTION((0.,0.,1.));\n\
#12=IFCDIRECTION((1.,0.,0.));\n\
#13=IFCAXIS2PLACEMENT3D(#10,#11,#12);\n\
#14=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#13,$);\n\
#15=IFCPROJECT('0Test00000000000000003',$,'Test',$,$,$,$,(#14),#6);\n\
#16=IFCLOCALPLACEMENT($,#13);\n\
#20=IFCCIRCLE(#13,1000.);\n\
{solid}\n\
#22=IFCSHAPEREPRESENTATION(#14,'Body','AdvancedSweptSolid',(#21));\n\
#23=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));\n\
#24=IFCREINFORCINGBAR('0Test0000000000000Ring',$,'Ring',$,$,#16,#23,$,$,20.,0.,$,.NOTDEFINED.,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

fn assert_raw_circle_arc(mesh: &Mesh, end_angle: f64) {
    assert!(!mesh.indices.is_empty(), "raw-circle sweep produced nothing");
    let (min, max) = bounds(mesh);
    let (s, c) = end_angle.sin_cos();
    // Arc from (1000, 0) to (1000 cos a, 1000 sin a) mm, tube radius 10 mm;
    // each end cap is square to the arc, so it spans the radial direction.
    assert_close("max x", max[0], 1.01);
    assert_close("min x", min[0], (0.99 * c) as f32);
    assert_close("min y", min[1], 0.0);
    assert_close("max y", max[1], (1.01 * s) as f32);
}

#[test]
fn raw_circle_start_and_end_param_bound_the_arc() {
    // tests/models/ifcopenshell/1032-curve.ifc: StartParam 0, EndParam 0.79.
    // The full circle reached min y = -1.01 m.
    let content = raw_circle_bar("#21=IFCSWEPTDISKSOLID(#20,10.,$,0.,0.79);", "#2");
    assert_raw_circle_arc(&mesh_element(&content, 24), 0.79);
}

#[test]
fn raw_circle_parameters_are_in_the_plane_angle_unit() {
    let content = raw_circle_bar("#21=IFCSWEPTDISKSOLID(#20,10.,$,0.,45.);", "#5");
    assert_raw_circle_arc(&mesh_element(&content, 24), 45f64.to_radians());
}

#[test]
fn explicit_full_circle_keeps_the_omitted_range_mesh() {
    // A conversion-based degree unit is deliberately inexact in binary; its
    // 360-degree range still represents the same full circle as omitted bounds.
    let implicit = raw_circle_bar("#21=IFCSWEPTDISKSOLID(#20,10.,$,$,$);", "#5");
    let explicit = raw_circle_bar("#21=IFCSWEPTDISKSOLID(#20,10.,$,0.,360.);", "#5");
    let implicit_mesh = mesh_element(&implicit, 24);
    let explicit_mesh = mesh_element(&explicit, 24);
    assert_eq!(explicit_mesh.positions, implicit_mesh.positions);
    assert_eq!(explicit_mesh.indices, implicit_mesh.indices);
}

#[test]
fn omitted_circle_end_param_uses_the_directrix_domain_end() {
    // Omitted EndParam means the circle's end parameter, not one turn past
    // StartParam. These two solids must therefore sweep the same 270° arc.
    let implicit = raw_circle_bar(
        "#21=IFCSWEPTDISKSOLID(#20,10.,$,1.5707963267948966,$);",
        "#2",
    );
    let explicit = raw_circle_bar(
        "#21=IFCSWEPTDISKSOLID(#20,10.,$,1.5707963267948966,6.283185307179586);",
        "#2",
    );
    let implicit_mesh = mesh_element(&implicit, 24);
    let explicit_mesh = mesh_element(&explicit, 24);
    assert!(!implicit_mesh.indices.is_empty());
    assert_eq!(implicit_mesh.positions, explicit_mesh.positions);
    assert_eq!(implicit_mesh.indices, explicit_mesh.indices);
}

#[test]
fn surface_curve_swept_area_reads_composite_spans_too() {
    // The sibling solid shares the directrix sampler: the same [0, 322]
    // window on the U-bar directrix sweeps only the first leg.
    let content = std::fs::read_to_string(UBAR).expect("read U-bar fixture");
    let content = content.replace(
        UBAR_SOLID,
        "#72=IFCFIXEDREFERENCESWEPTAREASOLID(#80,$,#71,0.,322.,#18);\n\
#80=IFCCIRCLEPROFILEDEF(.AREA.,$,$,14.5);",
    );
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    assert_eq!(
        decoder.decode_by_id(72).unwrap().ifc_type,
        IfcType::IfcFixedReferenceSweptAreaSolid
    );
    let (min, max) = bounds(&mesh_element(&content, UBAR_BAR_ID));
    assert_close("min z", min[2], -0.322);
    assert!(max[0] < 0.05, "swept past the first leg: max x {} m (#5566)", max[0]);
}
