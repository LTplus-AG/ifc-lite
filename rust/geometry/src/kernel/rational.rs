// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Exact (BigRational) predicate tier — the correctness ground truth and the
//! cascade's last-resort exact fallback. f64 coordinates are exactly
//! representable as `BigRational`, so every sign here is mathematically exact.

use super::{DropAxis, Lpi, Sign, Tpi};
use num_rational::BigRational;
use num_traits::Signed;

#[inline]
fn r(x: f64) -> BigRational {
    BigRational::from_float(x).expect("kernel: non-finite coordinate reached the exact predicate")
}

#[inline]
fn sign_of(x: &BigRational) -> Sign {
    if x.is_negative() {
        Sign::Negative
    } else if x.is_positive() {
        Sign::Positive
    } else {
        Sign::Zero
    }
}

type V3 = [BigRational; 3];

#[inline]
fn vec(p: [f64; 3]) -> V3 {
    [r(p[0]), r(p[1]), r(p[2])]
}

#[inline]
fn sub3(a: &V3, b: &V3) -> V3 {
    [&a[0] - &b[0], &a[1] - &b[1], &a[2] - &b[2]]
}

/// det of the 3×3 matrix with rows u, v, w  (= u · (v × w)).
fn det3(u: &V3, v: &V3, w: &V3) -> BigRational {
    &u[0] * (&v[1] * &w[2] - &v[2] * &w[1])
        + &u[1] * (&v[2] * &w[0] - &v[0] * &w[2])
        + &u[2] * (&v[0] * &w[1] - &v[1] * &w[0])
}

#[inline]
fn cross(u: &V3, v: &V3) -> V3 {
    [
        &u[1] * &v[2] - &u[2] * &v[1],
        &u[2] * &v[0] - &u[0] * &v[2],
        &u[0] * &v[1] - &u[1] * &v[0],
    ]
}

/// Exact explicit orient3d — Shewchuk's sign convention (matches
/// `geometry_predicates::orient3d`).
pub fn orient3d_exact(a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]) -> Sign {
    let (a, b, c, d) = (vec(a), vec(b), vec(c), vec(d));
    let ad = sub3(&a, &d);
    let bd = sub3(&b, &d);
    let cd = sub3(&c, &d);
    sign_of(&det3(&ad, &bd, &cd))
}

/// Exact orient2d on the two axes remaining after dropping `axis`.
pub fn orient2d_exact(a: [f64; 3], b: [f64; 3], c: [f64; 3], axis: DropAxis) -> Sign {
    let (i, j) = match axis {
        DropAxis::X => (1, 2),
        DropAxis::Y => (0, 2),
        DropAxis::Z => (0, 1),
    };
    let det = (r(a[i]) - r(c[i])) * (r(b[j]) - r(c[j])) - (r(a[j]) - r(c[j])) * (r(b[i]) - r(c[i]));
    sign_of(&det)
}

/// LPI λ-construction (exact): the implicit point is `(λx/d, λy/d, λz/d)`.
/// Cite: Attene "Indirect Predicates…" 2020 §4.2 — `qp=Q−P; sr=S−R; tr=T−R;
/// pr=P−R; d=det3(qp,sr,tr); n=det3(pr,sr,tr); λ = d·P + n·(Q−P)`.
pub fn lpi_lambda(l: &Lpi) -> (V3, BigRational) {
    let p = vec(l.p);
    let q = vec(l.q);
    let rr = vec(l.r);
    let s = vec(l.s);
    let t = vec(l.t);
    let qp = sub3(&q, &p);
    let sr = sub3(&s, &rr);
    let tr = sub3(&t, &rr);
    let pr = sub3(&p, &rr);
    let d = det3(&qp, &sr, &tr);
    let n = det3(&pr, &sr, &tr);
    let lx = &d * &p[0] + &n * &qp[0];
    let ly = &d * &p[1] + &n * &qp[1];
    let lz = &d * &p[2] + &n * &qp[2];
    ([lx, ly, lz], d)
}

/// The materialised LPI point `λ/d` (exact). Used by the oracle test that
/// independently checks the homogenised form in [`lpi_orient3d`].
pub fn lpi_point(l: &Lpi) -> V3 {
    let (lambda, d) = lpi_lambda(l);
    [&lambda[0] / &d, &lambda[1] / &d, &lambda[2] / &d]
}

/// Homogenised indirect orient3d for ONE implicit first-argument point `(λ/d)`
/// against three explicit points. `orient3d = (1/d)·Λ′`, where
/// `Λ′ = det3( (λ − d·p4), (p2−p4), (p3−p4) )`, so the geometric sign is
/// `assemble_sign(sign(Λ′), &[sign(d)])`. Shared by LPI and TPI — the
/// homogenisation depends only on the implicit-row count, not the point's
/// origin. The `sign(d)` flip (odd-multiplicity denominator) is mandatory.
fn indirect_orient3d(lambda: &V3, d: &BigRational, p2: [f64; 3], p3: [f64; 3], p4: [f64; 3]) -> Sign {
    let p4r = vec(p4);
    let row1 = [
        &lambda[0] - d * &p4r[0],
        &lambda[1] - d * &p4r[1],
        &lambda[2] - d * &p4r[2],
    ];
    let row2 = sub3(&vec(p2), &p4r);
    let row3 = sub3(&vec(p3), &p4r);
    super::assemble_sign(sign_of(&det3(&row1, &row2, &row3)), &[sign_of(d)])
}

/// Exact `orient3d(p1=LPI, p2, p3, p4)` with `p2,p3,p4` explicit.
pub fn lpi_orient3d(l: &Lpi, p2: [f64; 3], p3: [f64; 3], p4: [f64; 3]) -> Sign {
    let (lambda, d) = lpi_lambda(l);
    indirect_orient3d(&lambda, &d, p2, p3, p4)
}

/// TPI λ-construction (exact) via Cramer on the three plane equations
/// `nᵢ·x = cᵢ`, with `nᵢ=(Bᵢ−Aᵢ)×(Cᵢ−Aᵢ)`, `cᵢ=nᵢ·Aᵢ` (un-normalised → all
/// polynomials, no sqrt). Cite: Attene 2020 §4. `d=det3(n1,n2,n3)`, `λ` =
/// the Cramer numerators (column k replaced by `(c1,c2,c3)`).
pub fn tpi_lambda(t: &Tpi) -> (V3, BigRational) {
    let plane = |pl: &[[f64; 3]; 3]| -> (V3, BigRational) {
        let a = vec(pl[0]);
        let ba = sub3(&vec(pl[1]), &a);
        let ca = sub3(&vec(pl[2]), &a);
        let n = cross(&ba, &ca);
        let off = &n[0] * &a[0] + &n[1] * &a[1] + &n[2] * &a[2];
        (n, off)
    };
    let (n1, c1) = plane(&t.planes[0]);
    let (n2, c2) = plane(&t.planes[1]);
    let (n3, c3) = plane(&t.planes[2]);
    let d = det3(&n1, &n2, &n3);
    let ns = [&n1, &n2, &n3];
    let cs = [&c1, &c2, &c3];
    let cramer = |k: usize| -> BigRational {
        let mut rows: [V3; 3] = [ns[0].clone(), ns[1].clone(), ns[2].clone()];
        for (row, ci) in rows.iter_mut().zip(cs.iter()) {
            row[k] = (*ci).clone();
        }
        det3(&rows[0], &rows[1], &rows[2])
    };
    ([cramer(0), cramer(1), cramer(2)], d)
}

/// Exact `orient3d(p1=TPI, p2, p3, p4)` with `p2,p3,p4` explicit.
pub fn tpi_orient3d(t: &Tpi, p2: [f64; 3], p3: [f64; 3], p4: [f64; 3]) -> Sign {
    let (lambda, d) = tpi_lambda(t);
    indirect_orient3d(&lambda, &d, p2, p3, p4)
}

/// Materialised TPI point `λ/d` (exact) — for the oracle cross-check.
pub fn tpi_point(t: &Tpi) -> V3 {
    let (lambda, d) = tpi_lambda(t);
    [&lambda[0] / &d, &lambda[1] / &d, &lambda[2] / &d]
}

/// Oracle cross-check: orient3d with the first argument already materialised
/// (the exact LPI point). Independent of the homogenisation above — the two
/// MUST agree, which is what proves the `Λ′`/flip construction is correct.
pub fn orient3d_exact_pt(a: &V3, b: [f64; 3], c: [f64; 3], d: [f64; 3]) -> Sign {
    let (b, c, d) = (vec(b), vec(c), vec(d));
    let ad = sub3(a, &d);
    let bd = sub3(&b, &d);
    let cd = sub3(&c, &d);
    sign_of(&det3(&ad, &bd, &cd))
}

#[inline]
fn axis_idx(axis: DropAxis) -> (usize, usize) {
    match axis {
        DropAxis::X => (1, 2),
        DropAxis::Y => (0, 2),
        DropAxis::Z => (0, 1),
    }
}

/// Homogenised indirect orient2d for one implicit point `(λ/d)` against two
/// explicit points, projected on the two axes remaining after dropping `axis`.
/// `orient2d = (1/d)·Λ′₂` (the predicate is linear in the single implicit
/// point), so `sign = assemble_sign(sign(Λ′₂), &[sign(d)])` — the same odd
/// `sign(d)` flip as the 1-implicit orient3d.
fn indirect_orient2d(lambda: &V3, d: &BigRational, b: [f64; 3], c: [f64; 3], axis: DropAxis) -> Sign {
    let (i, j) = axis_idx(axis);
    let br = vec(b);
    let cr = vec(c);
    let li = &lambda[i] - d * &cr[i];
    let lj = &lambda[j] - d * &cr[j];
    let lambda_det2 = &li * (&br[j] - &cr[j]) - &lj * (&br[i] - &cr[i]);
    super::assemble_sign(sign_of(&lambda_det2), &[sign_of(d)])
}

/// Exact `orient2d(p1=LPI, b, c)` (b,c explicit), projected after `axis`.
pub fn lpi_orient2d(l: &Lpi, b: [f64; 3], c: [f64; 3], axis: DropAxis) -> Sign {
    let (lambda, d) = lpi_lambda(l);
    indirect_orient2d(&lambda, &d, b, c, axis)
}

/// Exact `orient2d(p1=TPI, b, c)` (b,c explicit), projected after `axis`.
pub fn tpi_orient2d(t: &Tpi, b: [f64; 3], c: [f64; 3], axis: DropAxis) -> Sign {
    let (lambda, d) = tpi_lambda(t);
    indirect_orient2d(&lambda, &d, b, c, axis)
}

/// Oracle cross-check: orient2d with the first arg already materialised.
pub fn orient2d_exact_pt(a: &V3, b: [f64; 3], c: [f64; 3], axis: DropAxis) -> Sign {
    let (i, j) = axis_idx(axis);
    let (br, cr) = (vec(b), vec(c));
    let det = (&a[i] - &cr[i]) * (&br[j] - &cr[j]) - (&a[j] - &cr[j]) * (&br[i] - &cr[i]);
    sign_of(&det)
}
