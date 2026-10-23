// SPDX-License-Identifier: MPL-2.0
//! Reading a STEP record's top-level argument list out of its text, for a
//! caller that then reads or writes one slot BY INDEX.
//!
//! The failure this module exists to prevent is silent. A scanner that loses
//! track of quote state or paren depth still produces parts; they are just not
//! the record's arguments any more, because the commas it swallowed took every
//! following slot with them. A write by index then lands on whatever the
//! mis-scan accumulated and the caller reports a success that did not happen
//! (LTplus-AG/ifc-lite#2470, #4125). So the split returns `None` rather than
//! parts it does not believe in, and the callers in [`crate::step_text`] treat
//! `None` as "this edit cannot be made".
//!
//! The grammar is core's, not this crate's: [`split_top_level_args`] is
//! `ifc_lite_core::parser::split_step_slots` and [`is_step_value`] is
//! `ifc_lite_core::parser::is_step_value` plus the one rule a WRITER adds (no
//! comment in a caller's value). This module used to hold its own `Vec<char>`
//! walker, an ASCII projection and a second per-slot grammar that read Unicode
//! whitespace, accepted `1..2` and checked a binary's hex only in one of its
//! two entry points (EXPORT-STEP-15, F4 M-export-a).
//!
//! The TypeScript twin is `packages/export/src/step-argument-parser.ts`'s
//! `splitTopLevelStepArguments` and `step-slot-grammar.ts`. The two cannot
//! share code, so both are held to `core/tests/fixtures/step_slot_vectors.json`
//! (the strict value grammar and the split, accepts and refusals) and to
//! `tests/fixtures/step_refuse_vectors.json` (the mis-scans a split must
//! refuse).
//!
//! Comments: a `/* ... */` comment's bytes stay inside the slot that carries
//! it, and the split steps over the whole region so a comma, paren or
//! apostrophe inside it is never structure. A slot that is ONLY a comment is
//! refused, because counting it as one more empty slot would shift every index
//! after it. Nesting is bounded by the tokenizer's depth (the TypeScript twin
//! recurses and shares the bound), and a comment that never closes refuses.

use ifc_lite_core::parser::{is_step_value as core_is_step_value, split_step_slots};

/// Split a STEP attribute list into its top-level arguments, or `None` when
/// the text is not an argument list this can scan.
///
/// `attrs` is the text BETWEEN a record's outermost parentheses. Nothing is
/// trimmed, so for accepted input `parts.join(",")` reproduces `attrs` byte for
/// byte and a caller that replaces one part leaves every other byte alone —
/// with ONE exception, the whitespace-only early return: `"   "` splits to
/// `[]`, so [`crate::step_text::apply_attr_mutations_counted`] rewrites
/// `#1=IFCFOO(   );` to `#1=IFCFOO();`. A record with no arguments has no slot
/// for a by-index caller to write, so the only bytes the exception can drop
/// are padding that carries no value.
///
/// An EMPTY top-level slot (`a,,b`, or a trailing comma) is NOT rejected: it is
/// invalid STEP that costs no alignment, because an empty argument is ONE part,
/// exactly as the entity parser counts it. An empty INPUT is not an empty slot:
/// `#1=IFCFOO();` splits to `[]` and any slot request fails the caller's own
/// bounds check.
///
/// This owned form is for a caller that replaces slots and rejoins (the
/// schema conversions, the mutation-log writer). A caller that only reads
/// slots, or swaps a few of them in place, borrows with [`slots_of`] and
/// allocates nothing per slot.
pub(crate) fn split_top_level_args(attrs: &str) -> Option<Vec<String>> {
    Some(split_step_slots(attrs)?.into_iter().map(str::to_owned).collect())
}

/// [`split_top_level_args`] without the copies: the slots are slices of
/// `attrs`, and `slots.join(",")` is `attrs` byte for byte.
pub(crate) fn slots_of(attrs: &str) -> Option<Vec<&str>> {
    split_step_slots(attrs)
}

/// Whether a caller-supplied, already-serialized value is ONE STEP value that
/// may be written into a slot as is (#7682, EXPORT-STEP-26): not empty, one
/// value by core's grammar, and holding no `/*` at all. A value with a
/// top-level `,` would shift every later slot, and one holding `);` would end
/// the record and start another. A comment is refused outright, even inside a
/// literal: a value that opens one swallows the rest of the record and lets a
/// later value close it and inject records of its own. A caller has no reason
/// to send a comment, so none is written.
///
/// A binary literal is held to the ISO 10303-21 form, `"` then one digit
/// `0`-`3` then hex then `"`: core's grammar says so for every reader, where
/// this module used to check it in this one entry point only (#7715 review).
pub(crate) fn is_step_value(value: &str) -> bool {
    !value.contains("/*") && core_is_step_value(value.as_bytes())
}

#[cfg(test)]
#[path = "step_slot_tests.rs"]
mod tests;
