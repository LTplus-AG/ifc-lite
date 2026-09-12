// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one per-ATTRIBUTE read over a raw STEP record:
//! [`nth_attribute_is_present`].
//!
//! A sibling file for the same reason `scanner_header.rs` and
//! `scanner_tests.rs` are: `scanner.rs` is at its `module_size_ratchet`
//! budget, and this read shares no state or control flow with the record
//! scan it sat next to. It walks one already-located record, comma by comma,
//! rather than hunting the next record.
//!
//! This used to exist twice: as `EntityScanner::has_non_null_attribute` here
//! (comment-aware inside the argument list, comment-blind at the `(`) and as
//! `schema_helpers::nth_attribute_is_present` (comment-blind throughout, and
//! trimming with `u8::is_ascii_whitespace`, which is not the STEP whitespace
//! set; see [`is_step_space`](crate::parser::lexical::is_step_space)). The two disagreed on
//! `#1=IFCWALL /* (was IFCSLAB) */ ($,'a');` and on a `,` inside a comment.
//! One rule, one home: the `schema_helpers` name is kept as the public entry
//! point and the scanner method is gone (core review behind #4577, finding 8).

use crate::parser::lexical::{skip_step_comment, skip_step_trivia};

/// Whether the top-level attribute at `index` (0-based, first attribute
/// after the `(`) of a STEP record holds a value: it exists, it is not `$`,
/// and it is not an empty slot (`,,`).
///
/// Cheap and textual: no entity decode. Nested parentheses and quoted
/// strings are respected, so a `,` inside `('a,b')` or `(#1,#2)` does not
/// count as a separator, and `/* ... */` comments are trivia everywhere
/// ISO 10303-21 allows them: before the `(`, around any value, and between
/// values. Whitespace is the STEP set (`is_step_space`), including the
/// vertical tab and form feed that `u8::is_ascii_whitespace` leaves out.
///
/// `false` for anything the record does not settle: an argument list that
/// never opens or never closes, a comment or string literal that never
/// closes, an index past the last attribute. `false` is the "no geometry"
/// side for every caller, so an unreadable record is skipped rather than
/// meshed.
///
/// Callers use it to check attribute 6 (`Representation`, stable across
/// every `IfcProduct` subtype) before deciding an otherwise-excluded spatial
/// container exceptionally carries geometry (#1910), companion to
/// `is_representationless_spatial_container_by_name`.
pub fn nth_attribute_is_present(record: &[u8], index: usize) -> bool {
    // Reach the '(' that opens the argument list. Only the `#id = TYPE` head
    // and trivia precede it, so each non-trivia byte is stepped over; a
    // comment is consumed as a region so a '(' inside it does not open the
    // list early.
    let mut pos = 0;
    loop {
        pos = match skip_step_trivia(record, pos) {
            Some(p) => p,
            None => return false,
        };
        match record.get(pos) {
            None => return false,
            Some(b'(') => {
                pos += 1;
                break;
            }
            Some(_) => pos += 1,
        }
    }

    // The answer for `index` is taken at its slot; the walk then continues
    // only to confirm the list closes, since an unclosed record settles
    // nothing. A slot already known to be null or empty needs no more walk.
    let mut slot = 0usize;
    let mut present = None;
    if index == 0 {
        present = slot_holds_a_value(record, pos);
        if present == Some(false) {
            return false;
        }
    }

    let mut depth = 0usize;
    let mut in_string = false;
    while pos < record.len() {
        let b = record[pos];
        if in_string {
            if b == b'\'' {
                // An escaped quote ('') stays inside the string.
                if record.get(pos + 1) == Some(&b'\'') {
                    pos += 2;
                    continue;
                }
                in_string = false;
            }
            pos += 1;
            continue;
        }
        match b {
            b'\'' => {
                in_string = true;
                pos += 1;
            }
            b'/' if record.get(pos + 1) == Some(&b'*') => {
                // A comment is consumed as a region, the other half of the
                // rule the quote branch gives in the opposite direction: a
                // ',', '(' or ')' inside it must not move `slot` or `depth`.
                match skip_step_comment(record, pos) {
                    Some(next) => pos = next,
                    None => return false,
                }
            }
            b'(' => {
                depth += 1;
                pos += 1;
            }
            b')' => {
                if depth == 0 {
                    return present.unwrap_or(false);
                }
                depth -= 1;
                pos += 1;
            }
            b',' if depth == 0 => {
                slot += 1;
                pos += 1;
                if slot == index {
                    present = slot_holds_a_value(record, pos);
                    if present == Some(false) {
                        return false;
                    }
                }
            }
            _ => pos += 1,
        }
    }
    false
}

/// Whether the slot starting at `pos` holds a value: skip trivia, then look
/// at the first real byte. `$` is the null token; `,` and `)` mean the slot
/// is empty. `None` when the record runs out or a comment never closes.
fn slot_holds_a_value(record: &[u8], pos: usize) -> Option<bool> {
    let p = skip_step_trivia(record, pos)?;
    Some(!matches!(*record.get(p)?, b'$' | b',' | b')'))
}

#[cfg(test)]
#[path = "scanner_attributes_tests.rs"]
mod tests;
