// SPDX-License-Identifier: MPL-2.0
//! Slots IFC2X3 requires a value in, on a downgrade to IFC2X3 (#4714).
//!
//! IFC4 made attributes optional that IFC2X3 declares mandatory, so a valid
//! IFC4 record legitimately carries `$` where the IFC2X3 target requires a
//! value. Two policies settle those slots, and this is the one object an
//! exporter threads through [`crate::schema_convert::convert_step_line`] to
//! apply both:
//!
//! - `IfcRoot.OwnerHistory` is REUSED from an `IfcOwnerHistory` the export
//!   already writes ([`OwnerHistoryFill`], #4686). Nothing is invented,
//!   because an owner history asserts who made the model, with which
//!   application, when.
//! - Every other required slot is read from the generated
//!   [`IFC2X3_REQUIRED_SLOTS`] table. An enum with a `NOTDEFINED` member takes
//!   `.NOTDEFINED.` and a BOOLEAN takes `.F.`, the values that claim nothing.
//!   A measure, label, identifier or entity reference has no such value, so
//!   the slot keeps `$` and is COUNTED: the caller learns the file is not
//!   valid IFC2X3 rather than receiving a fabricated dimension.
//!
//! Twin of `packages/export/src/schema-converter-ifc2x3-slots.ts`.

use crate::generated::ifc2x3_required_slots::{Ifc2x3RequiredSlot, IFC2X3_REQUIRED_SLOTS};
use crate::schema_owner_history::OwnerHistoryFill;
use crate::step_slot::split_top_level_args;

/// The IFC2X3 required-slot fills for one export: the owner history to reuse,
/// and how many slots of each kind stayed `$`. The exporter settles the owner
/// history before the first record and reads [`Self::warnings`] after the last.
pub(crate) struct Ifc2x3SlotFill {
    owner_history: OwnerHistoryFill,
    required_unfilled: usize,
}

impl Ifc2x3SlotFill {
    /// `owner_history` is the express id, as written in the OUTPUT, of an
    /// `IfcOwnerHistory` the export writes, or `None` when it writes none.
    pub(crate) fn new(owner_history: Option<u32>) -> Self {
        Self { owner_history: OwnerHistoryFill::new(owner_history), required_unfilled: 0 }
    }

    /// Switch to `reference` when there is one; otherwise keep the current
    /// one. A merged export calls this per model, so a model without an owner
    /// history of its own reuses one an earlier model wrote.
    pub(crate) fn prefer(&mut self, reference: Option<u32>) {
        self.owner_history.prefer(reference);
    }

    /// Records written with `$` in the mandatory `OwnerHistory` slot (#4686).
    pub(crate) fn owner_history_unfilled(&self) -> usize {
        self.owner_history.unfilled()
    }

    /// Slots other than `OwnerHistory` written with `$` where IFC2X3 requires
    /// a value and the schema offers no honest default (#4714). Counted per
    /// SLOT, not per record: one record can leave several.
    pub(crate) fn required_slots_unfilled(&self) -> usize {
        self.required_unfilled
    }

    /// One warning per non-zero counter, in the channel the exporters already
    /// carry. Same texts as the TypeScript twin's.
    pub(crate) fn warnings(&self) -> Vec<String> {
        let mut out: Vec<String> = self.owner_history.unfilled_warning().into_iter().collect();
        if self.required_unfilled > 0 {
            out.push(format!(
                "{} slot(s) keep $ where IFC2X3 requires a value and the schema offers no \
                 default that claims nothing (measures, labels, references, and enums with no \
                 NOTDEFINED member); the file is not valid IFC2X3 (#4714).",
                self.required_unfilled
            ));
        }
        out
    }

    /// Apply both fills to an already-converted IFC2X3 line `#id=TYPE(attrs);`.
    pub(crate) fn apply(&mut self, line: String) -> String {
        let line = self.owner_history.apply(line);
        self.fill_required(&line).unwrap_or(line)
    }

    /// Write the recorded fill into every required slot of `line` that holds
    /// `$`, counting the ones with no fill. `None` when the line is left as it
    /// is, for any of: it does not parse (the converter already passed it
    /// through for the same reason), IFC2X3 declares no required slot for its
    /// type, or its ARITY is not the one IFC2X3 declares.
    ///
    /// That last guard is what keeps a fill from landing on the wrong
    /// attribute. The table's indexes are positions in the IFC2X3 attribute
    /// list; a record carrying a different number of slots was not reconciled
    /// to that list (the downgrade only trims and pads the types whose lists
    /// are prefix-related), so position `i` there need not be attribute `i`
    /// here. Such a record is left alone AND not counted: nothing about its
    /// required slots was established.
    fn fill_required(&mut self, line: &str) -> Option<String> {
        let open = line.find('(')?;
        let close = line.rfind(')').filter(|&c| c > open)?;
        let eq = line.find('=').filter(|&e| e < open)?;
        let entity_type = line[eq + 1..open].trim().to_ascii_uppercase();
        let (arity, slots) = required_slots(&entity_type)?;
        let mut values = split_top_level_args(&line[open + 1..close])?;
        if values.len() != usize::from(arity) {
            return None;
        }
        let mut changed = false;
        for &(index, _name, fill) in slots {
            let slot = &mut values[usize::from(index)];
            if slot.trim() != "$" {
                continue;
            }
            if fill.is_empty() {
                self.required_unfilled += 1;
                continue;
            }
            *slot = fill.to_string();
            changed = true;
        }
        changed.then(|| format!("{}{}{}", &line[..=open], values.join(","), &line[close..]))
    }
}

/// `(total attribute count, required slots)` for an UPPERCASE IFC2X3 entity
/// type, or `None` when IFC2X3 declares no mandatory slot for it (or does not
/// know the type).
pub(crate) fn required_slots(entity_type: &str) -> Option<(u8, &'static [Ifc2x3RequiredSlot])> {
    let index = IFC2X3_REQUIRED_SLOTS.binary_search_by(|row| row.0.cmp(entity_type)).ok()?;
    let (_, arity, slots) = IFC2X3_REQUIRED_SLOTS[index];
    Some((arity, slots))
}
