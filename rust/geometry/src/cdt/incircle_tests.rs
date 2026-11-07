// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `incircle` must return the same bits as `geometry_predicates::incircle` on
//! every path: stage A, stage B, the exact zero-tail return, and the stage C
//! hand-off (#9016). The CDT reads only the sign, but bit identity is the
//! stronger claim and needs no sign argument.

use super::{incircle, stage_b};

type P = [f64; 2];

/// Deterministic xorshift, so no RNG dependency and the same cases everywhere.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    /// Uniform in `[-1, 1)`.
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 52) as f64 - 1.0
    }

    fn int(&mut self, n: i64) -> f64 {
        (self.next() % (2 * n as u64 + 1)) as f64 - n as f64
    }
}

#[derive(Default)]
struct Paths {
    stage_a: usize,
    stage_b: usize,
    stage_c: usize,
}

fn check(paths: &mut Paths, a: P, b: P, c: P, d: P) {
    let ours = incircle(a, b, c, d);
    let crate_value = geometry_predicates::incircle(a, b, c, d);
    assert_eq!(
        ours.to_bits(),
        crate_value.to_bits(),
        "incircle({a:?}, {b:?}, {c:?}, {d:?}): {ours:e} != {crate_value:e}"
    );
    // Classify by re-running the stages, to prove each path was exercised.
    match stage_b_permanent(a, b, c, d) {
        None => paths.stage_a += 1,
        Some(permanent) => match stage_b(a, b, c, d, permanent) {
            Some(_) => paths.stage_b += 1,
            None => paths.stage_c += 1,
        },
    }
}

/// `Some(permanent)` when stage A cannot decide, mirroring `incircle`.
fn stage_b_permanent(a: P, b: P, c: P, d: P) -> Option<f64> {
    let (adx, ady) = (a[0] - d[0], a[1] - d[1]);
    let (bdx, bdy) = (b[0] - d[0], b[1] - d[1]);
    let (cdx, cdy) = (c[0] - d[0], c[1] - d[1]);
    let (bdxcdy, cdxbdy) = (bdx * cdy, cdx * bdy);
    let (cdxady, adxcdy) = (cdx * ady, adx * cdy);
    let (adxbdy, bdxady) = (adx * bdy, bdx * ady);
    let alift = adx * adx + ady * ady;
    let blift = bdx * bdx + bdy * bdy;
    let clift = cdx * cdx + cdy * cdy;
    let det = alift * (bdxcdy - cdxbdy) + blift * (cdxady - adxcdy) + clift * (adxbdy - bdxady);
    let abs = geometry_predicates::predicates::abs;
    let permanent = (abs(bdxcdy) + abs(cdxbdy)) * alift
        + (abs(cdxady) + abs(adxcdy)) * blift
        + (abs(adxbdy) + abs(bdxady)) * clift;
    let errbound = super::ICC_ERRBOUND_A * permanent;
    (!(det > errbound || -det > errbound)).then_some(permanent)
}

#[test]
fn incircle_matches_geometry_predicates_bit_for_bit_issue_9016() {
    let mut rng = Rng(0x9016_8421_dead_beef);
    let mut paths = Paths::default();

    // Generic points: stage A.
    for _ in 0..20_000 {
        let p = [[rng.unit(), rng.unit()], [rng.unit(), rng.unit()], [rng.unit(), rng.unit()], [rng.unit(), rng.unit()]];
        check(&mut paths, p[0], p[1], p[2], p[3]);
    }

    // Integer lattice points, many cocircular or collinear: exact differences,
    // so stage B or its zero-tail return decides (the CDT's T-junction case).
    let ring: [P; 12] = [
        [5.0, 0.0], [4.0, 3.0], [3.0, 4.0], [0.0, 5.0], [-3.0, 4.0], [-4.0, 3.0],
        [-5.0, 0.0], [-4.0, -3.0], [-3.0, -4.0], [0.0, -5.0], [3.0, -4.0], [4.0, -3.0],
    ];
    for i in 0..ring.len() {
        for j in 0..ring.len() {
            for k in 0..ring.len() {
                for l in 0..ring.len() {
                    check(&mut paths, ring[i], ring[j], ring[k], ring[l]);
                }
            }
        }
    }
    for _ in 0..20_000 {
        let p: Vec<P> = (0..4).map(|_| [rng.int(4), rng.int(4)]).collect();
        check(&mut paths, p[0], p[1], p[2], p[3]);
    }

    // Collinear runs along a slanted constraint, scaled and offset off the
    // origin like a slab footprint in metres.
    for _ in 0..5_000 {
        let (ox, oy) = (rng.unit() * 100.0, rng.unit() * 100.0);
        let (dx, dy) = (rng.unit(), rng.unit());
        let t: Vec<f64> = (0..3).map(|_| rng.int(16) / 16.0).collect();
        let on = |s: f64| [ox + dx * s, oy + dy * s];
        check(&mut paths, on(t[0]), on(t[1]), on(t[2]), [ox + rng.unit(), oy + rng.unit()]);
        check(&mut paths, on(t[0]), [ox + rng.unit(), oy + rng.unit()], on(t[1]), on(t[2]));
    }

    // Lattice-cocircular `a`, `b`, `c` and a `d` nudged by ~1e-25: the rounded
    // differences stay exactly cocircular, so stage B cannot decide, but their
    // tails are not zero, so the crate's stage C must be reached.
    for i in 0..ring.len() {
        for j in 0..ring.len() {
            for k in 0..ring.len() {
                let d = ring[(i + j + k) % ring.len()];
                let nudged = [d[0] + rng.unit() * 1e-25, d[1] + rng.unit() * 1e-25];
                check(&mut paths, ring[i], ring[j], ring[k], nudged);
            }
        }
    }

    // Cocircular points with rounded coordinates: most are decided in stage B.
    for _ in 0..5_000 {
        let (cx, cy, r) = (rng.unit() * 1e3, rng.unit() * 1e3, 0.1 + rng.unit().abs());
        let on = |angle: f64| [cx + r * angle.cos(), cy + r * angle.sin()];
        check(&mut paths, on(0.3), on(2.1), on(4.0), on(rng.unit() * 6.0));
    }

    // Near-cocircular around the origin, `d` off the circle by r * 10^-k. The
    // coordinates straddle zero, so the differences are inexact, and for k in
    // 13..20 stage B's estimate lands near its own error bound. This is the
    // band that pins `ICC_ERRBOUND_B`: halve it and hundreds of these return
    // stage B's estimate where the crate refines in stage C (checked by
    // mutation against the revert oracle).
    for k in 12..20 {
        for _ in 0..1_000 {
            let (cx, cy, r) = (rng.unit() * 0.3, rng.unit() * 0.3, 0.5 + 0.5 * rng.unit().abs());
            let on = |angle: f64| [cx + r * angle.cos(), cy + r * angle.sin()];
            let d = on(rng.unit() * 6.0);
            let off = r * 10f64.powi(-k);
            let d = [d[0] + rng.unit() * off, d[1] + rng.unit() * off];
            check(&mut paths, on(0.3), on(2.1), on(4.0), d);
        }
    }

    // Near-cocircular: one ulp off a lattice circle, and huge/tiny magnitudes.
    for &scale in &[1e-300, 1e-12, 1.0, 1e12, 1e150] {
        for i in 0..ring.len() {
            let d = ring[(i + 5) % ring.len()];
            let nudged = [f64::from_bits(d[0].to_bits() + 1), d[1]];
            let s = |p: P| [p[0] * scale, p[1] * scale];
            check(&mut paths, s(ring[i]), s(ring[(i + 3) % 12]), s(ring[(i + 7) % 12]), s(nudged));
            check(&mut paths, s(ring[i]), s(ring[(i + 3) % 12]), s(ring[(i + 7) % 12]), s(d));
        }
    }

    // Degenerate and non-finite inputs keep the crate's value too.
    let z = [0.0, 0.0];
    check(&mut paths, z, z, z, z);
    check(&mut paths, [-0.0, 0.0], [1.0, -0.0], [0.0, 1.0], [-0.0, -0.0]);
    check(&mut paths, [f64::NAN, 0.0], [1.0, 0.0], [0.0, 1.0], [0.2, 0.2]);
    check(&mut paths, [f64::INFINITY, 0.0], [1.0, 0.0], [0.0, 1.0], [0.2, 0.2]);

    assert!(paths.stage_a > 10_000, "stage A barely exercised: {}", paths.stage_a);
    assert!(paths.stage_b > 10_000, "stage B barely exercised: {}", paths.stage_b);
    assert!(paths.stage_c > 500, "stage C hand-off barely exercised: {}", paths.stage_c);
}
