// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared float-noise-tolerance quantisation constants used by more than one
//! geometry pass. Single-sourced so two independently-evolving passes (e.g. a
//! weld and the plane-bucketing it feeds) can never drift apart on the SAME
//! tolerance — see `kernel::mesh_bridge::SNAP_GRID` for the kernel's own
//! canonical snap grid (that one stays defined in `kernel::mesh_bridge`, since
//! it is already the kernel's documented canonical constant).

/// Normal-direction quantisation grid (`f64`): a normal component is
/// multiplied by this and rounded to an integer before bucketing/keying. 1e3
/// gives ~0.057° resolution. Shared by `facet_weld`'s per-facet plane
/// clustering and `csg::consolidate`'s plane-bucket key, so a bucket boundary
/// can never disagree between the two passes.
pub(crate) const NORMAL_QUANT_F64: f64 = 1.0e3;

/// Same quantisation grid as [`NORMAL_QUANT_F64`], as `f32` for callers
/// (`mesh_weld`) that key directly off `Mesh`'s f32 normals.
pub(crate) const NORMAL_QUANT_F32: f32 = 1.0e3;

/// `x.round() as i32` (half away from zero, saturating, NaN to 0) without the
/// libm call `f32::round` becomes on targets without a native rounding
/// instruction (x86_64's baseline and wasm32 alike). Below 2^23 in magnitude
/// `x - trunc(x)` is exact, so comparing it with ±0.5 decides the same
/// rounding; at or above 2^23 every `f32` is already an integer, and the
/// saturating cast alone is the answer. Bit-for-bit the same `i32` for every
/// input, which the hashed quantisation keys need.
#[inline(always)]
pub(crate) fn round_i32(x: f32) -> i32 {
    let truncated = x as i32;
    if x.abs() < 8_388_608.0 {
        let fraction = x - truncated as f32;
        truncated + i32::from(fraction >= 0.5) - i32::from(fraction <= -0.5)
    } else {
        truncated
    }
}

/// [`round_i32`] for `f64` into `i64`: `x.round() as i64`, exact below 2^52.
#[inline(always)]
pub(crate) fn round_i64(x: f64) -> i64 {
    let truncated = x as i64;
    if x.abs() < 4_503_599_627_370_496.0 {
        let fraction = x - truncated as f64;
        truncated + i64::from(fraction >= 0.5) - i64::from(fraction <= -0.5)
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::{round_i32, round_i64};

    const EDGES_F32: [f32; 16] = [0.0, -0.0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 0.499_999_97, -0.499_999_97,
        8_388_607.5, -8_388_607.5, 8_388_608.0, 2.147_483_6e9, f32::MAX, f32::MIN_POSITIVE];

    /// Every 251st `f32` bit pattern (about 17M, both signs, every exponent,
    /// NaNs and infinities included) plus the rounding edges.
    #[test]
    fn round_i32_matches_libm_round_bit_for_bit() {
        for x in EDGES_F32.iter().copied().chain([f32::NAN, f32::INFINITY, f32::NEG_INFINITY]) {
            assert_eq!(round_i32(x), x.round() as i32, "{x:e}");
        }
        let mut bits = 0u32;
        loop {
            let x = f32::from_bits(bits);
            assert_eq!(round_i32(x), x.round() as i32, "{bits:#x}");
            bits = match bits.checked_add(251) { Some(b) => b, None => break };
        }
    }

    /// Edges plus 5M pseudo-random `f64` bit patterns, half of them drawn
    /// near the quantisation scale (|x| < 2^40) where the keys live.
    #[test]
    fn round_i64_matches_libm_round_bit_for_bit() {
        let edges = [0.0, -0.0, 0.5, -0.5, 1.5, -2.5, 0.499_999_999_999_999_94, 4_503_599_627_370_495.5,
            -4_503_599_627_370_495.5, 4_503_599_627_370_496.0, 9.223_372_036_854_775e18, f64::MAX,
            f64::NAN, f64::INFINITY, f64::NEG_INFINITY, f64::MIN_POSITIVE];
        for x in edges {
            assert_eq!(round_i64(x), x.round() as i64, "{x:e}");
        }
        let mut state = 0x2545_f491_4f6c_dd1d_u64;
        for i in 0..5_000_000u64 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            let x = if i % 2 == 0 {
                f64::from_bits(state)
            } else {
                (state as i64 as f64) / (1u64 << (state % 40)) as f64 / 65_536.0
            };
            assert_eq!(round_i64(x), x.round() as i64, "{:#x}", x.to_bits());
        }
    }
}
