// SPDX-License-Identifier: MPL-2.0
//! Tests for `lines.rs`, split out under the house pattern (AGENTS.md).

use super::*;

/// #7589: the slot grammar accepts a `\S\'`-operand literal as one value, so a
/// record carrying one still reads as slots (and a slot after it is writable).
#[test]
fn read_slots_keeps_a_page_operand_inside_its_string_7589() {
    let line = r"#1=IFCWALL('g',#2,'Para \S\' 5',IFCLABEL('Art \S\' 7'),#4);";
    let slots = read_slots(line).expect("readable slots");
    assert_eq!(slots, vec!["'g'", "#2", r"'Para \S\' 5'", r"IFCLABEL('Art \S\' 7')", "#4"]);
    assert_eq!(
        replace_argument(line, 4, "#40").as_deref(),
        Some(r"#1=IFCWALL('g',#2,'Para \S\' 5',IFCLABEL('Art \S\' 7'),#40);")
    );
}
