// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Byte-level SIMD fast scanner over raw IFC bytes.
//!
//! Independent of the nom [`tokenizer`](super::tokenizer): does its own
//! hand-rolled, quote- and comment-aware parsing without building [`Token`]s.

#[path = "scanner_header.rs"]
mod scanner_header;
use scanner_header::data_section_start;

// `has_non_null_attribute` lives next door, per this file's own split pattern
// (see `scanner_attributes.rs`'s doc comment).
#[path = "scanner_attributes.rs"]
mod scanner_attributes;

// The refusal/drop reporting surface, likewise (see its doc comment).
#[path = "scanner_diagnostics.rs"]
mod scanner_diagnostics;

/// Fast entity scanner over raw IFC bytes without full parsing.
/// O(n) performance for finding entities by type
/// Uses memchr for SIMD-accelerated byte searching
pub struct EntityScanner<'a> {
    bytes: &'a [u8],
    position: usize,
    /// `line_start` of every record refused for an oversized instance name,
    /// in scan order (so: strictly increasing). A `Vec` rather than a counter
    /// because a SHARDED caller has to know WHERE a refusal happened before it
    /// can tell a real one from one its speculative prefix invented — see
    /// [`Self::skipped_oversized_id_starts`]. It never allocates on a file
    /// with nothing to refuse, which is every real file.
    skipped_oversized_id_starts: Vec<usize>,
    /// See [`Self::malformed_record_starts`] for what these point at.
    malformed_record_starts: Vec<usize>,
}

impl<'a> EntityScanner<'a> {
    /// Create a new scanner.
    ///
    /// Positions past the STEP HEADER section when one is present so that a
    /// stray `#` inside a header string (e.g. a CATIA `FILE_NAME` like
    /// `'…\X0\2#.ifc'`) can't be mistaken for an entity start and corrupt
    /// quote-parity for the rest of the file (issue #654).
    pub fn new<T>(content: &'a T) -> Self
    where
        T: AsRef<[u8]> + ?Sized,
    {
        let bytes = content.as_ref();
        Self {
            bytes,
            position: data_section_start(bytes),
            skipped_oversized_id_starts: Vec::new(),
            malformed_record_starts: Vec::new(),
        }
    }

    /// Create a scanner positioned at a specific byte offset.
    ///
    /// Used by the sharded-scan pre-pass: each shard scans the full file
    /// (so byte offsets returned are GLOBAL, not relative to the shard's
    /// range) but starts walking at its assigned start offset. Callers are
    /// expected to rewind `position` to a known entity boundary (typically
    /// the byte after a `;\n` terminator) before calling `next_entity`.
    ///
    /// Does NOT auto-skip the HEADER section — that's the caller's
    /// responsibility, since shards expect the exact offset they were given.
    pub fn new_at<T>(content: &'a T, position: usize) -> Self
    where
        T: AsRef<[u8]> + ?Sized,
    {
        let bytes = content.as_ref();
        let clamped = position.min(bytes.len());
        Self {
            bytes,
            position: clamped,
            skipped_oversized_id_starts: Vec::new(),
            malformed_record_starts: Vec::new(),
        }
    }

    /// Current byte offset of the scanner (start of the next entity to scan).
    pub fn position(&self) -> usize {
        self.position
    }

    /// Record `at` as a dropped record. Offsets only advance, so the list
    /// stays strictly increasing.
    fn mark_malformed(&mut self, at: usize) {
        if self.malformed_record_starts.last() != Some(&at) {
            self.malformed_record_starts.push(at);
        }
    }

    /// Scan for the next entity
    /// Returns (entity_id, type_name, line_start, line_end)
    #[inline]
    pub fn next_entity(&mut self) -> Option<(u32, &'a str, usize, usize)> {
        // Find a '#' that actually starts an entity. A '#' is legal inside
        // STEP-encoded quoted strings (e.g. CATIA writes filenames like
        // `'…\X0\2#.ifc'` into the HEADER's FILE_NAME) AND inside STEP
        // `/* … */` comments. Two layered guards:
        //
        //   1. Skip past `/* … */` comment regions entirely so an inner
        //      `#N=…` token can't be mistaken for an entity (PR #865 follow-
        //      up — `/* previous #12= IFCWALL */` was the canonical example
        //      where the original `#N=` shape check still false-positived).
        //   2. After comment-skipping locates a candidate '#', validate it
        //      starts a real `#<trivia>=` pattern. Catches embedded
        //      references inside STEP strings (CATIA `'…\X0\2#.ifc'`) AND
        //      any comment-shaped tokens the comment skipper missed (mostly
        //      a fallback now — true `/* */` regions never reach this check).
        //
        // "Trivia", not whitespace: 10303-21 allows a comment wherever
        // whitespace is allowed, INCLUDING inside a record, so
        // `#1 /* was #7 */ = IFCWALL(…);` is a legal declaration and used to
        // produce no record at all. The same rule governs the gap between the
        // '=' and the type name, and `find_entity_end` skips a comment for it
        // in the record body — otherwise a ';' written inside one ends the
        // record early and the span handed to the decoder is truncated. The
        // matched TypeScript half is `skipTrivia` in
        // `packages/parser/src/step-lexing.ts`; change the two together.
        //
        // Both checks together are what `build_entity_index` (`decoder.rs`)
        // relies on for its own comment-awareness: it is a bare loop over
        // `next_entity`, not a separate scan, so it inherits this method's
        // comment handling directly rather than needing to duplicate it.
        let bytes = self.bytes;
        let len = bytes.len();
        // Outer loop so a record this scanner refuses (an oversized
        // instance name, below) is SKIPPED rather than ending the scan.
        loop {
            let (line_start, parsed_id, eq_pos) = loop {
                // Step (1): jump past any `/* … */` comment that starts at or
                // before the next candidate '#'. Use memchr2 so we look for
                // '#' and '/' in one SIMD pass — whichever comes first
                // decides the next move.
                let remaining = &bytes[self.position..];
                let next = memchr::memchr2(b'#', b'/', remaining)?;
                let candidate = self.position + next;
                let candidate_byte = bytes[candidate];

                if candidate_byte == b'/' {
                    // '/' might begin a STEP `/* … */` comment. If yes, jump
                    // past `*/`; if not, it's a STEP arithmetic '/' inside a
                    // value list (rare; just step past it).
                    if candidate + 1 < len && bytes[candidate + 1] == b'*' {
                        // An unterminated `/*` means corrupt input (#3303) —
                        // same "no resume point" shape as `find_entity_end`.
                        match super::lexical::skip_step_comment(bytes, candidate) {
                            Some(next_pos) => {
                                self.position = next_pos;
                                continue;
                            }
                            None => {
                                self.mark_malformed(candidate);
                                return None;
                            }
                        }
                    }
                    // Lone '/' — not a comment. Skip past.
                    self.position = candidate + 1;
                    continue;
                }

                // candidate_byte == b'#'. Step (2): validate `#<digits>[ws]*=`.
                let after = candidate + 1;
                let (digit_count, parsed_id) =
                    crate::express_id::parse_express_id_prefix(&bytes[after..]);
                if digit_count == 0 {
                    self.position = after;
                    continue;
                }
                let digit_end = after + digit_count;
                // Skip optional trivia and verify the next byte is '='.
                // `None` means a comment opened here and never closes, which
                // is not a declaration either — fall through to the rescan
                // below, where the outer memchr2 finds the same '/*' and
                // `skip_step_comment` ends the scan on it.
                let probe = super::lexical::skip_step_trivia(bytes, digit_end).unwrap_or(len);
                if probe < len && bytes[probe] == b'=' {
                    break (candidate, parsed_id, probe);
                }
                // '#<digits>' not followed by '=' — this is a comment or string
                // reference, not an entity definition. Skip past the digits and
                // keep searching.
                self.position = digit_end;
            };

            // Find the end of the entity (semicolon) while respecting quoted strings
            // IFC strings use single quotes and can contain semicolons
            // The prefix contains only digits and already-closed trivia (#3987).
            let body_start = eq_pos + 1;
            let line_content = &bytes[body_start..];
            let end_offset = match self.find_entity_end(line_content) {
                Some(o) => o,
                None => {
                    // Report it, then drop just THIS record rather than the
                    // rest of the file: the `)` balancing its `(` is a real
                    // 10303-21 boundary (#4179), the same per-record skip the
                    // oversized id below takes. An unterminated string or
                    // comment has no balancing `)` either, so #3695's
                    // "nothing to resume from" stop is unchanged.
                    self.mark_malformed(line_start);
                    self.position = match super::lexical::close_step_record(line_content) {
                        super::lexical::RecordClose::At(o) => body_start + o,
                        // No balancing ')', but the bytes after are readable:
                        // re-hunt from past this record's '#' so the NEXT
                        // declaration is still found. Stopping here cost the
                        // whole tail for a missing ')' (#4179 review).
                        super::lexical::RecordClose::Unbalanced => line_start + 1,
                        super::lexical::RecordClose::Unreadable => return None,
                    };
                    continue;
                }
            };
            let line_end = body_start + end_offset + 1;

            // Refusal is still reported AFTER malformed-body detection (#3987).
            let Some(id) = parsed_id else {
                // The instance name does not fit `u32` (issue #3395). SKIP
                // the record and keep scanning: returning `None` here would
                // end the whole scan at the first oversized id, silently
                // truncating the model from that byte on. Per-record skip is
                // what the rest of this scanner already does with malformed
                // input, and the counter above is how the caller finds out.
                self.skipped_oversized_id_starts.push(line_start);
                self.position = line_end;
                continue;
            };

            // Use the validated '=', not one inside `#1 /* a=b */ = IFCWALL`.
            // Skip trivia before the type; find_entity_end already verified
            // closed comments, with line_end as a conservative fallback.
            let type_start = super::lexical::skip_step_trivia(&self.bytes[..line_end], eq_pos + 1)
                .unwrap_or(line_end);

            // Find end of type name (at '(', whitespace, or a comment opener:
            // `IFCWALL/* n */(…)` is legal and its type name is IFCWALL).
            //
            // STEP whitespace includes vertical tab, unlike is_ascii_whitespace.
            let mut type_end = type_start;
            let mut type_bytes_or = 0u8;
            while type_end < line_end {
                let b = self.bytes[type_end];
                if b == b'(' || super::lexical::is_step_space(b) {
                    break;
                }
                if b == b'/' && self.bytes.get(type_end + 1) == Some(&b'*') {
                    break;
                }
                type_bytes_or |= b;
                type_end += 1;
            }

            let type_bytes = &self.bytes[type_start..type_end];
            let type_name = if type_bytes_or.is_ascii() {
                // SAFETY: the loop ORs every byte in this exact slice; a clear
                // high bit proves every byte is ASCII and therefore valid UTF-8.
                unsafe { std::str::from_utf8_unchecked(type_bytes) }
            } else {
                std::str::from_utf8(type_bytes).unwrap_or("UNKNOWN")
            };

            // Move position past this entity
            self.position = line_end;

            return Some((id, type_name, line_start, line_end));
        }
    }

    /// Offset of the record's terminating `;` from the start of the slice.
    ///
    /// `memchr3` jumps straight to the next quote, comment opener or
    /// semicolon, so a string-free geometry primitive
    /// (`#7=IFCCARTESIANPOINT((1.,2.,3.));`), the overwhelming majority of
    /// records, resolves in one vectorized hop rather than a per-byte loop.
    /// A quote is tested before a comment opener and a comment is then
    /// consumed whole, which is what makes a `/*` inside a literal text and a
    /// `;` or quote inside a comment text: `#1=IFCWALL('a', /* p; q */ $);` is
    /// legal 10303-21 and used to come back truncated at that inner `;`.
    ///
    /// Returns the first `;` outside a string and outside a comment, doubled
    /// `''` being an escaped in-string quote per STEP (ISO 10303-21), and
    /// `None` unless that `;` is preceded by the `)` closing the parameter
    /// list with no `=` before it, which bounds the search to the record's OWN
    /// body (#4179). [`close_step_record`](super::lexical::close_step_record)
    /// argues both rules, the general property they approximate, and why a
    /// refusal recovers rather than stops; the TypeScript halves are
    /// `step-record-boundary.ts` and `scan-worker-source.ts`. This is the
    /// single hottest structural-scan function: every entity of every model,
    /// native and wasm, through `build_entity_index` and the processor scan
    /// loop alike.
    #[inline]
    fn find_entity_end(&self, content: &[u8]) -> Option<usize> {
        let mut pos = 0;
        // Only the two arms that can make it true compute it (#4179).
        let mut closes_paren = false;

        loop {
            // Outside a quoted string: jump to the next quote, comment opener
            // or terminating semicolon in one SIMD pass. Slicing `rest` once
            // spares the arms below a repeated bounds check on `content[pos]`.
            let rest = &content[pos..];
            let hit = memchr::memchr3(b'\'', b';', b'/', rest)?;
            let plain = &rest[..hit];
            // An '=' out here is the NEXT declaration's: this record never ended.
            if memchr::memchr(b'=', plain).is_some() {
                return None;
            }
            let found = rest[hit];
            pos += hit;

            if found == b';' {
                // A ';' closing nothing belongs to what FOLLOWS the record.
                return super::lexical::closes_with_paren(plain, closes_paren).then_some(pos);
            }
            if found == b'/' {
                if content.get(pos + 1) == Some(&b'*') {
                    // A comment is trivia, so a ')' before it still counts:
                    // `#1=IFCWALL($) /* c */ ;` closes at that ')'.
                    closes_paren = super::lexical::closes_with_paren(plain, closes_paren);
                    // Unterminated: the rest of the input is inside the
                    // comment, so this record has no terminator. `None` drops
                    // it and ends the scan rather than inventing an end.
                    pos = super::lexical::skip_step_comment(content, pos)?;
                } else {
                    // A lone '/' is STEP division inside a value list.
                    closes_paren = false;
                    pos += 1;
                }
                continue;
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

    /// Find all entities of a specific type
    pub fn find_by_type(&mut self, target_type: &str) -> Vec<(u32, usize, usize)> {
        let mut results = Vec::new();

        while let Some((id, type_name, start, end)) = self.next_entity() {
            if type_name.eq_ignore_ascii_case(target_type) {
                results.push((id, start, end));
            }
        }

        results
    }

    /// Count entities by type
    pub fn count_by_type(&mut self) -> rustc_hash::FxHashMap<String, usize> {
        let mut counts = rustc_hash::FxHashMap::default();

        while let Some((_, type_name, _, _)) = self.next_entity() {
            *counts.entry(type_name.to_string()).or_insert(0) += 1;
        }

        counts
    }

    /// Count the entities remaining from the scanner's current position, without
    /// allocating anything per entity.
    ///
    /// Unlike [`count_by_type`](Self::count_by_type) (which builds a per-keyword
    /// map) or [`build_entity_index`](crate::build_entity_index) (which retains a
    /// span per entity, ~20 B each), this walks the byte stream and increments a
    /// single counter: `O(scan)` time, `O(1)` memory. It is the cheap primitive
    /// for a downstream entity-count DoS guard on a file too large to index
    /// (issue #1517). Advances the scanner to the end of the data section.
    pub fn count(&mut self) -> usize {
        let mut n = 0usize;
        while self.next_entity().is_some() {
            n += 1;
        }
        n
    }

    /// Reset scanner to beginning (re-applies the HEADER skip).
    pub fn reset(&mut self) {
        self.position = data_section_start(self.bytes);
        self.skipped_oversized_id_starts.clear();
        self.malformed_record_starts.clear();
    }
}

/// Count the entities in a STEP/IFC byte buffer in `O(scan)` time and `O(1)`
/// memory — no entity index, no per-type map.
///
/// A thin wrapper over [`EntityScanner::count`]. This is the cheap primitive a
/// downstream can use to reject a file with a pathologically large entity count
/// that a byte-size cap would miss, WITHOUT paying the ~20 B/entity the full
/// index costs (issue #1517). Header-aware and comment-/string-safe, exactly
/// like the scanner (it IS the scanner), so the count matches what
/// [`build_entity_index`](crate::build_entity_index) would find.
pub fn entity_count<T>(content: &T) -> usize
where
    T: AsRef<[u8]> + ?Sized,
{
    EntityScanner::new(content).count()
}

#[cfg(test)]
#[path = "scanner_tests.rs"]
mod scanner_tests;
