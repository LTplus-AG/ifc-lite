// SPDX-License-Identifier: MPL-2.0
//! `IfcRoot.OwnerHistory` on a downgrade to IFC2X3 (#4686).
//!
//! OwnerHistory is OPTIONAL in IFC4 and IFC4X3 but MANDATORY in IFC2X3, so a
//! record the source wrote with `$` there is invalid once the header says
//! IFC2X3. The downgrade reuses an `IfcOwnerHistory` the export already
//! writes; it never invents one, because an owner history asserts who made
//! the model with which application and when, and the source did not say.
//! When the export keeps none, the slot stays `$` and the record is counted,
//! so the caller can report that the file is not valid IFC2X3.
//!
//! Twin of `packages/export/src/schema-converter-owner-history.ts`.

use crate::step_slot::{slot_is, split_top_level_args};

/// The owner history a downgrade writes into `$` OwnerHistory slots, and how
/// many records it could not fill. One per export: the exporter resolves the
/// reference before the first record and reads [`Self::unfilled`] after the
/// last.
pub(crate) struct OwnerHistoryFill {
    reference: Option<u32>,
    unfilled: usize,
}

impl OwnerHistoryFill {
    /// `reference` is the express id, as written in the OUTPUT, of an
    /// `IfcOwnerHistory` the export writes, or `None` when it writes none.
    pub(crate) fn new(reference: Option<u32>) -> Self {
        Self { reference, unfilled: 0 }
    }

    /// Switch to `reference` when there is one; otherwise keep the current
    /// reference. A merged export calls this per model, so a model without an
    /// owner history of its own reuses one an earlier model wrote.
    pub(crate) fn prefer(&mut self, reference: Option<u32>) {
        if reference.is_some() {
            self.reference = reference;
        }
    }

    /// Records written with `$` in a mandatory OwnerHistory slot because
    /// there was no reference to write.
    pub(crate) fn unfilled(&self) -> usize {
        self.unfilled
    }

    /// The warning for [`Self::unfilled`], or `None` when every slot was
    /// filled. Same text as the TypeScript twin's.
    pub(crate) fn unfilled_warning(&self) -> Option<String> {
        (self.unfilled > 0).then(|| {
            format!(
                "{} record(s) keep $ in OwnerHistory, which IFC2X3 requires, because the \
                 export writes no IfcOwnerHistory to point them at; the file is not valid \
                 IFC2X3 (#4686).",
                self.unfilled
            )
        })
    }

    /// Fill slot 1 of an already-converted IFC2X3 line `#id=TYPE(attrs);` when
    /// `TYPE` is an `IfcRoot` subtype and the slot is `$`. Every other byte of
    /// the line is kept. A line that does not parse is returned unchanged:
    /// the converter already passed it through for the same reason.
    pub(crate) fn apply(&mut self, line: String) -> String {
        self.fill(&line).unwrap_or(line)
    }

    fn fill(&mut self, line: &str) -> Option<String> {
        let open = line.find('(')?;
        let close = line.rfind(')').filter(|&c| c > open)?;
        let eq = line.find('=').filter(|&e| e < open)?;
        let entity_type = line[eq + 1..open].trim();
        if !crate::rooted_type::is_rooted_type(entity_type) {
            return None;
        }
        let mut slots = split_top_level_args(&line[open + 1..close])?;
        if !slots.get(1).is_some_and(|slot| slot_is(slot, "$")) {
            return None;
        }
        let Some(reference) = self.reference else {
            self.unfilled += 1;
            return None;
        };
        slots[1] = format!("#{reference}");
        Some(format!("{}{}{}", &line[..=open], slots.join(","), &line[close..]))
    }
}
