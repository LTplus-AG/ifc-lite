// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7791 item 2: `IfcAxis2PlacementLinear.Axis` / `RefDirection` (attributes 1
//! and 2) were never read, so every authored rotation was dropped. IFC4X3
//! expresses both in the curve frame at the `Location` (X along the tangent,
//! Y left of travel, Z vertical).

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::GeometryRouter;

fn frame(axis: &str, ref_direction: &str) -> Result<[f64; 16], String> {
    // A straight basis curve along +X: tangent +X, left +Y, vertical +Z.
    let src = format!(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCCARTESIANPOINT((100.,0.,0.));\n\
         #3=IFCPOLYLINE((#1,#2));\n\
         #4=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(10.),$,$,$,#3);\n\
         #5=IFCDIRECTION((0.,1.,0.));\n#6=IFCDIRECTION((0.,0.,1.));\n#7=IFCDIRECTION((0.,0.,0.));\n\
         #8=IFCAXIS2PLACEMENTLINEAR(#4,{axis},{ref_direction});\n\
         #9=IFCLINEARPLACEMENT($,#8,$);\n"
    );
    let mut decoder = EntityDecoder::new(&src);
    let router = GeometryRouter::new();
    let placement = decoder.decode_by_id(9).unwrap();
    router
        .resolve_linear_placement_local_strict(&placement, &mut decoder)
        .map_err(|e| e.to_string())
}

fn col(m: &[f64; 16], c: usize) -> [f64; 3] {
    [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]]
}

fn assert_vec(got: [f64; 3], want: [f64; 3], what: &str) {
    assert!(
        got.iter().zip(want).all(|(g, w)| (g - w).abs() < 1e-9),
        "{what}: got {got:?}, want {want:?}"
    );
}

#[test]
fn default_frame_is_the_curve_frame() {
    let m = frame("$", "$").unwrap();
    assert_vec(col(&m, 0), [1., 0., 0.], "x");
    assert_vec(col(&m, 1), [0., 1., 0.], "y");
    assert_vec(col(&m, 2), [0., 0., 1.], "z");
    assert_vec(col(&m, 3), [10., 0., 0.], "origin");
}

#[test]
fn axis_is_the_local_z_in_the_curve_frame() {
    // Axis = curve-frame +Y (left of travel, world +Y): local Z becomes world
    // +Y, X stays on the tangent, Y = Z x X = -world Z.
    let m = frame("#5", "$").unwrap();
    assert_vec(col(&m, 0), [1., 0., 0.], "x");
    assert_vec(col(&m, 1), [0., 0., -1.], "y");
    assert_vec(col(&m, 2), [0., 1., 0.], "z");
    assert_vec(col(&m, 3), [10., 0., 0.], "origin is unchanged by Axis");
}

#[test]
fn ref_direction_is_the_local_x_in_the_curve_frame() {
    // RefDirection = curve-frame +Y: local X becomes world +Y, Z stays up,
    // Y = Z x X = -world X.
    let m = frame("$", "#5").unwrap();
    assert_vec(col(&m, 0), [0., 1., 0.], "x");
    assert_vec(col(&m, 1), [-1., 0., 0.], "y");
    assert_vec(col(&m, 2), [0., 0., 1.], "z");
}

#[test]
fn zero_length_direction_is_unresolvable_not_silently_dropped() {
    assert!(frame("#7", "$").is_err());
    assert!(frame("$", "#7").is_err());
}

/// PR #9969 review: a DistanceAlong of 3D length along an `IfcGradientCurve`
/// whose final circular profile (radius 10 m, level start, 5π m of arc) ends
/// vertical at station 10 lands on the arc up to that end: R(sin θ, 0,
/// 1 - cos θ) above (0, 0, 100) with θ = DistanceAlong / R. The cumulative
/// 3D length overran the end, and 5π landed at station 9.01.
#[test]
fn distance_along_a_gradient_curve_reaches_its_vertical_end() {
    let radius = 10.0_f64;
    let pi = std::f64::consts::PI;
    for along in [2.5 * pi, 5.0 * pi - 0.06, 5.0 * pi] {
        let src = format!(
            "#1=IFCCARTESIANPOINT((0.,0.));\n#2=IFCDIRECTION((1.,0.));\n#3=IFCVECTOR(#2,1.);\n\
             #4=IFCLINE(#1,#3);\n#5=IFCAXIS2PLACEMENT2D(#1,#2);\n\
             #6=IFCCURVESEGMENT(.CONTINUOUS.,#5,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(10.),#4);\n\
             #7=IFCCOMPOSITECURVE((#6),.F.);\n#8=IFCCARTESIANPOINT((0.,100.));\n\
             #9=IFCAXIS2PLACEMENT2D(#8,#2);\n#10=IFCCIRCLE(#5,10.);\n\
             #11=IFCCURVESEGMENT(.CONTINUOUS.,#9,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(15.707963267948966),#10);\n\
             #12=IFCGRADIENTCURVE((#11),.F.,#7,$);\n\
             #13=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE({along:?}),$,$,$,#12);\n\
             #14=IFCAXIS2PLACEMENTLINEAR(#13,$,$);\n#15=IFCLINEARPLACEMENT($,#14,$);\n"
        );
        let mut decoder = EntityDecoder::new(&src);
        let placement = decoder.decode_by_id(15).unwrap();
        let m = GeometryRouter::new()
            .resolve_linear_placement_local_strict(&placement, &mut decoder)
            .unwrap();
        assert!(m.iter().all(|v| v.is_finite()), "{along}: {m:?}");
        let angle = along / radius;
        let want = [radius * angle.sin(), 0.0, 100.0 + radius * (1.0 - angle.cos())];
        let got = col(&m, 3);
        assert!(got.iter().zip(want).all(|(g, w)| (g - w).abs() < 1e-4), "{along}: got {got:?}, want {want:?}");
    }
}
