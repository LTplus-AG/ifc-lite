// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One `IfcRelAggregates` parent per object across a merge (#5727, the Rust
//! twin of #5471 / `claimDecompositionParents` in
//! `packages/export/src/merged-decomposition-parents.ts`; the TS side also
//! covers `IfcRelNests` since #5726, tracked for Rust in #5802).
//!
//! `IfcObjectDefinition.Decomposes` is `SET [0:1]`, and
//! `IfcSpatialStructureElement.WR41` requires exactly one for a building or
//! storey. Once a later model's container unifies with the primary's, the
//! primary's own rel already gives it a parent, so a later rel naming the same
//! (final) id gives it a second one, whatever that rel's RelatingObject is.
//!
//! The rule runs on the FINAL line, the text actually written: references are
//! already in the merged id space, after spatial and GlobalId unification and
//! after empty-container narrowing. Every written rel records its members; in
//! a later, unified model a member already recorded is stripped, and a rel left
//! with no members is not written. A unified member with no parent yet is
//! kept, since that rel is then its only parentage statement (#3550).

use std::collections::HashSet;

use super::line_edit::{decide_line, LineDecision};
use super::plan::parse_ref_list;
use super::spatial::nth_attr;

/// Final ids that already have an aggregation parent written to the output.
#[derive(Default)]
pub(super) struct AggregationParents {
    claimed: HashSet<u32>,
}

impl AggregationParents {
    /// Decide how to write one final `IFCRELAGGREGATES` line, recording the
    /// members it writes. `dedupe` is false for the first model and for a
    /// federated one, which only record. `None`: do not write the line.
    pub(super) fn claim(&mut self, line: String, dedupe: bool) -> Option<String> {
        let members = nth_attr(&line, 5).map(parse_ref_list).unwrap_or_default();
        let redundant: HashSet<u32> = if dedupe {
            members.iter().copied().filter(|m| self.claimed.contains(m)).collect()
        } else {
            HashSet::new()
        };
        let line = if redundant.is_empty() {
            line
        } else {
            match decide_line(&line, &redundant) {
                LineDecision::Keep => line,
                LineDecision::Skip => return None,
                LineDecision::Rewrite(text) => text,
            }
        };
        self.claimed.extend(members.into_iter().filter(|m| !redundant.contains(m)));
        Some(line)
    }
}

#[cfg(test)]
#[path = "aggregates_tests.rs"]
mod tests;
