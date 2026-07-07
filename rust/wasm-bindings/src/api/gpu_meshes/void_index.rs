// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Defensive reconstruction of the batch void-index from its flat wire arrays.

use rustc_hash::FxHashMap;

/// Rebuild the host -> openings map from the flat `(keys, counts, values)` wire
/// arrays the prepass emits. Normally these are same-session-trusted, but under
/// the wasm `panic=abort` profile any upstream drift or off-by-one would trap the
/// entire wasm instance for the rest of the session, so validate defensively:
/// a `keys`/`counts` length mismatch drops the whole index (hosts then render
/// solid, which `processing::element` already treats as "no openings"), and an
/// out-of-range `values` slice stops reconstruction rather than panicking.
pub(super) fn reconstruct_void_index(
    void_keys: &[u32],
    void_counts: &[u32],
    void_values: &[u32],
) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    if void_counts.len() != void_keys.len() {
        return void_index;
    }
    let mut value_offset = 0usize;
    for (i, &host_id) in void_keys.iter().enumerate() {
        let count = void_counts[i] as usize;
        let end = value_offset.saturating_add(count);
        let Some(openings) = void_values.get(value_offset..end) else {
            break;
        };
        void_index.insert(host_id, openings.to_vec());
        value_offset = end;
    }
    void_index
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn well_formed_arrays_reconstruct() {
        let idx = reconstruct_void_index(&[10, 20], &[2, 1], &[1, 2, 3]);
        assert_eq!(idx.get(&10), Some(&vec![1, 2]));
        assert_eq!(idx.get(&20), Some(&vec![3]));
    }

    #[test]
    fn mismatched_counts_length_drops_index_not_panics() {
        // counts shorter than keys: pre-fix `void_counts[i]` panicked (wasm abort).
        let idx = reconstruct_void_index(&[10, 20, 30], &[2], &[1, 2]);
        assert!(idx.is_empty());
    }

    #[test]
    fn overlong_count_stops_without_panic() {
        // count overruns values: pre-fix the slice panicked. Now keep what fits.
        let idx = reconstruct_void_index(&[10, 20], &[1, 99], &[7, 8]);
        assert_eq!(idx.get(&10), Some(&vec![7]));
        assert_eq!(idx.get(&20), None); // second entry's slice overruns -> stopped
    }
}
