// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! PROC-15 (#7685): the sub-profiles of an `IfcCompositeProfileDef` are
//! disjoint areas (double angles, built-up sections, wall layers), each with
//! its own holes. They were folded into the first sub-profile as holes, so a
//! second area outside the first got inward-facing walls and a dropped or
//! stray cap, and a later sub-profile's own holes were lost.

use super::{assert_closed_outward, assert_volume, ifc, mesh_of, signed_volume};
use std::f64::consts::FRAC_PI_2;

const DATA: &str = "\
#1=IFCCARTESIANPOINT((-2.,0.));
#2=IFCAXIS2PLACEMENT2D(#1,$);
#3=IFCRECTANGLEPROFILEDEF(.AREA.,$,#2,1.,1.);
#4=IFCCARTESIANPOINT((2.,0.));
#5=IFCAXIS2PLACEMENT2D(#4,$);
#6=IFCRECTANGLEPROFILEDEF(.AREA.,$,#5,1.,1.);
#7=IFCCOMPOSITEPROFILEDEF(.AREA.,$,(#3,#6),$);
#8=IFCCARTESIANPOINT((-0.5,0.));
#9=IFCAXIS2PLACEMENT2D(#8,$);
#10=IFCRECTANGLEPROFILEDEF(.AREA.,$,#9,1.,1.);
#11=IFCCARTESIANPOINT((0.5,0.));
#12=IFCAXIS2PLACEMENT2D(#11,$);
#13=IFCRECTANGLEPROFILEDEF(.AREA.,$,#12,1.,1.);
#14=IFCCOMPOSITEPROFILEDEF(.AREA.,$,(#10,#13),$);
#15=IFCRECTANGLEHOLLOWPROFILEDEF(.AREA.,$,#5,2.,1.,0.25,$,$);
#16=IFCCOMPOSITEPROFILEDEF(.AREA.,$,(#3,#15),$);
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCAXIS2PLACEMENT3D(#20,$,$);
#22=IFCDIRECTION((0.,0.,1.));
#23=IFCEXTRUDEDAREASOLID(#7,#21,#22,3.);
#24=IFCEXTRUDEDAREASOLID(#14,#21,#22,3.);
#25=IFCEXTRUDEDAREASOLID(#16,#21,#22,3.);
#30=IFCCARTESIANPOINT((4.,0.5));
#31=IFCAXIS2PLACEMENT2D(#30,$);
#32=IFCRECTANGLEPROFILEDEF(.AREA.,$,#31,1.,1.);
#33=IFCCARTESIANPOINT((7.,0.5));
#34=IFCAXIS2PLACEMENT2D(#33,$);
#35=IFCRECTANGLEPROFILEDEF(.AREA.,$,#34,1.,1.);
#36=IFCCOMPOSITEPROFILEDEF(.AREA.,$,(#32,#35),$);
#37=IFCDIRECTION((0.,1.,0.));
#38=IFCAXIS1PLACEMENT(#20,#37);
#39=IFCREVOLVEDAREASOLID(#36,#21,#38,1.5707963267949);
#40=IFCDERIVEDPROFILEDEF(.AREA.,$,#16,#41,$);
#41=IFCCARTESIANTRANSFORMATIONOPERATOR2D($,$,#20,2.);
#42=IFCMIRROREDPROFILEDEF(.AREA.,$,#16,$,$);
#43=IFCEXTRUDEDAREASOLID(#40,#21,#22,3.);
#44=IFCEXTRUDEDAREASOLID(#42,#21,#22,3.);
#45=IFCEXTRUDEDAREASOLIDTAPERED(#7,#21,#22,3.,#7);
#46=IFCCARTESIANPOINT((0.,0.,5.));
#47=IFCPOLYLINE((#20,#46));
#48=IFCDIRECTION((1.,0.,0.));
#49=IFCFIXEDREFERENCESWEPTAREASOLID(#7,$,#47,$,$,#48);
";

fn model() -> String {
    ifc("IFC4", DATA)
}

#[test]
fn proc_15_disjoint_sub_profiles_extrude_as_separate_solids() {
    let mesh = mesh_of(&model(), 23);
    assert_volume("#23 two 1×1 squares × 3", signed_volume(&mesh), 6.0, 1e-4);
    assert_closed_outward("#23", &mesh, 2);
}

#[test]
fn proc_15_abutting_sub_profiles_are_both_filled() {
    // The shared edge makes the welded mesh non-manifold there, so only the
    // volume is asserted; it is only right if both caps and all walls of the
    // second square face out.
    let mesh = mesh_of(&model(), 24);
    assert_volume("#24 abutting squares × 3", signed_volume(&mesh), 6.0, 1e-4);
}

#[test]
fn proc_15_a_later_sub_profile_keeps_its_own_hole() {
    // 1 × 1 square plus a 2 × 1 hollow rectangle (wall 0.25, net 1.25).
    let mesh = mesh_of(&model(), 25);
    assert_volume("#25 square + hollow rect × 3", signed_volume(&mesh), 2.25 * 3.0, 1e-4);
    assert_closed_outward("#25", &mesh, 2);
}

#[test]
fn proc_15_revolved_composite_revolves_each_region() {
    // Pappus per region: centroids at r = 4 and r = 7.
    let mesh = mesh_of(&model(), 39);
    assert_volume("#39", signed_volume(&mesh), (4.0 + 7.0) * FRAC_PI_2, 0.015);
    assert_closed_outward("#39", &mesh, 2);
}

#[test]
fn proc_15_derived_and_mirrored_composites_keep_every_region_and_hole() {
    // #40 scales the composite by 2 (area × 4); #42 mirrors it about its Y axis.
    let m = model();
    for (id, expected) in [(43, 2.25 * 4.0 * 3.0), (44, 2.25 * 3.0)] {
        let mesh = mesh_of(&m, id);
        assert_volume(&format!("#{id}"), signed_volume(&mesh), expected, 1e-4);
        assert_closed_outward(&format!("#{id}"), &mesh, 2);
    }
}

#[test]
fn proc_15_tapered_and_swept_composites_build_every_region() {
    // The sibling solid builders take the same regions: a tapered extrusion
    // (start and end the same composite) and a fixed-reference sweep along a
    // straight 5 m directrix.
    let m = model();
    let tapered = mesh_of(&m, 45);
    assert_volume("#45 tapered", signed_volume(&tapered), 6.0, 1e-4);
    assert_closed_outward("#45 tapered", &tapered, 2);
    let swept = mesh_of(&m, 49);
    assert_volume("#49 fixed-reference sweep", signed_volume(&swept), 10.0, 1e-4);
    assert_closed_outward("#49 fixed-reference sweep", &swept, 2);
}
