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
        }
    }

    /// Current byte offset of the scanner (start of the next entity to scan).
    pub fn position(&self) -> usize {
        self.position
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
                    let mut p = candidate + 2;
                    while p + 1 < len {
                        // Find next '*'; check if followed by '/'.
                        let from = p;
                        let star = match memchr::memchr(b'*', &bytes[from..]) {
                            Some(off) => from + off,
                            None => return None, // unterminated comment
                        };
                        if star + 1 < len && bytes[star + 1] == b'/' {
                            self.position = star + 2;
                            break;
                        }
                        p = star + 1;
                    }
                    if self.position <= candidate {
                        // Comment never closed — refuse to scan further.
                        return None;
                    }
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
        let id = self.parse_u32_fast(id_start, id_end)?;

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

        Some((id, type_name, line_start, line_end))
    }

    /// Fast u32 parsing without string allocation
    #[inline]
    fn parse_u32_fast(&self, start: usize, end: usize) -> Option<u32> {
        let mut result: u32 = 0;
        for i in start..end {
            let digit = self.bytes[i].wrapping_sub(b'0');
            if digit > 9 {
                return None;
            }
            result = result.wrapping_mul(10).wrapping_add(digit as u32);
        }
        Some(result)
    }

    /// Find the terminating semicolon of an entity, skipping over quoted strings.
    /// IFC strings are enclosed in single quotes ('...') and can contain semicolons.
    /// Returns the offset of the semicolon from the start of the slice.
    #[inline]
    fn find_entity_end(&self, content: &[u8]) -> Option<usize> {
        let mut pos = 0;
        let len = content.len();
        let mut in_string = false;

        while pos < len {
            let b = content[pos];

            if in_string {
                if b == b'\'' {
                    // Check for escaped quote ('') - if next char is also quote, skip both
                    if pos + 1 < len && content[pos + 1] == b'\'' {
                        pos += 2; // Skip escaped quote
                        continue;
                    }
                    in_string = false;
                }
                pos += 1;
            } else {
                match b {
                    b'\'' => {
                        in_string = true;
                        pos += 1;
                    }
                    b';' => {
                        return Some(pos);
                    }
                    b'\n' => {
                        // Entity definitions can span multiple lines in some IFC files
                        pos += 1;
                    }
                    _ => {
                        pos += 1;
                    }
                }
            }
        }
        None
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
mod tests {
    use super::*;

    #[test]
    fn test_entity_scanner() {
        let content = r#"
#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);
#2=IFCWALL('guid2',$,$,$,$,$,$,$);
#3=IFCDOOR('guid3',$,$,$,$,$,$,$);
#4=IFCWALL('guid4',$,$,$,$,$,$,$);
"#;

        let mut scanner = EntityScanner::new(content);

        // Test next_entity
        let (id, type_name, _, _) = scanner.next_entity().unwrap();
        assert_eq!(id, 1);
        assert_eq!(type_name, "IFCPROJECT");

        // Test find_by_type
        scanner.reset();
        let walls = scanner.find_by_type("IFCWALL");
        assert_eq!(walls.len(), 2);
        assert_eq!(walls[0].0, 2);
        assert_eq!(walls[1].0, 4);

        // Test count_by_type
        scanner.reset();
        let counts = scanner.count_by_type();
        assert_eq!(counts.get("IFCPROJECT"), Some(&1));
        assert_eq!(counts.get("IFCWALL"), Some(&2));
        assert_eq!(counts.get("IFCDOOR"), Some(&1));
    }

    /// Regression for issue #654: CATIA exports a FILE_NAME whose first
    /// argument contains a literal `#` inside the quoted string (the encoded
    /// filename `'…\X0\2#.ifc'`). The scanner used to latch onto that `#`,
    /// flip `find_entity_end`'s quote parity at the closing `'`, and silently
    /// drop every entity in the file.
    #[test]
    fn test_entity_scanner_hash_in_header_filename() {
        let content = "ISO-10303-21;\nHEADER;\n\
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');\n\
FILE_NAME('26-IFC\\X2\\00B1\\X0\\2#.ifc','2026-04-29T18:21:27',$,$,'CATIA','CATIA',$);\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\n\
DATA;\n\
#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);\n\
#2=IFCWALL('guid2',$,$,$,$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n";

        let mut scanner = EntityScanner::new(content);
        let counts = scanner.count_by_type();
        assert_eq!(counts.get("IFCPROJECT"), Some(&1));
        assert_eq!(counts.get("IFCWALL"), Some(&1));
    }

    /// Files without a DATA; marker (partial fragments, test fixtures) must
    /// still scan from offset 0 — the HEADER-skip is best-effort.
    #[test]
    fn test_entity_scanner_no_header() {
        let content = "#1=IFCWALL('guid',$,$,$,$,$,$,$);\n";
        let mut scanner = EntityScanner::new(content);
        let (id, type_name, _, _) = scanner.next_entity().unwrap();
        assert_eq!(id, 1);
        assert_eq!(type_name, "IFCWALL");
    }

    /// HEADER fields are free-form strings — a description, comment, or
    /// embedded filename could legally contain the literal text `DATA;`.
    /// The seek must ignore matches inside quoted strings and land on the
    /// real section marker.
    #[test]
    fn test_entity_scanner_data_marker_inside_header_string() {
        let content = "ISO-10303-21;\nHEADER;\n\
FILE_DESCRIPTION(('section DATA; in description'),'2;1');\n\
FILE_NAME('weird DATA; name.ifc','2026-04-29T18:21:27',$,$,'a','b',$);\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\n\
DATA;\n\
#1=IFCWALL('guid',$,$,$,$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n";

        let mut scanner = EntityScanner::new(content);
        let counts = scanner.count_by_type();
        assert_eq!(counts.get("IFCWALL"), Some(&1));
        // Confirm we landed at the real DATA;, not the one in the description.
        let pos = scanner.position();
        assert!(pos == content.len() || pos > content.find("ENDSEC;").unwrap());
    }

    /// `count` / `entity_count` must agree with the number of entities the
    /// scanner walks (and with the entity index), while allocating nothing per
    /// entity. It shares `next_entity`, so it inherits the header-skip and the
    /// quote/comment guards for free.
    #[test]
    fn test_entity_count_matches_scan() {
        let content = "ISO-10303-21;\nHEADER;\n\
FILE_DESCRIPTION(('has a #99 and DATA; inside'),'2;1');\n\
FILE_NAME('26-IFC\\X2\\00B1\\X0\\2#.ifc','2026-04-29T18:21:27',$,$,'a','b',$);\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\n\
DATA;\n\
#1=IFCPROJECT('guid',$,$,$,$,$,$,$,$);\n\
/* a comment with #77= IFCWALL inside */\n\
#2=IFCWALL('guid2',$,$,$,'name with ; semicolon',$,$,$);\n\
#3=IFCDOOR('guid3',$,$,$,$,$,$,$);\n\
ENDSEC;\nEND-ISO-10303-21;\n";

        // Free function.
        assert_eq!(entity_count(content), 3);
        // Method, from a fresh scanner.
        assert_eq!(EntityScanner::new(content).count(), 3);
        // Agrees with the per-type tally (which walks the same entities).
        let total: usize = EntityScanner::new(content).count_by_type().values().sum();
        assert_eq!(total, 3);
    }

    /// An empty / header-only buffer counts zero, never panics.
    #[test]
    fn test_entity_count_empty() {
        assert_eq!(entity_count(""), 0);
        assert_eq!(entity_count("ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\n"), 0);
    }

    /// Escaped single quotes (`''`) keep the string open per ISO 10303-21.
    #[test]
    fn test_entity_scanner_escaped_quote_in_header() {
        let content = "ISO-10303-21;\nHEADER;\n\
FILE_DESCRIPTION(('it''s fine: DATA; inside'),'2;1');\n\
FILE_NAME('a','b',$,$,'c','d',$);\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\n\
DATA;\n\
#7=IFCDOOR('guid',$,$,$,$,$,$,$);\n\
ENDSEC;\n";

        let mut scanner = EntityScanner::new(content);
        let counts = scanner.count_by_type();
        assert_eq!(counts.get("IFCDOOR"), Some(&1));
    }
}
