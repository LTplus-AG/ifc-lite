// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// Reduce a 128-bit geometry hash to the 32-bit worker-affinity key the job
/// stream carries. Jobs with the SAME key are routed to the same geometry worker,
/// so their (byte-identical) geometry is meshed once per model instead of once per
/// worker — the win the per-worker content-dedup cache can't get across separate
/// WASM realms. A 32-bit collision only co-locates two unrelated geometries on one
/// worker (harmless: the cache still keys them apart), so xor-folding the lanes is
/// plenty.
#[inline]
pub(super) fn fold_u128_to_u32(h: u128) -> u32 {
    (h as u32) ^ ((h >> 32) as u32) ^ ((h >> 64) as u32) ^ ((h >> 96) as u32)
}

#[cfg(test)]
mod affinity_tests {
    use super::fold_u128_to_u32;

    #[test]
    fn fold_is_stable_and_mixes_all_lanes() {
        // Identical hashes fold to identical keys (routing stickiness).
        assert_eq!(fold_u128_to_u32(0x1234_5678_9abc_def0_1111_2222_3333_4444),
                   fold_u128_to_u32(0x1234_5678_9abc_def0_1111_2222_3333_4444));
        // A change confined to ANY single 32-bit lane changes the key — so two
        // geometries differing only in their high bits still route apart.
        let base = 0u128;
        assert_ne!(fold_u128_to_u32(base), fold_u128_to_u32(base | (1u128 << 0)));
        assert_ne!(fold_u128_to_u32(base), fold_u128_to_u32(base | (1u128 << 40)));
        assert_ne!(fold_u128_to_u32(base), fold_u128_to_u32(base | (1u128 << 72)));
        assert_ne!(fold_u128_to_u32(base), fold_u128_to_u32(base | (1u128 << 120)));
    }
}
