// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The styled-item index finds wrappers and styled items in one scan
//! (PROCESSING-SYM-18) and must still unwrap a presentation-style assignment
//! authored after the styled item that names it.

use super::build_styled_item_index;
use ifc_lite_core::{build_entity_index, EntityDecoder};

fn index(step: &str) -> std::collections::HashMap<u32, Vec<u32>> {
    let content = step.as_bytes();
    let mut decoder = EntityDecoder::with_index(content, build_entity_index(content));
    build_styled_item_index(content, &mut decoder)
}

#[test]
fn wrappers_unwrap_in_either_file_order_and_items_keep_file_order() {
    let styled = index(concat!(
        // Forward reference: the wrapper follows its styled item.
        "#1=IFCSTYLEDITEM(#100,(#2),$);",
        "#2=IFCPRESENTATIONSTYLEASSIGNMENT((#10,#11));",
        // A second styled item on the same item appends in file order.
        "#3=IFCSTYLEDITEM(#100,(#12),$);",
        // Backward reference, mixed with a direct style ref.
        "#4=IFCPRESENTATIONSTYLEASSIGNMENT((#13));",
        "#5=IFCSTYLEDITEM(#101,(#4,#14),$);",
        // An empty wrapper has no refs, so its raw ref stays as authored.
        "#6=IFCPRESENTATIONSTYLEASSIGNMENT(());",
        "#7=IFCSTYLEDITEM(#102,(#6),$);",
        // A styled item without styles adds nothing.
        "#8=IFCSTYLEDITEM(#103,(),$);",
    ));
    assert_eq!(styled.get(&100), Some(&vec![10, 11, 12]));
    assert_eq!(styled.get(&101), Some(&vec![13, 14]));
    assert_eq!(styled.get(&102), Some(&vec![6]));
    assert_eq!(styled.get(&103), None);
    assert_eq!(styled.len(), 3);
}
