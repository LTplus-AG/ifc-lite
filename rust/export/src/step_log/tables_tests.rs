// SPDX-License-Identifier: MPL-2.0
//! The generated tables are searched by binary search; a generator change
//! that stopped sorting one would turn lookups into silent misses.

use crate::generated::step_log_tables::*;

fn sorted<T: PartialOrd>(v: &[T]) -> bool {
    v.windows(2).all(|w| w[0] < w[1])
}

#[test]
fn every_binary_searched_table_is_strictly_sorted() {
    assert!(sorted(&SLOT_ROWS.iter().map(|r| r.0).collect::<Vec<_>>()));
    assert!(sorted(&NOMINAL_VALUE_LEAVES.iter().map(|r| r.0).collect::<Vec<_>>()));
    assert!(sorted(TYPE_OBJECT_CLASSES));
    assert!(sorted(&RETYPE_ROWS.iter().map(|r| (r.0, r.1)).collect::<Vec<_>>()));
    assert!(sorted(&DEFINED_TYPE_BASES.iter().map(|r| r.0).collect::<Vec<_>>()));
    let nonrel: Vec<(&str, &str, u8)> = NONREL_AGGREGATE_SLOTS.iter().map(|r| (r.0, r.1, r.2)).collect();
    assert!(sorted(&nonrel));
}
