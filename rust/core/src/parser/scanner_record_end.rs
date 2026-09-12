// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `EntityScanner::find_entity_end`, the record-terminator walk.
//!
//! A sibling file for the same reason `scanner_header.rs`,
//! `scanner_attributes.rs` and `scanner_diagnostics.rs` are: `scanner.rs` is
//! at its `module_size_ratchet` budget. This walk reads ONE already-located
//! record body looking for its `;`, where `next_entity` hunts the next
//! declaration, and the #4179 record-boundary rules it implements are argued
//! next door in `lexical.rs` beside the exact walk they approximate.

impl<'a> super::EntityScanner<'a> {
    /// Offset of the record's terminating `;` from the start of the slice.
    ///
    /// `memchr3` jumps straight to the next quote, semicolon or `=` in one
    /// SIMD pass, so a string-free geometry primitive
    /// (`#7=IFCCARTESIANPOINT((1.,2.,3.));`), the overwhelming majority of
    /// records, resolves in one vectorized hop rather than a per-byte loop.
    /// A comment opener is then looked for only in the plain span before the
    /// hit, and a comment is consumed whole, which is what makes a `/*` inside
    /// a literal text and a `;` or quote inside a comment text:
    /// `#1=IFCWALL('a', /* p; q */ $);` is legal 10303-21 and used to come
    /// back truncated at that inner `;`.
    ///
    /// Returns the first `;` outside a string and outside a comment, doubled
    /// `''` being an escaped in-string quote per STEP (ISO 10303-21), and
    /// `None` unless that `;` is preceded by the `)` closing the parameter
    /// list with no `=` before it, which bounds the search to the record's OWN
    /// body (#4179). [`close_step_record`](crate::parser::lexical::close_step_record)
    /// argues both rules, the general property they approximate, and why a
    /// refusal recovers rather than stops; the TypeScript halves are
    /// `step-record-boundary.ts` and `scan-worker-source.ts`. This is the
    /// single hottest structural-scan function: every entity of every model,
    /// native and wasm, through `build_entity_index` and the processor scan
    /// loop alike.
    ///
    /// `=` is IN the SIMD triple rather than checked on the plain span after
    /// the fact, and that placement is what keeps a file of unterminated
    /// records linear. A refused record resumes one byte past its `#`, so the
    /// walk from the next declaration must stop at THAT declaration's `=`
    /// rather than scanning on to a terminator that may be anywhere in the
    /// remaining file. With `=` outside the triple the walk ran to the next
    /// `'`, `;` or `/` first, which for `#1=A(\n` repeated is end of file:
    /// O(n^2), measured 4x per doubling (`refused_records_do_not_rescan_the_remainder_4179`).
    /// One rule bounds both this walk and `close_step_record`'s.
    #[inline]
    pub(super) fn find_entity_end(&self, content: &[u8]) -> Option<usize> {
        let mut pos = 0;
        // Only the two arms that can make it true compute it (#4179).
        let mut closes_paren = false;

        'record: loop {
            // Outside a quoted string: jump to the next quote, terminating
            // semicolon or next-declaration `=` in one SIMD pass. No hit at
            // all means this record cannot end. `hit` is ABSOLUTE so the
            // comment/division loop below can advance `pos` towards it
            // without ever re-running the SIMD pass over bytes it has passed.
            let hit = pos + memchr::memchr3(b'\'', b';', b'=', &content[pos..])?;

            // Every comment opener and division between `pos` and `hit` is
            // handled BEFORE the hit is trusted, because a comment may run
            // past it and swallow it. Each `/` moves `pos` past itself, and
            // the search for the next one covers only `[pos, hit)`, so a
            // record dense with divisions or comments costs one walk of its
            // own length. Re-scanning from `pos` to the hit per `/` made a
            // single 400 KB record quadratic in itself (1.23s against 0.32ms).
            while let Some(slash) = memchr::memchr(b'/', &content[pos..hit]).map(|i| pos + i) {
                if content.get(slash + 1) == Some(&b'*') {
                    // A comment is trivia, so a ')' before it still counts:
                    // `#1=IFCWALL($) /* c */ ;` closes at that ')'.
                    closes_paren = crate::parser::lexical::closes_with_paren(
                        &content[pos..slash],
                        closes_paren,
                    );
                    // Unterminated: the rest of the input is inside the
                    // comment, so this record has no terminator. `None` drops
                    // it and ends the scan rather than inventing an end.
                    pos = crate::parser::lexical::skip_step_comment(content, slash)?;
                    if pos > hit {
                        // The comment swallowed the hit: find the next one.
                        continue 'record;
                    }
                } else {
                    // A lone '/' is STEP division inside a value list.
                    closes_paren = false;
                    pos = slash + 1;
                }
            }

            let plain = &content[pos..hit];
            let found = content[hit];
            pos = hit;

            if found == b'=' {
                // The NEXT declaration's: this record never ended.
                return None;
            }
            if found == b';' {
                // A ';' closing nothing belongs to what FOLLOWS the record.
                return crate::parser::lexical::closes_with_paren(plain, closes_paren).then_some(pos);
            }

            // found == b'\'' : entered a quoted string. Scan to the closing
            // quote, treating a doubled '' as an escaped quote.
            pos += 1;
            loop {
                pos += memchr::memchr(b'\'', &content[pos..])?;
                if content.get(pos + 1) == Some(&b'\'') {
                    // Escaped quote ('') - skip both, stay in the string.
                    pos += 2;
                    continue;
                }
                // Closing quote.
                pos += 1;
                break;
            }
            closes_paren = false; // A literal is a parameter, not a close.
        }
    }
}
