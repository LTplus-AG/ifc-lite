// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! F3b drift 3.11 and 3.4 for the `IfcCurveSegment` fallback of a composite
//! curve (a parent the dense sampler does not take): the segment Placement is
//! read by the one reader, so X is RefDirection projected against Axis, and
//! a frame that does not read fails the profile instead of skipping the
//! segment (base ignored Axis and dropped an unreadable frame's point).

use super::*;

/// One `IfcCurveSegment` of length 10 on a polynomial parent, placed by #4.
fn segment_curve(placement: &str) -> String {
    format!(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));\n#2=IFCDIRECTION((1.,0.,1.));\n#3=IFCDIRECTION((1.,0.,0.));\n\
         #4={placement};\n#5=IFCPOLYNOMIALCURVE(#6,(0.,1.),(0.,0.),$);\n\
         #6=IFCAXIS2PLACEMENT2D(#7,$);\n#7=IFCCARTESIANPOINT((0.,0.));\n\
         #8=IFCCURVESEGMENT(.CONTINUOUS.,#4,0.,10.,#5);\n#9=IFCCOMPOSITECURVE((#8),.F.);\n\
         #10=IFCCARTESIANPOINT((0.,'x',0.));\n"
    )
}

fn sample(placement: &str) -> (Result<Vec<Point3<f64>>>, u64) {
    let content = segment_curve(placement);
    let mut decoder = EntityDecoder::new(&content);
    let curve = decoder.decode_by_id(9).expect("decode #9");
    let points = ProfileProcessor::new(IfcSchema::new()).get_curve_points(
        &curve,
        &mut decoder,
        TessellationQuality::Medium,
    );
    (points, decoder.refused_records())
}

#[test]
fn a_curve_segment_terminal_follows_x_projected_against_a_tilted_axis() {
    // Axis (1,0,1) tilts the frame; RefDirection (1,0,0) projects to
    // (1,0,-1)/sqrt(2). Base used the raw RefDirection: terminal (10,0,0).
    let (points, refused) = sample("IFCAXIS2PLACEMENT3D(#1,#2,#3)");
    let points = points.expect("a readable tilted frame samples");
    let h = 10.0 / 2f64.sqrt();
    assert_eq!(points.len(), 2, "{points:?}");
    assert!((points[0] - Point3::new(0.0, 0.0, 0.0)).norm() < 1e-9, "{points:?}");
    assert!((points[1] - Point3::new(h, 0.0, -h)).norm() < 1e-9, "{points:?}");
    assert_eq!(refused, 0);
    // Control: an untilted frame keeps the raw RefDirection, as on base.
    let (points, _) = sample("IFCAXIS2PLACEMENT3D(#1,$,#3)");
    let points = points.expect("control");
    assert!((points[1] - Point3::new(10.0, 0.0, 0.0)).norm() < 1e-9, "{points:?}");
}

#[test]
fn an_unreadable_curve_segment_frame_fails_the_profile_and_is_counted() {
    // Base skipped the segment (one point lost) and drew the rest.
    for placement in ["IFCAXIS2PLACEMENT3D($,#2,#3)", "IFCAXIS2PLACEMENT3D(#10,#2,#3)"] {
        let (points, refused) = sample(placement);
        assert!(points.is_err(), "{placement}: {points:?}");
        assert_eq!(refused, 1, "{placement}");
    }
}

#[test]
fn a_curve_segment_placement_that_is_not_an_axis2_placement_fails_the_profile() {
    // IFC4X3 types the Placement as IfcPlacement, so an IfcAxis1Placement is
    // schema-valid; the sampler reads Axis2 frames only. Base skipped the
    // segment (one point lost); head refuses it as Unsupported and counts it.
    let (points, refused) = sample("IFCAXIS1PLACEMENT(#1,#2)");
    assert!(points.is_err(), "{points:?}");
    assert_eq!(refused, 1);
}
