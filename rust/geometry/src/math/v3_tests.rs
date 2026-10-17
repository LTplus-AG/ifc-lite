// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `v3`: bit equality against the expanded formulas (which are the spec, not
//! a copy of the implementation), the non-finite table, and the no-FMA pin.

use super::v3::*;

/// Seeded xorshift64*; the sweeps need no dependency.
pub(super) struct Rng(pub u64);

impl Rng {
    pub(super) fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// A finite f64: signed zeros, subnormals, unit values, 1e7-scale world
    /// coordinates, and a wide random spread.
    pub(super) fn f64(&mut self) -> f64 {
        const SPECIAL: [f64; 10] =
            [0.0, -0.0, 5e-324, -5e-324, 1.0, -1.0, 1e7, -1e7, 123_456.789, -0.5];
        let r = self.next();
        if r.is_multiple_of(4) {
            return SPECIAL[(r >> 8) as usize % SPECIAL.len()];
        }
        let unit = (self.next() >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0;
        unit * 10f64.powi((self.next() % 17) as i32 - 8)
    }

    pub(super) fn v3(&mut self) -> V3 {
        [self.f64(), self.f64(), self.f64()]
    }
}

fn same(a: V3, b: V3) -> bool {
    (0..3).all(|k| a[k].to_bits() == b[k].to_bits())
}

#[test]
fn arithmetic_matches_the_expanded_formulas_bit_for_bit() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for _ in 0..20_000 {
        let (a, b, c) = (rng.v3(), rng.v3(), rng.v3());
        assert!(same(add(a, b), [a[0] + b[0], a[1] + b[1], a[2] + b[2]]));
        assert!(same(sub(a, b), [a[0] - b[0], a[1] - b[1], a[2] - b[2]]));
        let s = rng.f64();
        assert!(same(scale(a, s), [a[0] * s, a[1] * s, a[2] * s]));
        assert_eq!(dot(a, b).to_bits(), (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).to_bits());
        let x = [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
        ];
        assert!(same(cross(a, b), x));
        assert_eq!(norm(a).to_bits(), (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt().to_bits());
        // `dist` is bit-equal to the `powi(2)` spelling it replaces.
        let powi = ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
        assert_eq!(dist(a, b).to_bits(), powi.to_bits());
        let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
        ];
        assert!(same(tri_normal(a, b, c), n));
    }
}

#[test]
fn dot_and_cross_are_not_fused() {
    // x*x rounds to 1 + 2^-29 (the 2^-60 tail is lost), so unfused
    // `x*x + y` is exactly 0 while any fma(..) would leave 2^-60.
    let x = 1.0 + 2f64.powi(-30);
    let y = -(1.0 + 2f64.powi(-29));
    assert_eq!(dot([x, y, 0.0], [x, 1.0, 0.0]), 0.0);
    assert_eq!(cross([0.0, x, -y], [0.0, 1.0, x])[0], 0.0);
}

#[test]
fn normalize_refuses_exactly_a_non_finite_or_short_length() {
    assert_eq!(normalize([0.0; 3], 0.0), None);
    assert_eq!(normalize([-0.0; 3], 0.0), None);
    assert_eq!(normalize([f64::NAN, 1.0, 0.0], 0.0), None);
    assert_eq!(normalize([f64::INFINITY, 0.0, 0.0], 0.0), None);
    assert_eq!(normalize([1e200, 1e200, 0.0], 0.0), None, "length overflows to inf");
    assert_eq!(normalize([3.0, 4.0, 0.0], 0.0), Some([0.6, 0.8, 0.0]));
    // `<= min_len` is refused, `>` is kept.
    assert_eq!(normalize([1e-12, 0.0, 0.0], 1e-12), None);
    assert_eq!(normalize([2e-12, 0.0, 0.0], 1e-12), Some([1.0, 0.0, 0.0]));
    // Division per component, not a reciprocal multiply.
    let mut rng = Rng(7);
    for _ in 0..5_000 {
        let v = rng.v3();
        let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        match normalize(v, 0.0) {
            Some(n) => assert!(same(n, [v[0] / len, v[1] / len, v[2] / len])),
            None => assert!(len == 0.0 || !len.is_finite()),
        }
    }
}

#[test]
fn canonical_makes_the_largest_component_positive_with_x_y_z_ties() {
    assert_eq!(canonical([-3.0, 1.0, 2.0]), [3.0, -1.0, -2.0]);
    assert_eq!(canonical([1.0, -3.0, 2.0]), [-1.0, 3.0, -2.0]);
    assert_eq!(canonical([1.0, 2.0, -3.0]), [-1.0, -2.0, 3.0]);
    // |x| = |y|: x wins; |y| = |z| (both > |x|): y wins; all equal: x wins.
    assert_eq!(canonical([-1.0, 1.0, 0.0]), [1.0, -1.0, 0.0]);
    assert_eq!(canonical([0.0, -1.0, 1.0]), [-0.0, 1.0, -1.0]);
    assert_eq!(canonical([-1.0, 1.0, 1.0]), [1.0, -1.0, -1.0]);
}
