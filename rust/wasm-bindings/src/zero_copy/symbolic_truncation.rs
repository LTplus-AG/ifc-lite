/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! The truncation surface of [`SymbolicRepresentationCollection`].
//!
//! Split out of `symbolic.rs` rather than raising that file's ratchet budget:
//! the budget exists so a god-file cannot grow one accessor at a time, and
//! "the new field needed a getter" is exactly the increment it is meant to
//! refuse. These read one field and belong together (#2938).

use super::symbolic::SymbolicRepresentationCollection;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl SymbolicRepresentationCollection {
    /// Primitive count at which extraction stopped, else `undefined`.
    #[wasm_bindgen(getter, js_name = truncatedAt)]
    pub fn truncated_at(&self) -> Option<usize> {
        self.truncated.as_ref().map(|t| t.emitted)
    }

    /// Which bound stopped extraction, else `undefined`. One of
    /// `element-count`, `output-bytes`, `item-depth`, `item-revisits` —
    /// the same kebab-case strings the JSON path emits, so a consumer reading
    /// either surface reads one vocabulary.
    #[wasm_bindgen(getter, js_name = truncatedReason)]
    pub fn truncated_reason(&self) -> Option<String> {
        self.truncated
            .as_ref()
            .map(|t| t.reason.as_wire_str().to_string())
    }

    /// The bound's numeric value, when the reason has one, else `undefined`.
    /// Absent for the per-item reasons, whose bound is per item and not
    /// comparable with `truncatedAt`.
    #[wasm_bindgen(getter, js_name = truncatedLimit)]
    pub fn truncated_limit(&self) -> Option<usize> {
        self.truncated.as_ref().and_then(|t| t.limit)
    }
}
