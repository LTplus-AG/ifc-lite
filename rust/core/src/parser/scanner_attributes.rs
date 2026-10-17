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

use crate::parser::lexical::{is_step_space, skip_step_comment, skip_step_trivia};
use std::ops::Range;
use crate::step_encoding::step_string_literal_end;

/// The bytes that end a plain run inside an item: the separators and
/// brackets the item loop acts on, a quote or a possible comment opener, and
/// STEP whitespace (which the item's end must not include).
const SPECIAL: [bool; 256] = {
    let mut table = [false; 256];
    let specials = b",()'/ \t\n\r\x0b\x0c";
    let mut i = 0;
    while i < specials.len() {
        table[specials[i] as usize] = true;
        i += 1;
    }
    table
};

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

    /// The items of the list whose `(` sits just before `pos`.
    pub(crate) fn at(bytes: &'a [u8], pos: usize) -> Self {
        Self::after_open(bytes, pos)
    }

    /// Whether iteration has reached the list's own `)`.
    pub fn closed(&self) -> bool {
        self.state == ListState::Closed
    }
}

impl<'a> Iterator for StepListItems<'a> {
    type Item = &'a [u8];

    #[inline]
    fn next(&mut self) -> Option<&'a [u8]> {
        if self.state != ListState::Open {
            return None;
        }
        let bytes = self.bytes;
        let len = bytes.len();
        let mut pos = self.pos;
        // The item's non-trivia span, once a value byte has been seen.
        let (mut start, mut end) = (None, pos);
        let mut depth = 0usize;
        loop {
            // Trivia, inline: the whitespace run is the common case, and only
            // a `/*` leaves it.
            while pos < len && is_step_space(bytes[pos]) {
                pos += 1;
            }
            let Some(&b) = bytes.get(pos) else {
                break;
            };
            let value_start = pos;
            match b {
                b'/' if bytes.get(pos + 1) == Some(&b'*') => match skip_step_comment(bytes, pos) {
                    Some(next) => {
                        pos = next;
                        continue;
                    }
                    None => break,
                },
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
                // The shared literal rule: `''` and a `\S\` operand are text,
                // so a comma or paren after `'Para \S\' 5'` is not read as
                // structure (#7589). `pos` lands on the closing quote.
                b'\'' => match step_string_literal_end(bytes, pos) {
                    Some(past_close) => pos = past_close - 1,
                    None => {
                        self.state = ListState::Unreadable;
                        return None;
                    }
                },
                b'(' => depth += 1,
                b')' => depth -= 1,
                _ => {}
            }
            pos += 1;
            // A run of bytes that act on nothing and are no trivia is one
            // value stretch: jump it (F4-3).
            while pos < len && !SPECIAL[bytes[pos] as usize] {
                pos += 1;
            }
            start.get_or_insert(value_start);
            end = pos;
        }
        self.state = ListState::Unreadable;
        None
    }
}

/// The top-level items of a list's inner text (what sits between its
/// parentheses), as byte ranges: split at commas outside nesting, literals
/// and comments, each trimmed of STEP trivia at both ends. A comment inside
/// an item stays in its text, since the item is a slice of the input.
///
/// The tolerant splitter, for text that may be cut short or malformed (the
/// source header). Unlike [`StepListItems`] it never refuses: a literal that
/// never closes runs to the end, and a comment that never closes ends the
/// scan (everything after its `/*` is inside it). The last item is yielded
/// even though no `)` closes it, a blank last item only after a comma. A
/// stray `)` at depth 0 is not a separator, and neither is a comma after it.
/// Square brackets are ordinary text: Part 21 has no brackets outside
/// literals.
fn split_top_level_ranges(inner: &[u8]) -> Vec<Range<usize>> {
    let len = inner.len();
    let mut items = Vec::new();
    let mut span: Option<(usize, usize)> = None;
    let mut depth = 0i32;
    let mut i = 0;
    let take = |span: &mut Option<(usize, usize)>| {
        span.take().map_or(0..0, |(start, end)| start..end)
    };
    while i < len {
        let b = inner[i];
        if is_step_space(b) {
            i += 1;
            continue;
        }
        if b == b'/' && inner.get(i + 1) == Some(&b'*') {
            match skip_step_comment(inner, i) {
                Some(next) => {
                    i = next;
                    continue;
                }
                None => break,
            }
        }
        if b == b',' && depth == 0 {
            items.push(take(&mut span));
            i += 1;
            continue;
        }
        let start = i;
        match b {
            b'\'' => i = step_string_literal_end(inner, i).unwrap_or(len),
            b'(' => {
                depth += 1;
                i += 1;
            }
            b')' => {
                depth -= 1;
                i += 1;
            }
            _ => i += 1,
        }
        span = Some((span.map_or(start, |(first, _)| first), i));
    }
    if span.is_some() || !items.is_empty() {
        items.push(take(&mut span));
    }
    items
}

/// [`split_top_level_ranges`] over bytes, as slices of `inner`.
pub fn split_top_level_args(inner: &[u8]) -> Vec<&[u8]> {
    split_top_level_ranges(inner).into_iter().map(|r| &inner[r]).collect()
}

/// [`split_top_level_args`] over text. Every delimiter is ASCII, so the byte
/// ranges fall on character boundaries.
pub fn split_top_level_args_str(inner: &str) -> Vec<&str> {
    split_top_level_ranges(inner.as_bytes()).into_iter().map(|r| &inner[r]).collect()
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
    StepListItems::of_record(record).is_some_and(|attributes| attribute_is_present(attributes, index))
}

/// The one "does attribute `index` hold a value" rule over a record's
/// attributes; [`nth_attribute_is_present`] and `StepRecord::is_present`.
pub(crate) fn attribute_is_present(mut attributes: StepListItems<'_>, index: usize) -> bool {
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
