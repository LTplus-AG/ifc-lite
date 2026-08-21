/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! The truncation surface of [`SymbolicRepresentationCollection`].
//!
//! Also home to the reasoning behind `is_empty`'s truncation guard: a per-item
//! bound can fire having emitted nothing, so a truncated collection can hold no
//! primitives at all. A consumer that skips an "empty" collection would then
//! discard the only signal the browser gets that its drawing is clipped, since
//! geometry is client-side only. `SymbolicData::is_empty` in
//! `ifc-lite-processing` already refuses to call a truncated result empty; the
//! test below pins the two together rather than trusting two definitions to
//! stay in step.
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

#[cfg(test)]
mod tests {
    use super::SymbolicRepresentationCollection;
    use ifc_lite_processing::{
        SymbolicData, SymbolicTruncation, SymbolicTruncationReason,
    };

    fn truncated_but_empty() -> SymbolicData {
        // A per-item bound can fire having emitted nothing at all: the walk
        // refuses one representation item and the file contributes no
        // primitives. That is the shape this guard exists for.
        SymbolicData {
            truncated: Some(SymbolicTruncation {
                reason: SymbolicTruncationReason::ItemRevisits,
                emitted: 0,
                limit: None,
            }),
            ..SymbolicData::default()
        }
    }

    /// `is_empty` decides whether a consumer keeps the collection at all, so
    /// the two implementations disagreeing means the browser drops a
    /// diagnostic the server keeps. Assert PARITY, not each side separately:
    /// two independently-correct-looking definitions is exactly how they
    /// drifted in the first place.
    #[test]
    fn is_empty_agrees_with_the_processing_side_for_a_truncated_but_empty_result() {
        let data = truncated_but_empty();
        let expected = data.is_empty();
        let collection = SymbolicRepresentationCollection::from_data(data);

        assert!(
            !expected,
            "SymbolicData::is_empty must not call a truncated result empty"
        );
        assert_eq!(
            collection.is_empty(),
            expected,
            "the WASM collection must agree with SymbolicData::is_empty, or a \
             consumer that skips an empty collection silently discards the \
             truncation diagnostic (geometry is client-side only, so this is \
             the browser's only signal the drawing is clipped)"
        );
        // The diagnostic the guard protects is actually reachable.
        assert_eq!(collection.truncated_reason().as_deref(), Some("item-revisits"));
    }

    #[test]
    fn a_genuinely_complete_and_empty_result_is_still_empty() {
        // The other direction, so "always false" is not a passing fix.
        let data = SymbolicData::default();
        assert!(data.is_empty());
        let collection = SymbolicRepresentationCollection::from_data(data);
        assert!(collection.is_empty());
        assert_eq!(collection.truncated_reason(), None);
    }
}
