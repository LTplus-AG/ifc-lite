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

/// How many values an IFC2X3 IfcRelSpaceBoundary with no RelatedBuildingElement carries (the ones its omission
/// loses), or `None` when `line` is not one, or the export is not an upgrade to a schema that requires the element.
fn unrelated(line: &str, from: &str, to: &str) -> Option<usize> {
    if from != "IFC2X3" || !matches!(to, "IFC4" | "IFC4X3") { return None; }
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
    if from != "IFC2X3" || !matches!(to, "IFC4" | "IFC4X3") { return HashSet::new(); }
    records.filter(|(_, line)| unrelated(line, from, to).is_some()).map(|(id, _)| id).collect()
}

#[derive(Default)]
pub(crate) struct SpaceBoundaryElements {
    dropped: BTreeSet<u32>,
}

impl SpaceBoundaryElements {
    /// Whether the export writes `line`, a source-schema record. An unreadable
    /// record, or one whose arity is not IFC2X3's, is never judged.
    pub(crate) fn apply(&mut self, id: u32, line: &str, from: &str, to: &str, dropped: &mut usize) -> bool {
        match unrelated(line, from, to) {
            Some(values) => { *dropped += values; self.dropped.insert(id); false }
            None => true,
        }
    }
    pub(crate) fn warnings(&self) -> Vec<String> {
        if self.dropped.is_empty() { return Vec::new(); }
        let sites: Vec<String> = self.dropped.iter().map(|id| format!("#{id}")).collect();
        vec![format!(
            "{} IfcRelSpaceBoundary record(s) were not written: IFC4 requires RelatedBuildingElement and the source names none: {}.",
            self.dropped.len(),
            sites.join(", ")
        )]
    }
}

#[cfg(test)]
#[path = "schema_space_boundary_tests.rs"]
mod tests;
