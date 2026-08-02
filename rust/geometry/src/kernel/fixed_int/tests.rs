// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Differential fuzz for [`super::FixedInt`] against `bnum`: every hot op
//! (native) and cold op (bnum bridge) is pinned to agree on value AND the
//! `Some`/`None` overflow verdict across all four widths, boundary values, and
//! a deterministic LCG stream. See the module doc in `mod.rs` for why.

use super::mul::{mul_full_u32, mul_full_u64, mul_low_u32, mul_low_u64};
use super::*;
use num_traits::{CheckedAdd, CheckedMul, CheckedSub, FromPrimitive, One, ToPrimitive};

/// Deterministic LCG (no `rand` crate; fixed seed for reproducibility).
/// Constants are Knuth's MMIX multiplier / increment, matching the LCG in
/// `kernel/predicates.rs`.
struct Lcg(u64);
impl Lcg {
    #[inline]
    fn u(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0
    }
}

/// Generate a random `FixedInt<K>` whose magnitude has at most `maxbits`
/// bits, then a random sign. Concentrating mass near a target bit length
/// stresses the `checked_mul` overflow boundary where a truncated product
/// could escape.
macro_rules! rand_fixed {
    ($rng:expr, $K:literal, $maxbits:expr) => {{
        let bits = ($rng.u() as usize) % ($maxbits + 1); // 0..=maxbits
        let mut limbs = [0u64; $K];
        for l in limbs.iter_mut() {
            *l = $rng.u();
        }
        for i in 0..$K {
            let lo = i * 64;
            if lo >= bits {
                limbs[i] = 0;
            } else if lo + 64 > bits {
                let keep = bits - lo; // 1..=63 in this branch
                limbs[i] &= (1u64 << keep) - 1;
            }
        }
        let mut v = FixedInt::<$K>::from_limbs(limbs);
        if $rng.u() & 1 == 1 {
            v = -v;
        }
        v
    }};
}

/// Stamp out a per-width differential fuzz test. `$K` is the limb count and
/// `$BT` the matching `bnum` signed type (I256/I512/I1024/I2048).
macro_rules! diff_fuzz {
    ($name:ident, $K:literal, $BT:path) => {
        #[test]
        fn $name() {
            const W: usize = $K * 64; // total bit width

            // FixedInt<K> -> bnum, built independently from the limbs so the
            // hot-op comparisons are genuinely differential (native vs bnum).
            let to_bnum = |x: &FixedInt<$K>| -> $BT {
                let mut buf = [0u8; $K * 8];
                for i in 0..$K {
                    buf[i * 8..i * 8 + 8].copy_from_slice(&x.0[i].to_le_bytes());
                }
                <$BT>::from_le_slice(&buf).unwrap()
            };

            // Boundary set: 0, ±1, MIN, MAX, MIN+1, MAX-1, i64/u64 edges,
            // half-width powers of two (mul overflow straddles).
            let mut min_limbs = [0u64; $K];
            min_limbs[$K - 1] = 1u64 << 63;
            let mut max_limbs = [u64::MAX; $K];
            max_limbs[$K - 1] = i64::MAX as u64; // 0x7FFF...
            let mut half_limbs = [0u64; $K]; // 2^(W/2)
            half_limbs[$K / 2] = 1;
            let zero = FixedInt::<$K>::from_limbs([0u64; $K]);
            let one = <FixedInt<$K> as One>::one();
            let min = FixedInt::<$K>::from_limbs(min_limbs);
            let max = FixedInt::<$K>::from_limbs(max_limbs);
            let half = FixedInt::<$K>::from_limbs(half_limbs);
            let mut boundaries: Vec<FixedInt<$K>> = vec![
                zero,
                one,
                -one,
                min,
                max,
                min + one,          // MIN+1
                max - one,          // MAX-1
                half,
                -half,
                half - one,         // 2^(W/2) - 1
                -(half - one),
                <FixedInt<$K> as FromPrimitive>::from_i64(i64::MAX).unwrap(),
                <FixedInt<$K> as FromPrimitive>::from_i64(i64::MIN).unwrap(),
                <FixedInt<$K> as FromPrimitive>::from_u64(u64::MAX).unwrap(),
                <FixedInt<$K> as FromPrimitive>::from_i64(-1).unwrap(),
            ];

            // Assert a single pair agrees across every op vs bnum.
            let check_pair = |a: &FixedInt<$K>, b: &FixedInt<$K>| {
                let (ba, bb) = (to_bnum(a), to_bnum(b));

                // checked_add / sub / mul: value AND Some/None verdict.
                assert_eq!(
                    CheckedAdd::checked_add(a, b).map(|r| to_bnum(&r)),
                    CheckedAdd::checked_add(&ba, &bb),
                    "checked_add mismatch a={:?} b={:?}",
                    a.0,
                    b.0
                );
                assert_eq!(
                    CheckedSub::checked_sub(a, b).map(|r| to_bnum(&r)),
                    CheckedSub::checked_sub(&ba, &bb),
                    "checked_sub mismatch a={:?} b={:?}",
                    a.0,
                    b.0
                );
                assert_eq!(
                    CheckedMul::checked_mul(a, b).map(|r| to_bnum(&r)),
                    CheckedMul::checked_mul(&ba, &bb),
                    "checked_mul mismatch a={:?} b={:?}",
                    a.0,
                    b.0
                );

                // Ordering.
                assert_eq!(
                    a.cmp(b),
                    ba.cmp(&bb),
                    "cmp mismatch a={:?} b={:?}",
                    a.0,
                    b.0
                );

                // Div / Rem: bnum panics on zero divisor and on MIN / -1
                // (both guarded away in production; d is canonically > 0).
                let is_min = *b == min;
                let is_neg_one = *b == -one;
                if !b.is_zero() && !(*a == min && is_neg_one) && !is_min {
                    assert_eq!(
                        to_bnum(&(*a / *b)),
                        ba / bb,
                        "div mismatch a={:?} b={:?}",
                        a.0,
                        b.0
                    );
                    assert_eq!(
                        to_bnum(&(*a % *b)),
                        ba % bb,
                        "rem mismatch a={:?} b={:?}",
                        a.0,
                        b.0
                    );
                }
            };

            // Unary invariants vs bnum for a single value.
            let check_unary = |a: &FixedInt<$K>| {
                let ba = to_bnum(a);
                assert_eq!(to_bnum(&(-*a)), ba.wrapping_neg(), "neg mismatch {:?}", a.0);
                assert_eq!(a.to_i64(), ba.to_i64(), "to_i64 mismatch {:?}", a.0);
                assert_eq!(a.to_u64(), ba.to_u64(), "to_u64 mismatch {:?}", a.0);
                assert_eq!(a.to_f64(), ba.to_f64(), "to_f64 mismatch {:?}", a.0);
                assert_eq!(a.is_zero(), ba.is_zero(), "is_zero mismatch {:?}", a.0);
                assert_eq!(a.is_one(), ba.is_one(), "is_one mismatch {:?}", a.0);
                assert_eq!(a.is_negative(), ba.is_negative(), "is_neg mismatch {:?}", a.0);
                // is_positive is fully determined by is_negative + is_zero,
                // both pinned above; verify the composite matches bnum.
                assert_eq!(
                    !a.is_negative() && !a.is_zero(),
                    ba.is_positive(),
                    "is_pos mismatch {:?}",
                    a.0
                );
            };

            // Seed the boundary set with a handful of near-boundary randoms.
            let mut seed = Lcg(0x1234_5678_9abc_def0 ^ (W as u64));
            for _ in 0..8 {
                boundaries.push(rand_fixed!(seed, $K, W - 1));
            }

            // All boundary pairs (exact edge coverage).
            for a in &boundaries {
                check_unary(a);
                for b in &boundaries {
                    check_pair(a, b);
                }
            }

            // Random stream, heavy on the multiply overflow boundary: draw
            // magnitudes across the whole width so products straddle W bits.
            let mut rng = Lcg(0xdead_beef_0000_0000 ^ (W as u64));
            for _ in 0..40_000 {
                let a = rand_fixed!(rng, $K, W - 1);
                let b = rand_fixed!(rng, $K, W - 1);
                check_unary(&a);
                check_pair(&a, &b);

                // from_i64 / from_u64 exactness.
                let n = rng.u() as i64;
                assert_eq!(
                    to_bnum(&<FixedInt<$K> as FromPrimitive>::from_i64(n).unwrap()),
                    <$BT as FromPrimitive>::from_i64(n).unwrap(),
                    "from_i64 mismatch n={n}"
                );
                let m = rng.u();
                assert_eq!(
                    to_bnum(&<FixedInt<$K> as FromPrimitive>::from_u64(m).unwrap()),
                    <$BT as FromPrimitive>::from_u64(m).unwrap(),
                    "from_u64 mismatch m={m}"
                );
            }

            // Extra multiply-boundary sweep: pin bit-length sums around W so
            // both the fast-accept edge (W-1) and the ambiguous band (W, W+1)
            // are exercised densely.
            let mut rng2 = Lcg(0x0f0f_0f0f_f0f0_f0f0 ^ (W as u64));
            for _ in 0..40_000 {
                let ba_bits = (rng2.u() as usize) % (W / 2 + 2) + (W / 2 - 1);
                let bb_bits = W - (ba_bits.min(W)); // partner so sum ~ W
                let a = rand_fixed!(rng2, $K, ba_bits.min(W - 1));
                let b = rand_fixed!(rng2, $K, (bb_bits + 2).min(W - 1));
                let ta = to_bnum(&a);
                let tb = to_bnum(&b);
                assert_eq!(
                    CheckedMul::checked_mul(&a, &b).map(|r| to_bnum(&r)),
                    CheckedMul::checked_mul(&ta, &tb),
                    "checked_mul boundary mismatch a={:?} b={:?}",
                    a.0,
                    b.0
                );
            }
        }
    };
}

diff_fuzz!(fuzz_i256, 4, bnum::types::I256);
diff_fuzz!(fuzz_i512, 8, bnum::types::I512);
diff_fuzz!(fuzz_i1024, 16, bnum::types::I1024);
diff_fuzz!(fuzz_i2048, 32, bnum::types::I2048);

/// Targeted MIN-boundary check: `MIN * 1`, `MIN * -1` (overflow), `(-half) *
/// (-half)` at the exact `MIN` product for even widths.
#[test]
fn checked_mul_min_boundary() {
    // I256: MIN = -2^255. MIN * 1 = MIN (fits). MIN * -1 = 2^255 (overflow).
    let mut min_limbs = [0u64; 4];
    min_limbs[3] = 1u64 << 63;
    let min = FixedInt::<4>::from_limbs(min_limbs);
    let one = <FixedInt<4> as One>::one();
    let neg_one = -one;
    assert_eq!(CheckedMul::checked_mul(&min, &one), Some(min));
    assert_eq!(CheckedMul::checked_mul(&min, &neg_one), None);

    // (-2^127) * (-2^127) = 2^254 (fits, positive, top bit clear).
    let mut h = [0u64; 4];
    h[1] = 1u64 << 63; // 2^127
    let two127 = FixedInt::<4>::from_limbs(h);
    let neg = -two127;
    let prod = CheckedMul::checked_mul(&neg, &neg).expect("2^254 fits I256");
    let mut expect = [0u64; 4];
    expect[3] = 1u64 << 62; // 2^254
    assert_eq!(prod, FixedInt::<4>::from_limbs(expect));

    // (-2^128) * (2^127) = -2^255 = MIN exactly (fits ONLY because negative).
    let mut a = [0u64; 4];
    a[2] = 1; // 2^128
    let two128 = FixedInt::<4>::from_limbs(a);
    let prod2 = CheckedMul::checked_mul(&(-two128), &two127).expect("-2^255 = MIN fits");
    assert_eq!(prod2, min);
    // Positive 2^255 must overflow.
    assert_eq!(CheckedMul::checked_mul(&two128, &two127), None);
}

/// The wasm32 build multiplies with u32 digits (`mul_low_u32` / `mul_full_u32`,
/// avoiding `__multi3` libcalls); native uses u64 limbs. Cargo tests run on the
/// host, so the wasm digit path would otherwise be unexercised — pin both digit
/// widths to bit-identical outputs on boundary and random limb patterns for
/// every supported width. Raw (not magnitude) patterns are included because the
/// wrapping `Mul` impl feeds two's-complement limbs to `mul_low` directly.
macro_rules! digit_width_fuzz {
    ($name:ident, $K:literal) => {
        #[test]
        fn $name() {
            let mut patterns: Vec<[u64; $K]> = vec![[0u64; $K], [u64::MAX; $K]];
            // Single-bit walk (stride 7 hits every limb + misaligned bits).
            for bit in (0..$K * 64).step_by(7) {
                let mut l = [0u64; $K];
                l[bit / 64] = 1u64 << (bit % 64);
                patterns.push(l);
            }
            // Dense all-ones prefixes/suffixes (worst-case carry chains).
            for k in 0..$K {
                let mut lo = [0u64; $K];
                for slot in lo.iter_mut().take(k + 1) {
                    *slot = u64::MAX;
                }
                patterns.push(lo);
                let mut hi = [0u64; $K];
                for slot in hi.iter_mut().skip($K - 1 - k) {
                    *slot = u64::MAX;
                }
                patterns.push(hi);
            }
            // Random limbs at random bit-lengths (varied zero-digit skips).
            let mut rng = Lcg(0xabcd_ef01_2345_6789 ^ ($K as u64));
            for _ in 0..1_500 {
                let mut l = [0u64; $K];
                for slot in l.iter_mut() {
                    *slot = rng.u();
                }
                let cut = (rng.u() as usize) % ($K * 64 + 1);
                for i in 0..$K {
                    let lo = i * 64;
                    if lo >= cut {
                        l[i] = 0;
                    } else if lo + 64 > cut {
                        l[i] &= (1u64 << (cut - lo)) - 1;
                    }
                }
                patterns.push(l);
            }

            for a in &patterns {
                for b in patterns.iter().take(48) {
                    assert_eq!(
                        mul_low_u32(a, b),
                        mul_low_u64(a, b),
                        "mul_low digit-width mismatch a={:?} b={:?}",
                        a,
                        b
                    );
                    let mut full32 = [0u64; 64];
                    let mut full64 = [0u64; 64];
                    mul_full_u32(a, b, &mut full32);
                    mul_full_u64(a, b, &mut full64);
                    assert_eq!(
                        full32, full64,
                        "mul_full digit-width mismatch a={:?} b={:?}",
                        a, b
                    );
                }
            }
        }
    };
}

digit_width_fuzz!(digit_width_i256, 4);
digit_width_fuzz!(digit_width_i512, 8);
digit_width_fuzz!(digit_width_i1024, 16);
digit_width_fuzz!(digit_width_i2048, 32);
