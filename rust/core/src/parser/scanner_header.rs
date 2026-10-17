// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The STEP HEADER-skip used by [`super::EntityScanner`] to position past the
//! HEADER section before it starts looking for entities. Split out of
//! `scanner.rs` to keep that file under its module-size budget — this piece
//! is self-contained (one function, no scanner state) and has no reason to
//! live inline.

use crate::parser::header::{close_paren, find_keyword_then, Then, MAX_HEADER_BYTES};
use crate::parser::lexical::skip_step_trivia;

/// Locate the byte offset of the first character after `DATA;` (skipping the
/// STEP HEADER section). Returns 0 if the marker isn't found — partial files
/// without a HEADER still scan from the top.
///
/// Scanning the HEADER for entities is unsafe: the HEADER is a free-form
/// STEP record that legally contains arbitrary characters inside quoted
/// strings (filenames, descriptions). CATIA emits `FILE_NAME('…\X0\2#.ifc'…)`,
/// and a tokenizer that anchors on `#` will latch onto the in-string `#`,
/// flip `find_entity_end`'s quote parity, and drop the rest of the file.
/// See issue #654.
///
/// Quote-aware: the marker is only matched outside `'…'` strings, since a
/// HEADER field could legally contain the literal text `DATA;` in a
/// description or filename. Escaped single quotes (`''`) are treated as a
/// pair of in-string characters per ISO 10303-21.
///
/// The keyword is read by [`find_keyword_then`], the header reader's finder:
/// case-insensitive, on identifier boundaries (the `DATA` in `METADATA;` is
/// not the marker), with trivia allowed before the `;` (`DATA ;`), and the
/// ed.3 `DATA('name',(...));` form (CORE-9).
///
/// Comment-aware for the same reason: ISO 10303-21 allows a `/* … */`
/// comment wherever whitespace is allowed, the HEADER included, so a
/// commented-out `DATA;` is not the marker either. Matching one used to end
/// the search inside the comment, and every `#N=…` written after it in that
/// comment was then scanned as a real record.
///
/// An unterminated `/*` in the header gets the same answer as a missing
/// marker, 0: everything from that `/` on is inside the comment, so there is
/// no `DATA;` left to find. Answering 0 rather than skipping past the
/// comment is also what keeps the condition REPORTED — the scan then starts
/// at the top, [`super::EntityScanner::next_entity`] meets the same
/// unterminated `/*`, and [`super::lexical::skip_step_comment`] refusing it
/// marks `malformed_record_start` through the one channel #3699 added. It is
/// also what a headerless partial file needs: `#1=IFCWALL($); /* oops` has
/// real records BEFORE the bad comment, and they still scan.
pub(super) fn data_section_start(bytes: &[u8]) -> usize {
    // Cap the header scan. Real-world headers are <2 KB; an unbounded scan
    // here would defeat the point of an O(1)-up-front fix on giant files
    // that legitimately lack a HEADER section. One cap, shared with the
    // header reader.
    let window = &bytes[..bytes.len().min(MAX_HEADER_BYTES)];
    let Some(hit) = find_keyword_then(window, b"DATA", Then::ParenOrSemicolon) else {
        return 0;
    };
    if window[hit.then] == b';' {
        return hit.then + 1;
    }
    // ISO 10303-21 ed.3: `DATA('name',(schema, ...));`. The marker is the
    // balanced list and the `;` after it.
    let after = close_paren(window, hit.then).and_then(|close| skip_step_trivia(window, close + 1));
    match after {
        Some(semicolon) if window.get(semicolon) == Some(&b';') => semicolon + 1,
        _ => 0,
    }
}
