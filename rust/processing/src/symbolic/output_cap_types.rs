// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Diagnostics wire types for [`super::output_cap::SymbolicAccumulator`].
//!
//! Split out of `output_cap.rs` rather than kept inline: that file sits at
//! its 400-line ratchet ceiling, and these types are self-contained wire
//! shapes with no dependency on the accumulator's push/charge logic, so they
//! move without disturbing the policy they describe.

use serde::{Deserialize, Serialize};

/// Which bound stopped an extraction early.
///
/// `SymbolicData` had no diagnostics channel at all (#2938), so a drawing that
/// lost 60% of its curves was indistinguishable, in the response, from one that
/// legitimately had nothing more to emit.
///
/// The reason matters as much as the fact. #2938's own lead case is a
/// well-formed nested block import losing content to the PER-ITEM revisit
/// budget while the whole-file totals sit far below the extraction bounds --
/// so a diagnostic that only reported the extraction bounds would have reported
/// nothing on the exact scenario the issue is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SymbolicTruncationReason {
    /// [`super::output_cap::MAX_SYMBOLIC_ELEMENTS`] reached.
    ElementCount,
    /// [`super::output_cap::MAX_SYMBOLIC_BYTES`] reached.
    OutputBytes,
    /// One representation item nested deeper than the walk follows.
    ItemDepth,
    /// The EXTRACTION exhausted its revisit budget: a large acyclic fan-out,
    /// or a legitimate deeply-nested block import.
    ///
    /// Shared across the whole file since #3114, not per item -- a per-item
    /// budget reset on every top-level item, so nothing bounded a fan-out
    /// spread across many items. The name is kept for wire compatibility.
    /// Note the budget is extraction-wide while `ItemWalk::seen` stays per
    /// item, so re-placing one library block is not charged as a revisit.
    ItemRevisits,
    /// The walk's path guard (`ItemWalk::enter_node`) refused to re-enter a
    /// node already on the current path -- a genuine cycle in the
    /// representation graph, not merely a large fan-out. Distinct from
    /// [`Self::ItemRevisits`], whose budget can also be exhausted by an
    /// acyclic file (#2938's lead case); this reason is a cycle and nothing
    /// else (#3108).
    ItemCycle,
}

impl SymbolicTruncationReason {
    /// The wire spelling, identical to what `Serialize` emits.
    ///
    /// The WASM boundary cannot hand a serde enum to JavaScript, so it needs a
    /// plain string; having it here rather than a `match` in wasm-bindings keeps
    /// one vocabulary for both surfaces. `the_wire_spellings_match_serde` pins
    /// them together, because two hand-kept lists is how they drift.
    pub fn as_wire_str(self) -> &'static str {
        match self {
            Self::ElementCount => "element-count",
            Self::OutputBytes => "output-bytes",
            Self::ItemDepth => "item-depth",
            Self::ItemRevisits => "item-revisits",
            Self::ItemCycle => "item-cycle",
        }
    }
}

/// What stopped an extraction early, when something did.
///
/// Present only on a truncated result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SymbolicTruncation {
    /// The MOST SEVERE bound that fired, not the first: an extraction bound
    /// outranks a per-item one whatever the scan order. See
    /// `SymbolicAccumulator::record`.
    pub reason: SymbolicTruncationReason,
    /// Primitives emitted in total. NOT necessarily equal to any limit: a
    /// traversal bound stops content from being produced while the file-level
    /// totals stay far below the extraction bounds.
    pub emitted: usize,
    /// The bound's value, when the reason has a single numeric one. `None` for
    /// the traversal reasons, whose bounds count a DIFFERENT UNIT from
    /// `emitted` -- revisits and nesting depth, not primitives -- so there is
    /// no meaningful "{emitted} of {limit}" to render.
    ///
    /// Note this is no longer because those bounds are per item: since #3114
    /// the revisit budget is extraction-wide. It is the units that do not
    /// line up, and that is what keeps `limit` absent.
    ///
    /// Skipped rather than serialized as `null`: the TypeScript mirror declares
    /// `limit?: number`, which means the key is ABSENT. Emitting `null` satisfies
    /// Rust and breaks the consumer's `'limit' in truncated` check.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}
