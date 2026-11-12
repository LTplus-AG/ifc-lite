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

fn samples(source: &str, id: u32, start: Option<CurveMeasure>, end: Option<CurveMeasure>) -> Result<DirectrixSamples> {
    let mut decoder = EntityDecoder::new(source);
    let curve = decoder.decode_by_id(id).unwrap();
    ProfileProcessor::new(IfcSchema::new()).get_directrix_samples(
        &curve,
        &mut decoder,
        start,
        end,
        TessellationQuality::Medium,
    )
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

/// Every sample of an `IfcGradientCurve` directrix lies on the vertical
/// profile, and no chord strays more than `CHORD_TOL_M` from it. The
/// plain-curve path returned the flat BaseCurve (z = 0) here.
#[test]
fn gradient_directrix_samples_lie_on_the_profile_within_chord_tolerance() {
    let samples = samples(CREST, 17, None, None).unwrap();
    let points = &samples.points;
    assert!(points[0].x.abs() < 1e-9 && (points.last().unwrap().x - 400.0).abs() < 1e-9);
    for p in points {
        assert!(p.y.abs() < 1e-9);
        assert!((p.z - crest_elevation(p.x)).abs() < 1e-9, "{p:?}");
    }
    assert!(worst_chord_error(points, crest_elevation) <= CHORD_TOL_M, "{}", worst_chord_error(points, crest_elevation));
    // The parabola's 1 m sag is halved six times (sag / 4^6 = 0.24 mm); the
    // line after it stays one chord.
    assert_eq!(points.len(), 64 + 2);
}

/// The evaluated tangent at each sample is the unit 3D tangent of the
/// curve, not a chord direction: (1, 0, grade) normalised.
#[test]
fn gradient_directrix_carries_the_evaluated_tangents() {
    let samples = samples(CREST, 17, None, None).unwrap();
    let tangents = samples.tangents.expect("a gradient directrix has evaluated tangents");
    assert_eq!(tangents.len(), samples.points.len());
    for (p, t) in samples.points.iter().zip(&tangents) {
        let grade = if p.x <= 200.0 { 0.02 - 2e-4 * p.x } else { -0.02 };
        let expected = Vector3::new(1.0, 0.0, grade).normalize();
        assert!((t - expected).norm() < 1e-9, "{p:?}: {t:?}");
    }
}

/// A parameter bound is the BaseCurve's parameter: horizontal distance.
#[test]
fn parameter_trimmed_gradient_directrix_starts_and_ends_at_the_parameters() {
    let samples = samples(CREST, 17, Some(CurveMeasure::Parameter(150.0)), Some(CurveMeasure::Parameter(300.0))).unwrap();
    let (first, last) = (samples.points[0], *samples.points.last().unwrap());
    assert!((first.x - 150.0).abs() < 1e-9 && (first.z - crest_elevation(150.0)).abs() < 1e-9);
    assert!((last.x - 300.0).abs() < 1e-9 && (last.z - 98.0).abs() < 1e-9);
    assert!(samples.points.windows(2).all(|pair| pair[1].x > pair[0].x));
}

/// A 1000 m plan under a constant 10 % grade, on a BaseCurve given as
/// `base` (#7) with its segment entities.
fn steep(base: &str) -> String {
    format!(
        "#1=IFCCARTESIANPOINT((0.,0.));\n\
        #2=IFCDIRECTION((1.,0.));\n\
        #3=IFCVECTOR(#2,1.);\n\
        #4=IFCLINE(#1,#3);\n\
        #5=IFCAXIS2PLACEMENT2D(#1,#2);\n\
        {base}\n\
        #8=IFCCARTESIANPOINT((0.,100.));\n\
        #9=IFCDIRECTION((1.,0.1));\n\
        #10=IFCAXIS2PLACEMENT2D(#8,#9);\n\
        #11=IFCCURVESEGMENT(.CONTINUOUS.,#10,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(1100.),#4);\n\
        #12=IFCGRADIENTCURVE((#11),.F.,#7,$);"
    )
}

const COMPOSITE_BASE: &str = "#6=IFCCURVESEGMENT(.CONTINUOUS.,#5,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(1000.),#4);\n\
    #7=IFCCOMPOSITECURVE((#6),.F.);";
const POLYLINE_BASE: &str = "#13=IFCCARTESIANPOINT((1000.,0.));\n#7=IFCPOLYLINE((#1,#13));";

/// A length bound is measured along the 3D curve: on a 10 % grade 600 m
/// along it is 600 / sqrt(1.01) = 597.022 m along the plan. Lengths do not
/// depend on the BaseCurve's parameterisation, so a polyline base works too.
#[test]
fn length_trimmed_gradient_directrix_measures_along_the_slope() {
    for base in [COMPOSITE_BASE, POLYLINE_BASE] {
        let source = steep(base);
        let samples = samples(&source, 12, Some(CurveMeasure::Length(300.0)), Some(CurveMeasure::Length(600.0))).unwrap();
        let (first, last) = (samples.points[0], *samples.points.last().unwrap());
        assert!((first.x - 298.511).abs() < 1e-3, "{first:?}");
        assert!((last.x - 597.022).abs() < 1e-3, "{last:?}");
        assert!((last.z - (100.0 + 0.1 * last.x)).abs() < 1e-9, "{last:?}");
    }
}

/// The parameter of a 2-point IfcPolyline BaseCurve is 0..1 over its 1000 m,
/// not distance. That mapping is not read here, so parameter bounds on it
/// are refused rather than cut at 0.3..0.6 m. Unbounded, it still sweeps.
#[test]
fn parameter_trim_on_a_base_that_is_not_measured_by_distance_is_refused() {
    let source = steep(POLYLINE_BASE);
    assert!(samples(&source, 12, Some(CurveMeasure::Parameter(0.3)), Some(CurveMeasure::Parameter(0.6))).is_err());
    let whole = samples(&source, 12, None, None).unwrap();
    assert!((whole.points.last().unwrap().z - 200.0).abs() < 1e-9);
}

/// A final circular vertical segment (R 100 m, level start, 100 m of arc,
/// so 84.147 m of plan and a 57° end grade) has a curvature in station that
/// grows towards its end. Its chords still stay within tolerance, then the
/// line beyond it continues on the end grade.
#[test]
fn steep_circular_profile_stays_within_chord_tolerance() {
    let source = "#1=IFCCARTESIANPOINT((0.,0.));\n\
        #2=IFCDIRECTION((1.,0.));\n\
        #3=IFCVECTOR(#2,1.);\n\
        #4=IFCLINE(#1,#3);\n\
        #5=IFCAXIS2PLACEMENT2D(#1,#2);\n\
        #6=IFCCURVESEGMENT(.CONTINUOUS.,#5,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(200.),#4);\n\
        #7=IFCCOMPOSITECURVE((#6),.F.);\n\
        #8=IFCCARTESIANPOINT((0.,100.));\n\
        #10=IFCAXIS2PLACEMENT2D(#8,#2);\n\
        #11=IFCCIRCLE(#5,100.);\n\
        #12=IFCCURVESEGMENT(.CONTINUOUS.,#10,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(100.),#11);\n\
        #13=IFCGRADIENTCURVE((#12),.F.,#7,$);";
    let end = 100.0 * 1.0_f64.sin();
    let profile = |s: f64| {
        if s <= end {
            100.0 + 100.0 * (1.0 - (1.0 - (s / 100.0).powi(2)).sqrt())
        } else {
            100.0 + 100.0 * (1.0 - 1.0_f64.cos()) + 1.0_f64.tan() * (s - end)
        }
    };
    let samples = samples(source, 13, None, None).unwrap();
    for p in &samples.points {
        assert!((p.z - profile(p.x)).abs() < 1e-6, "{p:?}");
    }
    let worst = worst_chord_error(&samples.points, profile);
    assert!(worst <= CHORD_TOL_M, "{worst}");
}
