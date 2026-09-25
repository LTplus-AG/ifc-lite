// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Borrow bounded analytic occurrence lists under JavaScript object keys.

use std::collections::BTreeMap;

/// `serde-wasm-bindgen` requires string keys when maps become JS objects.
/// Convert only the IDs; the lists and their source geometry stay borrowed.
pub(super) fn string_keyed_refs<T>(
    values: &BTreeMap<u32, Vec<T>>,
) -> BTreeMap<String, &Vec<T>> {
    values.iter().map(|(id, items)| (id.to_string(), items)).collect()
}
