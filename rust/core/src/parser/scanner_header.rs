// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The STEP HEADER-skip used by [`super::EntityScanner`] to position past the
//! HEADER section before it starts looking for entities. Split out of
//! `scanner.rs` to keep that file under its module-size budget — this piece
//! is self-contained (one function, no scanner state) and has no reason to
//! live inline.

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
    const MARKER: &[u8] = b"DATA;";
    let len = bytes.len();
    if len < MARKER.len() {
        return 0;
    }
    // Cap the header scan. Real-world headers are <2 KB; an unbounded scan
    // here would defeat the point of an O(1)-up-front fix on giant files
    // that legitimately lack a HEADER section.
    let limit = len.min(1 << 18); // 256 KB
    let mut pos = 0;
    let mut in_string = false;
    while pos < limit {
        let b = bytes[pos];
        if in_string {
            if b == b'\'' {
                if pos + 1 < limit && bytes[pos + 1] == b'\'' {
                    pos += 2; // escaped quote
                    continue;
                }
                in_string = false;
            }
            pos += 1;
            continue;
        }
        if b == b'/' && bytes.get(pos + 1) == Some(&b'*') {
            // Bounded to the same cap as the marker search: a `*/` past the
            // cap could not change the answer (pos would leave the loop at 0)
            // and the unterminated arm already answers 0.
            match super::super::lexical::skip_step_comment(&bytes[..limit], pos) {
                Some(next) => {
                    pos = next;
                    continue;
                }
                // Unterminated: nothing after this is outside the comment.
                None => return 0,
            }
        }
        if b == b'\'' {
            in_string = true;
            pos += 1;
            continue;
        }
        if b == b'D' && pos + MARKER.len() <= len && &bytes[pos..pos + MARKER.len()] == MARKER {
            return pos + MARKER.len();
        }
        pos += 1;
    }
    0
}
