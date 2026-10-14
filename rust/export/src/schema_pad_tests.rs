// SPDX-License-Identifier: MPL-2.0
//! Tests for `schema_pad.rs`, split out under the house pattern (AGENTS.md).

use super::*;

/// #7589: a `\S\'` operand does not end the literal, so the comma between two
/// such strings is a real attribute boundary.
#[test]
fn count_top_level_attributes_keeps_a_page_operand_inside_its_string_7589() {
    assert_eq!(count_top_level_attributes(r"'g',#2,'Para \S\' 5','Art \S\' 7',#4"), 5);
}
