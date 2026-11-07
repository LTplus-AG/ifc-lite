// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Implicit point → f64 for [`super`]: the fixed-width homogeneous lambda
//! divided out in f64, with a coordinate whose exact value is an input-grid
//! value returned as exactly that value. Split from the parent to keep it under
//! the module-size ratchet.

use super::super::ImplicitPoint;
use super::{f1024, w1024, Lam};

/// log2 of the parent's `COARSE` and `FINE` scales: both are powers of two.
const COARSE_LOG2: u32 = 16;
const FINE_LOG2: u32 = 36;

/// Grid steps per unit of the finest input grid (2^-36). The coarse 2^-16
/// grid is a subset of it, so one snap serves points from either grid.
const GRID: f64 = (1u64 << FINE_LOG2) as f64;

/// How far, in f64 steps, the three-rounding quotient may sit from an exact
/// grid value and still be snapped to it. Each of the three roundings is
/// correct to nearest (bnum's integer → float cast rounds ties to even), so
/// the quotient's relative error is below `3·2^-53`: under 3 ulps of the
/// exact value, which is 3 half-size steps just below a power of two. One
/// step of margin on top.
const SNAP_STEPS: u64 = 4;

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
    quotients(&lambda, d, scale_log2)
}

/// f64 coordinates from an ALREADY-CACHED [`Lam`] (the interner's per-Vid I512
/// lambda), skipping the from-scratch I1024 recompute `point_to_f64` does. The
/// cached lambda is stored in one homogeneous COARSE convention (fine-scale points
/// fold their 2^20 scale ratio into `d`), so `real = λ/(d·COARSE)` for either grid
/// and the result is bit-identical to `point_to_f64`. `None` only when the cached
/// lambda was absent (overflow) — the caller then falls back to `point_to_f64`.
pub fn point_to_f64_from_lam(lam: &Lam) -> Option<[f64; 3]> {
    let (l, d) = lam;
    quotients(l, *d, COARSE_LOG2)
}

type Fixed<const K: usize> = crate::kernel::fixed_int::FixedInt<K>;

/// `λ[k] / (d · 2^scale_log2)` per axis: the three-rounding f64 quotient
/// (`λ.to_f64() / (d.to_f64() · 2^s)`), passed through [`snap_to_grid`].
fn quotients<const K: usize>(
    lambda: &[Fixed<K>; 3],
    d: Fixed<K>,
    scale_log2: u32,
) -> Option<[f64; 3]> {
    use num_traits::ToPrimitive;
    let denom = d.to_f64()? * (1u64 << scale_log2) as f64;
    if denom == 0.0 || !denom.is_finite() {
        return None;
    }
    let mut out = [0.0; 3];
    for (o, l) in out.iter_mut().zip(lambda) {
        let guess = l.to_f64()? / denom;
        if !guess.is_finite() {
            return None;
        }
        *o = snap_to_grid(*l, d, scale_log2, guess);
    }
    Some(out)
}

/// The three-rounding quotient `guess` of `n / (d · 2^s)`, or the input-grid
/// value `g` next to it when the exact quotient is `g`.
///
/// Rounding the operands to f64 before dividing can land an ulp or more from
/// the exact quotient. A point that lies exactly on an axis-aligned plane has
/// that plane's input coordinate as its exact coordinate, a multiple of 2^-16
/// (or 2^-36 for welded seams); coming back an ulp off it takes the point off
/// the plane, and the face carrying it stops being planar. Issue #8156: the
/// abutting-cutter union put one such vertex on the shared jamb of two
/// openings, and the next subtract kept the jamb's diagonal split on one side
/// of the seam only, an open T-junction.
///
/// `g` is the nearest multiple of 2^-36 to `guess`. It is taken only when
/// `n · 2^(36 − s) == round(g · 2^36) · d` holds in exact integer
/// arithmetic, which says `n / (d · 2^s)` IS `g`; and `g` is itself an f64
/// (an integer below 2^52 in magnitude times a power of two), so the
/// returned value is the exact coordinate, not an approximation of it. Every
/// other case returns `guess` unchanged, as before. The integer check runs
/// only when `guess` is off the grid but within [`SNAP_STEPS`] of it, so an
/// ordinary coordinate pays one multiply, one round and one compare.
///
/// Where an f64 step is as coarse as the grid (|coordinate| ≥ 2^16) every
/// f64 is a grid value and `guess` is returned as is.
fn snap_to_grid<const K: usize>(n: Fixed<K>, d: Fixed<K>, s: u32, guess: f64) -> f64 {
    let t = guess * GRID;
    let r = t.round();
    if r == t || r == 0.0 {
        return guess;
    }
    let g = r / GRID;
    if g.to_bits().abs_diff(guess.to_bits()) > SNAP_STEPS {
        return guess;
    }
    // `t` has a fraction, so |r| < 2^52 and the cast is exact.
    if quotient_is(n, d, s, r as i64) == Some(true) {
        g
    } else {
        guess
    }
}

/// Exactly whether `n / (d · 2^s) == r / 2^36`, i.e. `n · 2^(36 − s) == r · d`.
/// `None` on fixed-width overflow.
fn quotient_is<const K: usize>(n: Fixed<K>, d: Fixed<K>, s: u32, r: i64) -> Option<bool> {
    use num_traits::{CheckedMul, FromPrimitive};
    let lhs = match FINE_LOG2.checked_sub(s)? {
        0 => n,
        k => n.checked_mul(&Fixed::<K>::from_u64(1u64 << k)?)?,
    };
    let rhs = d.checked_mul(&Fixed::<K>::from_i64(r)?)?;
    Some(lhs == rhs)
}

#[cfg(test)]
mod tests {
    use super::super::super::Lpi;
    use super::{Fixed, ImplicitPoint};
    use num_traits::{CheckedMul, FromPrimitive, ToPrimitive};

    /// The scale exponents and the grid match the parent's scales.
    #[test]
    fn scale_exponents_match_the_scales() {
        assert_eq!(super::super::COARSE, (1u64 << super::COARSE_LOG2) as f64);
        assert_eq!(super::super::FINE, (1u64 << super::FINE_LOG2) as f64);
        assert_eq!(super::super::FINE, super::GRID);
        assert_eq!(super::super::FINE_OVER_COARSE, 1 << (super::FINE_LOG2 - super::COARSE_LOG2));
    }

    /// Issue #8156: an LPI whose line lies in the plane x = X meets the plane
    /// y = Y. Its exact x is X and its exact y is Y, both on the input grid,
    /// so materialising it must return them bit for bit through both
    /// fixed-width paths. The coordinates are the jamb of the two abutting
    /// openings on wall #43810 (site offset, local frame). The three-rounding
    /// quotient alone puts x one ulp off X (asserted below, so this test fails
    /// if the snap stops engaging), the jamb face stops being planar, and the
    /// next subtract leaves a T-junction on it.
    #[test]
    fn point_on_an_axis_plane_materialises_on_that_plane() {
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
        let lam = super::super::cached_lambda(&p).expect("the lambda fits I512");
        let (l, d) = &lam;
        let unsnapped = l[0].to_f64().unwrap() / (d.to_f64().unwrap() * super::super::COARSE);
        assert_ne!(unsnapped, X, "the three-rounding quotient alone is off the plane");
        let fixed = super::point_to_f64(&p).expect("on-grid LPI materialises");
        assert_eq!([fixed[0], fixed[1]], [X, Y], "point_to_f64 stays on both planes");
        let cached = super::point_to_f64_from_lam(&lam).expect("cached lambda materialises");
        assert_eq!([cached[0], cached[1]], [X, Y], "point_to_f64_from_lam stays on both planes");
        assert_eq!(fixed, cached, "the two paths agree");
    }

    fn fixed(a: i64, b: i64, c: i64) -> Fixed<16> {
        let f = |v: i64| Fixed::<16>::from_i64(v).unwrap();
        f(a).checked_mul(&f(b)).unwrap().checked_mul(&f(c)).unwrap()
    }

    fn xorshift(mut seed: u64) -> impl FnMut() -> u64 {
        move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        }
    }

    /// A quotient whose exact value is a grid value `G · 2^-36` comes back as
    /// exactly that value at both scales, including the fine-into-coarse fold
    /// of `point_to_f64_from_lam`, wherever the three-rounding quotient lands.
    /// Wide denominators make the operand roundings bite; the test requires
    /// that some of them did, so the snap is exercised and not just passed
    /// through.
    #[test]
    fn grid_valued_quotients_come_back_exact() {
        let mut next = xorshift(0x9e37_79b9_7f4a_7c15);
        let mut off = 0;
        for i in 0..20_000 {
            // |G| < 2^52 / 2^4 keeps coordinates under 2^12 = 4096 units.
            let mut g = (next() >> 16) as i64 - (1 << 47);
            if i % 2 == 0 {
                g &= !((1 << 20) - 1); // a coarse-grid value
            }
            if g == 0 {
                continue;
            }
            let sign = if next() & 1 == 0 { 1 } else { -1 };
            let d = fixed(sign * ((next() >> 2) as i64 | 1), (next() >> 2) as i64 | 1, 3);
            let want = g as f64 / super::GRID;
            let gf = Fixed::<16>::from_i64(g).unwrap();
            // Fine scale: n / (d · 2^36) = G / 2^36.
            let n = gf.checked_mul(&d).unwrap();
            // Coarse convention with a folded fine denominator: n / (d · 2^20 · 2^16).
            let d_fold = d.checked_mul(&Fixed::<16>::from_i64(1 << 20).unwrap()).unwrap();
            let mut cases = vec![(n, d, super::FINE_LOG2), (n, d_fold, super::COARSE_LOG2)];
            if g % (1 << 20) == 0 {
                // A coarse-grid point at the coarse scale: n / (d · 2^16) = (G / 2^20) / 2^16.
                let nc = Fixed::<16>::from_i64(g >> 20).unwrap().checked_mul(&d).unwrap();
                cases.push((nc, d, super::COARSE_LOG2));
            }
            for (n, d, s) in cases {
                let got = super::quotients(&[n, n, n], d, s).unwrap();
                let guess = n.to_f64().unwrap() / (d.to_f64().unwrap() * (1u64 << s) as f64);
                off += usize::from(guess != want);
                assert_eq!(got[0].to_bits(), want.to_bits(), "G = {g}, s = {s}");
            }
        }
        assert!(off > 100, "only {off} three-rounding quotients were off the grid value");
    }

    /// A quotient a hair off a grid value (numerator one unit past `G · d`) is
    /// not a grid value, so it keeps the three-rounding quotient bit for bit,
    /// even when that quotient sits within snapping range of the grid.
    #[test]
    fn off_grid_quotients_keep_the_three_rounding_quotient() {
        let mut next = xorshift(0x2545_f491_4f6c_dd1d);
        let one = Fixed::<16>::from_i64(1).unwrap();
        let mut near = 0;
        for _ in 0..20_000 {
            let g = (next() >> 16) as i64 - (1 << 47);
            let d = fixed((next() >> 2) as i64 | 1, (next() >> 2) as i64 | 1, 5);
            let n = Fixed::<16>::from_i64(g).unwrap().checked_mul(&d).unwrap() + one;
            let s = super::FINE_LOG2;
            let guess = n.to_f64().unwrap() / (d.to_f64().unwrap() * (1u64 << s) as f64);
            let got = super::quotients(&[n, n, n], d, s).unwrap();
            assert_eq!(got[0].to_bits(), guess.to_bits(), "G = {g}");
            let grid = g as f64 / super::GRID;
            near += usize::from(guess != grid && grid.to_bits().abs_diff(guess.to_bits()) <= super::SNAP_STEPS);
        }
        assert!(near > 100, "only {near} quotients reached the integer check");
    }
}
