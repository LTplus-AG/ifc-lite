// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The strict reads, for STEP WRITERS (F4, #7778): [`is_step_value`], whether
//! text is exactly one well-formed STEP value, and [`split_step_slots`], an
//! argument list cut into slots that each are one.
//!
//! A reader may be tolerant ([`StepListItems`](super::StepListItems) answers
//! with what it can read). A writer must not be: a slot it cannot vouch for
//! is a slot a by-index edit lands on the wrong attribute of
//! (LTplus-AG/ifc-lite#2470, #4125). So these refuse instead of guessing, and
//! the grammar is the one the tokenizer reads: whatever passes here is a
//! `Token` there. The export crate had three copies of it (a `Vec<char>`
//! walker in `step_slot`, a second in `step_log::lines`, a regex port in
//! `step_log::attrs`) that disagreed on whitespace, numbers and binaries.

use super::lexical::{is_step_space, skip_step_trivia};
use super::numeric_literal::read_step_number;
use super::record::parse_ref;
use super::tokenizer::MAX_NESTING_DEPTH;
use crate::step_encoding::step_string_literal_end;

fn is_name_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Whether `value` is exactly ONE STEP value: a string `'...'`, a binary
/// `"[0-3]hex*"`, `$`, `*`, a reference `#digits`, an enumeration `.NAME.`, a
/// number, a list `( ... )` of values, or a typed value `NAME( ... )`.
///
/// Trivia (STEP whitespace, `/* ... */` comments) may surround it and sit
/// wherever STEP allows it; a comment that never closes is not a value, and
/// neither is a value that is only trivia. Not values, because the tokenizer
/// reads none of them: a bare keyword, `1..2`, `#+5`, an empty list element
/// (`(1,,2)`, `(1,)`), a binary with a non-hex byte, an integer beyond `i64`.
/// Nesting deeper than the tokenizer's bound is refused.
///
/// Iterative, so no input exhausts the stack.
pub fn is_step_value(value: &[u8]) -> bool {
    let len = value.len();
    let Some(mut i) = skip_step_trivia(value, 0) else { return false };
    let mut depth = 0u32;
    // Whether the next thing read is a value (after `(` or `,`) rather than a
    // separator (after a value).
    let mut expect_value = true;
    loop {
        if expect_value {
            let Some(&b) = value.get(i) else { return false };
            match b {
                b'\'' => match step_string_literal_end(value, i) {
                    Some(end) => i = end,
                    None => return false,
                },
                b'"' => {
                    let Some(close) = value[i + 1..].iter().position(|&c| c == b'"') else { return false };
                    let body = &value[i + 1..i + 1 + close];
                    match body.split_first() {
                        Some((b'0'..=b'3', hex)) if hex.iter().all(u8::is_ascii_hexdigit) => {}
                        _ => return false,
                    }
                    i += close + 2;
                }
                b'$' | b'*' => i += 1,
                b'#' => {
                    let end = i + 1 + value[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
                    if parse_ref(&value[i..end]).is_none() {
                        return false;
                    }
                    i = end;
                }
                b'.' if value.get(i + 1).is_some_and(|c| !c.is_ascii_digit()) => {
                    let name = value[i + 1..].iter().take_while(|&&c| is_name_byte(c)).count();
                    if name == 0 || value.get(i + 1 + name) != Some(&b'.') {
                        return false;
                    }
                    i += name + 2;
                }
                b'(' => {
                    depth += 1;
                    if depth > MAX_NESTING_DEPTH {
                        return false;
                    }
                    let Some(next) = skip_step_trivia(value, i + 1) else { return false };
                    i = next;
                    // An empty list is a value; an element may not be empty.
                    if value.get(i) == Some(&b')') {
                        depth -= 1;
                        i += 1;
                        expect_value = false;
                    }
                    let Some(next) = skip_step_trivia(value, i) else { return false };
                    i = next;
                    continue;
                }
                b'+' | b'-' | b'.' | b'0'..=b'9' => match read_step_number(&value[i..]) {
                    Some((_, used)) => i += used,
                    None => return false,
                },
                c if c.is_ascii_alphabetic() || c == b'_' => {
                    let name = value[i..].iter().take_while(|&&c| is_name_byte(c)).count();
                    let Some(open) = skip_step_trivia(value, i + name) else { return false };
                    if value.get(open) != Some(&b'(') {
                        return false; // a bare keyword is no value
                    }
                    depth += 1;
                    if depth > MAX_NESTING_DEPTH {
                        return false;
                    }
                    let Some(next) = skip_step_trivia(value, open + 1) else { return false };
                    i = next;
                    if value.get(i) == Some(&b')') {
                        depth -= 1;
                        i += 1;
                        expect_value = false;
                    }
                    let Some(next) = skip_step_trivia(value, i) else { return false };
                    i = next;
                    continue;
                }
                _ => return false,
            }
            expect_value = false;
            let Some(next) = skip_step_trivia(value, i) else { return false };
            i = next;
            continue;
        }
        // A value just closed: at depth zero it was the whole slot.
        if depth == 0 {
            return i == len;
        }
        match value.get(i) {
            Some(b')') => depth -= 1,
            Some(b',') => expect_value = true,
            _ => return false,
        }
        let Some(next) = skip_step_trivia(value, i + 1) else { return false };
        i = next;
    }
}

/// The argument list `inner` (the text between a record's outermost
/// parentheses) cut at its top-level commas into slots, or `None` when it is
/// not a list a by-index writer can trust. The slots are slices of `inner`,
/// NOT trimmed, so for an accepted list `slots.join(",")` is `inner` byte for
/// byte and a caller that replaces one slot leaves every other byte alone.
///
/// Refused: a string literal or binary literal that never closes, a comment
/// that never closes, parentheses that do not balance (a depth that goes
/// below zero, or does not return to it), and a slot that is not one
/// [`is_step_value`] (so a comment-only slot is refused: counting it as one
/// more empty slot would shift every index after it).
///
/// An EMPTY top-level slot (`a,,b`, a trailing comma, all blanks) is kept: it
/// is invalid STEP that costs no alignment, since the entity parser counts an
/// empty argument as one attribute too. `inner` of only blanks has no slots.
pub fn split_step_slots(inner: &str) -> Option<Vec<&str>> {
    let bytes = inner.as_bytes();
    if bytes.iter().all(|&b| is_step_space(b)) {
        return Some(Vec::new());
    }
    let mut slots = Vec::new();
    let (mut depth, mut start, mut i) = (0usize, 0usize, 0usize);
    while i < bytes.len() {
        match bytes[i] {
            b'\'' => {
                i = step_string_literal_end(bytes, i)?;
                continue;
            }
            // A binary has no escapes: the first following quote closes it.
            b'"' => i += 1 + bytes[i + 1..].iter().position(|&c| c == b'"')?,
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i = super::lexical::skip_step_comment(bytes, i)?;
                continue;
            }
            b'(' => depth += 1,
            b')' => depth = depth.checked_sub(1)?,
            b',' if depth == 0 => {
                slots.push(&inner[start..i]);
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    if depth != 0 {
        return None;
    }
    slots.push(&inner[start..]);
    slots
        .iter()
        .all(|slot| slot.bytes().all(is_step_space) || is_step_value(slot.as_bytes()))
        .then_some(slots)
}

#[cfg(test)]
#[path = "slots_tests.rs"]
mod tests;
