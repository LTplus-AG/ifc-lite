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

use super::{DropAxis, ImplicitPoint, Sign};

/// Generate the full predicate set over a fixed-width signed integer type.
macro_rules! fixed_impl {
    ($T:ty) => {
        use super::super::{assemble_sign, DropAxis, ImplicitPoint, Lpi, Sign, Tpi};
        use num_traits::{CheckedAdd, CheckedMul, CheckedSub, FromPrimitive, One, Signed, Zero};

        type I = $T;
        type V3 = [I; 3];

        #[inline]
        fn gi(x: f64) -> Option<I> {
            let scaled = x * 65536.0;
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
        fn lambda_of(p: &ImplicitPoint) -> Option<(V3, I)> {
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

mod w256 {
    fixed_impl!(bnum::types::I256);
}
mod w512 {
    fixed_impl!(bnum::types::I512);
}
mod w1024 {
    fixed_impl!(bnum::types::I1024);
}

// Tiered dispatch: narrowest width first, escalate on overflow. `None` from ALL
// three ⇒ off-grid (not overflow) ⇒ caller falls to BigRational.
macro_rules! cascade {
    ($name:ident ( $($arg:ident : $ty:ty),* )) => {
        pub fn $name($($arg : $ty),*) -> Option<Sign> {
            w256::$name($($arg),*)
                .or_else(|| w512::$name($($arg),*))
                .or_else(|| w1024::$name($($arg),*))
        }
    };
}
cascade!(orient2d_2i(a: &ImplicitPoint, b: &ImplicitPoint, c: [f64; 3], axis: DropAxis));
cascade!(orient2d_3i(a: &ImplicitPoint, b: &ImplicitPoint, c: &ImplicitPoint, axis: DropAxis));
cascade!(indirect_orient2d(p: &ImplicitPoint, b: [f64; 3], c: [f64; 3], axis: DropAxis));
cascade!(cmp_lex(a: &ImplicitPoint, b: &ImplicitPoint));
cascade!(cmp_along(a: &ImplicitPoint, b: &ImplicitPoint, u: [f64; 3]));
cascade!(indirect_orient3d(p: &ImplicitPoint, p2: [f64; 3], p3: [f64; 3], p4: [f64; 3]));
