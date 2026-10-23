// SPDX-License-Identifier: MPL-2.0
//! Record-level text operations shared by the phases: reading a record's
//! slots (`readStepSlots`) and replacing one (`replaceStepArgument`), under the
//! TypeScript slot grammar.

use crate::step_record_frame::record_frame;

/// `replaceStepArgument`: slot `index` of the record replaced, or `None` when
/// the record does not read as `#id=TYPE(args);` with that slot.
pub(crate) fn replace_argument(text: &str, index: usize, replacement: &str) -> Option<String> {
    let frame = record_frame(text)?;
    let mut args = crate::step_slot::slots_of(frame.args(text))?;
    if index >= args.len() {
        return None;
    }
    args[index] = replacement;
    Some(frame.with_args(text, &args.join(",")))
}

/// `readStepSlots`: the record's UPPERCASE type and argument slots, or `None`
/// when it does not read as `#id=TYPE(args);` with a splittable list.
pub(crate) fn read_slots(text: &str) -> Option<(String, Vec<String>)> {
    let frame = record_frame(text)?;
    let slots = split_args(frame.args(text))?;
    Some((frame.head.type_name(text).to_ascii_uppercase(), slots))
}

/// `splitTopLevelStepArguments`: core's strict split. It was the shared
/// splitter plus a second grammar that held every part to the TypeScript
/// rules (`isWellFormedStepSlot`); both are core's one grammar now, which the
/// TypeScript twin is pinned to by `core/tests/fixtures/step_slot_vectors.json`.
pub(crate) fn split_args(attrs: &str) -> Option<Vec<String>> {
    crate::step_slot::split_top_level_args(attrs)
}

#[cfg(test)]
#[path = "lines_tests.rs"]
mod tests;
