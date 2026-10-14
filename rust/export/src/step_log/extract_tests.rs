// SPDX-License-Identifier: MPL-2.0
//! Tests for `extract.rs`, split out under the house pattern (AGENTS.md).

use super::*;

/// #7589: `'Para \S\' 5'` decodes to "Para § 5" and the attributes after it
/// keep their positions; a `)` inside such a literal does not close the list.
#[test]
fn extract_entity_keeps_a_page_operand_inside_its_string_7589() {
    let (id, ty, attrs) = extract_entity(r"#1=IFCWALL('g',#2,'Para \S\' 5','Art \S\') 7',#4);").expect("a record");
    assert_eq!((id, ty.as_str()), (1, "IFCWALL"));
    assert_eq!(
        attrs,
        vec![
            JsVal::Str("g".into()),
            JsVal::Num(2.0),
            JsVal::Str("Para § 5".into()),
            JsVal::Str("Art §) 7".into()),
            JsVal::Num(4.0),
        ]
    );
}
