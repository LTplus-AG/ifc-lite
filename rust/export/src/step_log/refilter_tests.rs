// SPDX-License-Identifier: MPL-2.0
//! Tests for `refilter.rs`, split out under the house pattern (AGENTS.md).

use super::*;

/// #7589: a list item that is a `\S\'`-operand literal stays one item, so the
/// reference after it is its own item.
#[test]
fn list_items_keep_a_page_operand_inside_its_string_7589() {
    assert_eq!(list_items(r"'Para \S\' 5',#7, 'Art \S\' 7'"), vec![r"'Para \S\' 5'", "#7", r"'Art \S\' 7'"]);
}
