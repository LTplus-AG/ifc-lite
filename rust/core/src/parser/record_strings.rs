// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Record-only quoted-value boundaries and forward recovery (#7541).
//! HEADER string decoding deliberately does not use this parameter grammar.

use super::lexical::{is_page_quote_operand, is_step_space, skip_step_comment, skip_step_trivia};

pub(super) enum QuoteBoundary {
    Close,
    WrappedEscape(usize),
    Invalid,
    Unreadable,
}

/// Call only after PAGE and immediate doubled-quote checks. A quoted STEP
/// parameter closes before ',' or ')', modulo trivia. Preserve the existing
/// line-wrapped doubled apostrophe convention without accepting arbitrary
/// quoted text concatenation or comments as an escape.
pub(super) fn quote_boundary(bytes: &[u8], quote: usize) -> QuoteBoundary {
    if matches!(bytes.get(quote + 1), Some(b',' | b')')) {
        return QuoteBoundary::Close;
    }
    let mut p = quote + 1;
    while matches!(bytes.get(p), Some(b'\r' | b'\n')) {
        p += 1;
    }
    if p > quote + 1 && bytes.get(p) == Some(&b'\'') {
        return QuoteBoundary::WrappedEscape(p + 1);
    }
    let Some(next) = skip_step_trivia(bytes, quote + 1) else { return QuoteBoundary::Unreadable };
    match bytes.get(next) {
        Some(b',' | b')') => QuoteBoundary::Close,
        _ => QuoteBoundary::Invalid,
    }
}

/// A delimiter-confirmed record literal, or refusal without inventing a value.
pub(super) fn skip_record_string(bytes: &[u8], opening: usize) -> Option<usize> {
    let mut p = opening + 1;
    while p < bytes.len() {
        p += memchr::memchr(b'\'', &bytes[p..])?;
        if is_page_quote_operand(bytes, p) { p += 1; continue; }
        if bytes.get(p + 1) == Some(&b'\'') { p += 2; continue; }
        match quote_boundary(bytes, p) {
            QuoteBoundary::Close => return Some(p + 1),
            QuoteBoundary::WrappedEscape(next) => p = next,
            QuoteBoundary::Invalid | QuoteBoundary::Unreadable => return None,
        }
    }
    None
}

/// Quote parity is corrupt after the offending apostrophe. First seek a
/// delimiter-confirmed end of that damaged value; do not trust anchors in
/// its text. Then skip complete subsequent quoted parameters before trusting
/// a line/semicolon-anchored declaration. Ambiguous/unclosed values refuse.
/// Each candidate/trivia/literal span advances the same cursor once.
pub(super) fn next_record_after_bad_quote(bytes: &[u8], quote: usize) -> usize {
    let mut p = quote + 1;
    let mut known_outside = false;
    let mut parameter_start = false;
    let mut anchored = false;
    while p < bytes.len() {
        let b = bytes[p];
        if !known_outside {
            if b != b'\'' { p += 1; continue; }
            if is_page_quote_operand(bytes, p) { p += 1; continue; }
            if bytes.get(p + 1) == Some(&b'\'') { p += 2; continue; }
            match quote_boundary(bytes, p) {
                QuoteBoundary::Close => { known_outside = true; p += 1; }
                QuoteBoundary::WrappedEscape(next) => p = next,
                QuoteBoundary::Invalid => p += 1,
                QuoteBoundary::Unreadable => return bytes.len(),
            }
        } else if b == b'\'' {
            if !parameter_start { return bytes.len(); }
            let Some(end) = skip_record_string(bytes, p) else { return bytes.len() };
            p = end;
            parameter_start = false;
            anchored = false;
        } else if b == b'/' && bytes.get(p + 1) == Some(&b'*') {
            let Some(end) = skip_step_comment(bytes, p) else { return bytes.len() };
            anchored |= bytes[p..end].iter().any(|b| matches!(b, b'\r' | b'\n'));
            p = end;
        } else if b == b'#' && anchored {
            let start = p;
            p += 1;
            let digits = p;
            while bytes.get(p).is_some_and(u8::is_ascii_digit) { p += 1; }
            if p == digits { anchored = false; parameter_start = false; continue; }
            let Some(end) = skip_step_trivia(bytes, p) else { return bytes.len() };
            if bytes.get(end) == Some(&b'=') { return start; }
            anchored = bytes[p..end].iter().any(|b| matches!(b, b'\r' | b'\n'));
            parameter_start = false;
            p = end;
        } else {
            if matches!(b, b'\r' | b'\n' | b';') { anchored = true; }
            else if !is_step_space(b) { anchored = false; }
            if !is_step_space(b) { parameter_start = matches!(b, b'(' | b','); }
            p += 1;
        }
    }
    bytes.len()
}
