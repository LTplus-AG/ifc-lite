// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! PROC-AL-5 (#7685): `IfcSectionedSolidHorizontal` places, stitches and caps
//! every hole of its cross-sections, outward for either frame handedness
//! (IFC4x3 `IfcAxis2PlacementLinear` is proper; IFC4x1's right-of-travel
//! `IfcDistanceExpression` is mirrored) and either profile winding.

use super::{assert_closed_outward, assert_volume, ifc, mesh_of, signed_volume};

const DATA: &str = "\
#1=IFCCARTESIANPOINT((0.,0.));
#2=IFCAXIS2PLACEMENT2D(#1,$);
#3=IFCRECTANGLEHOLLOWPROFILEDEF(.AREA.,$,#2,2.,1.,0.25,$,$);
#10=IFCCARTESIANPOINT((-1.,0.));
#11=IFCCARTESIANPOINT((-1.,1.));
#12=IFCCARTESIANPOINT((1.,1.));
#13=IFCCARTESIANPOINT((1.,0.));
#14=IFCPOLYLINE((#10,#11,#12,#13,#10));
#15=IFCCARTESIANPOINT((-0.5,0.25));
#16=IFCCARTESIANPOINT((0.5,0.25));
#17=IFCCARTESIANPOINT((0.5,0.75));
#18=IFCCARTESIANPOINT((-0.5,0.75));
#19=IFCPOLYLINE((#15,#16,#17,#18,#15));
#20=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#14,(#19));
#30=IFCCARTESIANPOINT((0.,0.));
#31=IFCCARTESIANPOINT((0.,20.));
#32=IFCPOLYLINE((#30,#31));
#33=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(0.),$,$,$,#32);
#34=IFCAXIS2PLACEMENTLINEAR(#33,$,$);
#35=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(20.),$,$,$,#32);
#36=IFCAXIS2PLACEMENTLINEAR(#35,$,$);
#37=IFCSECTIONEDSOLIDHORIZONTAL(#32,(#3,#3),(#34,#36));
#38=IFCSECTIONEDSOLIDHORIZONTAL(#32,(#20,#20),(#34,#36));
#40=IFCCARTESIANPOINT((0.,0.,0.));
#41=IFCCARTESIANPOINT((0.,20.,0.));
#42=IFCPOLYLINE((#40,#41));
#43=IFCDISTANCEEXPRESSION(0.,0.,0.,0.,.T.);
#44=IFCDISTANCEEXPRESSION(20.,0.,0.,0.,.T.);
#45=IFCSECTIONEDSOLIDHORIZONTAL(#42,(#3,#3),(#43,#44));
#46=IFCSECTIONEDSOLIDHORIZONTAL(#42,(#20,#20),(#43,#44));
#50=IFCDIRECTION((1.,0.));
#51=IFCVECTOR(#50,1.);
#52=IFCLINE(#1,#51);
#53=IFCCIRCLE(#2,100.);
#54=IFCCURVESEGMENT(.CONTINUOUS.,#2,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(157.0796326795),#53);
#55=IFCCARTESIANPOINT((100.,100.));
#56=IFCDIRECTION((0.,1.));
#57=IFCAXIS2PLACEMENT2D(#55,#56);
#58=IFCCURVESEGMENT(.DISCONTINUOUS.,#57,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(0.),#52);
#59=IFCCOMPOSITECURVE((#54,#58),.F.);
#60=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(0.),$,$,$,#59);
#61=IFCAXIS2PLACEMENTLINEAR(#60,$,$);
#62=IFCPOINTBYDISTANCEEXPRESSION(IFCLENGTHMEASURE(157.0796326795),$,$,$,#59);
#63=IFCAXIS2PLACEMENTLINEAR(#62,$,$);
#64=IFCSECTIONEDSOLIDHORIZONTAL(#59,(#3,#3),(#61,#63));
";

fn model() -> String {
    ifc("IFC4X3_ADD2", DATA)
}

/// Hollow rectangle 2 × 1, wall 0.25.
const HOLLOW_RECT_AREA: f64 = 1.25;
/// 2 × 1 rectangle with a 1 × 0.5 void.
const VOIDED_RECT_AREA: f64 = 1.5;

#[test]
fn proc_al_5_hollow_section_keeps_its_hole_in_a_proper_frame() {
    let mesh = mesh_of(&model(), 37);
    assert_volume("#37 IFC4x3 linear", signed_volume(&mesh), HOLLOW_RECT_AREA * 20.0, 0.005);
    assert_closed_outward("#37 IFC4x3 linear", &mesh, 1);
}

#[test]
fn proc_al_5_hollow_section_keeps_its_hole_in_a_mirrored_frame() {
    let mesh = mesh_of(&model(), 45);
    assert_volume("#45 IFC4x1 distance", signed_volume(&mesh), HOLLOW_RECT_AREA * 20.0, 0.005);
    assert_closed_outward("#45 IFC4x1 distance", &mesh, 1);
}

#[test]
fn proc_al_5_clockwise_section_with_a_counter_clockwise_void() {
    let m = model();
    for (id, what) in [(38, "IFC4x3 linear"), (46, "IFC4x1 distance")] {
        let mesh = mesh_of(&m, id);
        assert_volume(&format!("#{id} {what}"), signed_volume(&mesh), VOIDED_RECT_AREA * 20.0, 0.005);
        assert_closed_outward(&format!("#{id} {what}"), &mesh, 1);
    }
}

#[test]
fn proc_al_5_curved_directrix_places_the_interpolated_holes() {
    // A quarter circle of radius 100: the sweep subdivides into intermediate
    // stations, whose (interpolated) holes must be placed and stitched too.
    // The profile centroid is on the directrix, so V = A · L (Pappus).
    let mesh = mesh_of(&model(), 64);
    assert_volume("#64 quarter circle", signed_volume(&mesh), HOLLOW_RECT_AREA * 157.0796, 0.01);
    assert_closed_outward("#64 quarter circle", &mesh, 1);
}
