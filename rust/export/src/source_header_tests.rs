// SPDX-License-Identifier: MPL-2.0
//! Tests for `source_header.rs`, split out under the house pattern (AGENTS.md).
//!
//! `parse_source_header` itself is covered end to end from
//! `tests/source_header_comments.rs`, which is where a reader should look
//! first. This file is for the things that are `pub(crate)` and so cannot be
//! reached from an integration test, which today means `Lex`.

use super::*;

#[test]
fn the_comment_scan_stays_linear_on_hostile_input() {
    // The property, not the timing. Searching at every `/*` is quadratic: a
    // failing search runs to the end of the buffer, the caller advances one
    // byte, and the next `/*` repeats it. This side is handed whole uncapped
    // files by `detect_schema`, so it is the worse half.
    //
    // One failure proves no closer exists at or after any later position, and
    // the scan only moves forward, so at most one search can ever fail and none
    // should happen after it. Asserting the count pins that without a
    // wall-clock threshold that would flake on a loaded machine.
    //
    // `/*` repeated would OVERLAP into `*/` and terminate itself, so the opens
    // are spaced. The TypeScript twin of this test caught that fixture bug.
    let hostile = format!("HEADER;\n{}\nFILE_SCHEMA;", "/* ".repeat(1000));
    assert!(!hostile.contains("*/"));
    let mut lex = Lex::new(hostile.as_bytes());
    let mut i = 0;
    while i < hostile.len() {
        match lex.skip_lexical_at(i) {
            Some(end) if end > i => i = end,
            _ => i += 1,
        }
    }
    assert_eq!(lex.searches, 1, "one failed search should silence the rest");

    // The memo must not fire early: 500 real comments, none unterminated, so
    // every search succeeds and each consumes a span the others do not.
    let packed = format!("HEADER;\n{}FILE_SCHEMA;", "/*x*/".repeat(500));
    let mut lex = Lex::new(packed.as_bytes());
    let (mut i, mut skipped) = (0usize, 0u32);
    while i < packed.len() {
        match lex.skip_lexical_at(i) {
            Some(end) if end > i => {
                skipped += 1;
                i = end;
            }
            _ => i += 1,
        }
    }
    assert_eq!(skipped, 500);
    assert_eq!(lex.searches, 500);
}
