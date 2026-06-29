// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Shared, read-only entity index backed by a sorted byte buffer.
//!
//! Each WASM geometry worker is a separate realm, so today every worker rebuilds
//! the [`crate::EntityIndex`] FxHashMap from the source bytes — on a 12.6 M-entity
//! / 722 MB model that is ~7 s and ~350 MB EACH (×N workers). This is the
//! cross-worker form: the prepass builds the bytes ONCE
//! ([`build_shared_entity_index_bytes`]), the orchestrator hands the same
//! `SharedArrayBuffer` to every worker, and each worker views it zero-copy and
//! binary-searches it. A spike on the 722 MB model measured the build at ~2 s
//! native (~7 s wasm), the buffer at 152 MB (vs 3×354 MB hashmaps), and the
//! binary-search lookup at ~24 ns (1.8× a hashmap get — negligible).

use crate::parser::EntityScanner;
use std::sync::Arc;

/// One entry: `id` (u32) + `start` (u32) + `end` (u32), little-endian.
const ENTRY: usize = 12;

/// A read-only entity index over a shared, id-sorted buffer of `(id, start, end)`
/// u32 triples. Cheap to clone (`Arc`); lookups are `O(log n)` binary search.
#[derive(Clone)]
pub struct SharedEntityIndex {
    /// id-sorted, packed `(id, start, end)` LE u32 triples.
    data: Arc<[u8]>,
}

impl SharedEntityIndex {
    /// Wrap a pre-built, id-sorted triple buffer (see [`build_shared_entity_index_bytes`]).
    /// The buffer length must be a multiple of 12; a non-conforming buffer yields
    /// an empty index (all lookups miss) rather than panicking.
    pub fn from_bytes(data: Arc<[u8]>) -> Self {
        if data.len() % ENTRY != 0 {
            return Self { data: Arc::from(&[][..]) };
        }
        Self { data }
    }

    /// Number of indexed entities.
    #[inline]
    pub fn len(&self) -> usize {
        self.data.len() / ENTRY
    }

    /// Whether the index has no entries.
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.data.len() < ENTRY
    }

    #[inline]
    fn id_at(&self, i: usize) -> u32 {
        let o = i * ENTRY;
        u32::from_le_bytes([self.data[o], self.data[o + 1], self.data[o + 2], self.data[o + 3]])
    }

    #[inline]
    fn span_at(&self, i: usize) -> (usize, usize) {
        let o = i * ENTRY;
        let start =
            u32::from_le_bytes([self.data[o + 4], self.data[o + 5], self.data[o + 6], self.data[o + 7]]);
        let end =
            u32::from_le_bytes([self.data[o + 8], self.data[o + 9], self.data[o + 10], self.data[o + 11]]);
        (start as usize, end as usize)
    }

    /// Binary-search for `id`, returning its `(start, end)` byte span.
    #[inline]
    pub fn get(&self, id: u32) -> Option<(usize, usize)> {
        let mut lo = 0usize;
        let mut hi = self.len();
        while lo < hi {
            let mid = lo + (hi - lo) / 2;
            let mid_id = self.id_at(mid);
            match mid_id.cmp(&id) {
                std::cmp::Ordering::Equal => return Some(self.span_at(mid)),
                std::cmp::Ordering::Less => lo = mid + 1,
                std::cmp::Ordering::Greater => hi = mid,
            }
        }
        None
    }
}

/// Build the shared-index byte buffer for `content`: scan every entity, collect
/// `(id, start, end)`, sort by id, and pack as LE u32 triples — the form a
/// [`SharedEntityIndex`] reads.
///
/// Returns an EMPTY buffer if any byte offset would overflow u32 (content ≥ 4 GiB).
/// That can't happen on wasm32 (4 GiB address space), and callers treat an empty
/// buffer as "no shared index" and fall back to the owned FxHashMap, so the
/// contract degrades safely rather than truncating offsets.
///
/// Entity ids are unique in valid STEP, matching the FxHashMap's keying. On a
/// malformed file with duplicate ids the hashmap keeps the last insert while this
/// returns an arbitrary one; valid files are byte-identical.
pub fn build_shared_entity_index_bytes<T>(content: &T) -> Vec<u8>
where
    T: AsRef<[u8]> + ?Sized,
{
    let content = content.as_ref();
    if content.len() > u32::MAX as usize {
        return Vec::new();
    }
    let estimated = content.len() / 50;
    let mut entries: Vec<(u32, u32, u32)> = Vec::with_capacity(estimated);
    let mut scanner = EntityScanner::new(content);
    while let Some((id, _ty, start, end)) = scanner.next_entity() {
        entries.push((id, start as u32, end as u32));
    }
    serialize_sorted_triples(entries)
}

/// Build the shared-index bytes from an already-built [`crate::EntityIndex`]
/// (FxHashMap) — no content re-scan. Use this where the owned index already
/// exists (e.g. the prepass) so sharing costs only a sort + serialize, not a
/// second scan. Produces the same bytes as [`build_shared_entity_index_bytes`].
///
/// Returns an EMPTY buffer if any offset would overflow u32 (content ≥ 4 GiB),
/// matching the scan-based builder's degrade-to-owned contract.
pub fn build_shared_entity_index_bytes_from_map(index: &crate::EntityIndex) -> Vec<u8> {
    let mut entries: Vec<(u32, u32, u32)> = Vec::with_capacity(index.len());
    for (&id, &(start, end)) in index.iter() {
        if start > u32::MAX as usize || end > u32::MAX as usize {
            return Vec::new();
        }
        entries.push((id, start as u32, end as u32));
    }
    serialize_sorted_triples(entries)
}

/// Sort `(id, start, end)` triples by id and pack them as LE u32 — the layout
/// [`SharedEntityIndex`] binary-searches. Sorting here keeps both builders honest.
fn serialize_sorted_triples(mut entries: Vec<(u32, u32, u32)>) -> Vec<u8> {
    entries.sort_unstable_by_key(|e| e.0);
    let mut out = Vec::with_capacity(entries.len() * ENTRY);
    for (id, start, end) in entries {
        out.extend_from_slice(&id.to_le_bytes());
        out.extend_from_slice(&start.to_le_bytes());
        out.extend_from_slice(&end.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build_entity_index;

    // Ids deliberately out of file order (#10 before #3) so the sort + binary
    // search is actually exercised, and the spans are non-trivial.
    const SAMPLE: &str = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n\
#1=IFCWALL('guid1',$,'W1');\n\
#2=IFCSLAB('guid2',$,'S1');\n\
#10=IFCOPENINGELEMENT('guid3',$,'O1');\n\
#3=IFCCARTESIANPOINT((0.,0.,0.));\n\
#42=IFCPOLYLOOP((#3,#3,#3));\n\
ENDSEC;\nEND-ISO-10303-21;\n";

    fn shared(content: &str) -> SharedEntityIndex {
        let bytes = build_shared_entity_index_bytes(content);
        SharedEntityIndex::from_bytes(Arc::from(bytes.into_boxed_slice()))
    }

    #[test]
    fn shared_index_matches_hashmap_for_every_id() {
        let map = build_entity_index(SAMPLE);
        let s = shared(SAMPLE);
        assert_eq!(s.len(), map.len(), "entity count must match the FxHashMap");
        for (&id, &(start, end)) in map.iter() {
            assert_eq!(s.get(id), Some((start, end)), "span mismatch for #{id}");
            // And the span actually points at this entity's record.
            assert!(SAMPLE.as_bytes()[start..end].starts_with(format!("#{id}=").as_bytes()));
        }
        assert_eq!(s.get(9999), None, "absent id must miss");
        assert_eq!(map.get(&9999), None);
    }

    #[test]
    fn from_map_matches_from_content() {
        let map = build_entity_index(SAMPLE);
        let from_content = build_shared_entity_index_bytes(SAMPLE);
        let from_map = build_shared_entity_index_bytes_from_map(&map);
        assert_eq!(from_content, from_map, "from_map must produce identical sorted bytes");
    }

    #[test]
    fn out_of_order_ids_resolve_via_binary_search() {
        let s = shared(SAMPLE);
        for id in [1u32, 2, 3, 10, 42] {
            assert!(s.get(id).is_some(), "#{id} must resolve");
        }
    }

    #[test]
    fn malformed_buffer_yields_empty_index() {
        let s = SharedEntityIndex::from_bytes(Arc::from(vec![1u8, 2, 3].into_boxed_slice()));
        assert_eq!(s.len(), 0);
        assert!(s.is_empty());
        assert_eq!(s.get(1), None);
    }

    #[test]
    fn empty_content_yields_empty_index() {
        let s = shared("");
        assert_eq!(s.len(), 0);
        assert_eq!(s.get(1), None);
    }
}
