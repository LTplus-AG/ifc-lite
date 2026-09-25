// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One parent per object and single-valued decomposition inverse across a
//! merge: the Rust twin of `claimInverses` in
//! `packages/export/src/merged-inverse-claims.ts` (#5471 / #5727 for
//! `IfcRelAggregates`, #5726 / #5802 for `IfcRelNests`).
//!
//! `IfcObjectDefinition.Decomposes` is `SET [0:1]` (and, from IFC4, so is
//! `Nests`), and `IfcSpatialStructureElement.WR41` requires exactly one for a
//! building or storey. A merge unifies entities (by GlobalId, and spatially)
//! but never relationships, so once a later model's entity unifies with an
//! earlier one, the earlier model's rel already gives it a parent, and a later
//! rel naming the same (final) id gives it a second one, whatever that rel's
//! RelatingObject is.
//!
//! The rule runs on the FINAL line, the text actually written: references are
//! already in the merged id space, after spatial and GlobalId unification and
//! after empty-container narrowing. Every written rel records its members; in
//! a later, unified model a member already recorded for the same inverse is
//! stripped, and a rel left with no members is not written. A unified member
//! with no parent yet is kept, since that rel is then its only parentage
//! statement (#3550).
//!
//! Known ordering difference from the TypeScript twin: claims are made in line
//! order, while TypeScript claims every aggregation of a model before any of
//! its nests. The two can only pick a different winner in IFC2X3 output when
//! ONE later model both nests and aggregates the same unclaimed object (legal
//! only in an IFC4 source converted down); both keep exactly one `Decomposes`
//! parent, which is the invariant this module enforces.

use std::collections::{HashMap, HashSet};

use super::line_edit::{decide_line, LineDecision};
use super::plan::parse_ref_list;
use super::spatial::nth_attr;

/// The single-valued inverse `rel_type` (uppercase) fills on its
/// RelatedObjects (argument 5), in the OUTPUT schema, which decides (#5726):
/// in IFC2X3 `IfcRelAggregates` and `IfcRelNests` are both `IfcRelDecomposes`
/// and share `Decomposes : SET [0:1]`, so one nesting and one aggregation
/// parent together are already two; IFC4 and later split
/// `Nests : SET [0:1] OF IfcRelNests` off `Decomposes`.
fn inverse_of(rel_type: &str, ifc2x3: bool) -> Option<&'static str> {
    match (rel_type, ifc2x3) {
        ("IFCRELAGGREGATES", _) | ("IFCRELNESTS", true) => Some("Decomposes"),
        ("IFCRELNESTS", false) => Some("Nests"),
        _ => None,
    }
}

/// Final ids that already have a parent written to the output, per
/// single-valued inverse of the output schema. One instance per merge.
pub(super) struct ParentClaims {
    ifc2x3: bool,
    claimed: HashMap<&'static str, HashSet<u32>>,
}

impl ParentClaims {
    pub(super) fn new(ifc2x3: bool) -> Self {
        Self { ifc2x3, claimed: HashMap::new() }
    }

    /// Decide how to write one final line of type `rel_type`, recording the
    /// members it writes. `dedupe` is false for the first model and for a
    /// federated one, which only record. `None`: do not write the line.
    pub(super) fn claim(&mut self, rel_type: &str, line: String, dedupe: bool) -> Option<String> {
        let Some(inverse) = inverse_of(rel_type, self.ifc2x3) else { return Some(line) };
        let claimed = self.claimed.entry(inverse).or_default();
        let members = nth_attr(&line, 5).map(parse_ref_list).unwrap_or_default();
        let redundant: HashSet<u32> = if dedupe {
            members.iter().copied().filter(|m| claimed.contains(m)).collect()
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
        claimed.extend(members.into_iter().filter(|m| !redundant.contains(m)));
        Some(line)
    }
}

#[cfg(test)]
#[path = "single_parents_tests.rs"]
mod tests;
