// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `alignment.rs`, split out per the house pattern for
//! modules whose bulk is test code so the production module stays inside
//! its module-size ratchet budget.

use super::*;

/// Sanity-check straight-line evaluation: a line segment heading
/// along +X must reach `(length, 0)` with unchanged heading.
#[test]
fn line_segment_evaluation() {
    let seg = HSeg::Line {
        sx: 0.0,
        sy: 0.0,
        heading: 0.0,
        length: 10.0,
        cum_start: 0.0,
    };
    let (x, y, h) = h_eval(&seg, 10.0);
    assert!((x - 10.0).abs() < 1e-9);
    assert!(y.abs() < 1e-9);
    assert!(h.abs() < 1e-9);
}

/// Reproduce the issue #828 bridge fixture's first arc: start at
/// origin, heading 13.36° (= 0.2332 rad), radius 9279, length 2965.68,
/// CW. Per the file, the next segment starts at #103=(2945.13,216.39),
/// so the arc end must land there within rounding error.
#[test]
fn fixture_828_arc_endpoint() {
    let seg = HSeg::Arc {
        sx: 0.0,
        sy: 0.0,
        heading: 13.35833333_f64.to_radians(),
        radius: 9279.0,
        length: 2965.68,
        ccw: false,
        cum_start: 0.0,
    };
    let (x, y, _) = h_eval(&seg, 2965.68);
    // ~5-inch tolerance accounts for the truncated 13.358333° heading
    // in the source file.
    assert!((x - 2945.13).abs() < 5.0, "x = {} expected ~2945.13", x);
    assert!((y - 216.39).abs() < 5.0, "y = {} expected ~216.39", y);
}

/// Base placement frame on a straight directrix: right = (0, -1, 0),
/// up = (0, 0, 1). `cant_angle` is a stable 0 stub (cant is not
/// wired through the parser), so the processor's roll step is a
/// no-op at every station.
#[test]
fn base_frame_axes_and_cant_stub() {
    // Straight directrix along +X, no slope.
    let curve = AlignmentCurve {
        horizontal: vec![HSeg::Line {
            sx: 0.0,
            sy: 0.0,
            heading: 0.0,
            length: 100.0,
            cum_start: 0.0,
        }],
        vertical: vec![],
    };
    let frame = curve.evaluate(50.0);
    assert!((frame.right.x).abs() < 1e-9);
    assert!((frame.right.y + 1.0).abs() < 1e-9);
    assert!((frame.up.z - 1.0).abs() < 1e-9);
    // Cant is a fixed-0 stub regardless of station.
    assert!(curve.cant_angle(50.0).abs() < 1e-9);
    assert!(curve.cant_angle(150.0).abs() < 1e-9);
}

/// `from_polyline` builds a piecewise-linear directrix. Each edge
/// becomes one horizontal Line segment + one vertical Line segment;
/// `evaluate(station)` walks them in order.
#[test]
fn polyline_directrix_evaluates_piecewise() {
    // Build a 3-point polyline directly (we test the construction
    // logic, not the parsing — that's covered by integration tests).
    // Path: (0,0,0) → (10, 0, 1) → (10, 10, 2)
    // Edge 1: heading 0, length 10, gradient 0.1
    // Edge 2: heading π/2, length 10, gradient 0.1
    let curve = AlignmentCurve {
        horizontal: vec![
            HSeg::Line {
                sx: 0.0,
                sy: 0.0,
                heading: 0.0,
                length: 10.0,
                cum_start: 0.0,
            },
            HSeg::Line {
                sx: 10.0,
                sy: 0.0,
                heading: std::f64::consts::FRAC_PI_2,
                length: 10.0,
                cum_start: 10.0,
            },
        ],
        vertical: vec![
            VSeg::Line {
                start: 0.0,
                length: 10.0,
                h0: 0.0,
                g0: 0.1,
            },
            VSeg::Line {
                start: 10.0,
                length: 10.0,
                h0: 1.0,
                g0: 0.1,
            },
        ],
    };
    // Mid-point of edge 1: station 5.
    let f1 = curve.evaluate(5.0);
    assert!((f1.origin.x - 5.0).abs() < 1e-9);
    assert!((f1.origin.y).abs() < 1e-9);
    assert!((f1.origin.z - 0.5).abs() < 1e-9);
    // Mid-point of edge 2: station 15.
    let f2 = curve.evaluate(15.0);
    assert!((f2.origin.x - 10.0).abs() < 1e-9);
    assert!((f2.origin.y - 5.0).abs() < 1e-9);
    assert!((f2.origin.z - 1.5).abs() < 1e-9);
}

#[test]
fn transition_kind_heading_integral_normalised() {
    // g(0) = 0, g(1) ∈ [0.4, 0.6] (depends on profile — all the
    // smoothstep-like profiles have ½ for the integral at the
    // midpoint, and the clothoid has ½ exactly).
    for kind in [
        TransitionKind::Clothoid,
        TransitionKind::Bloss,
        TransitionKind::Cosine,
        TransitionKind::Sine,
        TransitionKind::CubicParabola,
        TransitionKind::BiquadraticParabola,
    ] {
        assert!(kind.heading_integral(0.0).abs() < 1e-12, "{:?}", kind);
        let mid = kind.heading_integral(0.5);
        assert!(mid > 0.0 && mid < 0.5, "{:?} mid={}", kind, mid);
        // Clothoid: ½ · u² → ½ · 1 = ½ at u=1.
        // Bloss / others: each peaks below ½ as a smooth blend.
        let end = kind.heading_integral(1.0);
        assert!(end > 0.0 && end < 1.0, "{:?} end={}", kind, end);
    }
}

#[test]
fn parabolic_vertical_segment() {
    // From fixture #95: K=36000, sag (IsConvex=false), start gradient
    // 0.0579, start height 399. At local distance 1680:
    //   z = 399 + 0.0579·1680 + 1680²/(2·36000)
    //     = 399 + 97.272 + 39.20  = 535.47
    let seg = VSeg::Parabolic {
        start: 3600.0,
        length: 3685.68,
        h0: 399.0,
        g0: 0.0579,
        parabola_constant: 36000.0,
        is_convex: false,
    };
    let (z, slope) = v_eval(&seg, 1680.0);
    assert!((z - 535.472).abs() < 0.01, "z = {}", z);
    assert!((slope - 0.1046).abs() < 1e-3, "slope = {}", slope);
}

/// Regression: an alignment whose `IfcAlignment2DHorizontal.StartDistAlong`
/// is a nonzero chainage (1000) must keep its horizontal and vertical
/// evaluation in the same station domain. The horizontal geometry is
/// indexed from station 0, but the vertical segment's `StartDistAlong`
/// is authored as the absolute chainage 1000; without rebasing the two
/// axes desync and the vertical lookup clamps to the segment's start
/// height everywhere.
///
/// Physical setup: a 100 m straight along +X, rising at grade 0.1 from
/// height 50. At the halfway station the horizontal position is x = 50,
/// so the elevation must be the halfway grade value 50 + 0.1·50 = 55.
///
/// Pre-fix (no rebasing) the vertical segment sits at station 1000 while
/// the input station is 50, so `evaluate_vertical(50)` clamped into it
/// and returned the start height 50 — disagreeing with the horizontal
/// axis about where "halfway" is. This assertion fails on main.
#[test]
fn nonzero_start_dist_along_rebases_vertical_to_horizontal() {
    let content = "\
ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X1'));
ENDSEC;
DATA;
#10=IFCCARTESIANPOINT((0.,0.));
#11=IFCLINESEGMENT2D(#10,0.,100.);
#12=IFCALIGNMENT2DHORIZONTALSEGMENT($,$,$,#11);
#13=IFCALIGNMENT2DHORIZONTAL(1000.,(#12));
#14=IFCALIGNMENT2DVERSEGLINE($,$,$,1000.,100.,50.,0.1);
#15=IFCALIGNMENT2DVERTICAL((#14));
#16=IFCALIGNMENTCURVE(#13,#15,$);
ENDSEC;
END-ISO-10303-21;
";
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let directrix = decoder.decode_by_id(16).expect("decode IfcAlignmentCurve");
    let curve = AlignmentCurve::parse(&directrix, &mut decoder)
        .expect("parse alignment")
        .expect("directrix recognised as alignment");

    // Station 0 (physical start): x = 0, z = start height 50.
    let f0 = curve.evaluate(0.0);
    assert!((f0.origin.x - 0.0).abs() < 1e-6, "start x = {}", f0.origin.x);
    assert!((f0.origin.z - 50.0).abs() < 1e-6, "start z = {}", f0.origin.z);

    // Station 50 (halfway): horizontal x = 50, so elevation must be
    // 50 + 0.1·50 = 55. On main this returns 50 (clamped) and fails.
    let f_mid = curve.evaluate(50.0);
    assert!((f_mid.origin.x - 50.0).abs() < 1e-6, "mid x = {}", f_mid.origin.x);
    assert!(
        (f_mid.origin.z - 55.0).abs() < 1e-6,
        "mid z = {} (expected 55; main desyncs vertical and returns ~50)",
        f_mid.origin.z,
    );

    // Station 100 (physical end): x = 100, z = 60.
    let f_end = curve.evaluate(100.0);
    assert!((f_end.origin.x - 100.0).abs() < 1e-6, "end x = {}", f_end.origin.x);
    assert!((f_end.origin.z - 60.0).abs() < 1e-6, "end z = {}", f_end.origin.z);
}

/// A negative SegmentLength drives (station - cum).min(length) negative and
/// emits NaN world coordinates. It must be rejected as an Err at parse time.
/// (Zero-length stubs stay legal; only negative/non-finite is rejected.)
#[test]
fn negative_segment_length_errors_not_nan() {
    let content = "\
ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X1'));
ENDSEC;
DATA;
#10=IFCCARTESIANPOINT((0.,0.));
#11=IFCLINESEGMENT2D(#10,0.,-100.);
#12=IFCALIGNMENT2DHORIZONTALSEGMENT($,$,$,#11);
#13=IFCALIGNMENT2DHORIZONTAL(0.,(#12));
#14=IFCALIGNMENT2DVERSEGLINE($,$,$,0.,100.,50.,0.1);
#15=IFCALIGNMENT2DVERTICAL((#14));
#16=IFCALIGNMENTCURVE(#13,#15,$);
ENDSEC;
END-ISO-10303-21;
";
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let directrix = decoder.decode_by_id(16).expect("decode IfcAlignmentCurve");
    assert!(AlignmentCurve::parse(&directrix, &mut decoder).is_err());
}

/// A station BEFORE the first vertical segment extrapolates from the FIRST
/// segment's entry, not the last segment's exit. The reported fixture: a
/// 900 m straight whose vertical profile is authored from station 100
/// onward (flat at 10 to station 500, then rising at 5 % to 30 at 900).
/// Station 0 came back as -15 (= 30 - 0.05 * 900, the last exit grade run
/// backwards over the whole alignment) with the last segment's slope,
/// where 10 and grade 0 are right.
#[test]
fn station_before_first_vertical_segment_extrapolates_from_the_first_segment() {
    let content = "\
ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X1'));
ENDSEC;
DATA;
#10=IFCCARTESIANPOINT((0.,0.));
#11=IFCLINESEGMENT2D(#10,0.,900.);
#12=IFCALIGNMENT2DHORIZONTALSEGMENT($,$,$,#11);
#13=IFCALIGNMENT2DHORIZONTAL(0.,(#12));
#14=IFCALIGNMENT2DVERSEGLINE($,$,$,100.,400.,10.,0.);
#15=IFCALIGNMENT2DVERSEGLINE($,$,$,500.,400.,10.,0.05);
#16=IFCALIGNMENT2DVERTICAL((#14,#15));
#17=IFCALIGNMENTCURVE(#13,#16,$);
ENDSEC;
END-ISO-10303-21;
";
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let directrix = decoder.decode_by_id(17).expect("decode IfcAlignmentCurve");
    let curve = AlignmentCurve::parse(&directrix, &mut decoder)
        .expect("parse alignment")
        .expect("directrix recognised as alignment");

    // Control: the covered stretch and the past-the-end extrapolation are
    // unchanged (station 950 runs the LAST exit grade forwards).
    assert!((curve.evaluate(100.0).origin.z - 10.0).abs() < 1e-9);
    assert!((curve.evaluate(700.0).origin.z - 20.0).abs() < 1e-9);
    assert!((curve.evaluate(950.0).origin.z - 32.5).abs() < 1e-9);

    for station in [0.0, 50.0, 99.0] {
        let frame = curve.evaluate(station);
        assert!(
            (frame.origin.z - 10.0).abs() < 1e-9,
            "station {station}: z = {} (last-exit extrapolation gives {})",
            frame.origin.z,
            30.0 - 0.05 * (900.0 - station),
        );
        assert!(
            frame.tangent.z.abs() < 1e-9,
            "station {station}: slope must be the FIRST segment's 0, got tangent.z = {}",
            frame.tangent.z,
        );
    }
}

/// A station in a GAP between vertical segments extrapolates from the
/// nearer bracketing end: forwards from the previous exit when that is
/// closer, backwards from the next entry when that is.
#[test]
fn station_in_a_vertical_gap_uses_the_nearer_bracketing_segment() {
    let curve = AlignmentCurve {
        horizontal: vec![HSeg::Line {
            sx: 0.0,
            sy: 0.0,
            heading: 0.0,
            length: 400.0,
            cum_start: 0.0,
        }],
        vertical: vec![
            // Ends at station 100, z = 10, grade 0.1.
            VSeg::Line {
                start: 0.0,
                length: 100.0,
                h0: 0.0,
                g0: 0.1,
            },
            // Starts at station 300, z = 50, flat.
            VSeg::Line {
                start: 300.0,
                length: 100.0,
                h0: 50.0,
                g0: 0.0,
            },
        ],
    };
    // 50 past the first exit, 150 before the second entry: first wins.
    let near_first = curve.evaluate(150.0);
    assert!((near_first.origin.z - 15.0).abs() < 1e-9, "z = {}", near_first.origin.z);
    assert!((near_first.tangent.z - 0.1 / (1.0f64 + 0.01).sqrt()).abs() < 1e-9);
    // 180 past the first exit, 20 before the second entry: second wins.
    let near_second = curve.evaluate(280.0);
    assert!((near_second.origin.z - 50.0).abs() < 1e-9, "z = {}", near_second.origin.z);
    assert!(near_second.tangent.z.abs() < 1e-9);
}

/// A zero-length `IfcTransitionCurveSegment2D` (a stationing stub the
/// parser deliberately allows) divided by its length and evaluated to NaN
/// position and heading at station 0. It has no extent: it is its start.
#[test]
fn zero_length_transition_segment_evaluates_to_its_start_not_nan() {
    let content = "\
ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X1'));
ENDSEC;
DATA;
#10=IFCCARTESIANPOINT((5.,7.));
#11=IFCTRANSITIONCURVESEGMENT2D(#10,0.,0.,$,100.,.T.,.T.,.CLOTHOIDCURVE.);
#12=IFCALIGNMENT2DHORIZONTALSEGMENT($,$,$,#11);
#20=IFCLINESEGMENT2D(#10,0.,100.);
#21=IFCALIGNMENT2DHORIZONTALSEGMENT($,$,$,#20);
#13=IFCALIGNMENT2DHORIZONTAL(0.,(#12,#21));
#14=IFCALIGNMENT2DVERSEGLINE($,$,$,0.,100.,0.,0.);
#15=IFCALIGNMENT2DVERTICAL((#14));
#16=IFCALIGNMENTCURVE(#13,#15,$);
ENDSEC;
END-ISO-10303-21;
";
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let directrix = decoder.decode_by_id(16).expect("decode IfcAlignmentCurve");
    let curve = AlignmentCurve::parse(&directrix, &mut decoder)
        .expect("zero-length stubs are accepted at parse time")
        .expect("directrix recognised as alignment");

    // Station 0 matches the stub (0 <= 0 + 1e-9) and evaluates it.
    let f0 = curve.evaluate(0.0);
    assert!(
        f0.origin.x.is_finite() && f0.origin.y.is_finite() && f0.tangent.x.is_finite(),
        "station 0 must be finite, got origin {:?} tangent {:?}",
        f0.origin,
        f0.tangent
    );
    assert!((f0.origin.x - 5.0).abs() < 1e-9 && (f0.origin.y - 7.0).abs() < 1e-9);
    assert!((f0.tangent.x - 1.0).abs() < 1e-9, "heading 0 along +X");

    // The following line segment is unaffected.
    let f50 = curve.evaluate(50.0);
    assert!((f50.origin.x - 55.0).abs() < 1e-9 && (f50.origin.y - 7.0).abs() < 1e-9);
}

/// Direct check on the transition evaluator: a zero-length Transition
/// returns its start point and heading for every sampled arc length.
#[test]
fn h_eval_zero_length_transition_is_its_start() {
    let seg = HSeg::Transition {
        sx: 1.0,
        sy: 2.0,
        heading: 0.3,
        length: 0.0,
        start_curv: 0.0,
        end_curv: 0.01,
        kind: TransitionKind::Clothoid,
        cum_start: 0.0,
    };
    let (x, y, h) = h_eval(&seg, 0.0);
    assert_eq!((x, y, h), (1.0, 2.0, 0.3));
}
