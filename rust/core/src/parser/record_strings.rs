// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Whether a quote closes a string parameter, and where a scan resumes when
//! one cannot have (#7541).
//!
//! An unescaped apostrophe (`'it's'` where 10303-21 needs `'it''s'`) flips a
//! scanner's in-string state. With a second one in a later record the state
//! flips back, so the first record is closed at the second one's `;` and every
//! record between them disappears with nothing reported. The #4179 rules
//! cannot see it: they judge bytes outside strings, and the state is inverted.
//!
//! What can see it is the byte after a closing quote. A string is a
//! parameter, so after trivia it is followed by `,` or `)`. Anything else
//! means the quote was text, and the record holding it is refused at that
//! quote, before any misaligned byte is read.
//!
//! The resume point is NOT the record's own `)`: the balance walk that finds
//! it reads strings with the same inverted state. It is the next declaration
//! that begins a line or follows a `;`, searched forward from the quote, so a
//! file of refusals costs its length. Both heuristics act only on a file that
//! is already invalid. The TypeScript halves are `stringParameterEnd` and
//! `resyncAtRecordStart` in `packages/parser/src/step-record-boundary.ts`, and
//! the Blob worker's copies in `scan-worker-lexing.ts`; change them together.

use super::lexical::skip_step_trivia;

/// What the quote at `quote` is, called only where it would close a string:
/// after the PAGE operand (#7540) and doubled-quote tests.
pub(super) enum QuoteEnd {
    /// It closes the string.
    Closes,
    /// It cannot close a parameter: an unescaped apostrophe.
    Stray,
    /// A comment opened after it never closes, so nothing after is readable.
    Unreadable,
}

/// One compare settles a real file: every closing quote in the tracked corpus
/// is followed directly by `,` or `)`. A quote after nothing but line breaks
/// is a `''` a writer wrapped (10303-21 clause 5.6 lets a line break fall
/// inside a token), so it closes here and the next quote reopens the string.
#[inline]
pub(super) fn string_parameter_end(bytes: &[u8], quote: usize) -> QuoteEnd {
    let after = quote + 1;
    if matches!(bytes.get(after), Some(b',' | b')')) {
        return QuoteEnd::Closes;
    }
    let mut wrap = after;
    while matches!(bytes.get(wrap), Some(b'\r' | b'\n')) {
        wrap += 1;
    }
    if wrap > after && bytes.get(wrap) == Some(&b'\'') {
        return QuoteEnd::Closes;
    }
    match skip_step_trivia(bytes, after) {
        None => QuoteEnd::Unreadable,
        Some(next) if matches!(bytes.get(next), Some(b',' | b')')) => QuoteEnd::Closes,
        Some(_) => QuoteEnd::Stray,
    }
}

/// The next `#<digits> =` after `from` that begins a line or follows a `;`
/// (spaces and tabs before it, line breaks after the `;`), or `bytes.len()`.
///
/// Forward only, and every byte is read a bounded number of times: only a `;`
/// skips line breaks, and a line break stops the skip of the anchor before it.
pub(super) fn resync_at_record_start(bytes: &[u8], from: usize) -> usize {
    let len = bytes.len();
    let mut p = from;
    while let Some(i) = memchr::memchr3(b'\n', b'\r', b';', &bytes[p.min(len)..]) {
        let anchor = bytes[p + i];
        p += i + 1;
        let mut q = p;
        while q < len
            && (matches!(bytes[q], b' ' | b'\t')
                || (anchor == b';' && matches!(bytes[q], b'\n' | b'\r')))
        {
            q += 1;
        }
        if declaration_at(bytes, q) {
            return q;
        }
    }
    len
}

/// Whether `#<digits> [spaces] =` starts at `q`. The caller validates the
/// rest of the declaration as it does for any other candidate.
fn declaration_at(bytes: &[u8], q: usize) -> bool {
    if bytes.get(q) != Some(&b'#') {
        return false;
    }
    let mut d = q + 1;
    while bytes.get(d).is_some_and(u8::is_ascii_digit) {
        d += 1;
    }
    if d == q + 1 {
        return false;
    }
    while matches!(bytes.get(d), Some(b' ' | b'\t')) {
        d += 1;
    }
    bytes.get(d) == Some(&b'=')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn end(text: &[u8], quote: usize) -> &'static str {
        match string_parameter_end(text, quote) {
            QuoteEnd::Closes => "closes",
            QuoteEnd::Stray => "stray",
            QuoteEnd::Unreadable => "unreadable",
        }
    }

    #[test]
    fn a_closing_quote_is_followed_by_a_separator_7541() {
        assert_eq!(end(b"'a',", 2), "closes");
        assert_eq!(end(b"'a')", 2), "closes");
        assert_eq!(end(b"'a' ,", 2), "closes");
        assert_eq!(end(b"'a'/* c */,", 2), "closes");
        assert_eq!(end(b"'a'\r\n,", 2), "closes");
        // A `''` wrapped by a line break.
        assert_eq!(end(b"'it'\n's'", 3), "closes");
        assert_eq!(end(b"'it'\r\n's'", 3), "closes");
        assert_eq!(end(b"'it's',", 3), "stray");
        assert_eq!(end(b"'a';", 2), "stray");
        assert_eq!(end(b"'a' (", 2), "stray");
        assert_eq!(end(b"'a'", 2), "stray");
        assert_eq!(end(b"'a' /* never closes", 2), "unreadable");
    }

    #[test]
    fn resync_finds_only_anchored_declarations_7541() {
        let text = b"s',$);\n#21=X($);";
        assert_eq!(resync_at_record_start(text, 0), 7);
        assert_eq!(resync_at_record_start(b"x;#5 =A;", 0), 2);
        assert_eq!(resync_at_record_start(b"x;\r\n  #5=A;", 0), 6);
        // Not anchored, not a declaration, or nothing left.
        assert_eq!(resync_at_record_start(b"x #5=A;", 0), 7);
        assert_eq!(resync_at_record_start(b"x\n#5 3;", 0), 7);
        assert_eq!(resync_at_record_start(b"x\n#=A", 0), 5);
        assert_eq!(resync_at_record_start(b"", 0), 0);
    }
}
