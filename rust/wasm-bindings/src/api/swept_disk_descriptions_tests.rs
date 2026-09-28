// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Native coverage of the optional-ID adapter; WASM serialization is tested
//! through the exported `IfcAPI` in `tests/swept_disk_descriptions.rs`.

use super::extract;

const LINE: &[u8] = include_bytes!("../../../geometry/tests/fixtures/swept_disk_trimmed_line.ifc");

#[test]
fn absent_ids_select_all_and_present_empty_ids_select_none() {
    assert!(extract(LINE, None).elements.contains_key(&50));
    let empty = extract(LINE, Some(vec![]));
    assert!(empty.elements.is_empty());
    assert!(empty.diagnostics.is_empty());
}

#[test]
fn selected_ids_are_product_ids_and_duplicates_do_not_duplicate_results() {
    let selected = extract(LINE, Some(vec![50, 50, 43]));
    assert_eq!(selected.elements.len(), 1);
    assert_eq!(selected.elements[&50].len(), 1);
    assert!(extract(LINE, Some(vec![43])).elements.is_empty());
}
