// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression coverage for the #4901 B-spline curve degree bound. Split out
//! per the house pattern (`stream_meta.rs`) rather than inlined, so
//! `curves.rs` stays under the module-size ratchet.

use super::*;
use ifc_lite_core::EntityDecoder;
use std::time::{Duration, Instant};

/// `IfcBSplineCurveWithKnots(degree, (points...), .UNSPECIFIED., .F., .F.,
/// (mults...), (knots...))` — 3 control points, so a legitimate degree is 2.
fn curve_content(degree: usize) -> String {
    format!(
        r#"
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCCARTESIANPOINT((1.,1.,0.));
#3=IFCCARTESIANPOINT((2.,0.,0.));
#10=IFCBSPLINECURVEWITHKNOTS({degree},(#1,#2,#3),.UNSPECIFIED.,.F.,.F.,(3,3),(0.,1.));
"#
    )
}

/// Baseline: a legitimate degree-2, 3-control-point curve still samples
/// interior points, proving the #4901 bound doesn't touch real output.
#[test]
fn legitimate_bspline_curve_still_samples() {
    let content = curve_content(2);
    let mut decoder = EntityDecoder::new(&content);
    let curve = decoder.decode_by_id(10).unwrap();
    let start = Point3::new(0.0, 0.0, 0.0);
    let pts = sample_bspline_edge_curve(&curve, &start, true, &mut decoder, TessellationQuality::Medium).unwrap();
    assert!(pts.len() > 1, "a real B-spline edge must sample interior points, got {pts:?}");
}

/// #4901: a file-supplied `Degree` far past any practical NURBS must degrade
/// to the single start vertex FAST, not spend seconds in the (formerly
/// non-memoized, exponential) Cox-de Boor recursion.
#[test]
fn pathological_curve_degree_fails_fast_not_hangs() {
    let content = curve_content(999_999);
    let mut decoder = EntityDecoder::new(&content);
    let curve = decoder.decode_by_id(10).unwrap();
    let start = Point3::new(0.0, 0.0, 0.0);

    let begin = Instant::now();
    let pts = sample_bspline_edge_curve(&curve, &start, true, &mut decoder, TessellationQuality::Medium).unwrap();
    let elapsed = begin.elapsed();

    assert_eq!(pts, vec![start], "a degree past MAX_BSPLINE_DEGREE must degrade to the start vertex");
    assert!(
        elapsed < Duration::from_secs(2),
        "pathological curve degree must fail within the deterministic bound, took {elapsed:?}"
    );
}

/// #4901 review: degree exactly ONE past the bound (65, `MAX_BSPLINE_DEGREE`
/// is 64) must reject too, not just an absurd degree — pins the boundary,
/// not just "some huge number works".
#[test]
fn degree_one_past_the_bound_is_rejected() {
    let content = curve_content(65);
    let mut decoder = EntityDecoder::new(&content);
    let curve = decoder.decode_by_id(10).unwrap();
    let start = Point3::new(0.0, 0.0, 0.0);

    let pts = sample_bspline_edge_curve(&curve, &start, true, &mut decoder, TessellationQuality::Medium).unwrap();
    assert_eq!(pts, vec![start], "degree 65 (MAX_BSPLINE_DEGREE + 1) must be rejected");
}

/// #4901 review: a `ControlPointsList` naming ONE MILLION points must be
/// rejected before any of them is decoded — none of the referenced entities
/// exist in this file at all, so a version of this check that ran AFTER
/// decoding (or that decoded even one of them) would hit an unresolved-
/// reference error instead of the typed degree/point-count rejection,
/// proving the raw (undecoded) list length is what trips it.
#[test]
fn one_million_control_points_rejected_before_decode() {
    let refs: String = (1..=1_000_000).map(|i| format!("#{i}")).collect::<Vec<_>>().join(",");
    let content = format!(
        "#10=IFCBSPLINECURVEWITHKNOTS(2,({refs}),.UNSPECIFIED.,.F.,.F.,(3,3),(0.,1.));\n"
    );
    let mut decoder = EntityDecoder::new(&content);
    let curve = decoder.decode_by_id(10).unwrap();
    let start = Point3::new(0.0, 0.0, 0.0);

    let begin = Instant::now();
    let pts = sample_bspline_edge_curve(&curve, &start, true, &mut decoder, TessellationQuality::Medium).unwrap();
    let elapsed = begin.elapsed();

    assert_eq!(
        pts,
        vec![start],
        "a control-point list past MAX_BSPLINE_CURVE_CONTROL_POINTS must be rejected"
    );
    assert!(
        elapsed < Duration::from_secs(2),
        "a million-reference list must be rejected fast (before any decode attempt), took {elapsed:?}"
    );
}

/// A degree-2 rational curve over (0,0,0), (1,1,0), (2,0,0) with `weights`
/// written as the WeightsData attribute (index 8).
fn rational_content(weights: &str) -> String {
    format!(
        r#"
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCCARTESIANPOINT((1.,1.,0.));
#3=IFCCARTESIANPOINT((2.,0.,0.));
#10=IFCRATIONALBSPLINECURVEWITHKNOTS(2,(#1,#2,#3),.UNSPECIFIED.,.F.,.F.,(3,3),(0.,1.),.UNSPECIFIED.,{weights});
"#
    )
}

/// #7750: the rational curve was sampled unweighted. With weights (1,2,1) the
/// conic's midpoint is (P0 + 2*2*P1 + P2) / (1 + 4 + 1) = (1, 2/3), not the
/// plain B-spline's (1, 1/2).
#[test]
fn rational_curve_is_sampled_with_its_weights_7750() {
    let content = rational_content("(1.,2.,1.)");
    let mut decoder = EntityDecoder::new(&content);
    let curve = decoder.decode_by_id(10).unwrap();
    let parsed = parse_bspline_curve(&curve, &mut decoder).ok().flatten().expect("readable rational curve");
    let mid = parsed.at(0.5);
    assert!((mid - Point3::new(1.0, 2.0 / 3.0, 0.0)).norm() < 1e-12, "midpoint {mid:?}");
    // The clamped ends are interpolated either way.
    assert!((parsed.at(0.0) - Point3::new(0.0, 0.0, 0.0)).norm() < 1e-12);
    assert!((parsed.at(1.0) - Point3::new(2.0, 0.0, 0.0)).norm() < 1e-12);

    // Every sampled point lies on the weighted curve, which the unweighted
    // parabola fails.
    let pts = sample_bspline_curve_polyline(&curve, &mut decoder, TessellationQuality::Medium).unwrap();
    assert!(pts.len() > 4);
    for p in &pts {
        // Rational Bezier with weights (1,w,1) over (0,0),(1,1),(2,0):
        // x = (2 w t (1-t) + 2 t^2) / d, y = 2 w t (1-t) / d,
        // d = (1-t)^2 + 2 w t (1-t) + t^2. Find t from x, compare y.
        let w = 2.0;
        let t = (0..=100_000)
            .map(|i| i as f64 / 100_000.0)
            .min_by(|a, b| {
                let fx = |t: f64| {
                    let d = (1.0 - t).powi(2) + 2.0 * w * t * (1.0 - t) + t * t;
                    (2.0 * w * t * (1.0 - t) + 2.0 * t * t) / d
                };
                (fx(*a) - p.x).abs().total_cmp(&(fx(*b) - p.x).abs())
            })
            .unwrap();
        let d = (1.0 - t).powi(2) + 2.0 * w * t * (1.0 - t) + t * t;
        let y = 2.0 * w * t * (1.0 - t) / d;
        assert!((p.y - y).abs() < 1e-4, "{p:?} is off the weighted curve (y {y})");
    }
}

/// WeightsData is mandatory, finite and positive, one per control point
/// (the surface rule, #7687): anything else refuses the curve rather than
/// sampling it unweighted.
#[test]
fn malformed_rational_weights_refuse_the_curve_7750() {
    for weights in ["(1.,2.)", "(1.,2.,1.,1.)", "(1.,0.,1.)", "(1.,-2.,1.)", "(1.,$,1.)", "(1.,1.E999,1.)", "$"] {
        let content = rational_content(weights);
        let mut decoder = EntityDecoder::new(&content);
        let curve = decoder.decode_by_id(10).unwrap();
        assert!(
            parse_bspline_curve(&curve, &mut decoder).is_err(),
            "weights {weights} must refuse the curve"
        );
    }
}

/// The plain curve has no weights and must not start refusing for lack of them.
#[test]
fn plain_curve_needs_no_weights_7750() {
    let content = curve_content(2);
    let mut decoder = EntityDecoder::new(&content);
    let curve = decoder.decode_by_id(10).unwrap();
    assert!(matches!(parse_bspline_curve(&curve, &mut decoder), Ok(Some(_))));
}
