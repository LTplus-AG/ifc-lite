// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

#[test]
fn compact_builder_preserves_index_last_occurrence_and_sparse_ids() {
    for source in [
        "DATA;#2=IFCWALL('old');#0=IFCWALL();#1=IFCWALL();#2=IFCBEAM('last');",
        "DATA;#4294967295=IFCWALL();#3=IFCBEAM('old');#3=IFCBEAM('last');",
    ] {
        let expected = ifc_lite_core::build_entity_index(source);
        let mut builder = IndexBuilder::Compact { pages: Vec::new(), len: 0, max_rows: PAGE_ROWS * 2 };
        let mut scan = ifc_lite_core::EntityScanner::new(source);
        while let Some((id, _, start, end)) = scan.next_entity() { builder.insert(id, (start, end)); }
        let index = builder.finish();
        let mut decoder = index.decoder(source.as_bytes());
        for (id, (start, end)) in expected {
            assert_eq!(decoder.get_raw_bytes(id), Some(&source.as_bytes()[start..end]));
        }
        assert!(decoder.decode_by_id(123).is_err());
    }
}

#[test]
fn compact_builder_crosses_pages_without_losing_rows() {
    let mut builder = IndexBuilder::Compact { pages: Vec::new(), len: 0, max_rows: PAGE_ROWS * 2 };
    for id in 0..(PAGE_ROWS as u32 + 3) { builder.insert(id, (id as usize * 10, id as usize * 10 + 5)); }
    let ProcessingIndex::Dense(index) = builder.finish() else { panic!("dense ids should select direct lookup") };
    for id in 0..(PAGE_ROWS as u32 + 3) {
        assert_eq!(index.lookup(id), Some((id as usize * 10, id as usize * 10 + 5)));
    }
}

#[test]
fn native_wide_offsets_keep_the_hash_representation() {
    #[cfg(target_pointer_width = "64")]
    {
        assert!(!compact_eligible(u32::MAX as usize + 1));
        let mut builder = IndexBuilder::Hash(FxHashMap::default());
        let span = (u32::MAX as usize + 10, u32::MAX as usize + 20);
        builder.insert(1, span);
        let ProcessingIndex::Hash(index) = builder.finish() else { panic!("wide offsets must not narrow") };
        assert_eq!(index.get(&1), Some(&span));
    }
}

// PR #3921: malformed short records must not grow staging with duplicate count.
#[test]
fn duplicate_heavy_input_bounds_rows_and_keeps_the_last_authored_span() {
    let source_len = 32 * 1024 * 1024;
    let budget = source_len / 50;
    let mut builder = IndexBuilder::new(source_len, true);
    for row in 0..budget * 2 {
        builder.insert((row % 3) as u32, (row * 10, row * 10 + 5));
        if let IndexBuilder::Compact { len, pages, .. } = &builder {
            assert!(*len <= budget);
            assert!(pages.iter().map(Vec::capacity).sum::<usize>() <= budget + PAGE_ROWS);
        }
    }
    let ProcessingIndex::Hash(index) = builder.finish() else { panic!("dense records must leave bounded staging") };
    assert_eq!(index.len(), 3);
    for row in budget * 2 - 3..budget * 2 {
        assert_eq!(index.get(&((row % 3) as u32)), Some(&(row * 10, row * 10 + 5)));
    }
}

#[test]
fn staging_budget_transition_preserves_unique_and_sparse_ids() {
    let mut builder = IndexBuilder::Compact { pages: Vec::new(), len: 0, max_rows: 2 };
    builder.insert(0, (0, 0));
    builder.insert(u32::MAX, (11, 17));
    builder.insert(42, (20, 24));
    builder.insert(u32::MAX, (30, 38));
    let ProcessingIndex::Hash(index) = builder.finish() else { panic!("budget transition must coalesce directly") };
    assert_eq!(index.len(), 3);
    assert_eq!(index.get(&0), Some(&(0, 0)));
    assert_eq!(index.get(&42), Some(&(20, 24)));
    assert_eq!(index.get(&u32::MAX), Some(&(30, 38)));
}
