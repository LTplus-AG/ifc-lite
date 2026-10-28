// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Implicit point → f64 for [`super`]: the fixed-width homogeneous lambda
//! divided out with ONE correct rounding per coordinate. Split from the parent
//! to keep it under the module-size ratchet.

use super::super::ImplicitPoint;
use super::{f1024, w1024, Lam};

/// log2 of the parent's `COARSE` and `FINE` scales: both are powers of two, so
/// the materialisation denominator `d · scale` is a shift.
const COARSE_LOG2: usize = 16;
const FINE_LOG2: usize = 36;

/// Materialize an implicit point to f64 via the FIXED-width (I1024) homogeneous
/// lambda — the fast path for the BigRational `rational::point_of`. The lambda is
/// computed in the `gi`-scaled domain (coords × 2^16), so the real coordinate is
/// `lambda[k] / (d · 2^16)`. Returns `None` on off-grid coords / overflow, where
/// the caller falls back to the exact BigRational materialization. Used for the
/// classifier centroids AND the output verts (the dominant per-op cost).
pub fn point_to_f64(p: &ImplicitPoint) -> Option<[f64; 3]> {
    // Coarse scale first (the common case), then the fine welded-seam scale —
    // the real coordinate is λ/(d·scale) for whichever scale resolved.
    let (lambda, d, scale_log2) = w1024::lambda_of(p)
        .map(|(l, d)| (l, d, COARSE_LOG2))
        .or_else(|| f1024::lambda_of(p).map(|(l, d)| (l, d, FINE_LOG2)))?;
    rounded_quotients(&lambda, d, scale_log2)
}

/// f64 coordinates from an ALREADY-CACHED [`Lam`] (the interner's per-Vid I512
/// lambda), skipping the from-scratch I1024 recompute `point_to_f64` does. The
/// cached lambda is stored in one homogeneous COARSE convention (fine-scale points
/// fold their 2^20 scale ratio into `d`), so `real = λ/(d·COARSE)` for either grid
/// and the result is bit-identical to `point_to_f64`. `None` only when the cached
/// lambda was absent (overflow) — the caller then falls back to `point_to_f64`.
pub fn point_to_f64_from_lam(lam: &Lam) -> Option<[f64; 3]> {
    let (l, d) = lam;
    rounded_quotients(l, *d, COARSE_LOG2)
}

type Fixed<const K: usize> = crate::kernel::fixed_int::FixedInt<K>;

/// `λ[k] / (d · 2^scale_log2)` per axis, each correctly rounded to the nearest
/// f64 (ties to even), so this agrees bit for bit with the BigRational
/// materialisation `rational::point_of` falls back to.
///
/// Rounding the three operands to f64 first and dividing (`λ.to_f64() /
/// (d.to_f64() · scale)`) rounds three times, so the result can land an ulp
/// or more from the exact quotient. A point that lies exactly on an
/// axis-aligned plane, whose coordinate is therefore an f64, then comes back
/// off that plane, and the face carrying it stops being planar. Issue #8156:
/// the abutting-cutter union put one such vertex on the shared jamb of two
/// openings, and the next subtract kept the jamb's diagonal split on one side
/// of the seam only, an open T-junction.
///
/// That three-rounding quotient is still the starting guess: [`settle`]
/// proves or corrects it against its neighbouring midpoints in fixed-width
/// integers, and only a tie, an overflow or a non-normal value pays for the
/// arbitrary-precision division.
fn rounded_quotients<const K: usize>(
    lambda: &[Fixed<K>; 3],
    d: Fixed<K>,
    scale_log2: usize,
) -> Option<[f64; 3]> {
    use num_traits::ToPrimitive;
    if d.is_zero() {
        return None;
    }
    let guess_denom = d.to_f64()? * (1u64 << scale_log2) as f64;
    let mut out = [0.0; 3];
    for (o, l) in out.iter_mut().zip(lambda) {
        let guess = l.to_f64()? / guess_denom;
        let v = match settle(*l, d, scale_log2 as i32, guess) {
            Some(v) => v,
            None => {
                let denom = d.to_bigint() << scale_log2;
                num_rational::BigRational::new_raw(l.to_bigint(), denom).to_f64()?
            }
        };
        if !v.is_finite() {
            return None;
        }
        *o = v;
    }
    Some(out)
}

/// The nearest f64 to `n / (d · 2^s)`, found by stepping from `guess` until
/// the exact quotient lies strictly between the candidate's two neighbouring
/// midpoints. `None` (the caller divides exactly) on a zero numerator, a
/// non-normal candidate, a quotient exactly on a midpoint, a fixed-width
/// overflow, or a guess more than a few ulps out.
fn settle<const K: usize>(n: Fixed<K>, d: Fixed<K>, s: i32, guess: f64) -> Option<f64> {
    use std::cmp::Ordering::{Equal, Greater, Less};
    let negative = n.is_negative() != d.is_negative();
    let (n, d) = (magnitude(n)?, magnitude(d)?);
    if n.is_zero() || guess == 0.0 || (guess < 0.0) != negative {
        return None;
    }
    let mut c = guess.abs();
    for _ in 0..4 {
        if !c.is_normal() {
            return None;
        }
        let bits = c.to_bits();
        let biased = (bits >> 52) as i32;
        let mant = (bits & ((1u64 << 52) - 1)) | (1u64 << 52);
        // c = mant · 2^e; the midpoints to its neighbours, as m · 2^k.
        let e = biased - 1075;
        let above = (2 * mant + 1, e - 1);
        // Below a power of two the spacing halves.
        let below = if mant == 1u64 << 52 { (4 * mant - 1, e - 2) } else { (2 * mant - 1, e - 1) };
        match cmp_quotient(n, d, s, above)? {
            Greater => c = f64::from_bits(bits + 1),
            Equal => return None,
            Less => match cmp_quotient(n, d, s, below)? {
                Less => c = f64::from_bits(bits - 1),
                Equal => return None,
                Greater => return Some(if negative { -c } else { c }),
            },
        }
    }
    None
}

/// `n / (d · 2^s)` against `m · 2^k`, all positive, exactly: `n` against
/// `m · d · 2^(k + s)`, with the power of two moved to whichever side keeps
/// the shift non-negative. `None` on overflow.
fn cmp_quotient<const K: usize>(
    n: Fixed<K>,
    d: Fixed<K>,
    s: i32,
    (m, k): (u64, i32),
) -> Option<std::cmp::Ordering> {
    use num_traits::{CheckedMul, FromPrimitive};
    let rhs = d.checked_mul(&Fixed::<K>::from_u64(m)?)?;
    let shift = k + s;
    let (lhs, rhs) = if shift >= 0 {
        (n, shl(rhs, shift as u32)?)
    } else {
        (shl(n, shift.unsigned_abs())?, rhs)
    };
    Some(lhs.cmp(&rhs))
}

/// `x · 2^k`, `None` on overflow.
fn shl<const K: usize>(mut x: Fixed<K>, mut k: u32) -> Option<Fixed<K>> {
    use num_traits::{CheckedMul, FromPrimitive};
    while k > 0 {
        let step = k.min(62);
        x = x.checked_mul(&Fixed::<K>::from_u64(1u64 << step)?)?;
        k -= step;
    }
    Some(x)
}

/// `|x|`, `None` for the one value whose negation overflows.
fn magnitude<const K: usize>(x: Fixed<K>) -> Option<Fixed<K>> {
    if !x.is_negative() {
        return Some(x);
    }
    let m = -x;
    (!m.is_negative()).then_some(m)
}

#[cfg(test)]
mod tests {
    use super::super::super::Lpi;
    use super::ImplicitPoint;

    /// The materialisation denominators are shifts by these exponents.
    #[test]
    fn scale_exponents_match_the_scales() {
        assert_eq!(super::super::COARSE, (1u64 << super::COARSE_LOG2) as f64);
        assert_eq!(super::super::FINE, (1u64 << super::FINE_LOG2) as f64);
        assert_eq!(super::super::FINE_OVER_COARSE, 1 << (super::FINE_LOG2 - super::COARSE_LOG2));
    }

    /// Issue #8156: an LPI whose line lies in the plane x = X meets the plane
    /// y = Y. Its exact x is X, an f64, so materialising it must return X bit
    /// for bit, through both fixed-width paths, and agree with the exact
    /// BigRational materialisation on every axis. The coordinates are the jamb
    /// of the two abutting openings on wall #43810 (site offset, local frame).
    /// Dividing f64-rounded operands put x one ulp off X, so the jamb face
    /// stopped being planar and the next subtract left a T-junction on it.
    #[test]
    fn point_on_an_axis_plane_materialises_on_that_plane() {
        use num_traits::ToPrimitive;
        const X: f64 = -26.285125732421875;
        const Y: f64 = -0.7299957275390625;
        let p = ImplicitPoint::Lpi(Lpi {
            p: [X, -0.7449951171875, 0.4134979248046875],
            q: [X, 1.475006103515625, -0.4134979248046875],
            r: [-26.621124267578125, Y, -0.4134979248046875],
            s: [X, Y, -0.4134979248046875],
            t: [X, Y, 0.4134979248046875],
        });
        let exact = crate::kernel::rational::point_of(&p).map(|c| c.to_f64().unwrap());
        assert_eq!(exact[0], X, "the exact point lies on x = X");
        assert_eq!(exact[1], Y, "the exact point lies on y = Y");
        let fixed = super::point_to_f64(&p).expect("on-grid LPI materialises");
        assert_eq!(fixed, exact, "point_to_f64 against the exact materialisation");
        let lam = super::super::cached_lambda(&p).expect("the lambda fits I512");
        let cached = super::point_to_f64_from_lam(&lam).expect("cached lambda materialises");
        assert_eq!(cached, exact, "point_to_f64_from_lam against the exact materialisation");
    }

    /// The fixed-width settle agrees with the exact BigRational quotient bit
    /// for bit, and resolves on its own (no exact fallback) for ordinary
    /// quotients. Includes quotients just around powers of two, where the
    /// lower neighbour's spacing halves, and exactly representable ones.
    #[test]
    fn settle_agrees_with_the_exact_quotient() {
        use super::{settle, Fixed};
        use num_traits::{CheckedMul, FromPrimitive, ToPrimitive};
        let big = |a: i64, b: i64| {
            Fixed::<8>::from_i64(a).unwrap().checked_mul(&Fixed::<8>::from_i64(b).unwrap()).unwrap()
        };
        let mut seed = 0x9e37_79b9_7f4a_7c15_u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let mut cases: Vec<(Fixed<8>, Fixed<8>)> = Vec::new();
        for _ in 0..4000 {
            let a = (next() >> 12) as i64 - (1 << 51);
            let b = (next() >> 30) as i64 | 1;
            let c = (next() >> 20) as i64 | 1;
            let sign = if next() & 1 == 0 { 1 } else { -1 };
            cases.push((big(a, c), big(sign * b, c)));
        }
        // Around powers of two: (2^j ± 1) / 2^j and exact dyadics.
        for j in [1i64, 7, 20, 40, 52, 53, 60] {
            for off in [-1i64, 0, 1] {
                cases.push((big((1i64 << j) + off, 3), big(1i64 << j, 3)));
                cases.push((big(1i64 << j, 1), big((1i64 << j) + off, 1)));
            }
        }
        // Exactly on a midpoint (2^53 + 1 and 2^53 + 3 lie between f64s):
        // ties go to even, which the exact division decides.
        for k in [1i64, 3, 5, -3] {
            for t in [(1i64 << 53) + 1, (1i64 << 53) + 3] {
                cases.push((big(k, t), big(k, 1)));
            }
        }
        let mut settled = 0;
        for (n, d) in &cases {
            for s in [16, 36] {
                let exact = num_rational::BigRational::new_raw(
                    n.to_bigint(),
                    d.to_bigint() << s as usize,
                )
                .to_f64()
                .unwrap();
                let guess = n.to_f64().unwrap() / (d.to_f64().unwrap() * (1u64 << s) as f64);
                if let Some(v) = settle(*n, *d, s, guess) {
                    assert_eq!(v.to_bits(), exact.to_bits(), "{n:?} / ({d:?} * 2^{s})");
                    settled += 1;
                }
                let full = super::rounded_quotients(&[*n, *n, *n], *d, s as usize).unwrap();
                assert_eq!(full[0].to_bits(), exact.to_bits());
            }
        }
        assert!(settled * 100 >= cases.len() * 2 * 90, "settled {settled} of {}", cases.len() * 2);
    }
}
