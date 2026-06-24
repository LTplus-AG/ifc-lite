// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Public predicate dispatch over `ImplicitPoint` configurations.
//!
//! Implements every explicit/implicit `orient3d`/`orient2d` configuration the
//! arrangement pipeline produces, each first through the fast interval and
//! fixed-width tiers and escalating to the exact (BigRational) tier on a
//! straddling filter — every fast tier verified `≡` the exact tier here.

use super::{fixed, interval, rational};
use super::{DropAxis, ImplicitPoint, Sign};

/// Exact `orient3d` over a mix of explicit + implicit points.
///
/// Cascade: explicit args go through the Shewchuk adaptive predicate (its own
/// semi-static→exact ladder). Indirect args try the interval tier first and
/// escalate to the exact (BigRational) tier only on a straddle. Every tier
/// returns the SAME sign — verified against the oracle in tests.
pub fn orient3d(a: &ImplicitPoint, b: &ImplicitPoint, c: &ImplicitPoint, d: &ImplicitPoint) -> Sign {
    use ImplicitPoint::{Explicit, Lpi, Tpi};
    match (a, b, c, d) {
        (Explicit(a), Explicit(b), Explicit(c), Explicit(d)) => {
            Sign::from_f64(geometry_predicates::orient3d(*a, *b, *c, *d))
        }
        (Lpi(l), Explicit(b), Explicit(c), Explicit(d)) => interval::lpi_orient3d(l, *b, *c, *d)
            .or_else(|| {
                crate::kernel::budget::note_escalation();
                fixed::indirect_orient3d(a, *b, *c, *d)
            })
            .unwrap_or_else(|| rational::lpi_orient3d(l, *b, *c, *d)),
        (Tpi(t), Explicit(b), Explicit(c), Explicit(d)) => interval::tpi_orient3d(t, *b, *c, *d)
            .or_else(|| {
                crate::kernel::budget::note_escalation();
                fixed::indirect_orient3d(a, *b, *c, *d)
            })
            .unwrap_or_else(|| rational::tpi_orient3d(t, *b, *c, *d)),
        // By-construction unreachable: kernel callers only ever build the configurations above.
        _ => unimplemented!(
            "kernel::orient3d: implicit-point configuration never produced by the arrangement pipeline"
        ),
    }
}

/// Exact `orient2d(a, b, c)` projected on the two axes remaining after dropping
/// `axis` (the in-plane predicate for re-triangulation). Same cascade as
/// `orient3d`; the indirect 1-implicit case shares the `sign(d)` flip.
pub fn orient2d(a: &ImplicitPoint, b: &ImplicitPoint, c: &ImplicitPoint, axis: DropAxis) -> Sign {
    use ImplicitPoint::{Explicit, Lpi, Tpi};
    let (i, j) = match axis {
        DropAxis::X => (1, 2),
        DropAxis::Y => (0, 2),
        DropAxis::Z => (0, 1),
    };
    match (a, b, c) {
        (Explicit(a), Explicit(b), Explicit(c)) => {
            Sign::from_f64(geometry_predicates::orient2d([a[i], a[j]], [b[i], b[j]], [c[i], c[j]]))
        }
        (Lpi(l), Explicit(b), Explicit(c)) => interval::lpi_orient2d(l, *b, *c, axis)
            .or_else(|| {
                crate::kernel::budget::note_escalation();
                fixed::indirect_orient2d(a, *b, *c, axis)
            })
            .unwrap_or_else(|| rational::lpi_orient2d(l, *b, *c, axis)),
        (Tpi(t), Explicit(b), Explicit(c)) => interval::tpi_orient2d(t, *b, *c, axis)
            .or_else(|| {
                crate::kernel::budget::note_escalation();
                fixed::indirect_orient2d(a, *b, *c, axis)
            })
            .unwrap_or_else(|| rational::tpi_orient2d(t, *b, *c, axis)),
        // By-construction unreachable: kernel callers only ever build the configurations above.
        _ => unimplemented!(
            "kernel::orient2d: implicit-point configuration never produced by the arrangement pipeline"
        ),
    }
}

/// orient2d with two implicit points (a,b) + one explicit (c) — cascade.
pub fn orient2d_2i(a: &ImplicitPoint, b: &ImplicitPoint, c: [f64; 3], axis: DropAxis) -> Sign {
    // cascade: interval filter → fixed-width exact (fast) → BigRational (off-grid / overflow)
    interval::orient2d_2i(a, b, c, axis)
        .or_else(|| {
            crate::kernel::budget::note_escalation();
            fixed::orient2d_2i(a, b, c, axis)
        })
        .unwrap_or_else(|| rational::orient2d_2i(a, b, c, axis))
}

/// orient2d with three implicit points (a,b,c) — cascade.
pub fn orient2d_3i(a: &ImplicitPoint, b: &ImplicitPoint, c: &ImplicitPoint, axis: DropAxis) -> Sign {
    interval::orient2d_3i(a, b, c, axis)
        .or_else(|| {
            crate::kernel::budget::note_escalation();
            fixed::orient2d_3i(a, b, c, axis)
        })
        .unwrap_or_else(|| rational::orient2d_3i(a, b, c, axis))
}

/// Exact lexicographic total order on points — the interner's comparison (cascade).
pub fn cmp_lex(a: &ImplicitPoint, b: &ImplicitPoint) -> Sign {
    interval::cmp_lex(a, b)
        .or_else(|| {
            crate::kernel::budget::note_escalation();
            fixed::cmp_lex(a, b)
        })
        .unwrap_or_else(|| rational::cmp_lex(a, b))
}

#[inline]
fn explicit_coord(p: &ImplicitPoint) -> [f64; 3] {
    match p {
        ImplicitPoint::Explicit(c) => *c,
        _ => unreachable!("explicit_coord on an implicit point"),
    }
}

/// `orient2d` over ANY mix of explicit/implicit points in ANY argument position
/// (the predicate the re-triangulation's point location needs). `orient2d` is
/// antisymmetric, so we canonicalise the args to implicit-first (stable, to keep
/// it a pure function), dispatch to the 0I/1I/2I/3I config, and flip the result
/// once per transposition (the permutation parity).
pub fn orient2d_any(a: &ImplicitPoint, b: &ImplicitPoint, c: &ImplicitPoint, axis: DropAxis) -> Sign {
    let pts = [a, b, c];
    let key = |p: &ImplicitPoint| u8::from(matches!(p, ImplicitPoint::Explicit(_))); // implicit=0
    let keys = [key(a), key(b), key(c)];
    let mut perm = [0usize, 1, 2];
    perm.sort_by_key(|&i| keys[i]); // stable → implicit first, original order kept
    let inversions = u8::from(perm[0] > perm[1]) + u8::from(perm[0] > perm[2]) + u8::from(perm[1] > perm[2]);
    let rp = [pts[perm[0]], pts[perm[1]], pts[perm[2]]];
    let n_implicit = 3 - (keys[0] + keys[1] + keys[2]) as usize;
    let canonical = match n_implicit {
        // (E,E,E) and (I,E,E) are handled by the position-specific dispatch.
        0 | 1 => orient2d(rp[0], rp[1], rp[2], axis),
        2 => orient2d_2i(rp[0], rp[1], explicit_coord(rp[2]), axis),
        _ => orient2d_3i(rp[0], rp[1], rp[2], axis),
    };
    if inversions % 2 == 1 {
        canonical.flip()
    } else {
        canonical
    }
}

#[cfg(test)]
mod tests {
    use super::super::{rational, DropAxis, Lpi, Tpi};
    use super::{
        cmp_lex, orient2d, orient2d_2i, orient2d_3i, orient2d_any, orient3d, ImplicitPoint, Sign,
    };

    fn e(p: [f64; 3]) -> ImplicitPoint {
        ImplicitPoint::Explicit(p)
    }

    /// Adversarial explicit-orient3d configurations (coplanar, building-scale
    /// off-plane, near-coincident large coords, sub-mm + mirrored tetra).
    fn battery() -> Vec<[[f64; 3]; 4]> {
        vec![
            [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [1., 1., 0.]], // coplanar -> 0
            [[0., 0., 12.3456789], [10., 0., 12.3456789], [0., 7., 12.3456789], [3.3, 2.1, 12.3456789 + 1e-9]],
            [[0., 0., 12.3456789], [10., 0., 12.3456789], [0., 7., 12.3456789], [3.3, 2.1, 12.3456789 - 1e-9]],
            [[1e7, 1e7, 0.], [1e7 + 1., 1e7, 0.], [1e7, 1e7 + 1., 0.], [1e7 + 0.5, 1e7 + 0.5, 1e-7]],
            [[0., 0., 0.], [1., 2., 3.], [-2., 1., 0.5], [0.5, 0.5, 0.5]],
            [[0., 0., 0.], [1., 1., 1.], [2., 2., 2.], [5., 1., 9.]], // collinear base -> 0
            [[0., 0., 0.], [1e-4, 0., 0.], [0., 1e-4, 0.], [0., 0., 1e-4]],
            [[0., 0., 0.], [0., 1e-4, 0.], [1e-4, 0., 0.], [0., 0., 1e-4]],
            [[-3., 2., 5.], [7., -1., 2.], [4., 4., -6.], [1.5, 0.0, 0.25]],
        ]
    }

    /// LPI cases: (line PQ ∩ plane RST), plus a query triangle (p2,p3,p4).
    fn lpi_cases() -> Vec<(Lpi, [f64; 3], [f64; 3], [f64; 3])> {
        vec![
            // vertical line ∩ z=0 plane -> (0.3,0.3,0); query triangle at z=1 (LPI below)
            (
                Lpi { p: [0.3, 0.3, -1.], q: [0.3, 0.3, 1.], r: [0., 0., 0.], s: [2., 0., 0.], t: [0., 2., 0.] },
                [0., 0., 1.], [1., 0., 1.], [0., 1., 1.],
            ),
            // same LPI, query triangle at z=-1 (LPI above)
            (
                Lpi { p: [0.3, 0.3, -1.], q: [0.3, 0.3, 1.], r: [0., 0., 0.], s: [2., 0., 0.], t: [0., 2., 0.] },
                [0., 0., -1.], [1., 0., -1.], [0., 1., -1.],
            ),
            // tilted line ∩ tilted plane
            (
                Lpi { p: [1., 1., 0.], q: [2., 3., 4.], r: [0., 0., 1.], s: [3., 0., 2.], t: [0., 3., 2.] },
                [5., -2., 0.], [-1., 4., 3.], [2., 2., -3.],
            ),
            // building-scale
            (
                Lpi { p: [12.3, 4.5, -2.], q: [12.3, 4.5, 6.], r: [0., 0., 3.1], s: [20., 0., 3.1], t: [0., 9., 3.1] },
                [10., 10., 10.], [-5., 0., 0.], [0., -5., 8.],
            ),
        ]
    }

    #[test]
    fn explicit_orient3d_matches_rational_oracle() {
        for cfg in battery() {
            let [a, b, c, d] = cfg;
            let fast = orient3d(&e(a), &e(b), &e(c), &e(d));
            let oracle = rational::orient3d_exact(a, b, c, d);
            assert_eq!(fast, oracle, "explicit orient3d != rational oracle on {cfg:?}");
        }
    }

    #[test]
    fn lpi_orient3d_matches_materialised_point() {
        // The homogenised LPI-orient3d must equal the direct orient3d on the
        // exact materialised λ/d point — proving the Λ′ + sign(d)-flip.
        for (l, p2, p3, p4) in lpi_cases() {
            let homog = rational::lpi_orient3d(&l, p2, p3, p4);
            let direct = rational::orient3d_exact_pt(&rational::lpi_point(&l), p2, p3, p4);
            assert_eq!(homog, direct, "LPI homogenisation/flip wrong for {l:?}");
            // sanity: these are non-degenerate, so the sign is definite
            assert_ne!(homog, Sign::Zero, "test LPI case should be off-plane: {l:?}");
        }
    }

    #[test]
    fn lpi_orient3d_sign_invariant_to_plane_winding() {
        // Re-wind the plane (swap S,T): flips sign(d) but the point + geometry
        // are identical, so the per-config flip must yield the SAME sign. This
        // is the test that catches a missing/extra `sign(d)` flip.
        for (l, p2, p3, p4) in lpi_cases() {
            let l_rewound = Lpi { s: l.t, t: l.s, ..l };
            assert_eq!(
                rational::lpi_orient3d(&l, p2, p3, p4),
                rational::lpi_orient3d(&l_rewound, p2, p3, p4),
                "LPI-orient3d sign changed under plane re-winding — the sign(d) flip is wrong/missing"
            );
        }
    }

    #[test]
    fn assemble_sign_per_config_flip() {
        use super::super::assemble_sign;
        // odd #negatives -> flip; even -> no flip; any zero -> Zero.
        assert_eq!(assemble_sign(Sign::Positive, &[Sign::Negative]), Sign::Negative);
        assert_eq!(assemble_sign(Sign::Positive, &[Sign::Negative, Sign::Negative]), Sign::Positive);
        assert_eq!(assemble_sign(Sign::Negative, &[Sign::Positive]), Sign::Negative);
        assert_eq!(assemble_sign(Sign::Positive, &[Sign::Zero]), Sign::Zero);
        assert_eq!(assemble_sign(Sign::Positive, &[]), Sign::Positive);
    }

    #[test]
    fn next_up_down_are_adjacent() {
        use super::super::interval::{next_down, next_up};
        for &x in &[1.0, -1.0, 0.0, 1e7, -1e-9, 12.3456789, f64::MIN_POSITIVE] {
            assert!(next_up(x) > x, "next_up({x}) not strictly greater");
            assert!(next_down(x) < x, "next_down({x}) not strictly less");
            // Round-trip = adjacency: nothing representable strictly between.
            assert_eq!(next_down(next_up(x)), x, "next_up/next_down not adjacent at {x}");
        }
    }

    /// Deterministic LCG for the soundness fuzz (no Math::random; fixed seed).
    struct Lcg(u64);
    impl Lcg {
        fn u(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0
        }
        fn f(&mut self, lo: f64, hi: f64) -> f64 {
            let unit = (self.u() >> 11) as f64 / (1u64 << 53) as f64; // [0,1)
            lo + (hi - lo) * unit
        }
        fn p(&mut self) -> [f64; 3] {
            [self.f(-10., 10.), self.f(-10., 10.), self.f(-10., 10.)]
        }
    }

    #[test]
    fn interval_tier_is_sound_and_the_cascade_equals_exact() {
        use super::super::{interval, rational, Lpi};
        let mut rng = Lcg(0x1234_5678_9abc_def0);
        let (mut definite, mut escalated) = (0u32, 0u32);
        for _ in 0..3000 {
            let l = Lpi { p: rng.p(), q: rng.p(), r: rng.p(), s: rng.p(), t: rng.p() };
            let (p2, p3, p4) = (rng.p(), rng.p(), rng.p());
            let exact = rational::lpi_orient3d(&l, p2, p3, p4);
            // Soundness: a definite interval sign must equal the exact sign.
            match interval::lpi_orient3d(&l, p2, p3, p4) {
                Some(s) => {
                    assert_eq!(s, exact, "interval returned a WRONG definite sign for {l:?}");
                    definite += 1;
                }
                None => escalated += 1,
            }
            // The public cascade (interval → escalate) must always equal exact.
            let cascade = orient3d(&ImplicitPoint::Lpi(l), &e(p2), &e(p3), &e(p4));
            assert_eq!(cascade, exact, "cascade != exact for {l:?}");
        }
        // The interval fast path must carry the overwhelming majority (perf gate).
        assert!(
            definite as f64 / (definite + escalated) as f64 > 0.95,
            "interval resolved only {definite}/{} — fast path too cold",
            definite + escalated
        );
        eprintln!("interval tier: {definite} definite, {escalated} escalated to exact");
    }


    /// TPI cases: three planes (each a triangle) + a query triangle.
    fn tpi_cases() -> Vec<(Tpi, [f64; 3], [f64; 3], [f64; 3])> {
        // planes x=0.3, y=0.4, z=0 -> point (0.3,0.4,0)
        let axis_aligned = Tpi {
            planes: [
                [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]],     // z=0
                [[0.3, 0., 0.], [0.3, 1., 0.], [0.3, 0., 1.]],  // x=0.3
                [[0., 0.4, 0.], [1., 0.4, 0.], [0., 0.4, 1.]],  // y=0.4
            ],
        };
        // three tilted planes meeting at a general point
        let tilted = Tpi {
            planes: [
                [[0., 0., 1.], [3., 0., 2.], [0., 3., 2.]],
                [[1., 0., 0.], [1., 2., 1.], [2., 0., 3.]],
                [[-1., -1., 0.], [2., -1., 1.], [-1., 2., 2.]],
            ],
        };
        vec![
            (axis_aligned, [0., 0., 1.], [1., 0., 1.], [0., 1., 1.]),   // query above
            (axis_aligned, [0., 0., -1.], [1., 0., -1.], [0., 1., -1.]), // query below
            (tilted, [5., -2., 0.], [-1., 4., 3.], [2., 2., -3.]),
            (tilted, [10., 10., 10.], [-5., 0., 0.], [0., -5., 8.]),
        ]
    }

    #[test]
    fn tpi_orient3d_matches_materialised_point() {
        // The homogenised TPI-orient3d must equal the direct orient3d on the
        // exact materialised λ/d point — proving the TPI Cramer λ + the flip.
        for (t, p2, p3, p4) in tpi_cases() {
            let homog = rational::tpi_orient3d(&t, p2, p3, p4);
            let direct = rational::orient3d_exact_pt(&rational::tpi_point(&t), p2, p3, p4);
            assert_eq!(homog, direct, "TPI homogenisation/flip wrong for {t:?}");
            assert_ne!(homog, Sign::Zero, "test TPI case should be off-plane: {t:?}");
        }
    }

    #[test]
    fn tpi_orient3d_sign_invariant_to_plane_winding() {
        // Re-wind plane 0 (swap its 2nd/3rd points): flips that plane's normal
        // and hence sign(d), but the meeting point is identical → the sign(d)
        // flip must yield the SAME geometric sign.
        for (t, p2, p3, p4) in tpi_cases() {
            let mut rewound = t;
            rewound.planes[0].swap(1, 2);
            assert_eq!(
                rational::tpi_orient3d(&t, p2, p3, p4),
                rational::tpi_orient3d(&rewound, p2, p3, p4),
                "TPI-orient3d sign changed under plane re-winding — the sign(d) flip is wrong/missing"
            );
        }
    }

    #[test]
    fn tpi_interval_is_sound_and_the_cascade_equals_exact() {
        use super::super::interval;
        let mut rng = Lcg(0xfeed_face_cafe_d00d);
        let (mut definite, mut escalated) = (0u32, 0u32);
        for _ in 0..2000 {
            // a random TPI = three random planes (generically meet at a point)
            let plane = |rng: &mut Lcg| [rng.p(), rng.p(), rng.p()];
            let t = Tpi { planes: [plane(&mut rng), plane(&mut rng), plane(&mut rng)] };
            let (p2, p3, p4) = (rng.p(), rng.p(), rng.p());
            let exact = rational::tpi_orient3d(&t, p2, p3, p4);
            match interval::tpi_orient3d(&t, p2, p3, p4) {
                Some(s) => {
                    assert_eq!(s, exact, "TPI interval returned a WRONG definite sign for {t:?}");
                    definite += 1;
                }
                None => escalated += 1,
            }
            let cascade = orient3d(&ImplicitPoint::Tpi(t), &e(p2), &e(p3), &e(p4));
            assert_eq!(cascade, exact, "TPI cascade != exact for {t:?}");
        }
        // TPI Λ′ is degree-3 in the planes (heavier than LPI) so the interval is
        // wider — still expect a healthy majority to resolve in f64.
        assert!(
            definite as f64 / (definite + escalated) as f64 > 0.80,
            "TPI interval resolved only {definite}/{}",
            definite + escalated
        );
        eprintln!("TPI interval tier: {definite} definite, {escalated} escalated");
    }

    const AXES: [DropAxis; 3] = [DropAxis::X, DropAxis::Y, DropAxis::Z];

    #[test]
    fn explicit_orient2d_matches_oracle() {
        for axis in AXES {
            for cfg in battery() {
                let [a, b, c, _d] = cfg;
                let fast = orient2d(&e(a), &e(b), &e(c), axis);
                let oracle = rational::orient2d_exact(a, b, c, axis);
                assert_eq!(fast, oracle, "explicit orient2d != oracle on {cfg:?} axis {axis:?}");
            }
        }
    }

    #[test]
    fn indirect_orient2d_matches_materialised_point() {
        // Homogenised LPI/TPI orient2d == the direct orient2d on the exact
        // materialised λ/d point, for every projection axis; cascade == exact.
        for axis in AXES {
            for (l, p2, p3, _p4) in lpi_cases() {
                let homog = rational::lpi_orient2d(&l, p2, p3, axis);
                let direct = rational::orient2d_exact_pt(&rational::lpi_point(&l), p2, p3, axis);
                assert_eq!(homog, direct, "LPI orient2d homog/flip wrong, axis {axis:?}");
                let cascade = orient2d(&ImplicitPoint::Lpi(l), &e(p2), &e(p3), axis);
                assert_eq!(cascade, direct, "LPI orient2d cascade != exact, axis {axis:?}");
            }
            for (t, p2, p3, _p4) in tpi_cases() {
                let homog = rational::tpi_orient2d(&t, p2, p3, axis);
                let direct = rational::orient2d_exact_pt(&rational::tpi_point(&t), p2, p3, axis);
                assert_eq!(homog, direct, "TPI orient2d homog/flip wrong, axis {axis:?}");
                let cascade = orient2d(&ImplicitPoint::Tpi(t), &e(p2), &e(p3), axis);
                assert_eq!(cascade, direct, "TPI orient2d cascade != exact, axis {axis:?}");
            }
        }
    }

    #[test]
    fn orient2d_interval_is_sound_vs_oracle() {
        use super::super::interval;
        let mut rng = Lcg(0xabcd_1234_5678_9999);
        for _ in 0..2000 {
            let l = Lpi { p: rng.p(), q: rng.p(), r: rng.p(), s: rng.p(), t: rng.p() };
            let (b, c) = (rng.p(), rng.p());
            let axis = AXES[(rng.u() % 3) as usize];
            let exact = rational::lpi_orient2d(&l, b, c, axis);
            if let Some(s) = interval::lpi_orient2d(&l, b, c, axis) {
                assert_eq!(s, exact, "orient2d interval returned a WRONG definite sign for {l:?}");
            }
            // cascade always equals exact
            assert_eq!(orient2d(&ImplicitPoint::Lpi(l), &e(b), &e(c), axis), exact);
        }
    }

    #[test]
    fn lpi_point_lies_on_its_defining_plane() {
        // GEOMETRIC correctness (not just self-consistency): orient3d(LPI, R,S,T)
        // must be 0 — the LPI point is on plane RST by definition. This guard is
        // what the consistency tests miss; it caught the λ = d·P ± n·qp sign bug.
        for (l, _, _, _) in lpi_cases() {
            assert_eq!(
                orient3d(&ImplicitPoint::Lpi(l), &e(l.r), &e(l.s), &e(l.t)),
                Sign::Zero,
                "LPI point is not on its defining plane R,S,T: {l:?}"
            );
        }
    }

    #[test]
    fn tpi_point_lies_on_all_three_defining_planes() {
        for (t, _, _, _) in tpi_cases() {
            for plane in &t.planes {
                assert_eq!(
                    orient3d(&ImplicitPoint::Tpi(t), &e(plane[0]), &e(plane[1]), &e(plane[2])),
                    Sign::Zero,
                    "TPI point is not on one of its defining planes: {t:?}"
                );
            }
        }
    }

    #[test]
    fn orient2d_1i_sign_invariant_to_plane_winding() {
        // Guards Risk #1 (the doc-vs-code sign-table conflict): rewinding the
        // implicit point's defining plane flips sign(d) while leaving the point +
        // 2D query geometrically identical, so the TRUE orient2d sign is
        // unchanged. The shipped d¹ flip preserves it; the doc's old d²/no-flip
        // would invert it. The orient3d analogue is tested at line ~137 — this
        // closes the matching gap for orient2d (the gap the LPI λ-sign bug used).
        for axis in AXES {
            for (l, p2, p3, _p4) in lpi_cases() {
                let rewound = Lpi { s: l.t, t: l.s, ..l };
                assert_eq!(
                    rational::lpi_orient2d(&l, p2, p3, axis),
                    rational::lpi_orient2d(&rewound, p2, p3, axis),
                    "orient2d 1I sign changed under plane re-winding (axis {axis:?})"
                );
            }
        }
    }

    #[test]
    fn multi_implicit_orient2d_matches_materialised_oracle() {
        // orient2d_2i / orient2d_3i over all {Lpi,Tpi} mixtures must equal
        // the direct orient2d on the materialised λ/d points, for every drop axis.
        let mut pts: Vec<ImplicitPoint> =
            lpi_cases().into_iter().map(|(l, ..)| ImplicitPoint::Lpi(l)).collect();
        pts.extend(tpi_cases().into_iter().map(|(t, ..)| ImplicitPoint::Tpi(t)));
        let c = [1.3, -0.7, 2.1];
        let cpt = rational::point_of(&ImplicitPoint::Explicit(c));
        for axis in AXES {
            for a in &pts {
                for b in &pts {
                    let oracle = rational::orient2d_pts(
                        &rational::point_of(a), &rational::point_of(b), &cpt, axis);
                    assert_eq!(rational::orient2d_2i(a, b, c, axis), oracle, "orient2d_2i (axis {axis:?})");
                    for cc in &pts {
                        let oracle3 = rational::orient2d_pts(
                            &rational::point_of(a), &rational::point_of(b), &rational::point_of(cc), axis);
                        assert_eq!(rational::orient2d_3i(a, b, cc, axis), oracle3, "orient2d_3i (axis {axis:?})");
                    }
                }
            }
        }
    }

    #[test]
    fn multi_implicit_orient2d_winding_invariant() {
        // Rewinding a's defining plane flips sign(d); 2I/3I must keep the sign.
        let l = lpi_cases()[2].0;
        let a = ImplicitPoint::Lpi(l);
        let a_rw = ImplicitPoint::Lpi(Lpi { s: l.t, t: l.s, ..l });
        let b = ImplicitPoint::Tpi(tpi_cases()[0].0);
        let cc = ImplicitPoint::Lpi(lpi_cases()[0].0);
        let c = [0.4, 1.1, -0.3];
        for axis in AXES {
            assert_eq!(
                rational::orient2d_2i(&a, &b, c, axis),
                rational::orient2d_2i(&a_rw, &b, c, axis),
                "2I sign changed under plane re-winding"
            );
            assert_eq!(
                rational::orient2d_3i(&a, &b, &cc, axis),
                rational::orient2d_3i(&a_rw, &b, &cc, axis),
                "3I sign changed under plane re-winding"
            );
        }
    }

    #[test]
    fn orient2d_any_matches_oracle_for_every_permutation_and_mix() {
        // The general dispatch must equal the direct orient2d on the materialised
        // points for EVERY ordered triple (covers all positions + permutation
        // parities) and every drop axis, across explicit/LPI/TPI mixes.
        let mut pts: Vec<ImplicitPoint> = vec![e([0.0, 0.0, 0.0]), e([3.0, 1.0, -2.0])];
        pts.extend(lpi_cases().into_iter().take(2).map(|(l, ..)| ImplicitPoint::Lpi(l)));
        pts.extend(tpi_cases().into_iter().take(2).map(|(t, ..)| ImplicitPoint::Tpi(t)));
        for axis in AXES {
            for a in &pts {
                for b in &pts {
                    for c in &pts {
                        let got = orient2d_any(a, b, c, axis);
                        let want = rational::orient2d_pts(
                            &rational::point_of(a),
                            &rational::point_of(b),
                            &rational::point_of(c),
                            axis,
                        );
                        assert_eq!(got, want, "orient2d_any mismatch (axis {axis:?})");
                    }
                }
            }
        }
    }

    #[test]
    fn cmp_lex_matches_materialised_order_and_is_a_total_order() {
        use std::cmp::Ordering;
        let mut pts: Vec<ImplicitPoint> =
            lpi_cases().into_iter().map(|(l, ..)| ImplicitPoint::Lpi(l)).collect();
        pts.extend(tpi_cases().into_iter().map(|(t, ..)| ImplicitPoint::Tpi(t)));
        pts.push(e([1.5, -2.0, 0.25]));
        pts.push(e([0.0, 0.0, 0.0]));
        let oracle = |a: &ImplicitPoint, b: &ImplicitPoint| -> Sign {
            let (pa, pb) = (rational::point_of(a), rational::point_of(b));
            for k in 0..3 {
                match pa[k].cmp(&pb[k]) {
                    Ordering::Less => return Sign::Negative,
                    Ordering::Greater => return Sign::Positive,
                    Ordering::Equal => {}
                }
            }
            Sign::Zero
        };
        for a in &pts {
            assert_eq!(rational::cmp_lex(a, a), Sign::Zero, "cmp_lex not reflexive-zero");
            for b in &pts {
                assert_eq!(rational::cmp_lex(a, b), oracle(a, b), "cmp_lex != materialised lex");
                assert_eq!(
                    rational::cmp_lex(a, b),
                    rational::cmp_lex(b, a).flip(),
                    "cmp_lex not antisymmetric"
                );
            }
        }
        // transitivity: a<b<c ⇒ a<c (no ordering cycles).
        for a in &pts {
            for b in &pts {
                for c in &pts {
                    if rational::cmp_lex(a, b) == Sign::Negative
                        && rational::cmp_lex(b, c) == Sign::Negative
                    {
                        assert_eq!(rational::cmp_lex(a, c), Sign::Negative, "cmp_lex not transitive");
                    }
                }
            }
        }
    }

    #[test]
    fn new_tier_interval_is_sound_and_cascade_equals_exact() {
        // The interval fast tiers for 2I/3I orient2d + cmp_lex never
        // return a wrong definite sign, and the public cascade always == exact.
        use super::super::interval;
        let mut rng = Lcg(0x0bad_c0de_1234_5678);
        for _ in 0..500 {
            let mk = |rng: &mut Lcg| Lpi { p: rng.p(), q: rng.p(), r: rng.p(), s: rng.p(), t: rng.p() };
            let a = ImplicitPoint::Lpi(mk(&mut rng));
            let b = ImplicitPoint::Lpi(mk(&mut rng));
            let cc = ImplicitPoint::Lpi(mk(&mut rng));
            let c = rng.p();
            for axis in AXES {
                let ex2 = rational::orient2d_2i(&a, &b, c, axis);
                if let Some(s) = interval::orient2d_2i(&a, &b, c, axis) {
                    assert_eq!(s, ex2, "orient2d_2i interval wrong sign");
                }
                assert_eq!(orient2d_2i(&a, &b, c, axis), ex2, "2i cascade != exact");
                let ex3 = rational::orient2d_3i(&a, &b, &cc, axis);
                if let Some(s) = interval::orient2d_3i(&a, &b, &cc, axis) {
                    assert_eq!(s, ex3, "orient2d_3i interval wrong sign");
                }
                assert_eq!(orient2d_3i(&a, &b, &cc, axis), ex3, "3i cascade != exact");
            }
            let exl = rational::cmp_lex(&a, &b);
            if let Some(s) = interval::cmp_lex(&a, &b) {
                assert_eq!(s, exl, "cmp_lex interval wrong sign");
            }
            assert_eq!(cmp_lex(&a, &b), exl, "cmp_lex cascade != exact");
        }
    }

    #[test]
    fn cmp_lex_welds_coincident_lpi_and_tpi() {
        // An LPI and a TPI built from DIFFERENT constructions at the SAME physical
        // point must compare equal (Zero) so the interner welds them to one VID.
        let lpi = ImplicitPoint::Lpi(Lpi {
            p: [0.3, 0.4, -1.],
            q: [0.3, 0.4, 1.],
            r: [0., 0., 0.],
            s: [1., 0., 0.],
            t: [0., 1., 0.],
        });
        let tpi = ImplicitPoint::Tpi(Tpi {
            planes: [
                [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]],    // z=0
                [[0.3, 0., 0.], [0.3, 1., 0.], [0.3, 0., 1.]], // x=0.3
                [[0., 0.4, 0.], [1., 0.4, 0.], [0., 0.4, 1.]], // y=0.4
            ],
        });
        assert_eq!(rational::point_of(&lpi), rational::point_of(&tpi), "test points not coincident");
        assert_eq!(
            rational::cmp_lex(&lpi, &tpi),
            Sign::Zero,
            "coincident LPI/TPI not welded by cmp_lex"
        );
    }

    #[test]
    fn cmp_along_matches_materialised_oracle() {
        use num_rational::BigRational;
        use num_traits::Signed;
        let mut pts: Vec<ImplicitPoint> =
            vec![e([0., 0., 0.]), e([3., 1., -2.]), e([1.5, -2., 0.25])];
        pts.extend(lpi_cases().into_iter().take(2).map(|(l, ..)| ImplicitPoint::Lpi(l)));
        pts.extend(tpi_cases().into_iter().take(2).map(|(t, ..)| ImplicitPoint::Tpi(t)));
        let dirs = [[1., 0., 0.], [0., 1., 0.], [0., 0., 1.], [1., 2., -1.], [-0.3, 1.7, 0.5]];
        for u in dirs {
            let ur = [
                BigRational::from_float(u[0]).unwrap(),
                BigRational::from_float(u[1]).unwrap(),
                BigRational::from_float(u[2]).unwrap(),
            ];
            for a in &pts {
                for b in &pts {
                    let pa = rational::point_of(a);
                    let pb = rational::point_of(b);
                    let dot = (&pa[0] - &pb[0]) * &ur[0]
                        + (&pa[1] - &pb[1]) * &ur[1]
                        + (&pa[2] - &pb[2]) * &ur[2];
                    let want = if dot.is_negative() {
                        Sign::Negative
                    } else if dot.is_positive() {
                        Sign::Positive
                    } else {
                        Sign::Zero
                    };
                    assert_eq!(rational::cmp_along(a, b, u), want, "cmp_along != oracle (u={u:?})");
                }
            }
        }
    }
}
