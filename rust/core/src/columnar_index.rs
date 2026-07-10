// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Columnar entity index — a compact, binary-searched alternative to the
//! [`EntityIndex`](crate::EntityIndex) `FxHashMap<u32, (usize, usize)>`.
//!
//! # Why
//!
//! The streaming pre-pass hands every wasm worker (N geometry workers plus the
//! prepass and parser workers) the same pre-scanned entity index as three
//! parallel `u32` columns
//! via `setEntityIndex`. Each worker used to materialize a private
//! `FxHashMap<u32, (usize, usize)>` from those columns. hashbrown rounds the
//! bucket count up to the next power of two, so for a 19.1 M-entity model it
//! allocates `2^25` buckets × ~13 B ≈ **436 MB per worker**, rebuilt in every
//! realm. Three sorted `Vec<u32>` columns for the same model are
//! `3 × 19.1 M × 4 B ≈ 229 MB` — no power-of-two rounding, no per-bucket control
//! byte, no `(usize, usize)` widening. The lookup becomes a `binary_search`
//! (≈24 probes at 19 M rows) instead of an O(1) hash probe; see the PR for the
//! measured wall-time delta on the full geometry pipeline.
//!
//! # `u32` offsets
//!
//! `starts`/`lengths` are `u32`, which is only sound while the source file is
//! < 4 GiB. This type is used **exclusively on the wasm ingestion path**
//! (`setEntityIndex` and the wasm `cached_entity_index`), where the whole file
//! already lives in the < 4 GiB wasm32 linear address space and the delivered
//! columns are themselves `&[u32]`. Native / server paths that can exceed 4 GiB
//! keep the `usize`-carrying [`EntityIndex`](crate::EntityIndex) hashmap.
//!
//! # Duplicate express ids
//!
//! [`crate::build_entity_index`] inserts scanned spans into an `FxHashMap` in
//! file order, so a repeated express id resolves to its **last** occurrence in
//! the file (`HashMap::insert` overwrites). Express ids are unique per the STEP
//! spec and duplicates essentially never occur, but this type replicates the
//! last-in-file-order-wins behaviour deliberately (see `from_unsorted` and the
//! `duplicate_id_last_wins` test) so a malformed file cannot diverge between the
//! hashmap and columnar paths.

use crate::decoder::EntityIndex;
use crate::parser::EntityScanner;
use std::sync::Arc;

/// Compact, sorted, binary-searched entity index. Columns are kept sorted by
/// `ids` (strictly ascending, unique) so [`Self::lookup`] can `binary_search`.
///
/// Invariants (upheld by every constructor):
/// - `ids.len() == starts.len() == lengths.len()`
/// - `ids` is strictly ascending (hence unique)
/// - `starts[i]` / `lengths[i]` are the byte offset / byte length of `ids[i]`,
///   so `lookup` returns `(start, start + length)` to match the `(start, end)`
///   tuple layout of [`EntityIndex`](crate::EntityIndex).
pub struct ColumnarEntityIndex {
    ids: Vec<u32>,
    starts: Vec<u32>,
    lengths: Vec<u32>,
}

impl ColumnarEntityIndex {
    /// Build from the three delivered columns (`setEntityIndex` ingestion).
    ///
    /// Verifies the id column's ordering **once**, O(n): the pre-pass emits in
    /// whatever order it iterates (its own `FxHashMap` iteration order is
    /// arbitrary), so this cannot assume ascending. If the ids are already
    /// strictly ascending the columns are used as-is (no sort); otherwise a
    /// single stable argsort permutation is applied and duplicate ids are
    /// collapsed last-in-input-order-wins.
    ///
    /// Mismatched column lengths yield an empty index (the wasm caller guards
    /// this too), so a malformed payload never panics a worker.
    pub fn from_columns(ids: &[u32], starts: &[u32], lengths: &[u32]) -> Self {
        let n = ids.len();
        if n == 0 || starts.len() != n || lengths.len() != n {
            return Self {
                ids: Vec::new(),
                starts: Vec::new(),
                lengths: Vec::new(),
            };
        }
        if is_strictly_ascending(ids) {
            // Already sorted AND unique — the common case once the producer
            // emits sorted columns. No permutation, no dedup: just adopt them.
            return Self {
                ids: ids.to_vec(),
                starts: starts.to_vec(),
                lengths: lengths.to_vec(),
            };
        }
        Self::from_unsorted(ids.to_vec(), starts.to_vec(), lengths.to_vec())
    }

    /// Build from an already-scanned [`EntityIndex`](crate::EntityIndex)
    /// hashmap, CONSUMING it. On the wasm prepass path the map is ~436 MB at
    /// 19.1 M entities and the conversion runs while the whole source file is
    /// resident in the same <4 GiB heap; borrowing (`from_hashmap`) keeps the
    /// map alive across the copy AND the sort, spiking ~970 MB of transients.
    ///
    /// Consuming drains into one interleaved `Vec<(id, start, len)>` (~229 MB)
    /// then sorts in place (`sort_unstable`; map keys are unique, so no
    /// stability/permutation buffer). Peak during the drain is map + rows
    /// capacity (~665 MB) until the map drops at end-of-loop; after that the
    /// sort is in-place and the final column split briefly overlaps rows +
    /// outputs (~458 MB) before rows drop. Still far below the borrowing path,
    /// and the steady-state index is ~229 MB.
    pub fn from_hashmap_consuming(map: EntityIndex) -> Self {
        let n = map.len();
        // Reserve while the map is still alive: peak ≈ map + rows (~665 MB at
        // 19.1 M). Draining without reserve would thrash reallocs for the same
        // asymptotic peak once the vec fills.
        let mut rows: Vec<(u32, u32, u32)> = Vec::with_capacity(n);
        for (id, (start, end)) in map {
            // u32 offsets are sound only under the wasm32 <4GiB address space
            // (module docs); see `from_hashmap`.
            debug_assert!(end <= u32::MAX as usize, "entity offset exceeds the u32 column ceiling");
            rows.push((id, start as u32, (end - start) as u32));
        }
        // `map` dropped with the loop; sort is in-place on `rows` alone.
        rows.sort_unstable_by_key(|r| r.0);
        let mut ids = Vec::with_capacity(rows.len());
        let mut starts = Vec::with_capacity(rows.len());
        let mut lengths = Vec::with_capacity(rows.len());
        for (id, start, len) in rows {
            ids.push(id);
            starts.push(start);
            lengths.push(len);
        }
        Self { ids, starts, lengths }
    }

    /// Build from an already-scanned [`EntityIndex`](crate::EntityIndex)
    /// hashmap. The map is unique by construction (last-in-file-order-wins was
    /// applied by `HashMap::insert`), so this only sorts the entries. Prefer
    /// [`Self::from_hashmap_consuming`] when the map is no longer needed - it
    /// avoids holding map + copies concurrently (P1 review finding on #1689).
    pub fn from_hashmap(map: &EntityIndex) -> Self {
        let n = map.len();
        let mut ids = Vec::with_capacity(n);
        let mut starts = Vec::with_capacity(n);
        let mut lengths = Vec::with_capacity(n);
        for (&id, &(start, end)) in map.iter() {
            // u32 offsets are sound only under the wasm32 <4GiB address space
            // (module docs). Catch a future native caller in debug builds
            // before a silent truncation decodes the wrong bytes.
            debug_assert!(end <= u32::MAX as usize, "entity offset exceeds the u32 column ceiling");
            ids.push(id);
            starts.push(start as u32);
            lengths.push((end - start) as u32);
        }
        // Entries are unique; `from_unsorted`'s dedup is a no-op but keeps one
        // sort/build code path.
        Self::from_unsorted(ids, starts, lengths)
    }

    /// Scan `content` and build the columns directly, replicating
    /// [`crate::build_entity_index`]'s HEADER-skipping / quoted-string scan and
    /// its last-in-file-order-wins duplicate handling — without ever
    /// materializing the intermediate `FxHashMap`. Used by the wasm lazy
    /// fallback when `setEntityIndex` was never called.
    pub fn from_scan<T>(content: &T) -> Self
    where
        T: AsRef<[u8]> + ?Sized,
    {
        let content = content.as_ref();
        let estimated = content.len() / 50;
        let mut ids = Vec::with_capacity(estimated);
        let mut starts = Vec::with_capacity(estimated);
        let mut lengths = Vec::with_capacity(estimated);
        let mut scanner = EntityScanner::new(content);
        while let Some((id, _type_name, start, end)) = scanner.next_entity() {
            debug_assert!(end <= u32::MAX as usize, "entity offset exceeds the u32 column ceiling");
            ids.push(id);
            starts.push(start as u32);
            lengths.push((end - start) as u32);
        }
        Self::from_unsorted(ids, starts, lengths)
    }

    /// Sort the (id, start, length) triples by id and collapse duplicate ids
    /// keeping the one that appeared **last** in the input order (matching
    /// `FxHashMap::insert`). The input `Vec`s are in original (file / delivery)
    /// order.
    fn from_unsorted(ids: Vec<u32>, starts: Vec<u32>, lengths: Vec<u32>) -> Self {
        let n = ids.len();
        // Argsort a permutation, ordering by (id, original_index). Ties break by
        // original index ascending, so within an equal-id run the last element
        // has the greatest original index == last-in-input-order.
        let mut perm: Vec<u32> = (0..n as u32).collect();
        perm.sort_unstable_by(|&a, &b| {
            let ka = ids[a as usize];
            let kb = ids[b as usize];
            ka.cmp(&kb).then_with(|| a.cmp(&b))
        });

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
        Self {
            ids: out_ids,
            starts: out_starts,
            lengths: out_lengths,
        }
    }

    /// Binary-search the byte span of `id`. Returns `(start, end)` where
    /// `end = start + length`, exactly matching [`EntityIndex`](crate::EntityIndex)'s
    /// tuple, or `None` if the id is absent.
    #[inline]
    pub fn lookup(&self, id: u32) -> Option<(usize, usize)> {
        match self.ids.binary_search(&id) {
            Ok(i) => {
                let start = self.starts[i] as usize;
                Some((start, start + self.lengths[i] as usize))
            }
            Err(_) => None,
        }
    }

    /// Sorted, unique id column (for re-emitting the entity-index event).
    #[inline]
    pub fn ids(&self) -> &[u32] {
        &self.ids
    }

    /// Byte-start column, parallel to [`Self::ids`].
    #[inline]
    pub fn starts(&self) -> &[u32] {
        &self.starts
    }

    /// Byte-length column, parallel to [`Self::ids`].
    #[inline]
    pub fn lengths(&self) -> &[u32] {
        &self.lengths
    }

    /// Number of indexed entities.
    #[inline]
    pub fn len(&self) -> usize {
        self.ids.len()
    }

    /// Whether the index is empty.
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.ids.is_empty()
    }
}

/// True iff `ids` is strictly ascending (which also proves uniqueness). O(n).
#[inline]
fn is_strictly_ascending(ids: &[u32]) -> bool {
    ids.windows(2).all(|w| w[0] < w[1])
}

/// The index representation an [`EntityDecoder`](crate::EntityDecoder) holds:
/// either the legacy `FxHashMap` (native / lazily-built paths) or the compact
/// columnar index (wasm shared-index ingestion). A thin dispatch keeps the
/// decoder hot path (`decode_by_id`) agnostic to which one is installed.
pub(crate) enum EntityIndexStore {
    Hash(Arc<EntityIndex>),
    Columnar(Arc<ColumnarEntityIndex>),
}

impl EntityIndexStore {
    /// Resolve `id` to its `(start, end)` byte span.
    #[inline]
    pub(crate) fn lookup(&self, id: u32) -> Option<(usize, usize)> {
        match self {
            EntityIndexStore::Hash(m) => m.get(&id).copied(),
            EntityIndexStore::Columnar(c) => c.lookup(id),
        }
    }
}

impl<'a> crate::EntityDecoder<'a> {
    /// Create a decoder backed by a shared columnar index (wasm shared-index
    /// path). Mirrors [`EntityDecoder::with_arc_index`](crate::EntityDecoder::with_arc_index)
    /// but installs the compact representation.
    pub fn with_arc_columnar_index<T>(content: &'a T, index: Arc<ColumnarEntityIndex>) -> Self
    where
        T: AsRef<[u8]> + ?Sized,
    {
        let mut decoder = Self::new(content);
        decoder.set_columnar_index(index);
        decoder
    }

    /// Install a shared columnar index into an existing decoder. Like
    /// [`EntityDecoder::set_entity_index`](crate::EntityDecoder::set_entity_index)
    /// but for the compact representation; afterwards `build_index` no-ops.
    pub fn set_columnar_index(&mut self, index: Arc<ColumnarEntityIndex>) {
        self.entity_index = Some(EntityIndexStore::Columnar(index));
    }
}

#[cfg(test)]
mod columnar_index_tests {
    use super::*;

    #[test]
    fn sorted_unique_uses_fast_path_and_looks_up() {
        let ids = [1u32, 5, 9, 100];
        let starts = [10u32, 20, 30, 40];
        let lengths = [3u32, 4, 5, 6];
        let idx = ColumnarEntityIndex::from_columns(&ids, &starts, &lengths);
        assert_eq!(idx.len(), 4);
        assert_eq!(idx.lookup(1), Some((10, 13)));
        assert_eq!(idx.lookup(5), Some((20, 24)));
        assert_eq!(idx.lookup(100), Some((40, 46)));
        assert_eq!(idx.lookup(2), None);
        assert_eq!(idx.lookup(101), None);
    }

    #[test]
    fn unsorted_input_is_sorted_then_searched() {
        let ids = [100u32, 1, 9, 5];
        let starts = [40u32, 10, 30, 20];
        let lengths = [6u32, 3, 5, 4];
        let idx = ColumnarEntityIndex::from_columns(&ids, &starts, &lengths);
        assert_eq!(idx.ids(), &[1, 5, 9, 100]);
        assert_eq!(idx.lookup(1), Some((10, 13)));
        assert_eq!(idx.lookup(5), Some((20, 24)));
        assert_eq!(idx.lookup(9), Some((30, 35)));
        assert_eq!(idx.lookup(100), Some((40, 46)));
    }

    #[test]
    fn duplicate_id_last_wins() {
        // Same express id 7 appears twice; the LAST occurrence in input order
        // must win, matching FxHashMap::insert / build_entity_index.
        let ids = [7u32, 3, 7];
        let starts = [10u32, 20, 30];
        let lengths = [1u32, 2, 3];
        let idx = ColumnarEntityIndex::from_columns(&ids, &starts, &lengths);
        assert_eq!(idx.len(), 2);
        // id 7 -> the (start=30, len=3) entry, NOT (10, 1)
        assert_eq!(idx.lookup(7), Some((30, 33)));
        assert_eq!(idx.lookup(3), Some((20, 22)));
    }

    #[test]
    fn empty_and_mismatched_columns_are_empty() {
        assert!(ColumnarEntityIndex::from_columns(&[], &[], &[]).is_empty());
        assert!(ColumnarEntityIndex::from_columns(&[1, 2], &[0], &[0, 0]).is_empty());
    }

    #[test]
    fn from_hashmap_matches_lookup() {
        let content = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n\
            #1=IFCCARTESIANPOINT((0.,0.,0.));\n\
            #7=IFCCARTESIANPOINT((1.,2.,3.));\n\
            ENDSEC;\nEND-ISO-10303-21;\n";
        let map = crate::build_entity_index(content);
        let col = ColumnarEntityIndex::from_hashmap(&map);
        assert_eq!(col.len(), map.len());
        for (&id, &(s, e)) in map.iter() {
            assert_eq!(col.lookup(id), Some((s, e)));
        }
        // A scan-built index must agree byte-for-byte with the hashmap one.
        let scanned = ColumnarEntityIndex::from_scan(content);
        assert_eq!(scanned.ids(), col.ids());
        for &id in col.ids() {
            assert_eq!(scanned.lookup(id), col.lookup(id));
        }
    }

    #[test]
    fn consuming_and_borrowing_hashmap_builds_agree() {
        let mut map: crate::EntityIndex = Default::default();
        for (id, start, end) in [(7u32, 100usize, 150usize), (3, 0, 40), (9, 200, 260), (1, 41, 99)] {
            map.insert(id, (start, end));
        }
        let borrowed = ColumnarEntityIndex::from_hashmap(&map);
        let consumed = ColumnarEntityIndex::from_hashmap_consuming(map);
        for id in [0u32, 1, 3, 7, 9, 10, u32::MAX] {
            assert_eq!(borrowed.lookup(id), consumed.lookup(id), "id {id}");
        }
        assert_eq!(consumed.len(), 4);
    }
}
