// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #6537 independent bnum oracle for active-bound products. Exercises native
//! AND wasm32 digit cores on the host, not just the platform-selected branch.

use super::{mul_low_magnitude, mul_low_u32_bounded, mul_low_u64_bounded};
use super::super::FixedInt;
use num_traits::CheckedMul;

fn bit_length<const K: usize>(a: &[u64; K]) -> usize {
    a.iter().enumerate().rev().find_map(|(i, &v)| {
        (v != 0).then(|| i * 64 + 64 - v.leading_zeros() as usize)
    }).unwrap_or(0)
}

fn with_bits<const K: usize>(bits: usize, dense: bool) -> [u64; K] {
    let mut a = [0; K];
    if bits == 0 { return a; }
    if dense {
        for (i, v) in a.iter_mut().enumerate() {
            let remaining = bits.saturating_sub(i * 64);
            *v = if remaining >= 64 { u64::MAX }
                else if remaining == 0 { 0 }
                else { (1u64 << remaining) - 1 };
        }
    } else {
        a[(bits - 1) / 64] = 1u64 << ((bits - 1) % 64);
    }
    a
}

macro_rules! magnitude_oracle {
    ($name:ident, $K:literal, $BT:path) => {
        #[test]
        fn $name() {
            const W: usize = $K * 64;
            let to_bnum = |a: &[u64; $K]| -> $BT {
                let mut bytes = [0u8; $K * 8];
                for (i, limb) in a.iter().enumerate() {
                    bytes[i * 8..i * 8 + 8].copy_from_slice(&limb.to_le_bytes());
                }
                <$BT>::from_le_slice(&bytes).expect("independent bnum operand")
            };
            let check_low = |a: &[u64; $K], b: &[u64; $K]| {
                let product = to_bnum(a).wrapping_mul(to_bnum(b)).to_le_bytes();
                let expected: [u64; $K] = std::array::from_fn(|i| {
                    u64::from_le_bytes(product[i * 8..i * 8 + 8].try_into().expect("oracle limb"))
                });
                let la = bit_length(a);
                let lb = bit_length(b);
                assert_eq!(mul_low_u64_bounded(a, b, la.div_ceil(64), lb.div_ceil(64)), expected,
                    "native bounded product a={a:?} b={b:?}");
                assert_eq!(mul_low_u32_bounded(a, b, la.div_ceil(32), lb.div_ceil(32)), expected,
                    "wasm-digit bounded product a={a:?} b={b:?}");
                if la > 0 && lb > 0 && la + lb < W {
                    assert_eq!(mul_low_magnitude(a, b, la, lb), expected,
                        "fitting magnitude dispatch a={a:?} b={b:?}");
                }
                // Full-width wrapping callers must keep signed high limbs.
                assert_eq!((FixedInt::from_limbs(*a) * FixedInt::from_limbs(*b)).0, expected,
                    "wrapping signed product a={a:?} b={b:?}");
            };
            let check_checked = |a: FixedInt<$K>, b: FixedInt<$K>| {
                let oracle = CheckedMul::checked_mul(&to_bnum(&a.0), &to_bnum(&b.0));
                assert_eq!(CheckedMul::checked_mul(&a, &b).map(|v| to_bnum(&v.0)), oracle,
                    "checked value/overflow a={a:?} b={b:?}");
            };

            // A carry is required beyond the active prefix in a provably-fit
            // positive checked product. Keep this first: a carry-loss mutation
            // must fail the actual eligible route, not only a later raw product.
            let fitting = with_bits::<$K>(64, true);
            let fitting_value = FixedInt::from_limbs(fitting);
            check_checked(fitting_value, fitting_value);
            check_low(&fitting, &fitting);

            let mut patterns = vec![[0; $K], [u64::MAX; $K]];
            for active in 1..=$K {
                // Dense prefixes force carries beyond active B. Partial final
                // limbs exercise the different native/u32 rounding of bounds.
                patterns.push(with_bits::<$K>(active * 64, true));
                patterns.push(with_bits::<$K>(active * 64 - 1, true));
                patterns.push(with_bits::<$K>(active * 64 - 31, true));
                let mut sparse = [0; $K];
                sparse[0] = 1;
                sparse[active - 1] |= 1u64 << 32;
                patterns.push(sparse);
                let mut suffix = [0; $K];
                suffix[$K - active..].fill(u64::MAX);
                patterns.push(suffix);
            }
            // Fixed-seed random magnitudes with sparse INTERIOR limbs. Upper
            // zero limbs are trimmed; interior zeros remain part of the core.
            let mut rng = 0x4d_756c_6537_u64 ^ ($K as u64);
            for _ in 0..96 {
                rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                let bits = (rng as usize) % (W + 1);
                let mut p = with_bits::<$K>(bits, true);
                for v in &mut p {
                    rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                    *v &= if rng & 3 == 0 { 0 } else { rng };
                }
                patterns.push(p);
            }
            // Pair every shape with dense/unequal/sparse widths and dense
            // high suffixes. Both argument orders matter (WASM skips A rows).
            for a in &patterns {
                for b in patterns.iter().take(22) {
                    check_low(a, b);
                    check_low(b, a);
                }
            }
            for active in 1..=$K {
                let mut suffix = [0; $K];
                suffix[$K - active..].fill(u64::MAX);
                check_low(&suffix, &suffix);
                check_low(&suffix, &with_bits::<$K>(W, true));
            }

            // Every conservative-precheck boundary: sums W-1 (fit), W/W+1
            // (ambiguous) and W+2 (reject), both dense and power-of-two values,
            // and every sign combination. Compare verdict AND full value.
            for la in [1, 2, 63, 64, 65, W / 2, W - 2, W - 1] {
                for sum in [W - 1, W, W + 1, W + 2] {
                    let Some(lb) = sum.checked_sub(la) else { continue; };
                    if lb == 0 || lb >= W { continue; }
                    for dense in [false, true] {
                        let a = FixedInt::from_limbs(with_bits::<$K>(la, dense));
                        let b = FixedInt::from_limbs(with_bits::<$K>(lb, dense));
                        check_low(&a.0, &b.0);
                        check_low(&b.0, &a.0);
                        for aa in [a, -a] {
                            for bb in [b, -b] { check_checked(aa, bb); }
                        }
                    }
                }
            }
            let min = FixedInt::from_limbs(with_bits::<$K>(W, false));
            let one = FixedInt::from_limbs(with_bits::<$K>(1, false));
            for a in [min, one, -one, FixedInt::from_limbs([0; $K])] {
                for b in [min, one, -one, FixedInt::from_limbs([0; $K])] {
                    check_checked(a, b);
                }
            }
        }
    };
}

magnitude_oracle!(issue_6537_magnitude_products_i256, 4, bnum::types::I256);
magnitude_oracle!(issue_6537_magnitude_products_i512, 8, bnum::types::I512);
magnitude_oracle!(issue_6537_magnitude_products_i1024, 16, bnum::types::I1024);
magnitude_oracle!(issue_6537_magnitude_products_i2048, 32, bnum::types::I2048);
