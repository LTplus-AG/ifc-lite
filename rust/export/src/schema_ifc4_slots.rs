// SPDX-License-Identifier: MPL-2.0
//! Counts the slots IFC4 requires a value in that a downgrade from IFC4X3 or
//! IFC5 leaves `$` (#5307, the Rust twin of #5202).
//!
//! IFC4X3 (and IFC5) made attributes optional that IFC4 declares mandatory,
//! e.g. `IfcProjectedCRS.Name`, so a valid IFC4X3/IFC5 record legitimately
//! carries `$` where the IFC4 target requires a value.
//!
//! Unlike [`crate::schema_ifc2x3_slots`] this never writes a value. None of
//! these slots has an honest default: the only candidates were BOOLEANs, and
//! every BOOLEAN slot IFC4 requires is required in IFC4X3 as well (`SameSense`,
//! `Orientation`, …), where `.F.` would flip geometry rather than claim
//! nothing. Enums stay unfilled because enum reconciliation is its own problem
//! (#5365). The count surfaces in `ConversionReport::ifc4_required_slots_unfilled`
//! and the merged exporter's warnings, so the caller learns the file is not
//! valid IFC4 instead of receiving an invented value.
//!
//! Twin of `packages/export/src/schema-converter-ifc4-slots.ts`
//! (`Ifc4SlotCheck`); both read one generated table.

use crate::generated::ifc4_required_slots::{Ifc4RequiredSlot, IFC4_REQUIRED_SLOTS};
use crate::step_slot::split_top_level_args;

/// How many IFC4-required slots one export left `$`.
#[derive(Default)]
pub(crate) struct Ifc4SlotCheck {
    required_unfilled: usize,
}

impl Ifc4SlotCheck {
    /// Required slots left `$`. Counted per SLOT: one record can leave several.
    pub(crate) fn required_slots_unfilled(&self) -> usize {
        self.required_unfilled
    }

    /// One warning when the counter is non-zero. Same text as the TypeScript
    /// twin's, so both exporters report the same thing.
    pub(crate) fn warnings(&self) -> Vec<String> {
        if self.required_unfilled == 0 {
            return Vec::new();
        }
        vec![format!(
            "{} slot(s) keep $ where IFC4 requires a value and the source offers none \
             (the converter does not invent measures, labels, identifiers, references, flags \
             or enums); the file is not valid IFC4 (#5202).",
            self.required_unfilled
        )]
    }

    /// Count every required slot of an already-converted IFC4 line that holds
    /// `$`. The line itself is never changed, so this takes it by reference.
    ///
    /// A line that does not parse, whose type IFC4 gives no required slot, or
    /// whose ARITY is not IFC4's is not counted: its position `i` need not be
    /// attribute `i` (the same guard `Ifc2x3SlotFill::fill_required` uses).
    pub(crate) fn count(&mut self, line: &str) {
        let Some(open) = line.find('(') else { return };
        let Some(close) = line.rfind(')').filter(|&c| c > open) else { return };
        let Some(eq) = line.find('=').filter(|&e| e < open) else { return };
        let entity_type = line[eq + 1..open].trim().to_ascii_uppercase();
        let Some((arity, slots)) = required_slots(&entity_type) else { return };
        let Some(values) = split_top_level_args(&line[open + 1..close]) else { return };
        if values.len() != usize::from(arity) {
            return;
        }
        for &(index, _name) in slots {
            if is_null_token(&values[usize::from(index)]) {
                self.required_unfilled += 1;
            }
        }
    }
}

/// `$`, possibly wrapped in whitespace and STEP `/* … */` comments.
fn is_null_token(slot: &str) -> bool {
    let mut rest = slot.trim_start();
    let mut seen_dollar = false;
    while !rest.is_empty() {
        if let Some(after) = rest.strip_prefix("/*") {
            let Some(end) = after.find("*/") else { return false };
            rest = after[end + 2..].trim_start();
        } else if let Some(after) = rest.strip_prefix('$') {
            if seen_dollar {
                return false;
            }
            seen_dollar = true;
            rest = after.trim_start();
        } else {
            return false;
        }
    }
    seen_dollar
}

/// `(total attribute count, required slots)` for an UPPERCASE IFC4 entity
/// type, or `None` when IFC4 declares no mandatory slot for it (or does not
/// know the type).
fn required_slots(entity_type: &str) -> Option<(u8, &'static [Ifc4RequiredSlot])> {
    let index = IFC4_REQUIRED_SLOTS.binary_search_by(|row| row.0.cmp(entity_type)).ok()?;
    let (_, arity, slots) = IFC4_REQUIRED_SLOTS[index];
    Some((arity, slots))
}

#[cfg(test)]
mod tests {
    use super::is_null_token;

    #[test]
    fn null_token_tolerates_whitespace_and_comments_only() {
        assert!(is_null_token("$"));
        assert!(is_null_token(" /* no name */ $ "));
        assert!(!is_null_token("'EPSG:27700'"));
        assert!(!is_null_token("$ $"));
        assert!(!is_null_token("/* unterminated $"));
    }
}
