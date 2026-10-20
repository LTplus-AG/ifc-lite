// SPDX-License-Identifier: MPL-2.0
//! Tests for `refilter.rs`, split out under the house pattern (AGENTS.md).

use super::*;

/// #7589: a list item that is a `\S\'`-operand literal stays one item, so the
/// reference after it is its own item.
#[test]
fn list_items_keep_a_page_operand_inside_its_string_7589() {
    assert_eq!(list_items(r"'Para \S\' 5',#7, 'Art \S\' 7'"), vec![r"'Para \S\' 5'", "#7", r"'Art \S\' 7'"]);
}

/// #7711: a palette attachment must not retain a dangling MappedTo after a
/// crop replaces or excludes the source tessellation. Exercise both passes.
#[test]
fn issue_7711_colour_map_is_withheld_when_its_geometry_is_excluded() {
    let line = "#90=IFCINDEXEDCOLOURMAP(#42,$,#80,(1,2));";
    for schema in ["IFC4", "IFC4X3"] {
        for filtered in [
            filter_source_line(line, 90, "IFCINDEXEDCOLOURMAP", schema, &|id| id == 42, true),
            filter_created_line(line, 90, "IFCINDEXEDCOLOURMAP", schema, &|id| id == 42, true),
        ] {
            assert!(matches!(filtered, Filtered::Withhold(_)));
        }
        assert!(matches!(
            filter_source_line(line, 90, "IFCINDEXEDCOLOURMAP", schema, &|id| id == 999, true),
            Filtered::Keep
        ));
    }
}
