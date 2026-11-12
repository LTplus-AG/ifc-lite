// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use ifc_lite_core::IfcSchema;

/// A 400 m straight plan layout under a crest: a parabola from +2 % to -2 %
/// over the first 200 m (z = 100 + 0.02 s - 1e-4 s^2, back to 100 m), then a
/// constant -2 % grade.
const CREST: &str = "#1=IFCCARTESIANPOINT((0.,0.));\n\
    #2=IFCDIRECTION((1.,0.));\n\
    #3=IFCVECTOR(#2,1.);\n\
    #4=IFCLINE(#1,#3);\n\
    #5=IFCAXIS2PLACEMENT2D(#1,#2);\n\
    #6=IFCCURVESEGMENT(.CONTINUOUS.,#5,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(400.),#4);\n\
    #7=IFCCOMPOSITECURVE((#6),.F.);\n\
    #8=IFCCARTESIANPOINT((0.,100.));\n\
    #9=IFCDIRECTION((1.,0.02));\n\
    #10=IFCAXIS2PLACEMENT2D(#8,#9);\n\
    #11=IFCPOLYNOMIALCURVE(#5,(0.,1.),(0.,0.02,-1.E-4),$);\n\
    #12=IFCCURVESEGMENT(.CONTINUOUS.,#10,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(200.),#11);\n\
    #13=IFCCARTESIANPOINT((200.,100.));\n\
    #14=IFCDIRECTION((1.,-0.02));\n\
    #15=IFCAXIS2PLACEMENT2D(#13,#14);\n\
    #16=IFCCURVESEGMENT(.CONTSAMEGRADIENT.,#15,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(200.04),#4);\n\
    #17=IFCGRADIENTCURVE((#12,#16),.F.,#7,$);";

fn crest_elevation(s: f64) -> f64 {
    if s <= 200.0 { 100.0 + 0.02 * s - 1e-4 * s * s } else { 100.0 - 0.02 * (s - 200.0) }
}

fn crest_points(start: Option<f64>, end: Option<f64>) -> Vec<Point3<f64>> {
    let mut decoder = EntityDecoder::new(CREST);
    let curve = decoder.decode_by_id(17).unwrap();
    ProfileProcessor::new(IfcSchema::new())
        .get_directrix_points(&curve, &mut decoder, start, end, TessellationQuality::Medium)
        .unwrap()
}

/// Every sample of an `IfcGradientCurve` directrix lies on the vertical
/// profile, and the vertical curve is subdivided until no chord strays
/// more than `CHORD_TOL_M` from it. The plain-curve path returned the
/// flat BaseCurve (z = 0) here.
#[test]
fn gradient_directrix_samples_lie_on_the_profile_within_chord_tolerance() {
    let points = crest_points(None, None);
    assert!((points[0].x - 0.0).abs() < 1e-9 && (points.last().unwrap().x - 400.0).abs() < 1e-9);
    for p in &points {
        assert!(p.y.abs() < 1e-9);
        assert!((p.z - crest_elevation(p.x)).abs() < 1e-9, "{p:?}");
    }
    for pair in points.windows(2) {
        let middle = 0.5 * (pair[0].x + pair[1].x);
        let chord = 0.5 * (pair[0].z + pair[1].z);
        assert!((crest_elevation(middle) - chord).abs() <= CHORD_TOL_M + 1e-12, "{pair:?}");
    }
    // The 1 m mid-span sag needs ceil(sqrt(1 / 5e-4)) = 45 steps; the line
    // after it stays one chord.
    assert_eq!(points.len(), 45 + 2);
}

/// StartParam/EndParam are horizontal distance along the BaseCurve.
#[test]
fn trimmed_gradient_directrix_starts_and_ends_at_the_parameters() {
    let points = crest_points(Some(150.0), Some(300.0));
    let (first, last) = (points[0], *points.last().unwrap());
    assert!((first.x - 150.0).abs() < 1e-9 && (first.z - crest_elevation(150.0)).abs() < 1e-9);
    assert!((last.x - 300.0).abs() < 1e-9 && (last.z - 98.0).abs() < 1e-9);
    assert!(points.windows(2).all(|pair| pair[1].x > pair[0].x));
}
