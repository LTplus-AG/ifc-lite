// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one per-ATTRIBUTE read over a raw STEP record: [`StepListItems`],
//! the top-level items of a record's argument list or of one list value, and
//! [`nth_attribute_is_present`] on top of it.
//!
//! A sibling file for the same reason `scanner_header.rs` and
//! `scanner_tests.rs` are: `scanner.rs` is at its `module_size_ratchet`
//! budget, and this read shares no state or control flow with the record
//! scan it sat next to. It walks one already-located record, comma by comma,
//! rather than hunting the next record.
//!
//! The split used to exist several times: as `EntityScanner::has_non_null_attribute`
//! and a comment-blind copy in `schema_helpers` (core review behind #4577,
//! finding 8), then as `georef_parse::nth_top_level_attribute` and the
//! processing crate's `parse_step_arguments`, which read a comma in a comment
//! as a separator and an apostrophe in one as a string (#4687). The rule
//! lives here.

use crate::parser::lexical::skip_step_trivia;

/// The top-level items of one parenthesized STEP list, each trimmed of
/// trivia (STEP whitespace and `/* ... */` comments) at both ends. Nested
/// parentheses and quoted strings are respected, so a `,` inside `('a,b')`
/// or `(#1,#2)` does not separate items, and a comment is trivia wherever
/// ISO 10303-21 allows one: a `,`, `(`, `)` or `'` inside it is comment text.
///
/// An empty slot (`,,`) is an empty item; `()` has no items. Iteration stops
/// at the list's own `)`, which sets [`Self::closed`], or at a list, string
/// or comment that never closes, which does not, and the unterminated item
/// is not yielded.
pub struct StepListItems<'a> {
    bytes: &'a [u8],
    pos: usize,
    first: bool,
    state: ListState,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ListState {
    Open,
    Closed,
    Unreadable,
}

impl<'a> StepListItems<'a> {
    /// The attributes of a record (`#id = TYPE(...)`). `None` when the
    /// argument list never opens.
    pub fn of_record(record: &'a [u8]) -> Option<Self> {
        argument_list_start(record).map(|pos| Self::after_open(record, pos))
    }

    /// The items of a list value whose `(` is its first non-trivia byte, such
    /// as one item of [`Self::of_record`]. `None` when it is not a list.
    pub fn of_list(value: &'a [u8]) -> Option<Self> {
        let open = skip_step_trivia(value, 0)?;
        (value.get(open) == Some(&b'(')).then(|| Self::after_open(value, open + 1))
    }

    fn after_open(bytes: &'a [u8], pos: usize) -> Self {
        Self { bytes, pos, first: true, state: ListState::Open }
    }

    /// Whether iteration has reached the list's own `)`.
    pub fn closed(&self) -> bool {
        self.state == ListState::Closed
    }
}

impl<'a> Iterator for StepListItems<'a> {
    type Item = &'a [u8];

    fn next(&mut self) -> Option<&'a [u8]> {
        if self.state != ListState::Open {
            return None;
        }
        let bytes = self.bytes;
        let mut pos = self.pos;
        // The item's non-trivia span, once a value byte has been seen.
        let (mut start, mut end) = (None, pos);
        let mut depth = 0usize;
        loop {
            let Some(next) = skip_step_trivia(bytes, pos) else {
                break;
            };
            pos = next;
            let Some(&b) = bytes.get(pos) else {
                break;
            };
            let value_start = pos;
            match b {
                b',' | b')' if depth == 0 => {
                    let first = std::mem::replace(&mut self.first, false);
                    self.pos = pos + 1;
                    if b == b')' {
                        self.state = ListState::Closed;
                        if first && start.is_none() {
                            return None; // `()`
                        }
                    }
                    return Some(start.map_or(&bytes[pos..pos], |s| &bytes[s..end]));
                }
                b'\'' => {
                    pos += 1;
                    loop {
                        match bytes.get(pos) {
                            // An escaped quote ('') stays inside the string.
                            Some(b'\'') if bytes.get(pos + 1) == Some(&b'\'') => pos += 2,
                            Some(b'\'') => break,
                            Some(_) => pos += 1,
                            None => {
                                self.state = ListState::Unreadable;
                                return None;
                            }
                        }
                    }
                }
                b'(' => depth += 1,
                b')' => depth -= 1,
                _ => {}
            }
            pos += 1;
            start.get_or_insert(value_start);
            end = pos;
        }
        self.state = ListState::Unreadable;
        None
    }
}

/// Whether the top-level attribute at `index` (0-based, first attribute
/// after the `(`) of a STEP record holds a value: it exists, it is not `$`,
/// and it is not an empty slot (`,,`). Attributes are split by
/// [`StepListItems`], so nesting, strings and comments follow its rule, and
/// whitespace is the STEP set (`is_step_space`), including the vertical tab
/// and form feed that `u8::is_ascii_whitespace` leaves out.
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
    let Some(mut attributes) = StepListItems::of_record(record) else {
        return false;
    };
    let holds_a_value = attributes
        .nth(index)
        .is_some_and(|value| !matches!(value.first(), None | Some(b'$')));
    // A value still needs the list to close: an unclosed record settles nothing.
    holds_a_value && {
        attributes.by_ref().for_each(drop);
        attributes.closed()
    }
}

/// The index just past the `(` that opens a record's argument list. Only the
/// `#id = TYPE` head and trivia precede it, so each non-trivia byte is stepped
/// over and a comment is consumed as a region: a `(` inside one does not open
/// the list. `None` when the list never opens or a comment never closes.
pub(crate) fn argument_list_start(record: &[u8]) -> Option<usize> {
    let mut pos = 0;
    loop {
        pos = skip_step_trivia(record, pos)?;
        match record.get(pos)? {
            b'(' => return Some(pos + 1),
            _ => pos += 1,
        }
    }
}

#[cfg(test)]
#[path = "scanner_attributes_tests.rs"]
mod tests;
