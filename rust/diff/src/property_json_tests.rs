// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::stringify_property_sorted;
use crate::input::PropertyValue as P;
use crate::js_json::{stringify_sorted, JsonValue as J};
use crate::JsString;

#[test]
fn composite_writer_preserves_existing_json_bytes_9331() {
    // UTF-16 ordering, duplicate keys, non-finite nested numbers, negative zero,
    // escaped lone surrogates and control characters retain the old contract.
    let key = JsString::from_units(vec![0xd800]);
    let raw = P::Object(vec![
        ("z".into(), P::Number(f64::INFINITY)),
        ("a".into(), P::Array(vec![P::Number(-0.0), P::String("\n\t\\\"".into()), P::Bool(true), P::Null])),
        (key.clone(), P::String(key.clone())),
        ("a".into(), P::Number(1e21)),
    ]);
    let old = J::Object(vec![
        ("z".into(), J::Number(f64::INFINITY)),
        ("a".into(), J::Array(vec![J::Number(-0.0), J::String("\n\t\\\"".into()), J::Bool(true), J::Null])),
        (key.clone(), J::String(key)),
        ("a".into(), J::Number(1e21)),
    ]);
    assert_eq!(stringify_property_sorted(&raw), stringify_sorted(&old));
}
