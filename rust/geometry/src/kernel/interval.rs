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

use super::{DropAxis, ImplicitPoint, Lpi, Sign, Tpi};

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

#[inline]
fn icross(u: &Iv3, v: &Iv3) -> Iv3 {
    [
        u[1].mul(v[2]).sub(u[2].mul(v[1])),
        u[2].mul(v[0]).sub(u[0].mul(v[2])),
        u[0].mul(v[1]).sub(u[1].mul(v[0])),
    ]
}

fn lpi_lambda(l: &Lpi) -> (Iv3, RnInterval) {
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
    // λ = d·P − n·(Q−P)  (see rational::lpi_lambda — the minus is load-bearing).
    let lx = d.mul(p[0]).sub(n.mul(qp[0]));
    let ly = d.mul(p[1]).sub(n.mul(qp[1]));
    let lz = d.mul(p[2]).sub(n.mul(qp[2]));
    ([lx, ly, lz], d)
}

fn tpi_lambda(t: &Tpi) -> (Iv3, RnInterval) {
    let plane = |pl: &[[f64; 3]; 3]| -> (Iv3, RnInterval) {
        let a = ivec(pl[0]);
        let ba = isub(&ivec(pl[1]), &a);
        let ca = isub(&ivec(pl[2]), &a);
        let n = icross(&ba, &ca);
        let off = n[0].mul(a[0]).add(n[1].mul(a[1])).add(n[2].mul(a[2]));
        (n, off)
    };
    let (n1, c1) = plane(&t.planes[0]);
    let (n2, c2) = plane(&t.planes[1]);
    let (n3, c3) = plane(&t.planes[2]);
    let d = idet3(&n1, &n2, &n3);
    let ns = [n1, n2, n3];
    let cs = [c1, c2, c3];
    let cramer = |k: usize| -> RnInterval {
        let mut rows = [ns[0], ns[1], ns[2]];
        for (row, ci) in rows.iter_mut().zip(cs.iter()) {
            row[k] = *ci;
        }
        idet3(&rows[0], &rows[1], &rows[2])
    };
    ([cramer(0), cramer(1), cramer(2)], d)
}

/// Interval-tier indirect orient3d for one implicit point `(λ/d)`. `None` ⇒ the
/// `Λ′` or `d` interval straddles zero ⇒ escalate to the exact tier.
fn indirect_orient3d(
    lambda: &Iv3,
    d: RnInterval,
    p2: [f64; 3],
    p3: [f64; 3],
    p4: [f64; 3],
) -> Option<Sign> {
    let p4i = ivec(p4);
    let row1 = [
        lambda[0].sub(d.mul(p4i[0])),
        lambda[1].sub(d.mul(p4i[1])),
        lambda[2].sub(d.mul(p4i[2])),
    ];
    let row2 = isub(&ivec(p2), &p4i);
    let row3 = isub(&ivec(p3), &p4i);
    let lambda_det = idet3(&row1, &row2, &row3);
    let sd = d.sign()?;
    let sld = lambda_det.sign()?;
    Some(super::assemble_sign(sld, &[sd]))
}

pub fn lpi_orient3d(l: &Lpi, p2: [f64; 3], p3: [f64; 3], p4: [f64; 3]) -> Option<Sign> {
    let (lambda, d) = lpi_lambda(l);
    indirect_orient3d(&lambda, d, p2, p3, p4)
}

pub fn tpi_orient3d(t: &Tpi, p2: [f64; 3], p3: [f64; 3], p4: [f64; 3]) -> Option<Sign> {
    let (lambda, d) = tpi_lambda(t);
    indirect_orient3d(&lambda, d, p2, p3, p4)
}

#[inline]
fn axis_idx(axis: DropAxis) -> (usize, usize) {
    match axis {
        DropAxis::X => (1, 2),
        DropAxis::Y => (0, 2),
        DropAxis::Z => (0, 1),
    }
}

/// Interval-tier indirect orient2d for one implicit point `(λ/d)`. `None` ⇒ the
/// `Λ′₂` or `d` interval straddles zero ⇒ escalate to the exact tier.
fn indirect_orient2d(
    lambda: &Iv3,
    d: RnInterval,
    b: [f64; 3],
    c: [f64; 3],
    axis: DropAxis,
) -> Option<Sign> {
    let (i, j) = axis_idx(axis);
    let br = ivec(b);
    let cr = ivec(c);
    let li = lambda[i].sub(d.mul(cr[i]));
    let lj = lambda[j].sub(d.mul(cr[j]));
    let lambda_det2 = li.mul(br[j].sub(cr[j])).sub(lj.mul(br[i].sub(cr[i])));
    let sd = d.sign()?;
    let sld = lambda_det2.sign()?;
    Some(super::assemble_sign(sld, &[sd]))
}

pub fn lpi_orient2d(l: &Lpi, b: [f64; 3], c: [f64; 3], axis: DropAxis) -> Option<Sign> {
    let (lambda, d) = lpi_lambda(l);
    indirect_orient2d(&lambda, d, b, c, axis)
}

pub fn tpi_orient2d(t: &Tpi, b: [f64; 3], c: [f64; 3], axis: DropAxis) -> Option<Sign> {
    let (lambda, d) = tpi_lambda(t);
    indirect_orient2d(&lambda, d, b, c, axis)
}

/// λ/d (interval) of an implicit point. Callers dispatch — never `Explicit`.
fn ilambda_of(p: &ImplicitPoint) -> (Iv3, RnInterval) {
    match p {
        ImplicitPoint::Lpi(l) => lpi_lambda(l),
        ImplicitPoint::Tpi(t) => tpi_lambda(t),
        ImplicitPoint::Explicit(_) => unreachable!("ilambda_of: Explicit"),
    }
}

/// Interval tier of `rational::orient2d_2i` — `None` on a zero-straddle.
pub fn orient2d_2i(a: &ImplicitPoint, b: &ImplicitPoint, c: [f64; 3], axis: DropAxis) -> Option<Sign> {
    let (i, j) = axis_idx(axis);
    let (lam1, d1) = ilambda_of(a);
    let (lam2, d2) = ilambda_of(b);
    let cr = ivec(c);
    let a_i = lam1[i].sub(d1.mul(cr[i]));
    let a_j = lam1[j].sub(d1.mul(cr[j]));
    let b_i = lam2[i].sub(d2.mul(cr[i]));
    let b_j = lam2[j].sub(d2.mul(cr[j]));
    let det = a_i.mul(b_j).sub(a_j.mul(b_i));
    let sd1 = d1.sign()?;
    let sd2 = d2.sign()?;
    Some(super::assemble_sign(det.sign()?, &[sd1, sd2]))
}

/// Interval tier of `rational::orient2d_3i` — `None` on a zero-straddle.
pub fn orient2d_3i(a: &ImplicitPoint, b: &ImplicitPoint, c: &ImplicitPoint, axis: DropAxis) -> Option<Sign> {
    let (i, j) = axis_idx(axis);
    let (lam1, d1) = ilambda_of(a);
    let (lam2, d2) = ilambda_of(b);
    let (lam3, d3) = ilambda_of(c);
    let u_i = d1.mul(lam2[i]).sub(d2.mul(lam1[i]));
    let u_j = d1.mul(lam2[j]).sub(d2.mul(lam1[j]));
    let v_i = d1.mul(lam3[i]).sub(d3.mul(lam1[i]));
    let v_j = d1.mul(lam3[j]).sub(d3.mul(lam1[j]));
    let det = u_i.mul(v_j).sub(u_j.mul(v_i));
    let sd2 = d2.sign()?;
    let sd3 = d3.sign()?;
    Some(super::assemble_sign(det.sign()?, &[sd2, sd3]))
}

/// Interval tier of one `cmp_lex` axis comparison — `None` on a zero-straddle.
fn icmp_axis(a: &ImplicitPoint, b: &ImplicitPoint, k: usize) -> Option<Sign> {
    use ImplicitPoint::Explicit;
    match (a, b) {
        (Explicit(ae), Explicit(be)) => Some(if ae[k] < be[k] {
            Sign::Negative
        } else if ae[k] > be[k] {
            Sign::Positive
        } else {
            Sign::Zero
        }),
        (_, Explicit(be)) => {
            let (lam, d) = ilambda_of(a);
            let num = lam[k].sub(d.mul(RnInterval::point(be[k])));
            Some(super::assemble_sign(num.sign()?, &[d.sign()?]))
        }
        (Explicit(ae), _) => {
            let (lam, d) = ilambda_of(b);
            let num = RnInterval::point(ae[k]).mul(d).sub(lam[k]);
            Some(super::assemble_sign(num.sign()?, &[d.sign()?]))
        }
        (_, _) => {
            let (la, da) = ilambda_of(a);
            let (lb, db) = ilambda_of(b);
            let num = la[k].mul(db).sub(lb[k].mul(da));
            Some(super::assemble_sign(num.sign()?, &[da.sign()?, db.sign()?]))
        }
    }
}

/// Interval tier of `rational::cmp_lex`. `None` if the deciding axis straddles
/// zero (escalate to exact). A definite-Zero axis advances to the next.
pub fn cmp_lex(a: &ImplicitPoint, b: &ImplicitPoint) -> Option<Sign> {
    for k in 0..3 {
        match icmp_axis(a, b, k)? {
            Sign::Zero => continue,
            s => return Some(s),
        }
    }
    Some(Sign::Zero)
}
