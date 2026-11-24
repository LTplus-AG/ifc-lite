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
use std::collections::BTreeSet;
use crate::schema_structural_links::slot_unset;
use crate::step_record_frame::{record_frame, record_head};
use crate::step_slot::slots_of;

const BOUNDARY: &str = "IFCRELSPACEBOUNDARY";
const ELEMENT: &str = "RelatedBuildingElement";

#[derive(Default)]
pub(crate) struct SpaceBoundaryElements {
    dropped: BTreeSet<u32>,
}

impl SpaceBoundaryElements {
    /// Whether the export writes `line`, a source-schema record. An unreadable
    /// record, or one whose arity is not IFC2X3's, is never judged.
    pub(crate) fn apply(&mut self, id: u32, line: &str, from: &str, to: &str, dropped: &mut usize) -> bool {
        if from != "IFC2X3" || !matches!(to, "IFC4" | "IFC4X3") { return true; }
        let Some(head) = record_head(line) else { return true };
        if !head.type_name(line).eq_ignore_ascii_case(BOUNDARY) { return true; }
        let Some(names) = crate::schema_convert::schema_attribute_names(from, BOUNDARY) else { return true };
        let Some(at) = names.iter().position(|a| *a == ELEMENT) else { return true };
        // The line converter also accepts a record without its terminating semicolon.
        let padded;
        let (text, frame) = match record_frame(line) {
            Some(frame) => (line, Some(frame)),
            None => { padded = format!("{line};"); (padded.as_str(), record_frame(&padded)) }
        };
        let Some(slots) = frame.and_then(|frame| slots_of(frame.args(text))) else { return true };
        if slots.len() != names.len() || crate::schema_convert::holds_value(slots[at]) { return true; }
        *dropped += slots.iter().filter(|s| !slot_unset(s)).count();
        self.dropped.insert(id);
        false
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
