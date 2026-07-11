// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Nearly-sorted permutation merge for [`crate::ColumnarEntityIndex`]
//! (split from `columnar_index.rs`): STEP id streams are a few long
//! ascending runs, and a k-way run merge beats the full argsort while
//! reproducing its exact (id, original-index) order.

/// Sort `(ids, starts, lengths)` by (id, original-index) with last-in-input
/// winning on duplicate ids — the exact argsort semantics `from_columns`
/// exposes; the nearly-sorted run merge is picked when it applies.
pub(crate) fn sort_columns(
ids: Vec<u32>,
starts: Vec<u32>,
lengths: Vec<u32>,
) -> (Vec<u32>, Vec<u32>, Vec<u32>) {
    let n = ids.len();
    // NEARLY-SORTED fast path: STEP exporters emit ids in ascending file
    // order except a handful of appended footer entities, so the id stream
    // is a few long ascending runs (measured: 57 runs across 19.1M records
    // on a real CATIA model). A k-way merge of the runs is O(n·log runs)
    // — with the SAME (id, original_index) order as the argsort below, so
    // last-in-input-order still wins on duplicate ids.
    let runs = ascending_runs(&ids);
    let perm: Vec<u32> = if runs.len() > 1 && runs.len() <= 64 {
        merge_runs_perm(&ids, &runs)
    } else {
        // Argsort a permutation, ordering by (id, original_index). Ties
        // break by original index ascending, so within an equal-id run the
        // last element has the greatest original index == last-in-input.
        let mut perm: Vec<u32> = (0..n as u32).collect();
        perm.sort_unstable_by(|&a, &b| {
            let ka = ids[a as usize];
            let kb = ids[b as usize];
            ka.cmp(&kb).then_with(|| a.cmp(&b))
        });
        perm
    };

    let mut out_ids: Vec<u32> = Vec::with_capacity(n);
    let mut out_starts: Vec<u32> = Vec::with_capacity(n);
    let mut out_lengths: Vec<u32> = Vec::with_capacity(n);
    for &p in &perm {
        let p = p as usize;
        let id = ids[p];
        if out_ids.last() == Some(&id) {
            // Duplicate id: overwrite the tail so the LAST occurrence wins.
            let li = out_ids.len() - 1;
            out_starts[li] = starts[p];
            out_lengths[li] = lengths[p];
        } else {
            out_ids.push(id);
            out_starts.push(starts[p]);
            out_lengths.push(lengths[p]);
        }
    }
    out_ids.shrink_to_fit();
    out_starts.shrink_to_fit();
    out_lengths.shrink_to_fit();
    (out_ids, out_starts, out_lengths)
}

/// Split `ids` into maximal ascending runs (`id[i] > id[i-1]` continues a
/// run; `<=` starts a new one — equal ids split so the merge's tie-break by
/// original index applies across runs AND within an equal-id pair).
pub(crate) fn ascending_runs(ids: &[u32]) -> Vec<(u32, u32)> {
    let mut runs = Vec::new();
    if ids.is_empty() {
        return runs;
    }
    let mut start = 0u32;
    for i in 1..ids.len() {
        if ids[i] <= ids[i - 1] {
            runs.push((start, i as u32));
            start = i as u32;
        }
    }
    runs.push((start, ids.len() as u32));
    runs
}

/// K-way merge of ascending runs into the (id, original_index)-ordered
/// permutation the argsort would produce. After each head rescan the winning
/// run STREAMS until its next id reaches the runner-up's key, so the cost is
/// O(n + interleavings·runs) — effectively linear for the few-long-runs shape
/// this path is gated to (a full head scan per pop would be O(n·runs), no
/// better than the argsort it replaces).
pub(crate) fn merge_runs_perm(ids: &[u32], runs: &[(u32, u32)]) -> Vec<u32> {
    let mut heads: Vec<(u32, u32)> = runs.to_vec(); // (cursor, end)
    let mut perm: Vec<u32> = Vec::with_capacity(ids.len());
    loop {
        // Rescan: find best and runner-up under (id, original_index) order.
        // Runs are index-ordered, so a smaller cursor is an earlier index.
        let mut best: Option<usize> = None;
        let mut second_key: Option<(u32, u32)> = None; // (id, cursor)
        for (r, &(cursor, end)) in heads.iter().enumerate() {
            if cursor >= end {
                continue;
            }
            let key = (ids[cursor as usize], cursor);
            match best {
                None => best = Some(r),
                Some(b) => {
                    let bkey = (ids[heads[b].0 as usize], heads[b].0);
                    if key < bkey {
                        second_key = Some(bkey);
                        best = Some(r);
                    } else if second_key.is_none_or(|sk| key < sk) {
                        second_key = Some(key);
                    }
                }
            }
        }
        let Some(b) = best else { break };
        let (mut cursor, end) = heads[b];
        // Stream from the winning run while it still beats the runner-up.
        match second_key {
            None => {
                // Single live run: drain it.
                while cursor < end {
                    perm.push(cursor);
                    cursor += 1;
                }
            }
            Some(sk) => {
                while cursor < end && (ids[cursor as usize], cursor) < sk {
                    perm.push(cursor);
                    cursor += 1;
                }
            }
        }
        heads[b].0 = cursor;
    }
    perm
}

#[cfg(test)]
mod nearly_sorted_tests {
    use super::*;
    use crate::ColumnarEntityIndex;

    /// Reference: last-in-input-order wins per id, output id-ascending.
    fn reference(ids: &[u32], starts: &[u32], lengths: &[u32]) -> Vec<(u32, u32, u32)> {
        let mut map = std::collections::BTreeMap::new();
        for i in 0..ids.len() {
            map.insert(ids[i], (starts[i], lengths[i]));
        }
        map.into_iter().map(|(id, (s, l))| (id, s, l)).collect()
    }

    fn assert_matches_reference(ids: &[u32]) {
        let starts: Vec<u32> = (0..ids.len() as u32).map(|i| i * 10).collect();
        let lengths: Vec<u32> = (0..ids.len() as u32).map(|i| i + 1).collect();
        let idx = ColumnarEntityIndex::from_columns(ids, &starts, &lengths);
        let want = reference(ids, &starts, &lengths);
        let got: Vec<(u32, u32, u32)> = (0..idx.ids().len())
            .map(|i| (idx.ids()[i], idx.starts()[i], idx.lengths()[i]))
            .collect();
        assert_eq!(got, want, "input {ids:?}");
    }

    #[test]
    fn few_runs_merge_matches_argsort_semantics() {
        // Two long ascending runs (the CATIA footer shape).
        assert_matches_reference(&[10, 20, 30, 40, 1, 2, 3]);
        // Three runs, interleaved ranges.
        assert_matches_reference(&[5, 50, 500, 7, 70, 700, 6, 60, 600]);
    }

    #[test]
    fn duplicate_ids_last_in_input_wins_across_and_within_runs() {
        // id 20 appears in run 0 and run 1: run 1's (later input) must win.
        assert_matches_reference(&[10, 20, 30, 20, 25, 35]);
        // Adjacent equal ids split runs; the second (later) must win.
        assert_matches_reference(&[10, 10, 11]);
        // Triplicate spread over three runs.
        assert_matches_reference(&[7, 9, 7, 8, 7]);
    }

    #[test]
    fn many_runs_falls_back_to_argsort_and_still_matches() {
        // 100 runs of 2 (descending pairs) — over the merge gate.
        let mut ids = Vec::new();
        for i in 0..100u32 {
            ids.push(1000 + i);
            ids.push(i);
        }
        assert_matches_reference(&ids);
    }

    #[test]
    fn run_detection_shapes() {
        assert_eq!(ascending_runs(&[]).len(), 0);
        assert_eq!(ascending_runs(&[1, 2, 3]).len(), 1);
        assert_eq!(ascending_runs(&[1, 2, 2, 3]).len(), 2);
        assert_eq!(ascending_runs(&[3, 2, 1]).len(), 3);
    }
}
