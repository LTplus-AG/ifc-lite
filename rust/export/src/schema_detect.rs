// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Read the schema a STEP file DECLARES, out of its raw bytes.
//!
//! Split out of `step_text.rs`, which is about editing STEP text. This is about
//! reading one fact out of it before anything is parsed, and the two have
//! different hazards: everything here runs on whole uncapped attacker-supplied
//! files, before any structure is known to exist.
//!
//! The sibling reader is `source_header::parse_source_header`, which answers
//! the same question from the same bytes and does it better (see #3303). This
//! one exists because it runs earlier and without the 64 KiB cap.

use crate::source_header::Lex;

/// Index of `needle` in `haystack`, skipping any occurrence that sits inside a
/// quoted STEP string literal or a `/* ... */` comment.
///
/// Case-SENSITIVE, where `source_header::find_ascii_ci_from` is not. ISO
/// 10303-21 keywords are case-insensitive, so a file spelling `endsec;` in
/// lower case ends its header in one of these readers and not the other. That
/// is a real divergence and it predates the comment handling here; it is
/// tracked in #3303 rather than changed in passing, because widening this match
/// changes where every header ends and wants its own corpus.
///
/// Neither literals nor comments carry structure, and this drives
/// `detect_schema`, which drives schema CONVERSION on export. So a comment read
/// as structure here does not lose a field, it converts the file to the wrong
/// schema: `/* was FILE_SCHEMA(('IFC2X3')); */` on a commented-out line
/// answered IFC2X3 for an IFC4X3 file.
///
/// The rule is `source_header::skip_lexical_at`, shared rather than copied, and
/// it handles the `''` escape by consuming a literal whole instead of toggling
/// a flag per apostrophe.
///
/// Linear in `haystack.len()`, and that is not free here. An unterminated
/// `/*` makes the naive form quadratic, and this function has no header cap,
/// so it can be handed a whole multi-megabyte file. What prevents it is the
/// `no_closer` memo on `source_header::Lex`: the closer search is deferred
/// until a `/*` is actually seen, and one failure proves no later `/*` can
/// open a comment either.
fn find_unquoted(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    let mut lex = Lex::new(haystack);
    let last_start = haystack.len() - needle.len();
    let mut i = 0;
    while i <= last_start {
        if let Some(end) = lex.skip_lexical_at(i) {
            i = end;
            continue;
        }
        if haystack[i..i + needle.len()] == *needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Detect the source `FILE_SCHEMA` label (e.g. `IFC2X3`); defaults to `IFC4`.
pub(crate) fn detect_schema(content: &[u8]) -> String {
    // Only look in the header region: from the start through the HEADER
    // section's closing `ENDSEC;`. A fixed byte cutoff is not safe here —
    // an earlier header field (e.g. a long DESCRIPTION or AUTHOR string)
    // can push FILE_SCHEMA past any fixed budget, silently falling back to
    // the IFC4 default and applying the wrong schema conversion. Scan for
    // the actual section terminator instead; if it's missing (malformed
    // input), fall back to scanning the whole buffer.
    //
    // Both this ENDSEC; search and the FILE_SCHEMA search below must be
    // quote-aware: a header field's plain-text string VALUE (e.g. a
    // DESCRIPTION or AUTHOR carrying the literal text "ENDSEC;" or
    // "FILE_SCHEMA") is not the section terminator or the schema entry, and
    // a raw byte search cannot tell the difference.
    let head_len = find_unquoted(content, b"ENDSEC;")
        .map(|idx| idx + b"ENDSEC;".len())
        .unwrap_or(content.len());
    let head = &content[..head_len];
    if let Some(idx) = find_unquoted(head, b"FILE_SCHEMA") {
        // The KEYWORD search skips comments, but the label search after it has
        // to as well, and for a while it did not: the first apostrophe inside a
        // comment was taken as the label's opening quote. Two ways that showed
        // up, both with the comment AFTER the keyword, which is why the tests
        // for this now put it there -- a comment on its own line before
        // FILE_SCHEMA is handled by the keyword search alone and proves
        // nothing about this half:
        //
        //   FILE_SCHEMA /* was 'IFC2X3' */ (('IFC4X3'));  ->  "IFC2X3"
        //   FILE_SCHEMA /* Jane's */ (('IFC4X3'));        ->  "s */ (("
        //
        // The first converts the file to the wrong schema. The second writes
        // that garbage into the exported header, since the label goes straight
        // to `escape()` when the header is re-written.
        //
        // Scanned as bytes rather than through `from_utf8_lossy`, so an offset
        // here means the same thing it means in `head`.
        //
        // Bounded to the FILE_SCHEMA record. An unbounded scan takes the
        // first apostrophe anywhere after the keyword, so a record with no
        // label at all borrows the next record's first string:
        //
        //   FILE_SCHEMA(());
        //   FILE_NAME('leak.ifc', ...);   ->  schema "leak.ifc"
        //
        // which is then written into the exported header through `escape()`.
        // Same failure as the comment case below, one bracket further out.
        let tail = &head[idx..];
        let mut lex = Lex::new(tail);
        let mut i = 0;
        let mut depth = 0i32;
        let mut open = None;
        while i < tail.len() {
            if tail[i] == b'\'' {
                open = Some(i);
                break;
            }
            if let Some(end) = lex.skip_lexical_at(i) {
                i = end; // a comment: its apostrophes are not the label's
                continue;
            }
            match tail[i] {
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    // `<= 0` rather than `== 0`: a stray leading `)` puts depth
                    // at -1, which `== 0` can never bring back, so the scan ran
                    // on into the next record and the bound did nothing.
                    if depth <= 0 {
                        break;
                    }
                }
                // A record with no parens at all never raises depth, so without
                // this the terminator is not a stop and `FILE_SCHEMA;` borrows
                // the next record's first string just as the unbounded scan did.
                b';' if depth == 0 => break,
                _ => {}
            }
            i += 1;
        }
        if let Some(q1) = open {
            // `''` is an escaped apostrophe, not the end of the literal. Taking
            // the first `'` read `FILE_SCHEMA(('IFC''4X3'))` as `IFC`, where
            // both header readers say `IFC'4X3`.
            //
            // The `end > q1 + 1` guard is load-bearing. `skip_lexical_at`
            // answers an UNTERMINATED literal with the buffer length, not
            // "closing quote + 1", so a file truncated inside its schema label
            // made `end - 1` an index one short of where the label starts.
            // That underflowed in debug and panicked on the slice in release,
            // on the export path, on attacker-supplied bytes. A truncated label
            // is no label.
            let end = lex.skip_lexical_at(q1).unwrap_or(q1 + 1);
            let closed = end > q1 + 1 && tail.get(end - 1) == Some(&b'\'');
            if let Some(label) = closed.then(|| String::from_utf8_lossy(&tail[q1 + 1..end - 1])) {
                if !label.is_empty() {
                    // `label` is the RAW, still-STEP-escaped slice between the
                    // quotes. Both call sites (`step.rs`'s `source_schema`
                    // fallback and `merged.rs`) feed this straight into
                    // `escape()` when the header is re-written, which doubles
                    // `\` again -- un-double it here first so a schema label
                    // carrying a literal `\` round-trips instead of being
                    // re-escaped on top of its own escaping. A no-op for every
                    // real schema label (IFC2X3, IFC4, IFC4X3_ADD2, ...), none
                    // of which contain a backslash.
                    // `''` gets the same treatment for the same reason. Without
                    // it the doubling compounds on every pass through the merge
                    // path: 'IFC''4' -> 'IFC''''4' -> 'IFC''''''''4'.
                    return label.replace("\\\\", "\\").replace("''", "'");
                }
            }
        }
    }
    "IFC4".to_string()
}

#[cfg(test)]
#[path = "schema_detect_tests.rs"]
mod tests;
