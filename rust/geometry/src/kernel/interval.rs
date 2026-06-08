// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Directed-rounding f64 interval tier — the predicate cascade's fast path.
//!
//! Every op widens the interval OUTWARD (round-to-nearest then ±1 ULP), so the
//! true real value is always bracketed. A predicate's sign is returned only
//! when the result interval is strictly one side of zero; a straddling interval
//! is a genuine near-degeneracy and escalates to the exact (BigRational) tier.
//! Because the interval can never claim a definite sign it doesn't have, it can
//! never return a WRONG sign — proven by the soundness test against the oracle.
//!
//! `next_up`/`next_down` are integer bit-twiddles (not `f64::next_up`), so the
//! widening is bit-identical across x86_64/aarch64/wasm — the determinism bar.
//! No `mul_add`/FMA anywhere (contraction would break the directed rounding).

use super::{Lpi, Sign};

#[derive(Clone, Copy, Debug)]
pub struct RnInterval {
    pub lo: f64,
    pub hi: f64,
}

/// Smallest representable f64 strictly greater than `x` (toward +∞).
#[inline]
pub fn next_up(x: f64) -> f64 {
    if x.is_nan() || x == f64::INFINITY {
        return x;
    }
    if x == 0.0 {
        return f64::from_bits(1); // +smallest subnormal
    }
    let b = x.to_bits();
    f64::from_bits(if x > 0.0 { b + 1 } else { b - 1 })
}

/// Largest representable f64 strictly less than `x` (toward −∞).
#[inline]
pub fn next_down(x: f64) -> f64 {
    if x.is_nan() || x == f64::NEG_INFINITY {
        return x;
    }
    if x == 0.0 {
        return -f64::from_bits(1); // −smallest subnormal
    }
    let b = x.to_bits();
    f64::from_bits(if x > 0.0 { b - 1 } else { b + 1 })
}

impl RnInterval {
    #[inline]
    pub fn point(x: f64) -> Self {
        Self { lo: x, hi: x }
    }
    #[inline]
    pub fn add(self, o: Self) -> Self {
        Self { lo: next_down(self.lo + o.lo), hi: next_up(self.hi + o.hi) }
    }
    #[inline]
    pub fn sub(self, o: Self) -> Self {
        Self { lo: next_down(self.lo - o.hi), hi: next_up(self.hi - o.lo) }
    }
    #[inline]
    pub fn mul(self, o: Self) -> Self {
        let c = [self.lo * o.lo, self.lo * o.hi, self.hi * o.lo, self.hi * o.hi];
        let mut mn = c[0];
        let mut mx = c[0];
        for &v in &c[1..] {
            if v < mn {
                mn = v;
            }
            if v > mx {
                mx = v;
            }
        }
        Self { lo: next_down(mn), hi: next_up(mx) }
    }
    /// Definite sign, or `None` if the interval straddles zero (escalate).
    #[inline]
    pub fn sign(self) -> Option<Sign> {
        if self.lo > 0.0 {
            Some(Sign::Positive)
        } else if self.hi < 0.0 {
            Some(Sign::Negative)
        } else if self.lo == 0.0 && self.hi == 0.0 {
            Some(Sign::Zero)
        } else {
            None
        }
    }
}

type Iv3 = [RnInterval; 3];

#[inline]
fn ivec(p: [f64; 3]) -> Iv3 {
    [RnInterval::point(p[0]), RnInterval::point(p[1]), RnInterval::point(p[2])]
}
#[inline]
fn isub(a: &Iv3, b: &Iv3) -> Iv3 {
    [a[0].sub(b[0]), a[1].sub(b[1]), a[2].sub(b[2])]
}
fn idet3(u: &Iv3, v: &Iv3, w: &Iv3) -> RnInterval {
    u[0]
        .mul(v[1].mul(w[2]).sub(v[2].mul(w[1])))
        .add(u[1].mul(v[2].mul(w[0]).sub(v[0].mul(w[2]))))
        .add(u[2].mul(v[0].mul(w[1]).sub(v[1].mul(w[0]))))
}

/// Interval-tier LPI-orient3d (mirrors `rational::lpi_orient3d`). `None` ⇒ the
/// `Λ′` or `d` interval straddles zero ⇒ escalate to the exact tier.
pub fn lpi_orient3d(l: &Lpi, p2: [f64; 3], p3: [f64; 3], p4: [f64; 3]) -> Option<Sign> {
    let p = ivec(l.p);
    let q = ivec(l.q);
    let rr = ivec(l.r);
    let s = ivec(l.s);
    let t = ivec(l.t);
    let qp = isub(&q, &p);
    let sr = isub(&s, &rr);
    let tr = isub(&t, &rr);
    let pr = isub(&p, &rr);
    let d = idet3(&qp, &sr, &tr);
    let n = idet3(&pr, &sr, &tr);
    let lx = d.mul(p[0]).add(n.mul(qp[0]));
    let ly = d.mul(p[1]).add(n.mul(qp[1]));
    let lz = d.mul(p[2]).add(n.mul(qp[2]));
    let p4i = ivec(p4);
    let row1 = [lx.sub(d.mul(p4i[0])), ly.sub(d.mul(p4i[1])), lz.sub(d.mul(p4i[2]))];
    let row2 = isub(&ivec(p2), &p4i);
    let row3 = isub(&ivec(p3), &p4i);
    let lambda_det = idet3(&row1, &row2, &row3);
    // Both the homogenised determinant and the denominator must be sign-definite.
    let sd = d.sign()?;
    let sld = lambda_det.sign()?;
    Some(super::assemble_sign(sld, &[sd]))
}
