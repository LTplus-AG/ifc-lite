// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `columnar_index.rs`.
//!
//! Split out per the repo convention for modules whose bulk is test code
//! (see `rust/core/src/georef.rs` / `georef_tests.rs`), which also keeps
//! `columnar_index.rs` inside its module-size ratchet budget.

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
fn adjacent_duplicate_ids_do_not_take_the_sorted_fast_path() {
    // `is_strictly_ascending` gates `from_columns`'s fast path (adopt the
    // columns as-is, no dedup) vs the slow path (`from_unsorted`, which
    // collapses duplicates last-wins). Ids that are non-decreasing but NOT
    // strictly increasing (an adjacent duplicate, e.g. two entities sharing
    // an express id back-to-back) must still take the slow path: `< ` not
    // `<=` in the ascending check. A `<=` mutation here survives every
    // other fixture in this module because none of them puts a duplicate
    // id in an ALREADY-SORTED, ADJACENT position.
    let ids = [1u32, 1, 5];
    let starts = [10u32, 20, 30];
    let lengths = [1u32, 2, 3];
    let idx = ColumnarEntityIndex::from_columns(&ids, &starts, &lengths);
    assert_eq!(idx.len(), 2, "adjacent duplicate id must be deduped, not adopted as-is");
    // Last-in-input-order wins, matching the hashmap/`from_unsorted` contract.
    assert_eq!(idx.lookup(1), Some((20, 22)));
    assert_eq!(idx.lookup(5), Some((30, 33)));
    assert_eq!(idx.ids(), &[1, 5]);
}

#[test]
fn empty_and_mismatched_columns_are_empty() {
    assert!(ColumnarEntityIndex::from_columns(&[], &[], &[]).is_empty());
    assert!(ColumnarEntityIndex::from_columns(&[1, 2], &[0], &[0, 0]).is_empty());
}

#[test]
fn from_hashmap_matches_lookup() {
    // #1 is redefined later (duplicate express id): both the hashmap path
    // (`HashMap::insert` overwrite) and the scan path (`from_unsorted`'s
    // last-in-file-order-wins) must resolve it to the SECOND span, not the
    // first — otherwise this fixture couldn't tell the two dedup
    // mechanisms apart (see `duplicate_id_last_wins`, which pins
    // `from_unsorted` alone but not its agreement with the hashmap path).
    let content = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n\
        #1=IFCCARTESIANPOINT((0.,0.,0.));\n\
        #7=IFCCARTESIANPOINT((1.,2.,3.));\n\
        #1=IFCCARTESIANPOINT((9.,9.,9.));\n\
        ENDSEC;\nEND-ISO-10303-21;\n";
    let map = crate::build_entity_index(content);
    let col = ColumnarEntityIndex::from_hashmap(&map);
    assert_eq!(col.len(), 2, "duplicate #1 must collapse to one entry");
    assert_eq!(col.len(), map.len());
    for (&id, &(s, e)) in map.iter() {
        assert_eq!(col.lookup(id), Some((s, e)));
    }
    // Pin the actual resolution, not just cross-path agreement: both paths
    // agreeing on the WRONG (first) span would still pass a mere equality
    // check between them.
    let (start_1, end_1) = col.lookup(1).unwrap();
    assert_eq!(&content.as_bytes()[start_1..end_1], b"#1=IFCCARTESIANPOINT((9.,9.,9.));");

    // A scan-built index must agree byte-for-byte with the hashmap one.
    let scanned = ColumnarEntityIndex::from_scan(content);
    assert_eq!(scanned.ids(), col.ids());
    assert_eq!(scanned.starts(), col.starts());
    assert_eq!(scanned.lengths(), col.lengths());
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
