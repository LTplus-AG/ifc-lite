// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! F3b X3a: the processors read placements and directions through the one
//! reader (`placement::Axis2Placement`, `EntityDecoder::direction3`), so an
//! unreadable value is refused instead of becoming the origin, `+Y`, or a
//! ratio of 1.0 (D3, D25, D30; drift 3.3 to 3.5, 3.11, 3.12). Every `refuses_*`
//! case below produced geometry on the base commit; each control case
//! produces the same geometry on both.

use super::*;
use crate::router::GeometryProcessor;
use crate::TessellationQuality;
use ifc_lite_core::{EntityDecoder, IfcSchema};

fn doc(body: &str) -> String {
    format!("{body}\n")
}

/// Process entity `id` of `body` with `processor`; also the refusal counter.
fn run(processor: &dyn GeometryProcessor, body: &str, id: u32) -> (crate::Result<crate::Mesh>, u64) {
    let content = doc(body);
    let mut decoder = EntityDecoder::new(&content);
    let schema = IfcSchema::new();
    let entity = decoder.decode_by_id(id).expect("entity");
    let result = processor.process(&entity, &mut decoder, &schema, TessellationQuality::Medium);
    (result, decoder.refused_records())
}

fn extrusion(direction: &str, position: &str) -> String {
    format!(
        "#1=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,100.,200.);\n#2=IFCDIRECTION{direction};\n\
         #3=IFCCARTESIANPOINT((1.,2.,3.));\n#4=IFCAXIS2PLACEMENT3D(#3,$,$);\n\
         #5=IFCEXTRUDEDAREASOLID(#1,{position},#2,300.);"
    )
}

fn extruder() -> ExtrudedAreaSolidProcessor {
    ExtrudedAreaSolidProcessor::new(IfcSchema::new())
}

#[test]
fn an_extruded_direction_without_a_z_ratio_is_refused() {
    // Base read the missing z as 1.0 and extruded `(1,0)` along `(1,0,1)`.
    // The WR refusal is refused input like any other: counted on the solid.
    let (result, refused) = run(&extruder(), &extrusion("((1.,0.))", "$"), 5);
    assert!(result.is_err(), "ValidExtrusionDirection: z must be non-zero");
    assert_eq!(refused, 1);
    let (result, refused) = run(&extruder(), &extrusion("((1.,0.,0.))", "$"), 5);
    assert!(result.is_err(), "an explicit zero Z is the same WR");
    assert_eq!(refused, 1);
    // A zero-length direction has no Z either: the same WR, counted once,
    // with its own message.
    let (result, refused) = run(&extruder(), &extrusion("((0.,0.,0.))", "$"), 5);
    let message = result.expect_err("a zero-length direction is refused").to_string();
    assert!(message.contains("zero-length ExtrudedDirection"), "{message}");
    assert_eq!(refused, 1);
    let (control, refused) = run(&extruder(), &extrusion("((0.,0.,1.))", "$"), 5);
    assert!(!control.expect("control").is_empty());
    assert_eq!(refused, 0);
}

#[test]
fn an_unreadable_extruded_direction_or_position_is_refused_and_counted() {
    // Base: `'x'` z -> 1.0 (a perfectly good +Z extrusion).
    let (result, refused) = run(&extruder(), &extrusion("((0.,0.,'x'))", "$"), 5);
    assert!(result.is_err());
    assert_eq!(refused, 1);
    // Base: a Position that is not an IfcAxis2Placement3D was ignored (identity).
    let (result, refused) = run(&extruder(), &extrusion("((0.,0.,1.))", "#3"), 5);
    assert!(result.is_err(), "a cartesian point is not a Position");
    assert_eq!(refused, 1);
    let (control, _) = run(&extruder(), &extrusion("((0.,0.,1.))", "#4"), 5);
    assert!(!control.expect("control").is_empty());
}

fn revolved(axis_placement: &str) -> String {
    format!(
        "#1=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,10.,20.);\n#2=IFCCARTESIANPOINT((50.,0.,0.));\n\
         #3=IFCDIRECTION((0.,1.,0.));\n#4=IFCDIRECTION((0.,1.));\n#5=IFCDIRECTION((1.));\n\
         #6=IFCDIRECTION((0.,0.,1.));\n#7=IFCCARTESIANPOINT((50.,'x',0.));\n\
         #8=IFCAXIS1PLACEMENT(#2,$);\n#9=IFCAXIS1PLACEMENT(#2,#3);\n#10=IFCAXIS1PLACEMENT(#2,#4);\n\
         #11=IFCAXIS1PLACEMENT(#2,#5);\n#12=IFCAXIS1PLACEMENT(#2,#6);\n#13=IFCAXIS1PLACEMENT(#7,#3);\n\
         #15=IFCDIRECTION((0.,0.,0.));\n#14=IFCAXIS1PLACEMENT(#2,#15);\n\
         #20=IFCREVOLVEDAREASOLID(#1,$,{axis_placement},1.5707963);"
    )
}

#[test]
fn a_revolved_axis_the_wr_rules_out_is_refused_instead_of_invented() {
    let processor = swept::RevolvedAreaSolidProcessor::new(IfcSchema::new());
    // Controls: the axis in XY, given in 3 ratios or 2 (promoted, z = 0).
    for ok in ["#9", "#10"] {
        let (result, refused) = run(&processor, &revolved(ok), 20);
        assert!(!result.expect(ok).is_empty(), "{ok}");
        assert_eq!(refused, 0, "{ok}");
    }
    // `$` Axis: base revolved about an invented +Y. +Z is not in XY either,
    // and a zero-length Axis has no direction. The WR refusals (#8, #12,
    // #14) are counted on the solid, the unreadable leaves (#11, #13) on
    // themselves: one refused record each (D3, D29).
    for bad in ["#8", "#12", "#14", "#11", "#13"] {
        let (result, refused) = run(&processor, &revolved(bad), 20);
        assert!(result.is_err(), "{bad}");
        assert_eq!(refused, 1, "{bad}");
    }
}

/// A revolved solid about `IFCDIRECTION({ratios})`, through `(50,0,0)`.
fn revolved_about(ratios: &str) -> String {
    format!(
        "#1=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,10.,20.);\n#2=IFCCARTESIANPOINT((50.,0.,0.));\n\
         #3=IFCDIRECTION({ratios});\n#4=IFCAXIS1PLACEMENT(#2,#3);\n\
         #20=IFCREVOLVEDAREASOLID(#1,$,#4,1.5707963);"
    )
}

#[test]
fn a_revolved_axis_whose_squared_length_overflows_is_tested_on_its_direction() {
    let processor = swept::RevolvedAreaSolidProcessor::new(IfcSchema::new());
    let mesh = |ratios: &str| run(&processor, &revolved_about(ratios), 20);
    // `|(1e308, 0, 1e308)|` overflows: the axis used to normalise to the zero
    // vector, pass the XY test, and revolve about nothing. It is 45° off the
    // plane, so AxisDirectionInXY refuses it, counted once on the solid.
    let (result, refused) = mesh("(1.E308,0.,1.E308)");
    let message = result.expect_err("an overflowing off-plane axis is refused").to_string();
    assert!(message.contains("does not lie in the XY plane"), "{message}");
    assert_eq!(refused, 1);
    // Huge but in XY: revolves exactly as its unit-scale twin, bit for bit.
    for (huge, unit) in [("(1.E308,1.E308,0.)", "(1.,1.,0.)"), ("(1.E308,0.,0.)", "(1.,0.,0.)")] {
        let (control, refused) = mesh(unit);
        let control = control.expect(unit);
        assert!(!control.is_empty() && refused == 0, "{unit}");
        let (result, refused) = mesh(huge);
        let result = result.expect(huge);
        assert_eq!(refused, 0, "{huge}");
        assert_eq!(result.positions, control.positions, "{huge}");
        assert_eq!(result.indices, control.indices, "{huge}");
    }
    // Subnormal ratios have no usable length: refused as zero length, once.
    for tiny in ["(5.E-324,0.,0.)", "(5.E-324,5.E-324,0.)", "(1.E-200,1.E-200,1.E-200)"] {
        let (result, refused) = mesh(tiny);
        let message = result.expect_err(tiny).to_string();
        assert!(message.contains("zero length"), "{tiny}: {message}");
        assert_eq!(refused, 1, "{tiny}");
    }
    // A subnormal Z on a unit XY axis is in the plane.
    let (result, refused) = mesh("(0.,1.,5.E-324)");
    assert!(!result.expect("subnormal z").is_empty());
    assert_eq!(refused, 0);
}

#[test]
fn an_extruded_direction_whose_squared_length_overflows_keeps_its_direction() {
    // Base and r1 accepted it, then normalised it to the zero vector and
    // extruded along +Z. Now it extrudes as its unit-scale twin, bit for bit.
    // The downward row pins the sense: a rescale by the signed largest
    // component would flip it to +Z and drop the downward depth shift.
    for (huge, unit) in [
        ("((1.E308,0.,1.E308))", "((1.,0.,1.))"),
        ("((0.,0.,1.E308))", "((0.,0.,1.))"),
        ("((0.,0.,-1.E308))", "((0.,0.,-1.))"),
    ] {
        let (control, refused) = run(&extruder(), &extrusion(unit, "$"), 5);
        let control = control.expect(unit);
        assert_eq!(refused, 0, "{unit}");
        let (result, refused) = run(&extruder(), &extrusion(huge, "$"), 5);
        let result = result.expect(huge);
        assert_eq!(refused, 0, "{huge}");
        assert_eq!(result.positions, control.positions, "{huge}");
        assert_eq!(result.indices, control.indices, "{huge}");
    }
    // The WR is still tested on the authored ratios: a huge X with
    // zero Z is refused, a subnormal pair is zero length; each counted once.
    let (result, refused) = run(&extruder(), &extrusion("((1.E308,0.,0.))", "$"), 5);
    assert!(result.expect_err("z = 0").to_string().contains("ValidExtrusionDirection"));
    assert_eq!(refused, 1);
    let (result, refused) = run(&extruder(), &extrusion("((5.E-324,0.,5.E-324))", "$"), 5);
    assert!(result.expect_err("subnormal").to_string().contains("zero-length"));
    assert_eq!(refused, 1);
}

fn block(position: &str) -> String {
    format!(
        "#1=IFCCARTESIANPOINT((1.,2.,3.));\n#3=IFCAXIS2PLACEMENT3D(#1,$,$);\n\
         #4=IFCAXIS2PLACEMENT3D($,$,$);\n#5=IFCBLOCK({position},1.,1.,1.);\n#6=IFCSPHERE({position},1.);"
    )
}

#[test]
fn a_csg_primitive_position_that_is_present_must_read() {
    let processors: [(&dyn GeometryProcessor, u32); 2] =
        [(&BlockProcessor::new(), 5), (&SphereProcessor::new(), 6)];
    for (processor, id) in processors {
        let (control, refused) = run(processor, &block("#3"), id);
        assert!(!control.expect("control").is_empty());
        assert_eq!(refused, 0);
        // Base ignored a Position of another type and drew at the origin.
        let (result, refused) = run(processor, &block("#1"), id);
        assert!(result.is_err(), "#{id} with a cartesian point as Position");
        assert_eq!(refused, 1);
        // Base placed a `$` Location at the origin.
        let (result, refused) = run(processor, &block("#4"), id);
        assert!(result.is_err(), "#{id} with a `$` Location");
        assert_eq!(refused, 1);
    }
}

#[test]
fn the_one_reader_refuses_an_unreadable_placement_or_direction() {
    use crate::placement::Axis2Placement;
    let content = "#1=IFCCARTESIANPOINT((1.,2.,3.));\n#2=IFCDIRECTION((0.,0.,1.));\n\
                   #3=IFCAXIS2PLACEMENT3D($,$,$);\n#4=IFCAXIS2PLACEMENT3D(#1,#1,$);\n\
                   #5=IFCAXIS2PLACEMENT3D(#1,$,$);\n";
    let mut decoder = EntityDecoder::new(content);
    // Base: a fast-path miss snapped to the origin and swallowed the error.
    assert!(Axis2Placement::read_id(3, &mut decoder).is_err());
    assert!(Axis2Placement::read_id(4, &mut decoder).is_err());
    let m = Axis2Placement::read_id(5, &mut decoder).expect("control").matrix();
    assert_eq!((m[(0, 3)], m[(1, 3)], m[(2, 3)]), (1.0, 2.0, 3.0));
    // Base: `get_direction_by_id` had no type check, so a point read as a
    // direction `(1,2,3)`. Its one caller now reads through the leaf reader.
    assert!(decoder.direction3(1).is_err());
    assert_eq!(decoder.direction3(2).expect("control")[2], 1.0);
}

fn profiled(position: &str) -> String {
    format!(
        "#1=IFCCARTESIANPOINT((10.,20.));\n#2=IFCDIRECTION((0.,1.));\n#3=IFCDIRECTION(('a',1.));\n\
         #4=IFCAXIS2PLACEMENT2D(#1,#2);\n#5=IFCAXIS2PLACEMENT2D($,$);\n#6=IFCAXIS2PLACEMENT2D(#1,#3);\n\
         #7=IFCRECTANGLEPROFILEDEF(.AREA.,$,{position},100.,200.);\n#8=IFCDIRECTION((0.,0.,1.));\n\
         #9=IFCEXTRUDEDAREASOLID(#7,$,#8,300.);"
    )
}

/// `apply_profile_position` (PROC-1, GEOM-2): base read a `$` Location as the
/// origin and a non-number x ratio as 1.0.
#[test]
fn a_profile_position_that_does_not_read_is_refused() {
    let (control, refused) = run(&extruder(), &profiled("#4"), 9);
    let mesh = control.expect("control");
    assert_eq!(refused, 0);
    let (min_x, max_x) = mesh.positions.chunks_exact(3).fold((f32::MAX, f32::MIN), |(lo, hi), p| (lo.min(p[0]), hi.max(p[0])));
    // RefDirection (0,1) turns the 100 x 200 rectangle: x spans 200, centred on 10 - 0.
    assert!((max_x - min_x - 200.0).abs() < 1e-3, "{min_x}..{max_x}");
    let (result, refused) = run(&extruder(), &profiled("#5"), 9);
    assert!(result.is_err(), "`$` Location");
    assert_eq!(refused, 1);
    let (result, refused) = run(&extruder(), &profiled("#6"), 9);
    assert!(result.is_err(), "unreadable RefDirection");
    assert_eq!(refused, 1);
}

/// PROC-S7: a conic whose Position does not read used to sample at the
/// origin (an identity frame); it now refuses the face.
#[test]
fn a_conic_edge_with_an_unreadable_position_refuses_the_face() {
    let face = |circle_position: &str| {
        format!(
            "#1=IFCCARTESIANPOINT((50.,0.,0.));\n#2=IFCCARTESIANPOINT((-50.,0.,0.));\n\
#3=IFCCARTESIANPOINT((0.,0.,0.));\n#5=IFCVERTEXPOINT(#1);\n#6=IFCVERTEXPOINT(#2);\n\
#9=IFCDIRECTION((0.,0.,1.));\n#10=IFCDIRECTION((1.,0.,0.));\n#11=IFCAXIS2PLACEMENT3D(#3,#9,#10);\n\
#12=IFCPLANE(#11);\n#16=IFCAXIS2PLACEMENT3D($,#9,#10);\n#17=IFCAXIS2PLACEMENT3D(#3,#9,#9);\n\
#13=IFCCIRCLE({circle_position},50.);\n\
#14=IFCTRIMMEDCURVE(#13,(#1),(#2),.T.,.CARTESIAN.);\n#15=IFCLINE(#2,#20);\n\
#20=IFCVECTOR(#21,1.);\n#21=IFCDIRECTION((1.,0.,0.));\n#30=IFCEDGECURVE(#5,#6,#14,.T.);\n\
#31=IFCEDGECURVE(#6,#5,#15,.T.);\n#40=IFCORIENTEDEDGE(*,*,#30,.T.);\n#41=IFCORIENTEDEDGE(*,*,#31,.T.);\n\
#50=IFCEDGELOOP((#40,#41));\n#51=IFCFACEOUTERBOUND(#50,.T.);\n#52=IFCADVANCEDFACE((#51),#12,.T.);\n\
#53=IFCOPENSHELL((#52));\n#54=IFCSHELLBASEDSURFACEMODEL((#53));"
        )
    };
    let processor = ShellBasedSurfaceModelProcessor::new();
    let (control, _) = run(&processor, &face("#11"), 54);
    assert!(!control.expect("control").is_empty());
    let (result, refused) = run(&processor, &face("#16"), 54);
    let drawn = result.map(|mesh| !mesh.is_empty()).unwrap_or(false);
    assert!(!drawn, "a `$` Location must not sample the circle at the origin");
    assert_eq!(refused, 1);
}
