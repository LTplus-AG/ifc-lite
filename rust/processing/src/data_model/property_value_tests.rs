// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

/// CORE-4 (#7776): a member that is a list of two strings is not a typed
/// value. It stringified as its second item, as the typed `IFCLABEL('x')` does.
#[test]
fn a_two_string_list_member_is_not_a_typed_value_core_4_7776() {
    let text = |t: &str| AttributeValue::String(t.to_owned());
    let typed = AttributeValue::Typed { name: "IFCLABEL".into(), value: Box::new(text("x")) };
    let pair = AttributeValue::List(vec![text("a"), text("b")]);
    let members = AttributeValue::List(vec![typed.clone(), pair]);
    assert_eq!(
        super::member_list(Some(&members)),
        Some(vec!["x".to_owned()]),
        "the pair is no scalar member"
    );
    assert_eq!(super::infer_data_type(Some(&typed)).as_deref(), Some("IFCLABEL"));
    assert_eq!(
        super::infer_data_type(Some(&AttributeValue::List(vec![text("a"), text("b")]))),
        None
    );
}
