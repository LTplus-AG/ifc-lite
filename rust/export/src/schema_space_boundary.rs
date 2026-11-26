// SPDX-License-Identifier: MPL-2.0
//! An IfcRelSpaceBoundary that names no element, on an IFC2X3 upgrade.
//!
//! IFC2X3 declares `RelatedBuildingElement` OPTIONAL, and a VIRTUAL boundary
//! (a space limit with nothing physical behind it) leaves it `$`. IFC4 and
//! IFC4X3 declare it MANDATORY, and their `CorrectPhysOrVirt` rule wants an
//! IfcVirtualElement (or IfcOpeningElement) behind a VIRTUAL boundary. Neither
//! a `$` nor a demotion to .NOTDEFINED can satisfy that, and the converter
//! invents no entity or reference, so the boundary is not written
//! (`convert_step_line` returns an empty line, which every STEP writer skips),
//! its values are counted dropped and the export names it. A boundary that
//! names an element is untouched. Twin of
//! `packages/export/src/schema-converter-space-boundary.ts`.
use std::collections::{BTreeSet, HashSet};
use crate::schema_structural_links::slot_unset;
use crate::step_record_frame::{record_frame, record_head};
use crate::step_slot::slots_of;

const BOUNDARY: &str = "IFCRELSPACEBOUNDARY";
const ELEMENT: &str = "RelatedBuildingElement";

/// Whether a `from` -> `to` export upgrades IfcRelSpaceBoundary to a schema that requires its element.
fn requires_element(from: &str, to: &str) -> bool { from == "IFC2X3" && matches!(to, "IFC4" | "IFC4X3") }

/// How many values an IFC2X3 IfcRelSpaceBoundary with no RelatedBuildingElement carries (the ones its omission
/// loses), or `None` when `line` is not one, or the export is not an upgrade to a schema that requires the element.
fn unrelated(line: &str, from: &str, to: &str) -> Option<usize> {
    if !requires_element(from, to) { return None; }
    let head = record_head(line)?;
    if !head.type_name(line).eq_ignore_ascii_case(BOUNDARY) { return None; }
    let names = crate::schema_convert::schema_attribute_names(from, BOUNDARY)?;
    let at = names.iter().position(|a| *a == ELEMENT)?;
    // The line converter also accepts a record without its terminating semicolon.
    let padded;
    let (text, frame) = match record_frame(line) {
        Some(frame) => (line, Some(frame)),
        None => { padded = format!("{line};"); (padded.as_str(), record_frame(&padded)) }
    };
    let slots = frame.and_then(|frame| slots_of(frame.args(text)))?;
    if slots.len() != names.len() || crate::schema_convert::holds_value(slots[at]) { return None; }
    Some(slots.iter().filter(|s| !slot_unset(s)).count())
}

/// The boundaries of `records`, `(id, source text)` pairs, that an upgrade `from` -> `to` leaves out. Known before any
/// record is written, so the relationships naming them can be scrubbed of them (#11457).
pub(crate) fn left_out<'a>(records: impl Iterator<Item = (u32, std::borrow::Cow<'a, str>)>, from: &str, to: &str) -> HashSet<u32> {
    if !requires_element(from, to) { return HashSet::new(); }
    records.filter(|(_, line)| unrelated(line, from, to).is_some()).map(|(id, _)| id).collect()
}

/// The boundaries an IFC2X3 upgrade leaves out (#11457): known before any record is written, so a relationship naming
/// one is narrowed, or withheld when nothing is left, instead of shipping a dangling reference. An edited boundary, one
/// a property edit gives a generated set, or one a copy-on-write repoints, is written as before (`restrict`).
pub(crate) fn plain_left_out(opts: &crate::StepOptions, content: &[u8], index: &crate::step_index::RecordIndex, included: &HashSet<u32>,
    edited: &std::collections::HashMap<u32, std::collections::BTreeMap<usize, String>>, from: &str, to: &str) -> HashSet<u32> {
    let hosts: HashSet<u32> = opts.property_mutations.iter().map(|m| m.express_id).chain(opts.copy_on_write.iter().map(|c| c.referrer_id)).collect();
    left_out(
        index.order.iter().filter(|id| included.contains(id) && !edited.contains_key(id) && !hosts.contains(id))
            .filter_map(|id| index.spans.get(id).map(|&(s, e)| (*id, String::from_utf8_lossy(&content[s..e])))),
        crate::schema_convert::canon(from), crate::schema_convert::canon(to))
}

#[derive(Default)]
pub(crate) struct SpaceBoundaryElements {
    dropped: BTreeSet<u32>,
    /// Set by [`Self::restrict`]: the writer listed what it leaves out up front, and only those are left out.
    only: Option<HashSet<u32>>,
}

impl SpaceBoundaryElements {
    /// Whether the export writes `line`, a source-schema record. An unreadable
    /// record, or one whose arity is not IFC2X3's, is never judged.
    pub(crate) fn apply(&mut self, id: u32, line: &str, from: &str, to: &str, dropped: &mut usize) -> bool {
        match unrelated(line, from, to) {
            Some(_) if self.only.as_ref().is_some_and(|only| !only.contains(&id)) => true,
            Some(values) => { *dropped += values; self.dropped.insert(id); false }
            None => true,
        }
    }
    /// Leave out only the boundaries in `ids`, the ones [`left_out`] judged before any record was written: an edited
    /// or created boundary is written as before, so no referrer names a record that is not there (#11457).
    pub(crate) fn restrict(&mut self, ids: &HashSet<u32>) { self.only = Some(ids.clone()); }
    /// The ids `apply` left out, in the id space the writer passed.
    pub(crate) fn ids(&self) -> impl Iterator<Item = u32> + '_ { self.dropped.iter().copied() }
    pub(crate) fn warnings(&self) -> Vec<String> {
        if self.dropped.is_empty() { return Vec::new(); }
        let sites: Vec<String> = self.dropped.iter().map(|id| format!("#{id}")).collect();
        vec![format!(
            "{} IfcRelSpaceBoundary record(s) were not written: IFC4 and IFC4X3 require RelatedBuildingElement and the source names none: {}.",
            self.dropped.len(),
            sites.join(", ")
        )]
    }
}

#[cfg(test)]
#[path = "schema_space_boundary_tests.rs"]
mod tests;
