// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `profiles::simplify` (split out of `simplify.rs`; `*_tests.rs`
//! is module-size-ratchet exempt).

use super::*;

#[test]
fn closed_loop_self_intersects_detects_bowtie() {
    // Simple unit square — no crossings.
    let square = [
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        Point2::new(1.0, 1.0),
        Point2::new(0.0, 1.0),
    ];
    assert!(!closed_loop_self_intersects(&square));

    // Bow-tie: swapping the last two vertices makes the closing edges
    // cross in the middle.
    let bowtie = [
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        Point2::new(0.0, 1.0),
        Point2::new(1.0, 1.0),
    ];
    assert!(closed_loop_self_intersects(&bowtie));

    // Degenerate (fewer than 4 vertices) can't self-cross.
    assert!(!closed_loop_self_intersects(&square[..3]));
}

/// Build a dense closed loop for a thin annular sector centred at
/// (0, -radius) (the issue #820 topology): an outer arc at `radius` and an
/// inner arc at `radius - thickness`, swept `span` radians and joined by
/// short radial caps. `seg` samples per arc.
fn annular_sector_loop(radius: f64, thickness: f64, span: f64, seg: usize) -> Vec<Point2<f64>> {
    let c = Point2::new(0.0, -radius);
    let mut loop_ = Vec::with_capacity(2 * seg + 2);
    for i in 0..=seg {
        let a = -span / 2.0 + span * (i as f64 / seg as f64);
        loop_.push(Point2::new(c.x + radius * a.cos(), c.y + radius * a.sin()));
    }
    let inner = radius - thickness;
    for i in 0..=seg {
        let a = span / 2.0 - span * (i as f64 / seg as f64);
        loop_.push(Point2::new(c.x + inner * a.cos(), c.y + inner * a.sin()));
    }
    loop_
}

fn loop_area(loop_: &[Point2<f64>]) -> f64 {
    let n = loop_.len();
    let mut a = 0.0;
    for i in 0..n {
        let p = loop_[i];
        let q = loop_[(i + 1) % n];
        a += p.x * q.y - q.x * p.y;
    }
    (a * 0.5).abs()
}

#[test]
fn simplify_thin_annular_sector_stays_simple_and_area_preserving() {
    // Regression for issue #820 *and* the silent-area-distortion class the
    // review flagged. A thin curved wall has a feature size (its thickness)
    // far below the bbox diagonal; the thickness-capped RDP epsilon must
    // keep every simplification both topologically simple (no folded-flap
    // seam) and area-faithful. The first row is the real fixture's
    // proportions (r=12000, 100 mm, 240°); the rest are the thicker/shorter
    // sectors the reviewer reproduced losing/gaining 5–13% area under the
    // un-capped epsilon.
    let cases = [
        (12000.0, 100.0, 240.0_f64),
        (12000.0, 300.0, 240.0),
        (12000.0, 600.0, 90.0),
        (12000.0, 600.0, 180.0),
    ];
    for (radius, thickness, span_deg) in cases {
        let span = span_deg.to_radians();
        let dense = annular_sector_loop(radius, thickness, span, 200);
        assert!(
            !closed_loop_self_intersects(&dense),
            "input sector r={radius} t={thickness} {span_deg}° should start simple",
        );
        let out = simplify_smooth_curve_polyline(&dense, 1.0);

        // Topology: never a folded-flap seam.
        assert!(
            !closed_loop_self_intersects(&out),
            "simplified sector r={radius} t={thickness} {span_deg}° self-intersects",
        );

        // Area: within 2% of the dense original (was up to ±13% pre-fix).
        let (a_in, a_out) = (loop_area(&dense), loop_area(&out));
        let rel = (a_out - a_in).abs() / a_in;
        assert!(
            rel < 0.02,
            "sector r={radius} t={thickness} {span_deg}°: area drift {:.1}% \
                 (in={a_in:.0} out={a_out:.0}) — thin curved wall was distorted",
            rel * 100.0,
        );
    }
}

#[test]
fn simplify_still_reduces_fat_round_disk() {
    // Guards THIN_FEATURE_RATIO from being set so high it suppresses the
    // issue #635 case it must preserve: an over-tessellated round window
    // (a *fat* disk, half-thickness ≈ radius/2) must still simplify to a
    // small recognizable polygon so void cuts fit the CSG polygon budget.
    let mut disk = Vec::new();
    let seg = 127;
    for i in 0..seg {
        let a = std::f64::consts::TAU * (i as f64 / seg as f64);
        disk.push(Point2::new(0.5 * a.cos(), 0.5 * a.sin()));
    }
    let out = simplify_smooth_curve_polyline(&disk, 1.0);
    assert!(
        out.len() < disk.len() && out.len() >= SIMPLIFIED_MIN_VERTICES,
        "round disk should simplify from {} to [{SIMPLIFIED_MIN_VERTICES}, {}) verts, got {}",
        disk.len(),
        disk.len(),
        out.len(),
    );
    assert!(!closed_loop_self_intersects(&out));
}

fn ellipse_loop(ar: f64, seg: usize) -> Vec<Point2<f64>> {
    let (a, b) = (ar * 0.5, 0.5);
    (0..seg)
        .map(|i| {
            let t = std::f64::consts::TAU * (i as f64 / seg as f64);
            Point2::new(a * t.cos(), b * t.sin())
        })
        .collect()
}

#[test]
fn elongated_filled_ellipse_is_not_thin_gated() {
    // Regression for the review's P1. An elongated *filled* ellipse is thin
    // by the half-thickness/diagonal measure (an 8:1 ellipse sits at ~0.048,
    // below THIN_FEATURE_RATIO, rising to ~0.020 at 20:1) — but it is convex
    // and does NOT double back, so the thin gate must not fire on it. The
    // earlier thinness-only gate wrongly skipped these, pinning a densely
    // sampled elliptical opening at its full vertex count, overflowing the
    // BSP void-cut budget and forcing the AABB-rectangle fallback (#635).
    for ar in [6.0_f64, 8.0, 12.0, 20.0] {
        assert!(
            !loop_doubles_back(&ellipse_loop(ar, 128)),
            "AR={ar} filled ellipse is convex — must not read as doubling back",
        );
    }

    // With the gate no longer blocking it, an elongated ellipse simplifies
    // exactly as it does without any thin gate (i.e. as on main): RDP +
    // SIMPLIFIED_MIN_VERTICES. At 8:1, RDP retains ≥ the floor, so it
    // genuinely reduces and stays simple. (Higher ratios bottom out at the
    // floor and keep the original — a pre-existing #635 limitation, not the
    // thin gate, and unchanged by this fix.)
    let ellipse = ellipse_loop(8.0, 128);
    let out = simplify_smooth_curve_polyline(&ellipse, 1.0);
    assert!(
        out.len() < ellipse.len() && out.len() >= SIMPLIFIED_MIN_VERTICES,
        "8:1 ellipse must still simplify (was wrongly thin-gated): {} -> {} verts",
        ellipse.len(),
        out.len(),
    );
    assert!(!closed_loop_self_intersects(&out));
    // Inscribed simplification of an elongated convex opening shaves a few
    // percent — acceptable for a void approximation (and the same as main).
    let rel = (loop_area(&out) - loop_area(&ellipse)).abs() / loop_area(&ellipse);
    assert!(rel < 0.08, "8:1 ellipse area drift {:.1}%", rel * 100.0);
}

#[test]
fn doubles_back_ignores_localized_spikes() {
    // The reflex-fraction metric must flag a genuine two-arc annular sector
    // but NOT a convex thin opening carrying a single localized defect — a
    // lone inward notch or the sub-mm out-and-back jog where a composite
    // curve closes. A total-turning measure double-counts such a spike and
    // would wrongly gate these convex openings back into the #635 AABB cut.

    // Genuine doubling-back: the #820 thin annular sector.
    assert!(loop_doubles_back(&annular_sector_loop(
        12000.0,
        100.0,
        (240.0_f64).to_radians(),
        128
    )));

    // Clean convex ellipse — not doubling back.
    let mut e = ellipse_loop(8.0, 128);
    assert!(!loop_doubles_back(&e));

    // ...with one deep inward notch at the blunt (x-tip) vertex. Find the
    // vertex of greatest |x| and pull it 25% of the minor axis toward centre.
    let tip = (0..e.len())
        .max_by(|&i, &j| e[i].x.abs().partial_cmp(&e[j].x.abs()).unwrap())
        .unwrap();
    e[tip].x *= 0.75;
    assert!(
        !loop_doubles_back(&e),
        "a single notch on a convex ellipse must not read as doubling back",
    );

    // Convex disk with a tiny out-and-back seam jog (a real, non-degenerate
    // near-coincident self-intersection of the kind the #820 seam leaves).
    let mut disk: Vec<Point2<f64>> = (0..128)
        .map(|i| {
            let t = std::f64::consts::TAU * (i as f64 / 128.0);
            Point2::new(t.cos(), t.sin())
        })
        .collect();
    // Insert a 1e-4 radial jog at vertex 0's neighbourhood.
    disk.insert(1, Point2::new(disk[0].x * 0.9999, disk[0].y * 0.9999));
    assert!(
        !loop_doubles_back(&disk),
        "a sub-mm seam jog on a convex loop must not read as doubling back",
    );
}

#[test]
fn doubles_back_independent_of_per_boundary_sampling_density() {
    // Codex review: measuring reflex VERTICES (not arc length) let a thin
    // sector slip when its two arcs are sampled at very different densities.
    // Their exact example: a 90° sector, r=12000, thickness=10, with the
    // convex outer arc finely sampled (96 segs) and the reflex inner arc
    // coarsely (16 segs). A count fraction reads ~0.13 (< gate) and the
    // wall is wrongly simplified to ~55% area drift; an arc-length fraction
    // reads ~0.5 because the inner and outer arcs are nearly equal LENGTH.
    let centre = Point2::new(0.0, -12000.0);
    let (r_out, r_in) = (12000.0, 12000.0 - 10.0);
    let span = (90.0_f64).to_radians();
    let mut loop_ = Vec::new();
    for i in 0..=96 {
        let a = -span / 2.0 + span * (i as f64 / 96.0);
        loop_.push(Point2::new(
            centre.x + r_out * a.cos(),
            centre.y + r_out * a.sin(),
        ));
    }
    for i in 0..=16 {
        let a = span / 2.0 - span * (i as f64 / 16.0);
        loop_.push(Point2::new(
            centre.x + r_in * a.cos(),
            centre.y + r_in * a.sin(),
        ));
    }
    assert!(
        loop_doubles_back(&loop_),
        "a non-uniformly tessellated thin sector must still read as doubling back",
    );
    // And it is gated end-to-end: simplify returns the faithful original.
    let out = simplify_smooth_curve_polyline(&loop_, 1.0);
    assert_eq!(
        out.len(),
        loop_.len(),
        "skewed-sampling thin sector must be gated"
    );
}

/// #1802 review: the absolute 10 mm cap must be unit-invariant — a physically
/// identical profile authored in millimetres (coords ×1000, scale 0.001) must
/// simplify to the same polygon as its metre twin. Both sit in the cap-bound
/// regime (diagonal-relative epsilon above 10 mm), where the (unit-dependent)
/// `RDP_EPSILON_MIN` floor plays no role.
#[test]
fn cap_is_unit_invariant_for_round_profile() {
    let seg = 127;
    let m: Vec<Point2<f64>> = (0..seg)
        .map(|i| {
            let a = std::f64::consts::TAU * (i as f64 / seg as f64);
            Point2::new(a.cos(), a.sin()) // radius 1 m
        })
        .collect();
    let mm: Vec<Point2<f64>> = m.iter().map(|p| Point2::new(p.x * 1000.0, p.y * 1000.0)).collect();
    let out_m = simplify_smooth_curve_polyline(&m, 1.0);
    let out_mm = simplify_smooth_curve_polyline(&mm, 0.001);
    assert!(
        out_m.len() < m.len(),
        "metre-unit 2 m disk must simplify ({} -> {})",
        m.len(),
        out_m.len()
    );
    assert_eq!(
        out_m.len(),
        out_mm.len(),
        "physically identical mm profile must simplify identically (m: {}, mm: {})",
        out_m.len(),
        out_mm.len()
    );
    for (a, b) in out_m.iter().zip(out_mm.iter()) {
        assert!(
            (a.x * 1000.0 - b.x).abs() < 1e-6 && (a.y * 1000.0 - b.y).abs() < 1e-6,
            "mm output must be the metre output scaled x1000"
        );
    }
}

/// #1802 review: a round opening profile authored in millimetre units must
/// still simplify (the #635 target), with the cap converted through the unit
/// scale rather than swamped by it.
#[test]
fn round_profile_still_simplifies_under_mm_units() {
    let seg = 127;
    let disk_mm: Vec<Point2<f64>> = (0..seg)
        .map(|i| {
            let a = std::f64::consts::TAU * (i as f64 / seg as f64);
            Point2::new(500.0 * a.cos(), 500.0 * a.sin()) // radius 500 mm
        })
        .collect();
    let out = simplify_smooth_curve_polyline(&disk_mm, 0.001);
    assert!(
        out.len() < disk_mm.len() && out.len() >= SIMPLIFIED_MIN_VERTICES,
        "mm-unit round disk should simplify from {} to [{SIMPLIFIED_MIN_VERTICES}, {}), got {}",
        disk_mm.len(),
        disk_mm.len(),
        out.len(),
    );
    assert!(!closed_loop_self_intersects(&out));
}

/// #1802 review: ellipse simplification must be unit-invariant in the
/// cap-bound regime (8 m x 1 m ellipse; diagonal-relative epsilon far above
/// the 10 mm cap in both unit systems).
#[test]
fn ellipse_simplification_is_unit_invariant() {
    let ellipse_m = ellipse_loop(8.0, 128);
    let ellipse_mm: Vec<Point2<f64>> =
        ellipse_m.iter().map(|p| Point2::new(p.x * 1000.0, p.y * 1000.0)).collect();
    let out_m = simplify_smooth_curve_polyline(&ellipse_m, 1.0);
    let out_mm = simplify_smooth_curve_polyline(&ellipse_mm, 0.001);
    assert!(out_m.len() < ellipse_m.len(), "metre ellipse must simplify");
    assert_eq!(
        out_m.len(),
        out_mm.len(),
        "mm-authored ellipse must simplify identically (m: {}, mm: {})",
        out_m.len(),
        out_mm.len()
    );
    for (a, b) in out_m.iter().zip(out_mm.iter()) {
        assert!(
            (a.x * 1000.0 - b.x).abs() < 1e-6 && (a.y * 1000.0 - b.y).abs() < 1e-6,
            "mm ellipse output must be the metre output scaled x1000, not merely equal in count"
        );
    }
}

/// #1802 review: the thin doubling-back gate (#820) must keep firing when the
/// profile is authored in millimetres and the metres-per-unit scale is passed
/// correctly — the 12.5 m-radius, 100 mm-thick curved wall stays untouched.
#[test]
fn thin_profile_gate_holds_under_mm_units() {
    let loop_mm = annular_sector_loop(12_500.0, 100.0, 0.3, 64);
    let out = simplify_smooth_curve_polyline(&loop_mm, 0.001);
    assert_eq!(
        out.len(),
        loop_mm.len(),
        "thin mm-unit annular sector must be gated (kept verbatim)"
    );
    // Gated profiles are returned untouched — assert point-for-point identity,
    // not just an equal vertex count (which a re-simplified loop could match).
    for (a, b) in out.iter().zip(loop_mm.iter()) {
        assert_eq!((a.x, a.y), (b.x, b.y), "gated profile must be kept verbatim");
    }
}
