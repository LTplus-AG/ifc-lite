// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

// The sampler's observable behaviour (samples on the profile within the
// chord tolerance, parameter trims and their refusal on a base not measured
// by distance, steep profiles) is tested through the public
// `ProfileProcessor::get_directrix_points` in
// `tests/gradient_directrix_sampling.rs`, and the length trims and evaluated
// tangents through the swept-solid processors in
// `processors/swept/surface_plan_tests.rs`. Only the split budget's report
// has no public path, so it is tested here.


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

/// The largest vertical gap between `profile` and the chords through
/// `points`, probed at 200 stations per chord.
fn worst_chord_error(points: &[Point3<f64>], profile: impl Fn(f64) -> f64) -> f64 {
    let mut worst: f64 = 0.0;
    for pair in points.windows(2) {
        for i in 1..200 {
            let t = i as f64 / 200.0;
            let x = pair[0].x + t * (pair[1].x - pair[0].x);
            let chord = pair[0].z + t * (pair[1].z - pair[0].z);
            worst = worst.max((profile(x) - chord).abs());
        }
    }
    worst
}

/// A span whose chords cannot reach the tolerance within its split budget
/// stops after `budget + 1` chords and reports it, instead of returning
/// coarse chords as if they met the bound. With the production budget the
/// same span passes. Its parabola sags 1 m over 200 m.
#[test]
fn an_exhausted_split_budget_is_bounded_and_reported() {
    let mut decoder = EntityDecoder::new(CREST);
    let curve = decoder.decode_by_id(17).unwrap();
    let alignment = AlignmentCurve::parse(&curve, &mut decoder).unwrap().unwrap();

    let mut stations = vec![0.0];
    assert!(!refine_span(&alignment, 0.0, 200.0, CHORD_TOL_M, 3, &mut stations));
    assert_eq!(stations.len(), 1 + 4, "{stations:?}");
    let points: Vec<_> = stations.iter().map(|&s| alignment.evaluate(s).origin).collect();
    assert!(worst_chord_error(&points, crest_elevation) > CHORD_TOL_M);

    let mut stations = vec![0.0];
    assert!(refine_span(&alignment, 0.0, 200.0, CHORD_TOL_M, MAX_SPAN_SPLITS, &mut stations));
    assert_eq!(stations.len(), 1 + 64);
}
