// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one keyword finder over ISO 10303-21 text that has no record framing
//! yet: the HEADER section, and the `DATA;` marker that ends it.
//!
//! Two readers used to walk it with their own literal and comment loops: the
//! header reader (`header::Lex`, a memoised copy of the comment rule that read
//! an unterminated comment as text, over a 64 KiB window) and the scanner's
//! `data_section_start` (exact `DATA;`, no trivia, no identifier boundary, over
//! a 256 KiB window). Both are this function now, over [`MAX_HEADER_BYTES`]
//! (F4-2, CORE-8, CORE-9, CORE-35).
//!
//! The rules are the shared ones: a literal ends by
//! [`step_string_literal_end`] (`''` and the `\S\` operand are text) and a
//! comment by [`skip_step_comment`]. A literal that never closes runs to the
//! end of the window, because a lone `'` cannot be read as anything else; a
//! comment that never closes does the same, because everything after its `/*`
//! is inside it (ISO 10303-21 comments do not nest and cannot be left open).
//! Either way nothing after it can be found, and the search ends there, so a
//! hostile run of `/*` costs one pass and no memo is needed.

use crate::parser::lexical::{skip_step_comment, skip_step_trivia};
use crate::step_encoding::step_string_literal_end;

/// What must follow a keyword (after trivia) for it to count as found.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Then {
    /// `(`: a record, `FILE_SCHEMA(...)`.
    Paren,
    /// `;`: a section marker, `ENDSEC;`.
    Semicolon,
    /// Either: `DATA;` and the ISO 10303-21 ed.3 `DATA('name',(...));`.
    ParenOrSemicolon,
}

/// Where [`find_keyword_then`] found a keyword.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct KeywordHit {
    /// Offset of the keyword's first byte.
    pub start: usize,
    /// Offset of the `(` or `;` that followed it.
    pub then: usize,
}

fn is_ident(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Find `keyword` (ASCII case-insensitive, on identifier boundaries on both
/// sides) outside literals and comments, followed after trivia by the byte
/// `then` asks for. A keyword followed by something else is skipped:
/// `FILE_SCHEMA` in prose is not the record, and `DATA` in `METADATA;` is not
/// the marker.
///
/// `None` when no such keyword occurs before the window ends or before a
/// comment that never closes.
pub fn find_keyword_then(haystack: &[u8], keyword: &[u8], then: Then) -> Option<KeywordHit> {
    let len = haystack.len();
    let (&lead, _) = keyword.split_first()?;
    if keyword.len() > len {
        return None;
    }
    let mut i = 0;
    while i + keyword.len() <= len {
        let b = haystack[i];
        if b == b'\'' {
            i = step_string_literal_end(haystack, i).unwrap_or(len);
            continue;
        }
        if b == b'/' && haystack.get(i + 1) == Some(&b'*') {
            i = skip_step_comment(haystack, i)?;
            continue;
        }
        let end = i + keyword.len();
        if b.eq_ignore_ascii_case(&lead)
            && (i == 0 || !is_ident(haystack[i - 1]))
            && haystack[i..end].eq_ignore_ascii_case(keyword)
            && (end == len || !is_ident(haystack[end]))
        {
            let at = skip_step_trivia(haystack, end)?;
            let wanted = match haystack.get(at) {
                Some(b'(') => matches!(then, Then::Paren | Then::ParenOrSemicolon),
                Some(b';') => matches!(then, Then::Semicolon | Then::ParenOrSemicolon),
                _ => false,
            };
            if wanted {
                return Some(KeywordHit { start: i, then: at });
            }
        }
        i += 1;
    }
    None
}

/// Offset of the `)` that closes the `(` at `open`, outside literals and
/// comments, or `None` when the list never closes.
pub fn close_paren(haystack: &[u8], open: usize) -> Option<usize> {
    let len = haystack.len();
    let mut depth = 0usize;
    let mut i = open;
    while i < len {
        match haystack[i] {
            b'\'' => {
                i = step_string_literal_end(haystack, i)?;
                continue;
            }
            b'/' if haystack.get(i + 1) == Some(&b'*') => {
                i = skip_step_comment(haystack, i)?;
                continue;
            }
            b'(' => depth += 1,
            b')' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}
