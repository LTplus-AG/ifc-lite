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
    let pts = sample_bspline_edge_curve(&curve, &start, true, &mut decoder, TessellationQuality::Medium);
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
    let pts = sample_bspline_edge_curve(&curve, &start, true, &mut decoder, TessellationQuality::Medium);
    let elapsed = begin.elapsed();

    assert_eq!(pts, vec![start], "a degree past MAX_BSPLINE_DEGREE must degrade to the start vertex");
    assert!(
        elapsed < Duration::from_secs(2),
        "pathological curve degree must fail within the deterministic bound, took {elapsed:?}"
    );
}
