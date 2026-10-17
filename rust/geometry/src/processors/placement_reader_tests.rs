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
    let (result, _) = run(&extruder(), &extrusion("((1.,0.))", "$"), 5);
    assert!(result.is_err(), "ValidExtrusionDirection: z must be non-zero");
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
    // `$` Axis: base revolved about an invented +Y. +Z is not in XY either.
    for (bad, counted) in [("#8", 0), ("#12", 0), ("#11", 1), ("#13", 1)] {
        let (result, refused) = run(&processor, &revolved(bad), 20);
        assert!(result.is_err(), "{bad}");
        assert_eq!(refused, counted, "{bad}");
    }
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
fn the_shared_helpers_refuse_an_unreadable_placement_or_direction() {
    let content = "#1=IFCCARTESIANPOINT((1.,2.,3.));\n#2=IFCDIRECTION((0.,0.,1.));\n\
                   #3=IFCAXIS2PLACEMENT3D($,$,$);\n#4=IFCAXIS2PLACEMENT3D(#1,#1,$);\n\
                   #5=IFCAXIS2PLACEMENT3D(#1,$,$);\n";
    let mut decoder = EntityDecoder::new(content);
    // Base: a fast-path miss snapped to the origin and swallowed the error.
    assert!(helpers::get_axis2_placement_transform_by_id(3, &mut decoder).is_err());
    assert!(helpers::get_axis2_placement_transform_by_id(4, &mut decoder).is_err());
    let m = helpers::get_axis2_placement_transform_by_id(5, &mut decoder).expect("control");
    assert_eq!((m[(0, 3)], m[(1, 3)], m[(2, 3)]), (1.0, 2.0, 3.0));
    // Base: no type check, so a point read as a direction `(1,2,3)`.
    // (`Option` on base, `Result` now; both iterate to nothing on a refusal.)
    assert!(helpers::get_direction_by_id(1, &mut decoder).into_iter().next().is_none());
    assert_eq!(helpers::get_direction_by_id(2, &mut decoder).into_iter().next().unwrap().z, 1.0);
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
