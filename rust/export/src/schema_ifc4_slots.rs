// SPDX-License-Identifier: MPL-2.0
//! Slots IFC4 requires a value in, on a downgrade from IFC4X3/IFC5 to IFC4
//! (#5307, the Rust twin of #5202).
//!
//! IFC4X3 (and IFC5) made attributes optional that IFC4 declares mandatory —
//! e.g. `IfcProjectedCRS.Name` — so a valid IFC4X3/IFC5 record legitimately
//! carries `$` where the IFC4 target requires a value. Unlike the IFC2X3
//! downgrade ([`crate::schema_ifc2x3_slots`]), there is no `OwnerHistory`
//! mismatch to reconcile here: `IfcRoot.OwnerHistory` is optional in both
//! IFC4X3 and IFC4. So this fill is only the generated required-slot table:
//! a BOOLEAN takes `.F.`, the value that claims nothing, and everything
//! else — including every enum-typed slot, since an invented enum member
//! would be indistinguishable from #5202's separate, unaddressed
//! enum-reconciliation gap — keeps `$` and is COUNTED, so the caller learns
//! the file is not valid IFC4 rather than receiving a fabricated value.
//!
//! Twin of `packages/export/src/schema-converter-ifc4-slots.ts` (#5202).

use crate::generated::ifc4_required_slots::{Ifc4RequiredSlot, IFC4_REQUIRED_SLOTS};
use crate::step_slot::split_top_level_args;

/// The IFC4 required-slot fill for one export: how many slots stayed `$`.
/// The exporter threads one through per export and reads [`Self::warnings`]
/// after the last record.
#[derive(Default)]
pub(crate) struct Ifc4SlotFill {
    required_unfilled: usize,
}

impl Ifc4SlotFill {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Slots written with `$` where IFC4 requires a value and the schema
    /// offers no honest default (every enum, and every measure, label,
    /// identifier or entity reference). Counted per SLOT, not per record: one
    /// record can leave several.
    pub(crate) fn required_slots_unfilled(&self) -> usize {
        self.required_unfilled
    }

    /// One warning when the counter is non-zero, in the channel the exporters
    /// already carry. Same text shape as the IFC2X3 twin's.
    pub(crate) fn warnings(&self) -> Vec<String> {
        if self.required_unfilled == 0 {
            return Vec::new();
        }
        vec![format!(
            "{} slot(s) keep $ where IFC4 requires a value and the schema offers no default \
             that claims nothing (measures, labels, references, and every enum); the file is \
             not valid IFC4 (#5307).",
            self.required_unfilled
        )]
    }

    /// Apply the fill to an already-converted IFC4 line `#id=TYPE(attrs);`.
    pub(crate) fn apply(&mut self, line: String) -> String {
        self.fill_required(&line).unwrap_or(line)
    }

    /// Write the recorded fill into every required slot of `line` that holds
    /// `$`, counting the ones with no fill. `None` when the line is left as
    /// it is, for any of: it does not parse, IFC4 declares no required slot
    /// for its type, or its ARITY is not the one IFC4 declares.
    ///
    /// That last guard is what keeps a fill from landing on the wrong
    /// attribute. The table's indexes are positions in the IFC4 attribute
    /// list; a record carrying a different number of slots was not
    /// reconciled to that list, so position `i` there need not be attribute
    /// `i` here. Such a record is left alone AND not counted: nothing about
    /// its required slots was established. Same policy as
    /// [`crate::schema_ifc2x3_slots::Ifc2x3SlotFill::fill_required`].
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

/// `(total attribute count, required slots)` for an UPPERCASE IFC4 entity
/// type, or `None` when IFC4 declares no mandatory slot for it (or does not
/// know the type).
fn required_slots(entity_type: &str) -> Option<(u8, &'static [Ifc4RequiredSlot])> {
    let index = IFC4_REQUIRED_SLOTS.binary_search_by(|row| row.0.cmp(entity_type)).ok()?;
    let (_, arity, slots) = IFC4_REQUIRED_SLOTS[index];
    Some((arity, slots))
}
