// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Where a `#id=TYPE(args);` record's parts sit in its text: the one reader
//! every STEP writer in this crate frames a record with before it edits one
//! (#7682, EXPORT-STEP-1).
//!
//! ISO 10303-21 allows trivia (whitespace, including vertical tab and form
//! feed, and `/* ... */` comments) wherever whitespace may go, so
//! `#5=IFCWALL(...) ;` and `#5=IFCWALL(...) /* c */;` are records like any
//! other. The writers used to find the frame each their own way, and the ones
//! that looked for a literal `");"` read those records as no record at all:
//! every named, positional and retype edit on them was dropped and nothing
//! counted it, while a sibling reader in the same pass edited the same line
//! fine. Trivia is read by core's rule ([`skip_step_trivia`],
//! [`is_step_space`]), the one the scanner that found the record uses.
//!
//! The TypeScript twin is `packages/export/src/step-record-frame.ts`; the two
//! are changed together and pinned by the shared parity vectors in
//! `tests/fixtures/step_log_parity_vectors.json`.
//!
//! The close is found from the END, the way the writers found it before: the
//! last `)` that only trivia and one `;` follow. A forward scan would have to
//! trust the record's string literals, and a record with an undoubled
//! apostrophe would then have no frame at all, where it now has one whose
//! argument list the slot splitter refuses and the caller reports as
//! unreadable. The candidate found walking back is then checked forward with
//! the core rule, so a frame returned is always one the scanner agrees with.

use ifc_lite_core::parser::{is_step_space, skip_step_trivia};

/// `#id=TYPE(`: everything a record's head says, as byte offsets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RecordHead {
    /// The `=` after the instance name.
    pub(crate) eq: usize,
    /// The type keyword, `type_start..type_end`.
    pub(crate) type_start: usize,
    pub(crate) type_end: usize,
    /// The `(` that opens the argument list.
    pub(crate) open: usize,
}

/// A whole record: its head, the `)` that closes the argument list, and the
/// `;` that ends the record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RecordFrame {
    pub(crate) head: RecordHead,
    pub(crate) close: usize,
    pub(crate) semi: usize,
}

impl RecordHead {
    /// The type keyword as written.
    pub(crate) fn type_name<'t>(&self, text: &'t str) -> &'t str {
        &text[self.type_start..self.type_end]
    }
}

impl RecordFrame {
    /// The text between the argument list's parentheses.
    pub(crate) fn args<'t>(&self, text: &'t str) -> &'t str {
        &text[self.head.open + 1..self.close]
    }

    /// `text` with its argument list replaced, every other byte kept.
    pub(crate) fn with_args(&self, text: &str, args: &str) -> String {
        format!("{}{args}{}", &text[..=self.head.open], &text[self.close..])
    }
}

fn is_keyword_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// The record's head, or `None` when `text` does not open as
/// `#digits = KEYWORD (`, trivia allowed around the `=` and before the `(`.
pub(crate) fn record_head(text: &str) -> Option<RecordHead> {
    let b = text.as_bytes();
    let mut i = skip_step_trivia(b, 0)?;
    if b.get(i) != Some(&b'#') {
        return None;
    }
    i += 1;
    let digits = i;
    while b.get(i).is_some_and(u8::is_ascii_digit) {
        i += 1;
    }
    if i == digits {
        return None;
    }
    let eq = skip_step_trivia(b, i)?;
    if b.get(eq) != Some(&b'=') {
        return None;
    }
    let type_start = skip_step_trivia(b, eq + 1)?;
    let mut type_end = type_start;
    while b.get(type_end).is_some_and(|&c| is_keyword_byte(c)) {
        type_end += 1;
    }
    if type_end == type_start {
        return None;
    }
    let open = skip_step_trivia(b, type_end)?;
    (b.get(open) == Some(&b'(')).then_some(RecordHead { eq, type_start, type_end, open })
}

/// Where a trailing comment that ends just before `k` (with `*/`) starts. A
/// comment cannot hold `*/`, so it opens at one of the `/*` after the
/// previous `*/`: the nearest one ([`Opener::Nearest`]) unless the comment
/// itself holds a `/*`, else the first one ([`Opener::First`]) unless a
/// string in the record body holds a `*/` and a `/*`. Neither guess is
/// trusted: [`record_frame`] tries both and keeps the one the forward check
/// confirms.
#[derive(Clone, Copy)]
enum Opener {
    Nearest,
    First,
}

fn comment_start(b: &[u8], end: usize, opener: Opener) -> Option<usize> {
    let body = &b[..end];
    match opener {
        Opener::Nearest => body.windows(2).rposition(|w| w == b"/*"),
        Opener::First => {
            let floor = body.windows(2).rposition(|w| w == b"*/").map_or(0, |p| p + 2);
            body[floor..].windows(2).position(|w| w == b"/*").map(|p| floor + p)
        }
    }
}

/// Walk back over trivia ending just before `k`.
fn trivia_back(b: &[u8], mut k: usize, opener: Opener) -> usize {
    loop {
        while k > 0 && is_step_space(b[k - 1]) {
            k -= 1;
        }
        if k < 4 || &b[k - 2..k] != b"*/" {
            return k;
        }
        match comment_start(b, k - 2, opener) {
            Some(start) => k = start,
            None => return k,
        }
    }
}

fn frame_with(b: &[u8], head: RecordHead, opener: Opener) -> Option<RecordFrame> {
    let semi = trivia_back(b, b.len(), opener).checked_sub(1)?;
    if b[semi] != b';' {
        return None;
    }
    let close = trivia_back(b, semi, opener).checked_sub(1)?;
    if close <= head.open || b[close] != b')' {
        return None;
    }
    // The walk back is a guess about where the trailing comments begin; the
    // core rule, run forward, is what decides it.
    let verified = skip_step_trivia(b, close + 1) == Some(semi) && skip_step_trivia(b, semi + 1) == Some(b.len());
    verified.then_some(RecordFrame { head, close, semi })
}

/// The record's frame, or `None` when `text` is not one whole record:
/// [`record_head`], then a `)` that only trivia, one `;` and trivia follow.
pub(crate) fn record_frame(text: &str) -> Option<RecordFrame> {
    let head = record_head(text)?;
    let b = text.as_bytes();
    frame_with(b, head, Opener::Nearest).or_else(|| frame_with(b, head, Opener::First))
}

#[cfg(test)]
#[path = "step_record_frame_tests.rs"]
mod tests;
