// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Fixed-width exact predicate tier — the FAST exact arithmetic between the
//! interval filter and the BigRational fallback.
//!
//! `num-rational` is correct but ~3ms/call (heap-allocated `BigInt` + the `Ratio`
//! wrapper on every op). The orient predicates are sign-invariant under uniform
//! positive coordinate scaling, so on-grid coords (the f32-snap grid, `k/2^16`)
//! scale to EXACT `i64` integers and the whole lambda/determinant computes in
//! stack-allocated bnum integers — no heap, no GCD. Every op is CHECKED: an
//! overflow (the chosen width is too narrow) OR an off-grid coord returns `None`.
//!
//! TIERED WIDTH: the same predicate is generated (by the `fixed_impl!` macro) at
//! I256 / I512 / I1024. The public dispatch tries the NARROWEST first — most LPI
//! predicates on building-scale coords fit I256 (4× faster than I1024) — and
//! escalates on overflow. So the result is always a sign identical to
//! BigRational, or a deferral up the cascade and finally to BigRational.
//!
//! DUAL SCALE (crack-family fix): the exact-plane lift in `mesh_bridge` welds
//! near-coplanar cutter vertices onto host planes at the FINER `k/2^36` grid
//! (`2^16` snap grid × the `2^20` α,β quantization). Those coordinates fail the
//! coarse `gi` fract check and previously fell to the ~3 ms BigRational tier on
//! EVERY predicate. The cascade therefore carries a second, fine-scale family
//! (`f256`/`f512`/`f1024`/`f2048`, gi scale `2^36`) tried only after the coarse
//! family declines — orientation predicates are sign-invariant under uniform
//! positive scaling, so a per-call uniform scale is exactly equivalent. The
//! extra `f2048` rung exists because second-order TPI×TPI products at the fine
//! scale reach ≈1340 bits (overflow I1024). Coarse-grid inputs keep resolving
//! in the unchanged coarse family ⇒ zero cost on the common path.

use super::{DropAxis, ImplicitPoint, Sign};

/// Generate the full predicate set over a fixed-width signed integer type at a
/// fixed coordinate scale (the grid the inputs must lie on, e.g. 2^16 or 2^36).
macro_rules! fixed_impl {
    ($T:ty, $scale:expr) => {
        use super::super::{assemble_sign, DropAxis, ImplicitPoint, Lpi, Sign, Tpi};
        use num_traits::{CheckedAdd, CheckedMul, CheckedSub, FromPrimitive, One, Signed};

        type I = $T;
        type V3 = [I; 3];

        #[inline]
        fn gi(x: f64) -> Option<I> {
            let scaled = x * $scale;
            if !scaled.is_finite() || scaled.fract() != 0.0 || scaled.abs() >= 9.0e18 {
                return None;
            }
            I::from_i64(scaled as i64)
        }
        #[inline]
        fn vec(p: [f64; 3]) -> Option<V3> {
            Some([gi(p[0])?, gi(p[1])?, gi(p[2])?])
        }
        #[inline]
        fn mul(a: I, b: I) -> Option<I> {
            CheckedMul::checked_mul(&a, &b)
        }
        #[inline]
        fn sub(a: I, b: I) -> Option<I> {
            CheckedSub::checked_sub(&a, &b)
        }
        #[inline]
        fn add(a: I, b: I) -> Option<I> {
            CheckedAdd::checked_add(&a, &b)
        }
        fn sub3(a: &V3, b: &V3) -> Option<V3> {
            Some([sub(a[0], b[0])?, sub(a[1], b[1])?, sub(a[2], b[2])?])
        }
        fn cross(u: &V3, v: &V3) -> Option<V3> {
            Some([
                sub(mul(u[1], v[2])?, mul(u[2], v[1])?)?,
                sub(mul(u[2], v[0])?, mul(u[0], v[2])?)?,
                sub(mul(u[0], v[1])?, mul(u[1], v[0])?)?,
            ])
        }
        fn det3(u: &V3, v: &V3, w: &V3) -> Option<I> {
            let m0 = sub(mul(v[1], w[2])?, mul(v[2], w[1])?)?;
            let m1 = sub(mul(v[2], w[0])?, mul(v[0], w[2])?)?;
            let m2 = sub(mul(v[0], w[1])?, mul(v[1], w[0])?)?;
            add(add(mul(u[0], m0)?, mul(u[1], m1)?)?, mul(u[2], m2)?)
        }
        #[inline]
        fn sign_of(x: &I) -> Sign {
            // Avoid `I::cmp` (vectorised to a v16i8 setcc wasm-SIMD128 can't select).
            if x.is_negative() {
                Sign::Negative
            } else if x.is_zero() {
                Sign::Zero
            } else {
                Sign::Positive
            }
        }
        #[inline]
        fn axis_idx(axis: DropAxis) -> (usize, usize) {
            match axis {
                DropAxis::X => (1, 2),
                DropAxis::Y => (0, 2),
                DropAxis::Z => (0, 1),
            }
        }
        fn lpi_lambda(l: &Lpi) -> Option<(V3, I)> {
            let p = vec(l.p)?;
            let q = vec(l.q)?;
            let rr = vec(l.r)?;
            let s = vec(l.s)?;
            let t = vec(l.t)?;
            let qp = sub3(&q, &p)?;
            let sr = sub3(&s, &rr)?;
            let tr = sub3(&t, &rr)?;
            let pr = sub3(&p, &rr)?;
            let d = det3(&qp, &sr, &tr)?;
            let n = det3(&pr, &sr, &tr)?;
            let lx = sub(mul(d, p[0])?, mul(n, qp[0])?)?;
            let ly = sub(mul(d, p[1])?, mul(n, qp[1])?)?;
            let lz = sub(mul(d, p[2])?, mul(n, qp[2])?)?;
            Some(([lx, ly, lz], d))
        }
        fn tpi_lambda(t: &Tpi) -> Option<(V3, I)> {
            let plane = |pl: &[[f64; 3]; 3]| -> Option<(V3, I)> {
                let a = vec(pl[0])?;
                let ba = sub3(&vec(pl[1])?, &a)?;
                let ca = sub3(&vec(pl[2])?, &a)?;
                let n = cross(&ba, &ca)?;
                let off = add(add(mul(n[0], a[0])?, mul(n[1], a[1])?)?, mul(n[2], a[2])?)?;
                Some((n, off))
            };
            let (n1, c1) = plane(&t.planes[0])?;
            let (n2, c2) = plane(&t.planes[1])?;
            let (n3, c3) = plane(&t.planes[2])?;
            let d = det3(&n1, &n2, &n3)?;
            let ns = [n1, n2, n3];
            let cs = [c1, c2, c3];
            let cramer = |k: usize| -> Option<I> {
                let mut rows = [ns[0], ns[1], ns[2]];
                for (row, &ci) in rows.iter_mut().zip(cs.iter()) {
                    row[k] = ci;
                }
                det3(&rows[0], &rows[1], &rows[2])
            };
            Some(([cramer(0)?, cramer(1)?, cramer(2)?], d))
        }
        pub fn lambda_of(p: &ImplicitPoint) -> Option<(V3, I)> {
            match p {
                ImplicitPoint::Lpi(l) => lpi_lambda(l),
                ImplicitPoint::Tpi(t) => tpi_lambda(t),
                ImplicitPoint::Explicit(e) => Some((vec(*e)?, I::one())),
            }
        }
        pub fn orient2d_2i(a: &ImplicitPoint, b: &ImplicitPoint, c: [f64; 3], axis: DropAxis) -> Option<Sign> {
            let (i, j) = axis_idx(axis);
            let (lam1, d1) = lambda_of(a)?;
            let (lam2, d2) = lambda_of(b)?;
            let cr = vec(c)?;
            let a_i = sub(lam1[i], mul(d1, cr[i])?)?;
            let a_j = sub(lam1[j], mul(d1, cr[j])?)?;
            let b_i = sub(lam2[i], mul(d2, cr[i])?)?;
            let b_j = sub(lam2[j], mul(d2, cr[j])?)?;
            let det = sub(mul(a_i, b_j)?, mul(a_j, b_i)?)?;
            Some(assemble_sign(sign_of(&det), &[sign_of(&d1), sign_of(&d2)]))
        }
        pub fn orient2d_3i(a: &ImplicitPoint, b: &ImplicitPoint, c: &ImplicitPoint, axis: DropAxis) -> Option<Sign> {
            let (i, j) = axis_idx(axis);
            let (lam1, d1) = lambda_of(a)?;
            let (lam2, d2) = lambda_of(b)?;
            let (lam3, d3) = lambda_of(c)?;
            let u_i = sub(mul(d1, lam2[i])?, mul(d2, lam1[i])?)?;
            let u_j = sub(mul(d1, lam2[j])?, mul(d2, lam1[j])?)?;
            let v_i = sub(mul(d1, lam3[i])?, mul(d3, lam1[i])?)?;
            let v_j = sub(mul(d1, lam3[j])?, mul(d3, lam1[j])?)?;
            let det = sub(mul(u_i, v_j)?, mul(u_j, v_i)?)?;
            Some(assemble_sign(sign_of(&det), &[sign_of(&d2), sign_of(&d3)]))
        }
        pub fn indirect_orient2d(p: &ImplicitPoint, b: [f64; 3], c: [f64; 3], axis: DropAxis) -> Option<Sign> {
            let (i, j) = axis_idx(axis);
            let (lambda, d) = lambda_of(p)?;
            let br = vec(b)?;
            let cr = vec(c)?;
            let li = sub(lambda[i], mul(d, cr[i])?)?;
            let lj = sub(lambda[j], mul(d, cr[j])?)?;
            let det = sub(mul(li, sub(br[j], cr[j])?)?, mul(lj, sub(br[i], cr[i])?)?)?;
            Some(assemble_sign(sign_of(&det), &[sign_of(&d)]))
        }
        fn cmp_axis(a: &ImplicitPoint, b: &ImplicitPoint, k: usize) -> Option<Sign> {
            use ImplicitPoint::Explicit;
            match (a, b) {
                (Explicit(ae), Explicit(be)) => Some(sign_of(&sub(gi(ae[k])?, gi(be[k])?)?)),
                (_, Explicit(be)) => {
                    let (lam, d) = lambda_of(a)?;
                    let bk = gi(be[k])?;
                    Some(assemble_sign(sign_of(&sub(lam[k], mul(d, bk)?)?), &[sign_of(&d)]))
                }
                (Explicit(ae), _) => {
                    let (lam, d) = lambda_of(b)?;
                    let ak = gi(ae[k])?;
                    Some(assemble_sign(sign_of(&sub(mul(ak, d)?, lam[k])?), &[sign_of(&d)]))
                }
                (_, _) => {
                    let (la, da) = lambda_of(a)?;
                    let (lb, db) = lambda_of(b)?;
                    Some(assemble_sign(
                        sign_of(&sub(mul(la[k], db)?, mul(lb[k], da)?)?),
                        &[sign_of(&da), sign_of(&db)],
                    ))
                }
            }
        }
        pub fn cmp_lex(a: &ImplicitPoint, b: &ImplicitPoint) -> Option<Sign> {
            for k in 0..3 {
                let s = cmp_axis(a, b, k)?;
                if s != Sign::Zero {
                    return Some(s);
                }
            }
            Some(Sign::Zero)
        }
        pub fn cmp_along(a: &ImplicitPoint, b: &ImplicitPoint, u: [f64; 3]) -> Option<Sign> {
            let (la, da) = lambda_of(a)?;
            let (lb, db) = lambda_of(b)?;
            let ur = vec(u)?;
            let dot_a = add(add(mul(la[0], ur[0])?, mul(la[1], ur[1])?)?, mul(la[2], ur[2])?)?;
            let dot_b = add(add(mul(lb[0], ur[0])?, mul(lb[1], ur[1])?)?, mul(lb[2], ur[2])?)?;
            let num = sub(mul(dot_a, db)?, mul(dot_b, da)?)?;
            Some(assemble_sign(sign_of(&num), &[sign_of(&da), sign_of(&db)]))
        }
        pub fn indirect_orient3d(p: &ImplicitPoint, p2: [f64; 3], p3: [f64; 3], p4: [f64; 3]) -> Option<Sign> {
            let (lambda, d) = lambda_of(p)?;
            let p4r = vec(p4)?;
            let row1 = [
                sub(lambda[0], mul(d, p4r[0])?)?,
                sub(lambda[1], mul(d, p4r[1])?)?,
                sub(lambda[2], mul(d, p4r[2])?)?,
            ];
            let row2 = sub3(&vec(p2)?, &p4r)?;
            let row3 = sub3(&vec(p3)?, &p4r)?;
            Some(assemble_sign(sign_of(&det3(&row1, &row2, &row3)?), &[sign_of(&d)]))
        }
    };
}

/// The operand snap-grid scale (2^16) — the common case.
const COARSE: f64 = 65_536.0;
/// The welded-seam grid scale (2^36 = 2^16 · 2^20) — see the DUAL SCALE note.
const FINE: f64 = 68_719_476_736.0;
/// The fine/coarse scale ratio (2^20) — what a fine-scale homogeneous lambda's
/// denominator absorbs to stay in the global coarse (λ, d·2^16) convention.
const FINE_OVER_COARSE: i64 = 1 << 20;

mod w256 {
    fixed_impl!(bnum::types::I256, super::COARSE);
}
mod w512 {
    fixed_impl!(bnum::types::I512, super::COARSE);
}
mod w1024 {
    fixed_impl!(bnum::types::I1024, super::COARSE);
}
mod f256 {
    fixed_impl!(bnum::types::I256, super::FINE);
}
mod f512 {
    fixed_impl!(bnum::types::I512, super::FINE);
}
mod f1024 {
    fixed_impl!(bnum::types::I1024, super::FINE);
}
mod f2048 {
    fixed_impl!(bnum::types::I2048, super::FINE);
}

// Tiered dispatch: narrowest width first, escalate on overflow; the coarse-scale
// family first, then the fine-scale family (welded-seam coords — a coarse-grid
// coordinate is also on the fine grid, so escalation stays sound; an input off
// BOTH grids fails every `gi` fract check cheaply). `None` from ALL tiers ⇒
// off-grid (not overflow) ⇒ caller falls to BigRational.
macro_rules! cascade {
    ($name:ident ( $($arg:ident : $ty:ty),* )) => {
        pub fn $name($($arg : $ty),*) -> Option<Sign> {
            w256::$name($($arg),*)
                .or_else(|| w512::$name($($arg),*))
                .or_else(|| w1024::$name($($arg),*))
                .or_else(|| f256::$name($($arg),*))
                .or_else(|| f512::$name($($arg),*))
                .or_else(|| f1024::$name($($arg),*))
                .or_else(|| f2048::$name($($arg),*))
        }
    };
}
cascade!(orient2d_2i(a: &ImplicitPoint, b: &ImplicitPoint, c: [f64; 3], axis: DropAxis));
cascade!(orient2d_3i(a: &ImplicitPoint, b: &ImplicitPoint, c: &ImplicitPoint, axis: DropAxis));
cascade!(indirect_orient2d(p: &ImplicitPoint, b: [f64; 3], c: [f64; 3], axis: DropAxis));
cascade!(cmp_lex(a: &ImplicitPoint, b: &ImplicitPoint));
cascade!(cmp_along(a: &ImplicitPoint, b: &ImplicitPoint, u: [f64; 3]));
cascade!(indirect_orient3d(p: &ImplicitPoint, p2: [f64; 3], p3: [f64; 3], p4: [f64; 3]));

// ── Cached-lambda predicates ───────────────────────────────────────────────
// The re-triangulation tests the SAME interned points in MANY predicates; the
// LPI/TPI lambda (degree-4/7 cross products) is the dominant per-call cost and is
// otherwise recomputed every time (interval pass + fixed pass + interner cmp_lex).
// The interner computes each point's lambda ONCE (via `lambda1024`) and the
// Vid-based predicates below evaluate the determinant directly from the cached
// `Lam`, skipping the interval filter (which can't resolve the degenerate box
// configs anyway) and all lambda recomputation. Cached at I512 — fits LPI/TPI
// determinants at building MILLIMETRE scale (real IFC CSG, coords ~thousands);
// `None` ⇒ overflow (georeferenced/huge coords) ⇒ caller falls to the cascade.
// FINE-scale (welded-seam k/2^36) points cache their f512 lambda with the 2^20
// scale ratio absorbed into `d`, so every cached lambda shares one homogeneous
// convention; their SECOND-ORDER products (e.g. `orient2d_from_lam`'s u·v at
// ~2^742 for fine LPI pairs) overflow I512 and fall to the dual-scale cascade —
// a deliberate trade that keeps the cache at I512 width for the coarse-grid
// majority (an I1024 cache measured +35% on the 841 corpus).
type Big = bnum::types::I512;
pub type Lam = ([Big; 3], Big);

#[inline]
fn bmul(a: Big, b: Big) -> Option<Big> {
    num_traits::CheckedMul::checked_mul(&a, &b)
}
#[inline]
fn bsub(a: Big, b: Big) -> Option<Big> {
    num_traits::CheckedSub::checked_sub(&a, &b)
}
#[inline]
fn bsign(x: &Big) -> Sign {
    use num_traits::Signed;
    if x.is_negative() {
        Sign::Negative
    } else if x.is_zero() {
        Sign::Zero
    } else {
        Sign::Positive
    }
}

/// The I512 homogeneous lambda of an implicit point (the value cached per Vid).
///
/// Computed at the coarse (2^16) scale; a point whose defining coords are on the
/// FINE welded-seam grid (k/2^36) is recomputed at the fine scale and its
/// denominator absorbs the 2^20 scale ratio — `real·2^16 = λ_fine/(d_fine·2^20)`
/// — so every cached lambda lives in ONE homogeneous convention and any two are
/// directly comparable in the Vid predicates below.
pub fn lambda1024(p: &ImplicitPoint) -> Option<Lam> {
    use num_traits::{CheckedMul, FromPrimitive, One};
    let (mut lam, mut d) = w512::lambda_of(p).or_else(|| {
        let (lam, d) = f512::lambda_of(p)?;
        let ratio = Big::from_i64(FINE_OVER_COARSE)?;
        Some((lam, CheckedMul::checked_mul(&d, &ratio)?))
    })?;
    // Canonicalize the denominator positive (negate λ and d together — same point).
    if d.is_negative() {
        d = -d;
        lam = [-lam[0], -lam[1], -lam[2]];
    }
    // Degenerate construction (LPI line exactly parallel to its plane / TPI
    // planes without a unique common point): d == 0, the point is undefined.
    // bnum's `%`/`/` panic on a zero divisor and the workspace ships with
    // panic='abort' (= shipped wasm worker abort — ISSUE_098 walls
    // 1246801/1247369/1247971). Return None: callers fall through to the
    // uncached cascade, whose `assemble_sign` yields the documented
    // `Sign::Zero` for zero denominators.
    if d.is_zero() {
        return None;
    }
    // On-grid reduction: when d divides every λ EXACTLY, store the true integer
    // coordinate (λ/d, 1). This is exact integer division — NO float weld / bucket /
    // tolerance — so the stored value is mathematically identical and bit-identical
    // native↔wasm. It lets the i128 fast path in the predicates engage for the
    // on-grid majority (axis-aligned crossings land exactly on the 1/65536 grid).
    // Off-grid points (oblique crossings, huge georef) keep (λ, d) and are unaffected.
    if !d.is_one()
        && (lam[0] % d).is_zero()
        && (lam[1] % d).is_zero()
        && (lam[2] % d).is_zero()
    {
        lam = [lam[0] / d, lam[1] / d, lam[2] / d];
        d = One::one();
    }
    Some((lam, d))
}

#[inline]
fn axis_ij(axis: DropAxis) -> (usize, usize) {
    match axis {
        DropAxis::X => (1, 2),
        DropAxis::Y => (0, 2),
        DropAxis::Z => (0, 1),
    }
}

/// 2-D orientation of three interned points from their cached lambdas.
pub fn orient2d_from_lam(a: &Lam, b: &Lam, c: &Lam, axis: DropAxis) -> Option<Sign> {
    use num_traits::ToPrimitive;
    let (i, j) = axis_ij(axis);
    let (lam1, d1) = a;
    let (lam2, d2) = b;
    let (lam3, d3) = c;
    // Fast path: all three points reduced on-grid (d=1, canonically positive) and
    // their λ fit i64 ⇒ the orientation is sign(det) computed in i128. d=1>0 makes
    // `assemble_sign` a no-op, so this is provably sign-identical to the I512 body.
    // Checked i128 ops fall through to the exact path on the rare overflow.
    if d1.is_one() && d2.is_one() && d3.is_one() {
        if let (Some(ai), Some(aj), Some(bi), Some(bj), Some(ci), Some(cj)) = (
            lam1[i].to_i64(),
            lam1[j].to_i64(),
            lam2[i].to_i64(),
            lam2[j].to_i64(),
            lam3[i].to_i64(),
            lam3[j].to_i64(),
        ) {
            let (ai, aj) = (ai as i128, aj as i128);
            let u_i = bi as i128 - ai;
            let u_j = bj as i128 - aj;
            let v_i = ci as i128 - ai;
            let v_j = cj as i128 - aj;
            if let (Some(p1), Some(p2)) = (u_i.checked_mul(v_j), u_j.checked_mul(v_i)) {
                if let Some(det) = p1.checked_sub(p2) {
                    return Some(match det.cmp(&0) {
                        std::cmp::Ordering::Less => Sign::Negative,
                        std::cmp::Ordering::Greater => Sign::Positive,
                        std::cmp::Ordering::Equal => Sign::Zero,
                    });
                }
            }
        }
    }
    let u_i = bsub(bmul(*d1, lam2[i])?, bmul(*d2, lam1[i])?)?;
    let u_j = bsub(bmul(*d1, lam2[j])?, bmul(*d2, lam1[j])?)?;
    let v_i = bsub(bmul(*d1, lam3[i])?, bmul(*d3, lam1[i])?)?;
    let v_j = bsub(bmul(*d1, lam3[j])?, bmul(*d3, lam1[j])?)?;
    let det = bsub(bmul(u_i, v_j)?, bmul(u_j, v_i)?)?;
    Some(super::assemble_sign(bsign(&det), &[bsign(d2), bsign(d3)]))
}

/// Lexicographic compare of two interned points from their cached lambdas.
pub fn cmp_lex_from_lam(a: &Lam, b: &Lam) -> Option<Sign> {
    use num_traits::ToPrimitive;
    let (la, da) = a;
    let (lb, db) = b;
    // Fast path: both reduced on-grid (d=1) and λ fit i64 ⇒ plain per-axis i64
    // compare (the true coordinate is λ since d=1). Sign-identical to the I512 body.
    if da.is_one() && db.is_one() {
        if let (Some(a0), Some(a1), Some(a2), Some(b0), Some(b1), Some(b2)) = (
            la[0].to_i64(),
            la[1].to_i64(),
            la[2].to_i64(),
            lb[0].to_i64(),
            lb[1].to_i64(),
            lb[2].to_i64(),
        ) {
            for (x, y) in [(a0, b0), (a1, b1), (a2, b2)] {
                match x.cmp(&y) {
                    std::cmp::Ordering::Less => return Some(Sign::Negative),
                    std::cmp::Ordering::Greater => return Some(Sign::Positive),
                    std::cmp::Ordering::Equal => {}
                }
            }
            return Some(Sign::Zero);
        }
    }
    for k in 0..3 {
        let s = bsub(bmul(la[k], *db)?, bmul(lb[k], *da)?)?;
        let sg = super::assemble_sign(bsign(&s), &[bsign(da), bsign(db)]);
        if sg != Sign::Zero {
            return Some(sg);
        }
    }
    Some(Sign::Zero)
}

/// Materialize an implicit point to f64 via the FIXED-width (I1024) homogeneous
/// lambda — the fast path for the BigRational `rational::point_of`. The lambda is
/// computed in the `gi`-scaled domain (coords × 2^16), so the real coordinate is
/// `lambda[k] / (d · 2^16)`. Returns `None` on off-grid coords / overflow, where
/// the caller falls back to the exact BigRational materialization. Used for the
/// classifier centroids AND the output verts (the dominant per-op cost).
pub fn point_to_f64(p: &ImplicitPoint) -> Option<[f64; 3]> {
    use num_traits::ToPrimitive;
    // Coarse scale first (the common case), then the fine welded-seam scale —
    // the real coordinate is λ/(d·scale) for whichever scale resolved.
    let (lambda, d, scale) = w1024::lambda_of(p)
        .map(|(l, d)| (l, d, COARSE))
        .or_else(|| f1024::lambda_of(p).map(|(l, d)| (l, d, FINE)))?;
    let denom = d.to_f64()? * scale;
    if denom == 0.0 || !denom.is_finite() {
        return None;
    }
    let x = lambda[0].to_f64()? / denom;
    let y = lambda[1].to_f64()? / denom;
    let z = lambda[2].to_f64()? / denom;
    if x.is_finite() && y.is_finite() && z.is_finite() {
        Some([x, y, z])
    } else {
        None
    }
}

/// f64 coordinates from an ALREADY-CACHED [`Lam`] (the interner's per-Vid I512
/// lambda), skipping the from-scratch I1024 recompute `point_to_f64` does. The
/// cached lambda is stored in one homogeneous COARSE convention (fine-scale points
/// fold their 2^20 scale ratio into `d`), so `real = λ/(d·COARSE)` for either grid
/// and the result is bit-identical to `point_to_f64`. `None` only when the cached
/// lambda was absent (overflow) — the caller then falls back to `point_to_f64`.
pub fn point_to_f64_from_lam(lam: &Lam) -> Option<[f64; 3]> {
    use num_traits::ToPrimitive;
    let (l, d) = lam;
    let denom = d.to_f64()? * COARSE;
    if denom == 0.0 || !denom.is_finite() {
        return None;
    }
    let (x, y, z) = (l[0].to_f64()? / denom, l[1].to_f64()? / denom, l[2].to_f64()? / denom);
    (x.is_finite() && y.is_finite() && z.is_finite()).then_some([x, y, z])
}

#[cfg(test)]
mod tests {
    use super::super::{interner::Interner, ImplicitPoint, Lpi, Tpi};
    use super::lambda1024;

    /// Degenerate LPI: line exactly parallel to its plane ⇒ d = 0. Must return
    /// `None` (fall through to the BigRational cascade), never panic — bnum's
    /// `%` aborts on a zero divisor under the shipped panic='abort' profile.
    #[test]
    fn degenerate_parallel_lpi_lambda_is_none_not_panic() {
        // Line through (0,0,1)-(1,0,1) is exactly parallel to plane z=0 → d = 0.
        // All coords on the 1/65536 grid → reaches the on-grid reduction.
        let p = ImplicitPoint::Lpi(Lpi {
            p: [0.0, 0.0, 1.0],
            q: [1.0, 0.0, 1.0],
            r: [0.0, 0.0, 0.0],
            s: [1.0, 0.0, 0.0],
            t: [0.0, 1.0, 0.0],
        });
        assert!(lambda1024(&p).is_none());
    }

    /// Degenerate TPI: two parallel planes ⇒ det(n1,n2,n3) = 0 ⇒ d = 0.
    #[test]
    fn degenerate_parallel_tpi_lambda_is_none_not_panic() {
        let p = ImplicitPoint::Tpi(Tpi {
            planes: [
                [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], // z=0
                [[0.0, 0.0, 1.0], [1.0, 0.0, 1.0], [0.0, 1.0, 1.0]], // z=1
                [[0.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]], // x=0
            ],
        });
        assert!(lambda1024(&p).is_none());
    }

    /// Interning a degenerate point must not panic: the cached-lambda fast path
    /// gets `None` and the binary search falls back to the exact `cmp_lex`
    /// cascade (zero denominator ⇒ `Sign::Zero` per the assemble_sign contract).
    #[test]
    fn interner_survives_degenerate_point() {
        let mut it = Interner::new();
        it.intern(ImplicitPoint::Explicit([0.0, 0.0, 0.0]));
        let _ = it.intern(ImplicitPoint::Lpi(Lpi {
            p: [0.0, 0.0, 1.0],
            q: [1.0, 0.0, 1.0],
            r: [0.0, 0.0, 0.0],
            s: [1.0, 0.0, 0.0],
            t: [0.0, 1.0, 0.0],
        }));
    }
}
