// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for the parity classifier, split out of `classify.rs` so that file
//! stays inside its module-size budget (`*_tests.rs` is ratchet-exempt).

use super::{operand_extent, point_inside, ray_dir, sound_far};
use crate::kernel::arrangement::box_mesh;

/// The endpoint must end up strictly outside the box for EVERY sign pattern of
/// the direction.
///
/// This is the invariant the whole design rests on, and it was silent until an
/// adversarial pass broke it: the production [`ray_dir`] happens to be
/// all-positive, and an earlier escape form assumed that, so negating one
/// component walked the endpoint back INSIDE the box and flipped 53 verdicts in
/// 20000 that the pre-fix code got right. `ray_dir` has already been changed
/// once in this file's history, so the property is pinned here rather than left
/// to hold by luck.
#[test]
fn the_extended_endpoint_clears_the_box_for_any_direction_sign() {
    let bb = ([-2.0, -1.0, -3.0], [4.0, 5.0, 6.0]);
    let (lo, hi) = bb;
    let inside = |q: [f64; 3]| (0..3).all(|i| q[i] >= lo[i] && q[i] <= hi[i]);

    let base = ray_dir();
    let mut dirs = vec![base];
    for mask in 1..8u8 {
        let mut d = base;
        for (i, c) in d.iter_mut().enumerate() {
            if mask & (1 << i) != 0 {
                *c = -*c;
            }
        }
        dirs.push(d);
    }
    // Axis-parallel directions exercise the `dir[i] == 0` skip.
    dirs.push([1.0, 0.0, 0.0]);
    dirs.push([0.0, -1.0, 0.0]);

    // Starts inside the box, where the extension is forced to fire.
    let starts = [
        [0.0, 0.0, 0.0],
        [-1.9, -0.9, -2.9],
        [3.9, 4.9, 5.9],
        [1.0, -0.5, 2.0],
    ];
    for d in &dirs {
        for p in &starts {
            for far_l in [3.0, 13.0, 1.0e6] {
                let q = sound_far(*p, *d, far_l, bb);
                assert!(
                    q.iter().all(|v| v.is_finite()),
                    "endpoint must stay finite: dir={d:?} p={p:?} far_l={far_l} q={q:?}"
                );
                assert!(
                    !inside(q),
                    "endpoint must clear the box: dir={d:?} p={p:?} far_l={far_l} q={q:?}"
                );
            }
        }
    }
}

/// A query whose default endpoint is already outside the box keeps the pre-fix
/// segment bit for bit. That is the only "unchanged" claim the fix makes: it
/// deliberately does NOT claim every previously-correct query is untouched,
/// which is false for non-convex operands, where a point can sit inside the
/// bounding box and outside the solid.
#[test]
fn an_endpoint_already_outside_the_box_is_returned_unchanged() {
    let bb = ([-2.0, -1.0, -3.0], [4.0, 5.0, 6.0]);
    let d = ray_dir();
    let p = [-50.0, -50.0, -50.0];
    let far_l = 4.0; // far short of the box
    let plain = [p[0] + d[0] * far_l, p[1] + d[1] * far_l, p[2] + d[2] * far_l];
    assert_eq!(sound_far(p, d, far_l, bb).map(f64::to_bits), plain.map(f64::to_bits));
}

/// SplitMix64. A pinned seed keeps the oracle test below a deterministic gate
/// rather than a flaky one.
struct Rng(u64);
impl Rng {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn f(&mut self, lo: f64, hi: f64) -> f64 {
        let u = (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64;
        lo + u * (hi - lo)
    }
}

/// Differential test of the parity predicate against an INDEPENDENT analytic
/// oracle. On an axis-aligned box "is `p` inside" has a closed form that shares
/// no code with the ray-cast, which separates the two questions an end-to-end
/// boolean test cannot: does the fix remove wrong INSIDE verdicts (#3341), and
/// does the longer segment ever turn a RIGHT verdict into a wrong one?
///
/// This is the gate for the CLASS; the nine pinned end-to-end cases in
/// `tests/touching_operand.rs` are the gate for the reported symptom. Reverting
/// the fix makes this test report 454 false-inside and 0 false-outside at the
/// `N` below, which is the figure to reproduce if you want to see it fail. A
/// random sweep at the boolean level cannot serve as this gate: its hit rate is
/// about 0.02%, so it is slow and statistically mushy as pass/fail.
///
/// Points are biased to the low-corner side along the ray direction, which is
/// where the unsound endpoint lands, so the sample is not spent on the easy half
/// of space.
#[test]
fn the_parity_predicate_matches_an_analytic_box_oracle() {
    const N: usize = 120_000;
    let mut rng = Rng(0x5EED_1234);
    let (mut wrong_inside, mut wrong_outside) = (0usize, 0usize);
    let mut examples: Vec<String> = Vec::new();

    for _ in 0..N {
        let lo = [rng.f(-6.5, 0.6), rng.f(-6.5, 0.6), rng.f(-6.5, 0.6)];
        let hi = [
            lo[0] + rng.f(0.15, 5.0),
            lo[1] + rng.f(0.15, 5.0),
            lo[2] + rng.f(0.15, 5.0),
        ];
        let tris = box_mesh(lo, hi);
        let far_l = operand_extent(&tris);

        let p = [
            rng.f(lo[0] - 6.0, hi[0] + 2.0),
            rng.f(lo[1] - 6.0, hi[1] + 2.0),
            rng.f(lo[2] - 6.0, hi[2] + 2.0),
        ];
        // Skip points within a hair of a face: the analytic answer there is a
        // coin flip on rounding, and resolving that is not what is under test.
        if (0..3).any(|i| (p[i] - lo[i]).abs() < 1.0e-9 || (p[i] - hi[i]).abs() < 1.0e-9) {
            continue;
        }

        let truth = (0..3).all(|i| p[i] > lo[i] && p[i] < hi[i]);
        let got = point_inside(p, &tris, far_l, (lo, hi));
        if got != truth {
            if got {
                wrong_inside += 1;
            } else {
                wrong_outside += 1;
            }
            if examples.len() < 3 {
                examples.push(format!("p={p:?} box=[{lo:?},{hi:?}] truth={truth} got={got}"));
            }
        }
    }

    assert!(
        wrong_inside == 0 && wrong_outside == 0,
        "the parity predicate must agree with the analytic oracle: {wrong_inside} \
         false-inside, {wrong_outside} false-outside in {N} queries\n  {}",
        examples.join("\n  ")
    );
}

/// `point_inside` now takes its caller's already-computed box instead of
/// rescanning `tris` (issue #3354). Pins two things at once:
///
/// 1. A box that is a SUPERSET of `tris`'s true bounding box — the exact box, or
///    one padded outward, as `BComponents::inside` passes — gives a
///    byte-identical verdict to the exact box, for points ON the box's faces,
///    just outside them, and strictly inside/outside.
/// 2. That equivalence is NOT vacuous: shrinking the box passed in (so it no
///    longer contains `tris`) DOES flip at least one verdict. If (1) passed
///    only because `point_inside` ignores its `aabb` argument, (2) would also
///    pass with no divergence found — it does not.
#[test]
fn a_superset_aabb_matches_the_exact_box_and_a_shrunk_one_does_not() {
    // Deliberately asymmetric box: no axis shares an extent, so a bug that only
    // shows up when lo/hi are far from symmetric (e.g. an off-by-one axis swap
    // in how the padding or shrink is applied) has somewhere to hide. Kept small
    // (max dim 4.0) so `far_l` values comparable to it stay clear of
    // `sound_far`'s `far_l` commensurability debug_assert at every box tested
    // below (exact, padded, shrunk).
    let lo = [-1.0, -0.3, -2.0];
    let hi = [3.0, 0.6, 1.0];
    let tris = box_mesh(lo, hi);
    let exact: super::Aabb = (lo, hi);

    // Boundary, just-outside, inside and outside query points along each axis.
    let eps = 1.0e-7;
    let points: Vec<[f64; 3]> = vec![
        [hi[0], 0.1, -0.5],          // on the +X face
        [hi[0] + eps, 0.1, -0.5],    // just outside the +X face
        [lo[0], 0.1, -0.5],          // on the -X face
        [lo[0] - eps, 0.1, -0.5],    // just outside the -X face
        [1.0, hi[1], -0.5],          // on the +Y face
        [1.0, hi[1] + eps, -0.5],    // just outside the +Y face
        [1.0, lo[1] - eps, -0.5],    // just outside the -Y face
        [1.0, 0.1, hi[2]],           // on the +Z face
        [1.0, 0.1, hi[2] + eps],     // just outside the +Z face
        [1.0, 0.1, lo[2] - eps],     // just outside the -Z face
        [1.0, 0.1, -0.5],            // strictly inside
        [50.0, 50.0, 50.0],          // strictly outside, far
        [-50.0, -50.0, -50.0],       // strictly outside, far, opposite corner
    ];
    // `far_l` values used with the ABOVE points only; kept >= the exact box's
    // max half-diagonal-ish scale so `sound_far`'s commensurability
    // debug_assert (`hi-lo <= far_l*4`) can never fire for the exact box or any
    // pad tested below.
    let far_ls = [2.0, 3.0, operand_extent(&tris)];

    // (1) Superset safety: padding the box outward must never change the
    // verdict, for any of the boundary/outside/inside points above.
    for &far_l in &far_ls {
        for &pad in &[0.0, 1.0e-4, 0.05, 0.3] {
            let padded: super::Aabb =
                ([lo[0] - pad, lo[1] - pad, lo[2] - pad], [hi[0] + pad, hi[1] + pad, hi[2] + pad]);
            for &p in &points {
                let want = point_inside(p, &tris, far_l, exact);
                let got = point_inside(p, &tris, far_l, padded);
                assert_eq!(
                    got, want,
                    "padded box changed the verdict at p={p:?}, far_l={far_l}, pad={pad}: \
                     exact-box={want} padded-box={got}"
                );
            }
        }
    }

    // (2) Non-vacuousness: an aabb that does NOT contain `tris` (shrunk inward)
    // must be able to flip a verdict, or (1) proves nothing about `aabb`
    // actually being used.
    //
    // Mechanism (see `sound_far`'s doc comment): it only extends the far
    // endpoint when the DEFAULT endpoint `p + dir*far_l` falls inside the box
    // it is handed; when that endpoint is already outside the box it is handed
    // back UNCHANGED, with no escape guarantee. So: construct `far0` to sit
    // strictly inside the exact box but within `shrink` of one face. Against
    // the exact box, `far0` is interior → `sound_far` extends it to a point
    // that truly clears the solid, giving the correct (outside) verdict for a
    // `p` chosen outside the solid. Against the shrunk box, that same `far0`
    // is now OUTSIDE the shrunk box on that axis → the early-return fires,
    // `sound_far` hands back `far0` itself — a point strictly INSIDE the real
    // solid (this mesh's solid interior is exactly its AABB interior, since
    // `tris` is a plain box). A segment from an exterior `p` to an interior
    // endpoint crosses the boundary an odd number of times, so the shrunk-box
    // path reports `p` as inside: wrong, and different from the exact-box
    // verdict. This also sidesteps `sound_far`'s commensurability
    // `debug_assert`, which only guards the extend branch the shrunk box never
    // reaches here (it takes the early-return branch instead).
    let dir = ray_dir();
    let far_l = 2.0; // commensurate with this box's extents (max 4.0 <= far_l*4)
    let eps_in = 1.0e-3; // far0's distance inside the +Y face of the exact box
    let shrink = 0.05; // > eps_in, so shrinking pushes far0 outside on Y
    assert!(eps_in < shrink, "far0 must land outside the shrunk box on Y");
    let far0 = [(lo[0] + hi[0]) / 2.0, hi[1] - eps_in, (lo[2] + hi[2]) / 2.0];
    let p = [far0[0] - dir[0] * far_l, far0[1] - dir[1] * far_l, far0[2] - dir[2] * far_l];
    // Sanity on the construction itself, so a future edit that breaks the
    // premise fails loudly here instead of silently making assert_ne! below
    // pass or fail for the wrong reason.
    assert!(
        (0..3).all(|i| far0[i] >= lo[i] && far0[i] <= hi[i]),
        "far0={far0:?} must be inside the exact box [{lo:?},{hi:?}]"
    );
    assert!(p[1] < lo[1], "p={p:?} must be strictly outside the box on Y (below lo[1]={})", lo[1]);

    let shrunk: super::Aabb =
        ([lo[0] + shrink, lo[1] + shrink, lo[2] + shrink], [hi[0] - shrink, hi[1] - shrink, hi[2] - shrink]);
    assert!(
        far0[1] > shrunk.1[1],
        "far0={far0:?} must land outside the shrunk box's +Y face at {}",
        shrunk.1[1]
    );

    let exact_verdict = point_inside(p, &tris, far_l, exact);
    let shrunk_verdict = point_inside(p, &tris, far_l, shrunk);
    assert_ne!(
        exact_verdict, shrunk_verdict,
        "expected the shrunk box to flip the verdict at p={p:?}, far_l={far_l}: \
         exact-box={exact_verdict} shrunk-box={shrunk_verdict} — if they agree, \
         `point_inside` may not actually be using its `aabb` argument, which would \
         make the superset-safety assertions above vacuous"
    );
    // `p` is outside the solid, so the exact box (which extends far0 to truly
    // clear the mesh) must report it correctly as outside.
    assert!(!exact_verdict, "exact-box verdict for an exterior p should be `outside`");
}
