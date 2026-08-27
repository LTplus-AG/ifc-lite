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
        let got = point_inside(p, &tris, far_l);
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
