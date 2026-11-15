// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

#[test]
fn slot_zero_is_the_empty_string_and_interning_dedupes() {
    let mut table = StringTable::new();
    assert_eq!(table.intern(""), 0);
    assert_eq!(table.intern("IfcWall"), 1);
    assert_eq!(table.intern("IfcSlab"), 2);
    assert_eq!(table.intern("IfcWall"), 1);
}

#[test]
fn an_absent_value_is_the_null_index_not_a_slot() {
    // #4930: a STEP `$` name must read back as absent, not as ''.
    let mut table = StringTable::new();
    assert_eq!(table.intern_opt(None), NULL_INDEX);
    assert_eq!(table.intern_opt(Some("")), 0);
    assert_eq!(table.write(), StringTable::new().write(), "null adds no slot");
}

#[test]
fn layout_is_count_cumulative_offsets_then_bytes() {
    let mut table = StringTable::new();
    table.intern("ab");
    table.intern("cde");
    let bytes = table.write();
    let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    assert_eq!(word(0), 3);
    assert_eq!([word(4), word(8), word(12), word(16)], [0, 0, 2, 5]);
    assert_eq!(&bytes[20..], b"abcde");
}
