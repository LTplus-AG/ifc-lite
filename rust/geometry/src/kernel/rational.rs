// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Exact (BigRational) predicate tier — the correctness ground truth and the
//! cascade's last-resort exact fallback. f64 coordinates are exactly
//! representable as `BigRational`, so every sign here is mathematically exact.

use super::{DropAxis, ImplicitPoint, Lpi, Sign, Tpi};
use num_rational::BigRational;
use num_traits::{Signed, Zero};

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

/// Exact average of explicit points. Finite fallback for a degenerate (d==0)
/// implicit point whose λ/d is undefined (avoids a worker-aborting div-by-zero).
fn average(pts: &[[f64; 3]]) -> V3 {
    let n = BigRational::from_float(pts.len() as f64).unwrap();
    let mut acc = [r(0.0), r(0.0), r(0.0)];
    for p in pts {
        let v = vec(*p);
        acc = [&acc[0] + &v[0], &acc[1] + &v[1], &acc[2] + &v[2]];
    }
    [&acc[0] / &n, &acc[1] / &n, &acc[2] / &n]
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
/// Line `PQ` ∩ plane `RST`: parametrise `X = P + τ·(Q−P)`; on-plane gives
/// `(P−R)·(SR×TR) + τ·(Q−P)·(SR×TR) = 0`, i.e. `n + τ·d = 0`, so `τ = −n/d`
/// and `λ = d·P − n·(Q−P)` (the MINUS is load-bearing — `+` lands off the
/// plane; verified by `tritri::edge_crossing_lpi_lies_exactly_on_the_plane`).
/// `qp=Q−P; sr=S−R; tr=T−R; pr=P−R; d=det3(qp,sr,tr); n=det3(pr,sr,tr)`.
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
    let lx = &d * &p[0] - &n * &qp[0];
    let ly = &d * &p[1] - &n * &qp[1];
    let lz = &d * &p[2] - &n * &qp[2];
    ([lx, ly, lz], d)
}

/// The materialised LPI point `λ/d` (exact). Used by the oracle test that
/// independently checks the homogenised form in [`lpi_orient3d`].
pub fn lpi_point(l: &Lpi) -> V3 {
    let (lambda, d) = lpi_lambda(l);
    if d.is_zero() {
        // Degenerate LPI (line parallel to plane): λ/d undefined. Return the
        // segment midpoint instead of dividing by zero (which aborts the worker;
        // reachable via classify::to_f64_pt / boolean::point_via_interner).
        return average(&[l.p, l.q]);
    }
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
    if d.is_zero() {
        // Degenerate TPI (planes not concurrent at a point): λ/d undefined. Fall
        // back to the first plane's centroid instead of dividing by zero.
        return average(&t.planes[0]);
    }
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

/// Exact sign of `(proj_u(l1) − proj_u(l2))` where `proj_u(X)=X·u` — i.e. order
/// two LPI points along direction `u`. `proj = (λ·u)/d`, so the sign is
/// `assemble_sign(sign((λ1·u)·d2 − (λ2·u)·d1), &[sign(d1), sign(d2)])`.
///
/// `u` need only be APPROXIMATELY along the points' shared line L: for points on
/// L, `proj_u(p1)−proj_u(p2) = (s1−s2)(L_dir·u)`, so as long as `L_dir·u > 0` the
/// exact sign equals the true 1D order along L regardless of `u`'s rounding.
pub fn lpi_compare_along(l1: &Lpi, l2: &Lpi, u: [f64; 3]) -> Sign {
    let (lam1, d1) = lpi_lambda(l1);
    let (lam2, d2) = lpi_lambda(l2);
    let ur = vec(u);
    let dot1 = &lam1[0] * &ur[0] + &lam1[1] * &ur[1] + &lam1[2] * &ur[2];
    let dot2 = &lam2[0] * &ur[0] + &lam2[1] * &ur[1] + &lam2[2] * &ur[2];
    let num = &dot1 * &d2 - &dot2 * &d1;
    super::assemble_sign(sign_of(&num), &[sign_of(&d1), sign_of(&d2)])
}

/// λ/d of an implicit point (Lpi or Tpi). Callers dispatch — never `Explicit`.
pub(crate) fn lambda_of(p: &ImplicitPoint) -> (V3, BigRational) {
    match p {
        ImplicitPoint::Lpi(l) => lpi_lambda(l),
        ImplicitPoint::Tpi(t) => tpi_lambda(t),
        ImplicitPoint::Explicit(_) => unreachable!("lambda_of: Explicit point"),
    }
}

/// λ/d of ANY point: an `Explicit` coordinate is `(λ=coord, d=1)`. Inline here so
/// `cmp_along` never routes an `Explicit` through `lambda_of`'s `unreachable!`.
fn lambda_or_explicit(p: &ImplicitPoint) -> (V3, BigRational) {
    match p {
        ImplicitPoint::Explicit(e) => (vec(*e), r(1.0)),
        _ => lambda_of(p),
    }
}

/// Exact sign of `(a − b)·u` — order two points along direction `u`, over ANY
/// Explicit/Lpi/Tpi mix (generalises [`lpi_compare_along`]). With `a=λa/da`,
/// `b=λb/db`: `(a−b)·u = ((λa·u)·db − (λb·u)·da)/(da·db)`.
pub fn cmp_along(a: &ImplicitPoint, b: &ImplicitPoint, u: [f64; 3]) -> Sign {
    let (la, da) = lambda_or_explicit(a);
    let (lb, db) = lambda_or_explicit(b);
    let ur = vec(u);
    let dot_a = &la[0] * &ur[0] + &la[1] * &ur[1] + &la[2] * &ur[2];
    let dot_b = &lb[0] * &ur[0] + &lb[1] * &ur[1] + &lb[2] * &ur[2];
    let num = &dot_a * &db - &dot_b * &da;
    super::assemble_sign(sign_of(&num), &[sign_of(&da), sign_of(&db)])
}

/// Exact materialised coordinates of any point (for the oracle).
pub(crate) fn point_of(p: &ImplicitPoint) -> V3 {
    match p {
        ImplicitPoint::Lpi(l) => lpi_point(l),
        ImplicitPoint::Tpi(t) => tpi_point(t),
        ImplicitPoint::Explicit(e) => vec(*e),
    }
}

/// orient2d on three already-materialised points (oracle), projected by `axis`.
// Used only by the exact-arithmetic oracle in unit tests.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn orient2d_pts(a: &V3, b: &V3, c: &V3, axis: DropAxis) -> Sign {
    sign_of(&tri_area2(a, b, c, axis))
}

/// Exact twice-signed-area of a projected triangle (for coverage checks).
// Used only by the exact-arithmetic oracle in unit tests.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn tri_area2(a: &V3, b: &V3, c: &V3, axis: DropAxis) -> BigRational {
    let (i, j) = axis_idx(axis);
    (&a[i] - &c[i]) * (&b[j] - &c[j]) - (&a[j] - &c[j]) * (&b[i] - &c[i])
}

/// orient2d with TWO implicit points (a,b) and one explicit (c), projected after
/// `axis`. `orient2d = Λ′/(d1·d2)` with
/// `Λ′ = (λ1_i−d1·c_i)(λ2_j−d2·c_j) − (λ1_j−d1·c_j)(λ2_i−d2·c_i)`; both
/// denominators are odd → `den_signs = [sign(d1), sign(d2)]`.
pub fn orient2d_2i(a: &ImplicitPoint, b: &ImplicitPoint, c: [f64; 3], axis: DropAxis) -> Sign {
    let (i, j) = axis_idx(axis);
    let (lam1, d1) = lambda_of(a);
    let (lam2, d2) = lambda_of(b);
    let cr = vec(c);
    let a_i = &lam1[i] - &d1 * &cr[i];
    let a_j = &lam1[j] - &d1 * &cr[j];
    let b_i = &lam2[i] - &d2 * &cr[i];
    let b_j = &lam2[j] - &d2 * &cr[j];
    let det = &a_i * &b_j - &a_j * &b_i;
    super::assemble_sign(sign_of(&det), &[sign_of(&d1), sign_of(&d2)])
}

/// orient2d with THREE implicit points (a,b,c), projected after `axis`, based on
/// `a`: `Λ′ = (d1·λ2_i−d2·λ1_i)(d1·λ3_j−d3·λ1_j) − (d1·λ2_j−d2·λ1_j)(d1·λ3_i−d3·λ1_i)`.
/// `D′ = d1²·d2·d3`, so the squared `d1` is dropped → `den_signs = [sign(d2), sign(d3)]`.
pub fn orient2d_3i(a: &ImplicitPoint, b: &ImplicitPoint, c: &ImplicitPoint, axis: DropAxis) -> Sign {
    let (i, j) = axis_idx(axis);
    let (lam1, d1) = lambda_of(a);
    let (lam2, d2) = lambda_of(b);
    let (lam3, d3) = lambda_of(c);
    let u_i = &d1 * &lam2[i] - &d2 * &lam1[i];
    let u_j = &d1 * &lam2[j] - &d2 * &lam1[j];
    let v_i = &d1 * &lam3[i] - &d3 * &lam1[i];
    let v_j = &d1 * &lam3[j] - &d3 * &lam1[j];
    let det = &u_i * &v_j - &u_j * &v_i;
    super::assemble_sign(sign_of(&det), &[sign_of(&d2), sign_of(&d3)])
}

/// Exact sign of `a[k] − b[k]` (coordinate `k`) over any explicit/implicit mix.
fn cmp_axis(a: &ImplicitPoint, b: &ImplicitPoint, k: usize) -> Sign {
    use ImplicitPoint::Explicit;
    match (a, b) {
        (Explicit(ae), Explicit(be)) => sign_of(&(r(ae[k]) - r(be[k]))),
        (_, Explicit(be)) => {
            // a implicit: (λa_k − da·b_k)/da
            let (lam, d) = lambda_of(a);
            let bk = r(be[k]);
            super::assemble_sign(sign_of(&(&lam[k] - &d * &bk)), &[sign_of(&d)])
        }
        (Explicit(ae), _) => {
            // b implicit: (a_k·db − λb_k)/db
            let (lam, d) = lambda_of(b);
            let ak = r(ae[k]);
            super::assemble_sign(sign_of(&(&ak * &d - &lam[k])), &[sign_of(&d)])
        }
        (_, _) => {
            // both implicit: (λa_k·db − λb_k·da)/(da·db)
            let (la, da) = lambda_of(a);
            let (lb, db) = lambda_of(b);
            super::assemble_sign(sign_of(&(&la[k] * &db - &lb[k] * &da)), &[sign_of(&da), sign_of(&db)])
        }
    }
}

/// Exact lexicographic total order on points (x, then y, then z), over any mix
/// of `Explicit`/`Lpi`/`Tpi`. `Zero` ⇔ the two points are EXACTLY coincident —
/// this is the interner's symbolic vertex-identity test (no float weld). A
/// strict total order: antisymmetric, transitive (proven by property test).
pub fn cmp_lex(a: &ImplicitPoint, b: &ImplicitPoint) -> Sign {
    for k in 0..3 {
        let s = cmp_axis(a, b, k);
        if s != Sign::Zero {
            return s;
        }
    }
    Sign::Zero
}

#[cfg(test)]
#[path = "rational_tests.rs"]
mod rational_tests;
