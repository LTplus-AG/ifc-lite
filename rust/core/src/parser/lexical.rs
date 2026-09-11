// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The STEP `/* ... */` comment-skip rule -- and, on top of it, the trivia
//! rule that says a comment is legal wherever whitespace is -- shared by every
//! scanner that has no reason to answer an unterminated comment differently
//! from the others.
//!
//! [`skip_step_comment`] answers an unterminated `/*` by refusing it: it
//! returns `None`, the same as "not a comment here" from the caller's point
//! of view. That is correct for a scanner walking already-located,
//! well-formed record bytes looking for structure — an unterminated comment
//! there means the input is corrupt, and silently consuming the rest of it
//! is worse than stopping. [`super::scanner::EntityScanner`] and
//! `ifc-lite-geometry`'s `IfcTriangulatedFaceSet` CoordIndex walk both used
//! to hand-roll this and disagreed with each other on exactly this case
//! (issue #3303); both now call this one function.
//!
//! `ifc-lite-export`'s STEP HEADER prescan (`source_header::Lex`) answers the
//! same question differently, on purpose, and that is not the divergence
//! #3303 is about: a header prescan that swallows every later record has
//! lost the schema, so it treats an unterminated `/*` as ordinary text
//! instead of refusing. See the doc comment on `Lex::skip_comment_at` for
//! why that call site needs its own answer. It still calls this function to
//! find where a *closed* comment ends — only the unterminated case is
//! handled differently, and only at that one call site.

/// If a STEP `/* ... */` comment starts at `bytes[i]`, the index just past
/// its closing `*/`.
///
/// Returns `None` when `bytes[i]` doesn't begin a comment, and ALSO when it
/// does but no closing `*/` exists anywhere in `bytes` after it — an
/// unterminated comment is refused rather than silently run to end of input.
/// A caller that needs to tell those two `None` cases apart already knows
/// which one it's in, from having checked `bytes[i..i + 2] == b"/*"` itself
/// before calling (as every call site in this repo does), so the single
/// `Option` return doesn't lose information.
#[inline]
pub fn skip_step_comment(bytes: &[u8], i: usize) -> Option<usize> {
    if bytes.get(i) != Some(&b'/') || bytes.get(i + 1) != Some(&b'*') {
        return None;
    }
    let len = bytes.len();
    let mut p = i + 2;
    while p + 1 < len {
        // Find the next '*'; check whether it's followed by '/'.
        let star = match memchr::memchr(b'*', &bytes[p..]) {
            Some(off) => p + off,
            None => return None, // unterminated comment
        };
        if star + 1 < len && bytes[star + 1] == b'/' {
            return Some(star + 2);
        }
        p = star + 1;
    }
    None // unterminated comment
}

/// Index of the first byte at or after `i` that is neither ASCII whitespace
/// nor part of a `/* ... */` comment.
///
/// ISO 10303-21 allows a comment ANYWHERE whitespace is allowed, which
/// includes inside a record: between an instance name and its `=`, between the
/// `=` and the type name, and between the type name and its `(`. A scanner
/// that skips only whitespace at those points reads
/// `#1 /* was #7 */ = IFCWALL(…);` as no record at all.
///
/// `None` when a comment opens here and never closes — everything from there
/// to the end of `bytes` is inside it, so there is nothing left to find. That
/// is [`skip_step_comment`]'s answer, deliberately, and not a separate rule.
///
/// This is the matched pair of `skipTrivia` in
/// `packages/parser/src/step-lexing.ts`; the two halves are changed together.
#[inline]
pub fn skip_step_trivia(bytes: &[u8], i: usize) -> Option<usize> {
    let len = bytes.len();
    let mut p = i;
    loop {
        while p < len && is_step_space(bytes[p]) {
            p += 1;
        }
        if bytes.get(p) != Some(&b'/') || bytes.get(p + 1) != Some(&b'*') {
            return Some(p);
        }
        p = skip_step_comment(bytes, p)?;
    }
}

/// ASCII whitespace per ISO 10303-21: space, tab, LF, CR, form feed, vertical
/// tab.
///
/// Spelled out rather than `u8::is_ascii_whitespace`, which follows the
/// WhatWG Infra Standard's definition and EXCLUDES vertical tab (0x0B) — its
/// docs say as much. `ifc-lite-export`'s `source_header::is_step_space`
/// already carries this exact set for this exact reason (see its doc
/// comment): reaching for a stdlib predicate here once mismatched the
/// TypeScript half's `isSpaceByte`/`isAsciiSpace` on `\x0B` and, before that
/// mismatch was found, TypeScript's `isSpaceByte` itself omitted both `\x0C`
/// and `\x0B` — issue #3733, a form feed silently dropping an entity that
/// this scanner parsed. Keep this set and `isSpaceByte` in
/// `packages/parser/src/step-lexing.ts` identical.
#[inline]
pub fn is_step_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
}

/// Where a refused record ends, and whether anything after it can be read.
///
/// The two failures are separate because they call for opposite answers. A
/// record whose parens never balance (`#2=IFCB(2;`) still leaves the rest of
/// the file readable, so a scan drops that ONE record and hunts on; one whose
/// literal or comment never closes puts everything to end of input inside it,
/// so there is nothing to resume from and the scan stops (#3695). Collapsing
/// them cost the whole tail of the file for a missing `)`, which is the same
/// amplification #4179 is about.
#[derive(Debug, PartialEq, Eq)]
pub enum RecordClose {
    /// Offset just past the `)` balancing the record's `(`.
    At(usize),
    /// No balancing `)`, but every literal and comment closed.
    Unbalanced,
    /// A literal or comment opened and never closed.
    Unreadable,
}

/// Whether the last significant byte of `plain` is `')'`, or `carried` when
/// `plain` holds nothing but STEP whitespace (so the answer stands from before
/// it). The cheap half of the record-boundary rule argued on
/// [`close_step_record`]; walks backwards, stopping on the first byte for
/// every real record.
#[inline]
pub fn closes_with_paren(plain: &[u8], carried: bool) -> bool {
    match plain.iter().rev().find(|b| !is_step_space(**b)) {
        Some(&b) => b == b')',
        None => carried,
    }
}

/// Offset just past the `)` that balances the first `(` in `bytes`, or `None`
/// when the input runs out, a comment or literal never closes, or a `)`
/// arrives before any `(`.
///
/// # Where a STEP record ends, and whether a `;` is its own (#4179)
///
/// This doc is the one argument for a rule four scans implement:
/// [`EntityScanner::find_entity_end`](super::scanner) and this function in
/// Rust, `StepTokenizer.scanEntitiesFast` (`packages/parser/src/tokenizer.ts`)
/// with `packages/parser/src/step-record-boundary.ts` in TypeScript, and
/// `WORKER_CODE` (`packages/parser/src/scan-worker-source.ts`), which
/// hand-duplicates it because a Blob worker cannot import at runtime. Rust is
/// the source of truth per AGENTS.md; the halves are changed together.
///
/// ## The two rules
///
/// A "skip to the next unquoted `;`" scan is bounded only by end-of-buffer, so
/// a record missing its own `;` takes the first `;` it can reach — the NEXT
/// record's, or the footer's — reporting success while swallowing whatever lay
/// between. Two rules read off the ISO 10303-21 grammar bound it to the
/// record's own body:
///
///   * `simple_record` is `keyword '(' [parameter_list] ')'`, so the last
///     significant byte before the terminator is always `')'`. A `;` preceded
///     by anything else, as in `#2=IFCWALL('b')\nENDSEC;`, is the footer's.
///   * `'='` appears in the exchange structure only in
///     `entity_instance_name '=' record`, never inside a parameter list, so
///     one before the terminator, as in `#2=IFCB(2)\n#3=IFCC(3);`, means the
///     scan walked into the NEXT declaration.
///
/// Both are judged only on bytes outside strings and comments: an `=` in
/// either is text, and a comment between the `)` and the `;` is trivia.
///
/// The two are a cheap approximation of one general property — *the `;` is the
/// first non-trivia byte after the `)` balancing the record's own `(`* — which
/// is what THIS function computes exactly. The approximation is deliberate:
/// the exact rule costs a full paren balance per record on the hottest
/// structural path, so it runs only where a byte test already refused. It is
/// strictly weaker, and admits shapes the exact rule rejects, `#2=IFCB(2) (3);`
/// among them.
///
/// ## Why a refusal RECOVERS instead of stopping
///
/// 10303-21 closes every record's parameter list, so the `)` this function
/// finds is a real grammar boundary even when the `;` after it is missing.
/// That lets the scan drop the ONE broken record and carry on. The rest of the
/// file is not the malformed record's to take: a shard whose scanner stops
/// hands back no handoff, and both stitches — `stitchShards`
/// (`packages/geometry/src/shard-stitch.ts`) and the native
/// `parallel_scan::stitch` — read that as "no more real entities" and discard
/// every LATER shard, including bytes those shards already scanned cleanly.
/// Measured on a 40-record file whose #20 lost its `;`, at four shards: 40
/// records in, 19 out. An unterminated string or comment has no such `)`,
/// nothing to resume from, so that case still stops as #3695 set it.
///
/// A string literal is jumped whole and a `/* … */` comment after it, in that
/// order, so a `(` or `)` inside either is text; the same rule and the same
/// order the scanner's own body walk uses. The matched TypeScript half is
/// `findEntityLength` in `packages/parser/src/step-lexing.ts`.
pub fn close_step_record(bytes: &[u8]) -> RecordClose {
    let mut pos = 0;
    let mut depth = 0u32;
    while pos < bytes.len() {
        match bytes[pos] {
            b'\'' => {
                pos += 1;
                loop {
                    match memchr::memchr(b'\'', &bytes[pos..]) {
                        Some(off) => pos += off + 1,
                        None => return RecordClose::Unreadable,
                    }
                    // A doubled '' is an escaped quote: still inside.
                    if bytes.get(pos) != Some(&b'\'') {
                        break;
                    }
                    pos += 1;
                }
            }
            b'/' if bytes.get(pos + 1) == Some(&b'*') => match skip_step_comment(bytes, pos) {
                Some(next) => pos = next,
                None => return RecordClose::Unreadable,
            },
            b'(' => {
                depth += 1;
                pos += 1;
            }
            b')' => {
                match depth.checked_sub(1) {
                    Some(d) => depth = d,
                    // A ')' before any '(' is not this record's close, but it
                    // closed nothing either, so the bytes after are readable.
                    None => return RecordClose::Unbalanced,
                }
                pos += 1;
                if depth == 0 {
                    return RecordClose::At(pos);
                }
            }
            _ => pos += 1,
        }
    }
    RecordClose::Unbalanced
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trivia_skips_a_run_of_whitespace_and_comments() {
        let bytes = b"  /* a */\t/* b */\n = X";
        let end = skip_step_trivia(bytes, 0).expect("every comment closes");
        assert_eq!(&bytes[end..], b"= X");
    }

    #[test]
    fn trivia_stops_on_the_first_non_trivia_byte() {
        assert_eq!(skip_step_trivia(b"=X", 0), Some(0));
        // A lone '/' is STEP division, not a comment opener, so trivia ends.
        assert_eq!(skip_step_trivia(b" /2", 0), Some(1));
    }

    #[test]
    fn trivia_refuses_an_unterminated_comment() {
        assert_eq!(skip_step_trivia(b" /* never closes", 0), None);
    }

    /// Issue #3733: form feed (0x0C) and vertical tab (0x0B) are both trivia.
    /// `u8::is_ascii_whitespace` (the WhatWG set) includes the former and
    /// excludes the latter, which is exactly the shape of bug this guards --
    /// see `is_step_space`'s doc comment.
    #[test]
    fn trivia_skips_form_feed_and_vertical_tab() {
        assert_eq!(skip_step_trivia(b"\x0c=X", 0), Some(1));
        assert_eq!(skip_step_trivia(b"\x0b=X", 0), Some(1));
        assert_eq!(skip_step_trivia(b"\x0c\x0b =X", 0), Some(3));
    }

    #[test]
    fn closed_comment_skips_to_after_close() {
        let bytes = b"/* hello #77 */rest";
        assert_eq!(skip_step_comment(bytes, 0), Some(15));
        assert_eq!(&bytes[15..], b"rest");
    }

    #[test]
    fn adjacent_asterisks_inside_a_comment_do_not_confuse_the_scan() {
        let bytes = b"/* a ** weird *comment* */tail";
        let end = skip_step_comment(bytes, 0).expect("comment is closed");
        assert_eq!(&bytes[end..], b"tail");
    }

    #[test]
    fn unterminated_comment_is_refused() {
        assert_eq!(skip_step_comment(b"/* never closes", 0), None);
        assert_eq!(skip_step_comment(b"/*", 0), None);
        assert_eq!(skip_step_comment(b"/* trailing star *", 0), None);
    }

    #[test]
    fn close_step_record_finds_the_balancing_paren() {
        // Offset is just PAST the ')', which is where a scan resumes.
        assert_eq!(close_step_record(b"IFCWALL($);rest"), RecordClose::At(10));
        assert_eq!(close_step_record(b"IFCWALL(('a'),(1.,2.))\ntail"), RecordClose::At(22));
        // A paren inside a literal or a comment is text, not depth.
        assert_eq!(close_step_record(b"IFCWALL('a)b');"), RecordClose::At(14));
        assert_eq!(close_step_record(b"IFCWALL('a''(b');"), RecordClose::At(16));
        assert_eq!(close_step_record(b"IFCWALL(/* ) ( */$);"), RecordClose::At(19));
        // Nothing to resume from: the stop the #3695 cluster relies on.
        assert_eq!(close_step_record(b"IFCWALL('never closes"), RecordClose::Unreadable);
        assert_eq!(close_step_record(b"IFCWALL(/* never closes"), RecordClose::Unreadable);
        // Readable, just never balanced: a scan may drop the record and hunt on.
        assert_eq!(close_step_record(b"IFCWALL($"), RecordClose::Unbalanced);
        assert_eq!(close_step_record(b"IFCWALL(2;#3=IFCC(3);"), RecordClose::Unbalanced);
        // A ')' before any '(' must not underflow.
        assert_eq!(close_step_record(b")))"), RecordClose::Unbalanced);
    }

    #[test]
    fn not_a_comment_at_all() {
        assert_eq!(skip_step_comment(b"/x not a comment", 0), None);
        assert_eq!(skip_step_comment(b"/", 0), None);
        assert_eq!(skip_step_comment(b"", 0), None);
    }
}
