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
