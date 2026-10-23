// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

/// The `nalgebra` spelling `ray_triangle_param` replaced (C2-5, ROUTER-8),
/// kept as the oracle that the array spelling is bit-equal to it.
fn legacy(
    origin: Point3<f64>,
    dir: &Vector3<f64>,
    a: Point3<f64>,
    b: Point3<f64>,
    c: Point3<f64>,
) -> Option<f64> {
    const EPS: f64 = 1e-9;
    let e1 = b - a;
    let e2 = c - a;
    let pvec = dir.cross(&e2);
    let det = e1.dot(&pvec);
    if det.abs() < EPS {
        return None;
    }
    let inv_det = 1.0 / det;
    let tvec = origin - a;
    let u = tvec.dot(&pvec) * inv_det;
    if !(-EPS..=1.0 + EPS).contains(&u) {
        return None;
    }
    let qvec = tvec.cross(&e1);
    let v = dir.dot(&qvec) * inv_det;
    if v < -EPS || u + v > 1.0 + EPS {
        return None;
    }
    Some(e2.dot(&qvec) * inv_det)
}

/// Deterministic xorshift stream of coordinates: mostly metre-scale, some
/// far-from-origin, some exact zeros and signed zeros.
struct Stream(u64);
impl Stream {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        let unit = (self.0 >> 11) as f64 / (1u64 << 53) as f64;
        match self.0 % 11 {
            0 => 0.0,
            1 => -0.0,
            2 => (unit - 0.5) * 2.0e6,
            3 => (unit - 0.5) * 1.0e-6,
            _ => (unit - 0.5) * 20.0,
        }
    }
    fn v(&mut self) -> V3 {
        [self.next(), self.next(), self.next()]
    }
}

fn pt(v: V3) -> Point3<f64> {
    Point3::new(v[0], v[1], v[2])
}

#[test]
fn ray_triangle_matches_nalgebra_spelling() {
    let mut s = Stream(0x9E37_79B9_7F4A_7C15);
    let mut hits = 0usize;
    for i in 0..200_000 {
        let (o, a, b, c) = (s.v(), s.v(), s.v(), s.v());
        // Aim a third of the rays at the triangle's own interior so the hit
        // branch (and its `t`) is compared, not just the miss branches.
        let o = if i % 3 == 0 {
            let w = [0.2, 0.3, 0.5];
            let target = [
                a[0] * w[0] + b[0] * w[1] + c[0] * w[2],
                a[1] * w[0] + b[1] * w[1] + c[1] * w[2],
                a[2] * w[0] + b[2] * w[1] + c[2] * w[2],
            ];
            [
                target[0] - PARITY_DIR_A[0] * 3.0,
                target[1] - PARITY_DIR_A[1] * 3.0,
                target[2] - PARITY_DIR_A[2] * 3.0,
            ]
        } else {
            o
        };
        let dir = if i % 2 == 0 { PARITY_DIR_A } else { PARITY_DIR_B };
        let old = legacy(pt(o), &Vector3::new(dir[0], dir[1], dir[2]), pt(a), pt(b), pt(c));
        let new = ray_triangle_param(o, dir, a, b, c, 1e-9, 1e-9);
        assert_eq!(old.map(f64::to_bits), new.map(f64::to_bits), "case {i}");
        hits += usize::from(new.is_some());
    }
    assert!(hits > 10_000, "the sweep must reach the hit branch ({hits})");
}

#[test]
fn forward_crossing_counts_only_hits_ahead_of_the_origin() {
    let (a, b, c) = ([0.0, 0.0, 1.0], [4.0, 0.0, 1.0], [0.0, 4.0, 1.0]);
    let dir = [0.0, 0.0, 1.0];
    assert!(forward_crossing([1.0, 1.0, 0.0], dir, a, b, c, 1e-9));
    assert!(!forward_crossing([1.0, 1.0, 2.0], dir, a, b, c, 1e-9));
    // A ray parallel to the triangle plane is not a crossing at any floor.
    assert!(!forward_crossing([1.0, 1.0, 1.0], [1.0, 0.0, 0.0], a, b, c, 1e-9));
}
