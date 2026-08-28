// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Byte-level SIMD fast scanner over raw IFC bytes.
//!
//! Independent of the nom [`tokenizer`](super::tokenizer): does its own
//! hand-rolled, quote- and comment-aware parsing without building [`Token`]s.

/// Fast entity scanner over raw IFC bytes without full parsing.
/// O(n) performance for finding entities by type
/// Uses memchr for SIMD-accelerated byte searching
pub struct EntityScanner<'a> {
    bytes: &'a [u8],
    position: usize,
    skipped_oversized_ids: usize,
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
            skipped_oversized_ids: 0,
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
            skipped_oversized_ids: 0,
        }
    }

    /// Current byte offset of the scanner (start of the next entity to scan).
    pub fn position(&self) -> usize {
        self.position
    }

    /// How many records this scanner has skipped because their instance name
    /// does not fit `u32` (issue #3395).
    ///
    /// ISO 10303-21 puts no upper bound on `#<digits>`, but every express-id
    /// column in this workspace is `u32` (`ColumnarIndex::ids`,
    /// `MeshData::express_id`, the wasm `express_ids` buffers), so a wider id
    /// cannot be represented — it used to wrap, making `#4294967297`
    /// indistinguishable from `#1`. The record is dropped instead, and this
    /// counter is the other half of that guard: callers report it rather than
    /// letting the model come back quietly short.
    pub fn skipped_oversized_ids(&self) -> usize {
        self.skipped_oversized_ids
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
        //      starts a real `#<digits>[ws]*=` pattern. Catches embedded
        //      references inside STEP strings (CATIA `'…\X0\2#.ifc'`) AND
        //      any comment-shaped tokens the comment skipper missed (mostly
        //      a fallback now — true `/* */` regions never reach this check).
        //
        // Both checks together keep `next_entity` aligned with
        // `build_entity_index` which is comment-blind today; if a stray
        // comment-bound entity slips past the scanner, the index also
        // ignores it, so the entity decoder + scanner stay consistent.
        let bytes = self.bytes;
        let len = bytes.len();
        // Outer loop so a record this scanner refuses (an oversized
        // instance name, below) is SKIPPED rather than ending the scan.
        loop {
            let (line_start, id_end_validated) = loop {
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
                        // An unterminated `/*` here means corrupt input.
                        // `skip_step_comment` refuses (returns `None`) rather
                        // than silently consuming the rest of the file — see
                        // its doc comment for why that's the right call for a
                        // scanner (issue #3303).
                        self.position = super::lexical::skip_step_comment(bytes, candidate)?;
                        continue;
                    }
                    // Lone '/' — not a comment. Skip past.
                    self.position = candidate + 1;
                    continue;
                }

                // candidate_byte == b'#'. Step (2): validate `#<digits>[ws]*=`.
                let after = candidate + 1;
                if after >= len || !bytes[after].is_ascii_digit() {
                    self.position = after;
                    continue;
                }
                // Walk the digit run.
                let mut digit_end = after;
                while digit_end < len && bytes[digit_end].is_ascii_digit() {
                    digit_end += 1;
                }
                // Skip optional whitespace and verify the next byte is '='.
                let mut probe = digit_end;
                while probe < len && bytes[probe].is_ascii_whitespace() {
                    probe += 1;
                }
                if probe < len && bytes[probe] == b'=' {
                    break (candidate, digit_end);
                }
                // '#<digits>' not followed by '=' — this is a comment or string
                // reference, not an entity definition. Skip past the digits and
                // keep searching.
                self.position = digit_end;
            };

            // Find the end of the entity (semicolon) while respecting quoted strings
            // IFC strings use single quotes and can contain semicolons
            let line_content = &bytes[line_start..];
            let end_offset = self.find_entity_end(line_content)?;
            let line_end = line_start + end_offset + 1;

            // Parse entity ID — digit range already validated in the candidate loop.
            let id_start = line_start + 1;
            let id_end = id_end_validated;
            let Some(id) = self.parse_u32_fast(id_start, id_end) else {
                // The instance name does not fit `u32` (issue #3395). SKIP
                // the record and keep scanning: returning `None` here would
                // end the whole scan at the first oversized id, silently
                // truncating the model from that byte on. Per-record skip is
                // what the rest of this scanner already does with malformed
                // input, and the counter above is how the caller finds out.
                self.skipped_oversized_ids += 1;
                self.position = line_end;
                continue;
            };

            // Find '=' after ID using SIMD
            let eq_search = &self.bytes[id_end..line_end];
            let eq_offset = memchr::memchr(b'=', eq_search)?;
            let mut type_start = id_end + eq_offset + 1;

            // Skip whitespace (inline)
            while type_start < line_end && self.bytes[type_start].is_ascii_whitespace() {
                type_start += 1;
            }

            // Find end of type name (at '(' or whitespace)
            let mut type_end = type_start;
            while type_end < line_end {
                let b = self.bytes[type_end];
                if b == b'(' || b.is_ascii_whitespace() {
                    break;
                }
                type_end += 1;
            }

            // Use safe UTF-8 conversion - malformed input should not cause UB
            let type_name = std::str::from_utf8(&self.bytes[type_start..type_end]).unwrap_or("UNKNOWN");

            // Move position past this entity
            self.position = line_end;

            return Some((id, type_name, line_start, line_end));
        }
    }

    /// Fast u32 parsing without string allocation.
    ///
    /// `start..end` is a validated ASCII digit run (the candidate loop in
    /// [`next_entity`](Self::next_entity) walks it with `is_ascii_digit`), so
    /// `None` means exactly one thing: the value does not fit `u32`. It used to
    /// be `wrapping_mul`/`wrapping_add`, which turned `#4294967297` into `1` —
    /// a real entity's id, indistinguishable from it downstream (issue #3395).
    ///
    /// Two loops rather than one: a run of at most 9 digits is at most
    /// 999_999_999 and cannot overflow `u32`, so every real file keeps the
    /// unchecked instruction sequence. Only a 10+ digit run — which no
    /// exporter emits — pays for `checked_mul`/`checked_add`.
    #[inline]
    fn parse_u32_fast(&self, start: usize, end: usize) -> Option<u32> {
        debug_assert!(
            self.bytes[start..end].iter().all(u8::is_ascii_digit),
            "parse_u32_fast expects a validated digit run"
        );
        let mut result: u32 = 0;
        if end - start <= 9 {
            for i in start..end {
                result = result * 10 + (self.bytes[i] - b'0') as u32;
            }
            return Some(result);
        }
        for i in start..end {
            result = result
                .checked_mul(10)?
                .checked_add((self.bytes[i] - b'0') as u32)?;
        }
        Some(result)
    }

    /// Find the terminating semicolon of an entity, skipping over quoted strings.
    /// IFC strings are enclosed in single quotes ('...') and can contain semicolons.
    /// Returns the offset of the semicolon from the start of the slice.
    ///
    /// SIMD scan: instead of inspecting every byte, `memchr2` jumps straight to
    /// the next quote or semicolon. The overwhelming majority of records are
    /// string-free geometry primitives (`#7=IFCCARTESIANPOINT((1.,2.,3.));`), so
    /// the common case resolves the terminator in a single vectorized hop rather
    /// than a per-byte loop. Semantics are byte-identical to the scalar walk:
    /// the first `;` outside a quoted string, with doubled `''` treated as an
    /// escaped in-string quote per STEP (ISO 10303-21). This is the single
    /// hottest structural-scan function and runs on every entity of every model
    /// (native and wasm), through both `build_entity_index` and the processor
    /// scan loop, which share this scanner.
    #[inline]
    fn find_entity_end(&self, content: &[u8]) -> Option<usize> {
        let mut pos = 0;

        loop {
            // Outside a quoted string: jump to the next quote or the
            // terminating semicolon in one SIMD pass.
            pos += memchr::memchr2(b'\'', b';', &content[pos..])?;
            if content[pos] == b';' {
                return Some(pos);
            }

            // content[pos] == b'\'' : entered a quoted string. Scan to the
            // closing quote, treating a doubled '' as an escaped quote.
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
        self.skipped_oversized_ids = 0;
    }

    /// Fast check if attribute at given index is non-null (not '$')
    /// This is used to filter building elements that don't have representation
    /// without full entity decode. Index 0 is first attribute after '('.
    ///
    /// Returns true if attribute exists and is not '$', false otherwise.
    #[inline]
    pub fn has_non_null_attribute(&self, start: usize, end: usize, attr_index: usize) -> bool {
        let content = &self.bytes[start..end];

        // Find the opening parenthesis
        let paren_pos = match memchr::memchr(b'(', content) {
            Some(p) => p + 1,
            None => return false,
        };

        let mut pos = paren_pos;
        let mut current_attr = 0;
        let mut depth = 0; // Track nested parentheses
        let mut in_string = false;

        // Helper to check if we're at target attribute and return result
        let check_target = |pos: usize, current_attr: usize, depth: usize| -> Option<bool> {
            if current_attr == attr_index && depth == 0 {
                // Skip whitespace
                let mut p = pos;
                while p < content.len() && content[p].is_ascii_whitespace() {
                    p += 1;
                }
                // Check if it's '$' (null)
                if p < content.len() {
                    return Some(content[p] != b'$');
                }
                return Some(false);
            }
            None
        };

        // Check if target is first attribute (index 0)
        if let Some(result) = check_target(pos, current_attr, depth) {
            return result;
        }

        while pos < content.len() {
            let b = content[pos];

            if in_string {
                if b == b'\'' {
                    // Check for escaped quote ('')
                    if pos + 1 < content.len() && content[pos + 1] == b'\'' {
                        pos += 2;
                        continue;
                    }
                    in_string = false;
                }
                pos += 1;
                continue;
            }

            match b {
                b'\'' => {
                    in_string = true;
                    pos += 1;
                }
                b'(' => {
                    depth += 1;
                    pos += 1;
                }
                b')' => {
                    if depth == 0 {
                        // End of entity - attribute not found
                        return false;
                    }
                    depth -= 1;
                    pos += 1;
                }
                b',' if depth == 0 => {
                    current_attr += 1;
                    pos += 1;
                    // Skip whitespace after comma
                    while pos < content.len() && content[pos].is_ascii_whitespace() {
                        pos += 1;
                    }
                    // Check if we're now at target attribute
                    if let Some(result) = check_target(pos, current_attr, depth) {
                        return result;
                    }
                }
                _ => {
                    pos += 1;
                }
            }
        }

        false
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
fn data_section_start(bytes: &[u8]) -> usize {
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

#[cfg(test)]
#[path = "scanner_tests.rs"]
mod scanner_tests;
