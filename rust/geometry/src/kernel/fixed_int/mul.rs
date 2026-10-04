// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Schoolbook limb multiplication for [`super::FixedInt`], with digit-width
//! dispatch: native uses u64 limbs (u64*u64→u128 is one `mulx`-class op);
//! wasm32 uses u32 digits, because wasm32 has no native 128-bit multiply and
//! every `(u64 as u128) * (u64 as u128)` partial product lowers to a
//! `__multi3` libcall there. The u32-digit schoolbook does up to 4x the
//! partial products, but each is a single `i64.mul` — the same trade upstream
//! bnum#74 makes. The product mod 2^(K*64) is digit-width independent, so
//! both paths are bit-identical; `super::tests::digit_width_*` pins that per
//! width, and the bnum differential fuzz pins the dispatching callers.

/// Low `K` limbs of the unsigned product `a * b` (mod 2^(K*64)). Exact for the
/// low limbs because a partial product `a[i]*b[j]` with `i+j >= K` is a multiple
/// of `2^(K*64)` and any carry off limb `K-1` lands at bit `>= K*64`, so both
/// are `0 mod 2^(K*64)` and may be dropped.
#[inline]
pub(super) fn mul_low<const K: usize>(a: &[u64; K], b: &[u64; K]) -> [u64; K] {
    #[cfg(target_arch = "wasm32")]
    {
        mul_low_u32(a, b)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        mul_low_u64(a, b)
    }
}

/// Low product for the checked-multiply PROVABLY-FIT magnitude branch only.
/// Bit lengths come from its existing overflow precheck, not a new scan.
/// Wrapping signed callers must retain full widths (sign-extension is real).
#[inline]
pub(super) fn mul_low_magnitude<const K: usize>(
    a: &[u64; K], b: &[u64; K], a_bits: usize, b_bits: usize,
) -> [u64; K] {
    debug_assert!(a_bits > 0 && b_bits > 0 && a_bits + b_bits < K * 64);
    #[cfg(target_arch = "wasm32")]
    {
        mul_low_u32_bounded(a, b, a_bits.div_ceil(32), b_bits.div_ceil(32))
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        mul_low_u64_bounded(a, b, a_bits.div_ceil(64), b_bits.div_ceil(64))
    }
}

/// u64-limb schoolbook low product.
#[inline]
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
pub(super) fn mul_low_u64<const K: usize>(a: &[u64; K], b: &[u64; K]) -> [u64; K] {
    mul_low_u64_bounded(a, b, K, K)
}

/// Shared low-product core. Only zero HIGH limbs may be excluded by bounds.
/// An untruncated row i ends at i+active_b: earlier rows end one limb lower,
/// so the row-end carry slot is fresh zero and may be ASSIGNED, not added.
/// If that slot reaches K, its carry is zero modulo 2^(K*64). The fit caller
/// separately guarantees no mathematically significant product overflow.
#[inline]
pub(super) fn mul_low_u64_bounded<const K: usize>(
    a: &[u64; K], b: &[u64; K], active_a: usize, active_b: usize,
) -> [u64; K] {
    debug_assert!(active_a <= K && active_b <= K);
    debug_assert!(a[active_a..].iter().all(|&v| v == 0));
    debug_assert!(b[active_b..].iter().all(|&v| v == 0));
    let mut out = [0u64; K];
    for i in 0..active_a {
        let mut carry: u128 = 0;
        let mut j = 0;
        while j < active_b && i + j < K {
            let idx = i + j;
            let t = (a[i] as u128) * (b[j] as u128) + (out[idx] as u128) + carry;
            out[idx] = t as u64;
            carry = t >> 64;
            j += 1;
        }
        if i + j < K {
            debug_assert_eq!(out[i + j], 0, "row-end carry slot must be fresh");
            out[i + j] = carry as u64;
        }
    }
    out
}

/// u32-digit schoolbook low product (wasm32: u32*u32→u64 is one `i64.mul`).
/// All-zero digits are skipped — a zero partial-product row adds nothing, so
/// the result is unchanged; on narrow magnitudes (the common case in the
/// predicate cascade) it also erases most of the 4x digit-count overhead.
#[inline]
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn mul_low_u32<const K: usize>(a: &[u64; K], b: &[u64; K]) -> [u64; K] {
    mul_low_u32_bounded(a, b, 2 * K, 2 * K)
}

/// Same fresh carry-slot proof as the u64 core, in radix 2^32. Preserves the
/// existing zero-A-digit skip; this prototype does not introduce that skip.
#[inline]
pub(super) fn mul_low_u32_bounded<const K: usize>(
    a: &[u64; K], b: &[u64; K], active_a: usize, active_b: usize,
) -> [u64; K] {
    debug_assert!(K <= 32, "FixedInt u32-digit scratch supports only K <= 32");
    let n = 2 * K;
    debug_assert!(active_a <= n && active_b <= n);
    let mut ad = [0u32; 64];
    let mut bd = [0u32; 64];
    for i in 0..K {
        ad[2 * i] = a[i] as u32;
        ad[2 * i + 1] = (a[i] >> 32) as u32;
        bd[2 * i] = b[i] as u32;
        bd[2 * i + 1] = (b[i] >> 32) as u32;
    }
    debug_assert!(ad[active_a..n].iter().all(|&v| v == 0));
    debug_assert!(bd[active_b..n].iter().all(|&v| v == 0));
    let mut out = [0u32; 64];
    for i in 0..active_a {
        let d = ad[i] as u64;
        if d == 0 {
            continue;
        }
        let mut carry: u64 = 0;
        let mut j = 0;
        while j < active_b && i + j < n {
            let idx = i + j;
            let t = d * (bd[j] as u64) + (out[idx] as u64) + carry;
            out[idx] = t as u32;
            carry = t >> 32;
            j += 1;
        }
        if i + j < n {
            debug_assert_eq!(out[i + j], 0, "row-end carry digit must be fresh");
            out[i + j] = carry as u32;
        }
    }
    let mut res = [0u64; K];
    for i in 0..K {
        res[i] = (out[2 * i] as u64) | ((out[2 * i + 1] as u64) << 32);
    }
    res
}

/// Full 2K-limb unsigned magnitude product into `full[..2K]` (same digit-width
/// dispatch rationale as [`mul_low`]).
///
/// PRECONDITION: `full[..2K]` must be zero on entry (debug-asserted). The u64
/// path folds `full[idx]` into its partial products (schoolbook accumulate)
/// while the u32 path computes into local scratch and writes back, so on a
/// dirty buffer the two digit widths would silently diverge — exactly the
/// bit-identity this module promises. The sole caller passes a fresh array.
#[inline]
pub(super) fn mul_full<const K: usize>(ma: &[u64; K], mb: &[u64; K], full: &mut [u64; 64]) {
    debug_assert!(
        full[..2 * K].iter().all(|&limb| limb == 0),
        "mul_full requires a zeroed output buffer (digit paths diverge on dirty input)"
    );
    #[cfg(target_arch = "wasm32")]
    {
        mul_full_u32(ma, mb, full)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        mul_full_u64(ma, mb, full)
    }
}

/// u64-limb schoolbook full product.
#[inline]
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
pub(super) fn mul_full_u64<const K: usize>(ma: &[u64; K], mb: &[u64; K], full: &mut [u64; 64]) {
    for i in 0..K {
        let mut carry: u128 = 0;
        for j in 0..K {
            let idx = i + j;
            let t = (ma[i] as u128) * (mb[j] as u128) + (full[idx] as u128) + carry;
            full[idx] = t as u64;
            carry = t >> 64;
        }
        full[i + K] = carry as u64;
    }
}

/// u32-digit schoolbook full product (wasm32; see [`mul_low_u32`]). Requires
/// the zeroed buffer [`mul_full`] asserts.
#[inline]
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
pub(super) fn mul_full_u32<const K: usize>(ma: &[u64; K], mb: &[u64; K], full: &mut [u64; 64]) {
    debug_assert!(K <= 32, "FixedInt u32-digit scratch supports only K <= 32");
    let n = 2 * K;
    let mut ad = [0u32; 64];
    let mut bd = [0u32; 64];
    for i in 0..K {
        ad[2 * i] = ma[i] as u32;
        ad[2 * i + 1] = (ma[i] >> 32) as u32;
        bd[2 * i] = mb[i] as u32;
        bd[2 * i + 1] = (mb[i] >> 32) as u32;
    }
    let mut out = [0u32; 128];
    for i in 0..n {
        let d = ad[i] as u64;
        if d == 0 {
            continue;
        }
        let mut carry: u64 = 0;
        for j in 0..n {
            let idx = i + j;
            let t = d * (bd[j] as u64) + (out[idx] as u64) + carry;
            out[idx] = t as u32;
            carry = t >> 32;
        }
        out[i + n] = carry as u32;
    }
    for (i, slot) in full.iter_mut().enumerate().take(n) {
        *slot = (out[2 * i] as u64) | ((out[2 * i + 1] as u64) << 32);
    }
}

#[cfg(test)]
#[path = "magnitude_mul_tests.rs"]
mod magnitude_mul_tests;
