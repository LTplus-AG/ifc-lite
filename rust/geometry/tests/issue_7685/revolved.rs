// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! PROC-4 (#7685): `IfcRevolvedAreaSolid` keeps the profile's holes, and its
//! walls and caps face out of the solid for any profile winding, any sign of
//! `Angle`, either axis direction and either side of the axis.
//!
//! Expected volumes are Pappus's theorem, `V = A_net · r̄ · θ`. The mesh is a
//! chordal approximation, so it comes in slightly under; the tolerances admit
//! that and nothing like a filled hole (60% more volume for the rectangle,
//! 128% more for the tube).

use super::{assert_closed_outward, assert_volume, ifc, mesh_of, signed_volume};
use std::f64::consts::{FRAC_PI_2, PI, TAU};

const DATA: &str = "\
#1=IFCCARTESIANPOINT((5.,0.));
#2=IFCAXIS2PLACEMENT2D(#1,$);
#3=IFCRECTANGLEHOLLOWPROFILEDEF(.AREA.,$,#2,2.,1.,0.25,$,$);
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCDIRECTION((0.,1.,0.));
#6=IFCAXIS1PLACEMENT(#4,#5);
#7=IFCAXIS2PLACEMENT3D(#4,$,$);
#8=IFCDIRECTION((0.,-1.,0.));
#9=IFCAXIS1PLACEMENT(#4,#8);
#10=IFCREVOLVEDAREASOLID(#3,#7,#6,1.5707963267949);
#11=IFCREVOLVEDAREASOLID(#3,#7,#6,-1.5707963267949);
#12=IFCREVOLVEDAREASOLID(#3,#7,#9,1.5707963267949);
#20=IFCCIRCLEHOLLOWPROFILEDEF(.AREA.,$,#2,1.,0.25);
#21=IFCREVOLVEDAREASOLID(#20,#7,#6,6.28318530718);
#22=IFCREVOLVEDAREASOLID(#20,#7,#6,3.14159265359);
#30=IFCCARTESIANPOINT((4.,0.));
#31=IFCCARTESIANPOINT((4.,1.));
#32=IFCCARTESIANPOINT((6.,1.));
#33=IFCCARTESIANPOINT((6.,0.));
#34=IFCPOLYLINE((#30,#31,#32,#33,#30));
#35=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#34);
#36=IFCREVOLVEDAREASOLID(#35,#7,#6,1.5707963267949);
#37=IFCREVOLVEDAREASOLID(#35,#7,#6,-1.5707963267949);
#38=IFCREVOLVEDAREASOLID(#35,#7,#9,1.5707963267949);
#40=IFCCARTESIANPOINT((-5.,0.));
#41=IFCAXIS2PLACEMENT2D(#40,$);
#42=IFCRECTANGLEHOLLOWPROFILEDEF(.AREA.,$,#41,2.,1.,0.25,$,$);
#43=IFCREVOLVEDAREASOLID(#42,#7,#6,1.5707963267949);
#50=IFCCARTESIANPOINT((4.5,0.25));
#51=IFCCARTESIANPOINT((5.5,0.25));
#52=IFCCARTESIANPOINT((5.5,0.75));
#53=IFCCARTESIANPOINT((4.5,0.75));
#54=IFCPOLYLINE((#50,#51,#52,#53,#50));
#55=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#34,(#54));
#56=IFCREVOLVEDAREASOLID(#55,#7,#6,1.5707963267949);
#57=IFCREVOLVEDAREASOLID(#55,#7,#9,-1.5707963267949);
";

fn model() -> String {
    ifc("IFC4", DATA)
}

/// Hollow rectangle 2 × 1, wall 0.25: 2 − 1.5 · 0.5 = 1.25, centroid r̄ = 5.
const HOLLOW_RECT_AREA: f64 = 1.25;
/// Hollow circle r = 1, wall 0.25.
const HOLLOW_TUBE_AREA: f64 = PI * (1.0 - 0.75 * 0.75);
/// The 2 × 1 arbitrary rectangle at r̄ = 5.
const SOLID_RECT_AREA: f64 = 2.0;
/// The same rectangle with a 1 × 0.5 void.
const VOIDED_RECT_AREA: f64 = 1.5;

#[test]
fn proc_4_revolved_hollow_rectangle_keeps_its_hole() {
    let m = model();
    for (id, what) in [
        (10, "+90° about +Y"),
        (11, "−90° about +Y"),
        (12, "+90° about −Y"),
    ] {
        let mesh = mesh_of(&m, id);
        let v = signed_volume(&mesh);
        assert_volume(&format!("#{id} hollow rect {what}"), v, HOLLOW_RECT_AREA * 5.0 * FRAC_PI_2, 0.015);
        assert_closed_outward(&format!("#{id} hollow rect {what}"), &mesh, 1);
    }
}

#[test]
fn proc_4_profile_on_the_negative_side_of_the_axis() {
    let mesh = mesh_of(&model(), 43);
    assert_volume("#43", signed_volume(&mesh), HOLLOW_RECT_AREA * 5.0 * FRAC_PI_2, 0.015);
    assert_closed_outward("#43", &mesh, 1);
}

#[test]
fn proc_4_revolved_hollow_circle_pipe_bend_keeps_its_bore() {
    let mesh = mesh_of(&model(), 22);
    assert_volume("#22 half bend", signed_volume(&mesh), HOLLOW_TUBE_AREA * 5.0 * PI, 0.03);
    assert_closed_outward("#22 half bend", &mesh, 1);
}

#[test]
fn proc_4_full_revolution_of_a_tube_is_a_hollow_torus() {
    // No caps: the outer and the bore surfaces are two separate closed
    // shells. The bore must face INTO the bore (negative own volume), so the
    // raw signed volume is outer − bore.
    let mesh = mesh_of(&model(), 21);
    assert_volume("#21 hollow torus", signed_volume(&mesh), HOLLOW_TUBE_AREA * 5.0 * TAU, 0.03);
    let mut probe = mesh.clone();
    let verdict = ifc_lite_geometry::orient_mesh_outward_verdict(&mut probe);
    assert!(verdict.all_closed && verdict.all_orientable, "#21: {verdict:?}");
    assert_eq!(verdict.components, 2, "#21: outer shell + bore shell: {verdict:?}");
    // #7755: the orienter must leave the bore wound into the bore. It used to
    // flip it positive, so the delivered element mesh read outer + bore
    // (151.68 m3 for a 43.18 m3 torus).
    assert!(!verdict.flipped, "#21: the bore was turned inside out: {verdict:?}");
    assert_volume("#21 after orient", signed_volume(&probe), HOLLOW_TUBE_AREA * 5.0 * TAU, 0.03);
}

#[test]
fn proc_4_clockwise_profile_faces_outward_for_either_angle_sign() {
    let m = model();
    for (id, what) in [
        (36, "+90° about +Y"),
        (37, "−90° about +Y"),
        (38, "+90° about −Y"),
    ] {
        let mesh = mesh_of(&m, id);
        let v = signed_volume(&mesh);
        assert_volume(&format!("#{id} CW rect {what}"), v, SOLID_RECT_AREA * 5.0 * FRAC_PI_2, 0.015);
        assert_closed_outward(&format!("#{id} CW rect {what}"), &mesh, 1);
    }
}

#[test]
fn proc_4_arbitrary_profile_with_voids_keeps_the_void() {
    // CW outer and a CCW void: both against the Profile2D convention.
    let m = model();
    for id in [56, 57] {
        let mesh = mesh_of(&m, id);
        assert_volume(&format!("#{id}"), signed_volume(&mesh), VOIDED_RECT_AREA * 5.0 * FRAC_PI_2, 0.015);
        assert_closed_outward(&format!("#{id}"), &mesh, 1);
    }
}

