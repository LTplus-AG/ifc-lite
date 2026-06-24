// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! STEP/IFC Parser using nom
//!
//! Zero-copy tokenization and fast entity scanning.

use nom::{
    branch::alt,
    bytes::complete::{take_while, take_while1},
    character::complete::{char, digit1, one_of},
    combinator::{map, map_res, opt, recognize},
    multi::separated_list0,
    sequence::{delimited, pair, preceded, tuple},
    IResult,
};

use crate::error::{Error, Result};
use crate::generated::IfcType;

/// STEP/IFC token.
///
/// String-like tokens borrow their original bytes. Decode them only at a
/// user-facing boundary so malformed real-world encodings cannot invalidate
/// the structural parser.
#[derive(Debug, Clone, PartialEq)]
pub enum Token<'a> {
    /// Entity reference: #123
    EntityRef(u32),
    /// String literal: 'text'
    String(&'a [u8]),
    /// Integer: 42
    Integer(i64),
    /// Float: 3.14
    Float(f64),
    /// Enum: .TRUE., .FALSE., .UNKNOWN.
    Enum(&'a [u8]),
    /// List: (1, 2, 3)
    List(Vec<Token<'a>>),
    /// Typed value: IFCPARAMETERVALUE(0.), IFCBOOLEAN(.T.)
    TypedValue(&'a [u8], Vec<Token<'a>>),
    /// Null value: $
    Null,
    /// Asterisk (derived value): *
    Derived,
}

/// Parse entity reference: #123
fn entity_ref(input: &[u8]) -> IResult<&[u8], Token<'_>> {
    map(
        preceded(char('#'), map_res(digit1, lexical_core::parse::<u32>)),
        Token::EntityRef,
    )(input)
}

/// Parse string literal: 'text' or "text"
/// IFC uses '' to escape a single quote within a string
/// Uses memchr for SIMD-accelerated quote searching
fn string_literal(input: &[u8]) -> IResult<&[u8], Token<'_>> {
    // Helper to parse string content with escaped quotes - SIMD optimized
    #[inline]
    fn parse_string_content(input: &[u8], quote_byte: u8) -> IResult<&[u8], &[u8]> {
        let bytes = input;
        let mut pos = 0;

        // Use memchr for SIMD-accelerated searching
        while let Some(found) = memchr::memchr(quote_byte, &bytes[pos..]) {
            let idx = pos + found;
            // Check if it's an escaped quote (doubled)
            if idx + 1 < bytes.len() && bytes[idx + 1] == quote_byte {
                pos = idx + 2; // Skip escaped quote pair
                continue;
            }
            // End of string found
            return Ok((&input[idx..], &input[..idx]));
        }

        // No closing quote found
        Err(nom::Err::Error(nom::error::Error::new(
            input,
            nom::error::ErrorKind::Char,
        )))
    }

    alt((
        map(
            delimited(char('\''), |i| parse_string_content(i, b'\''), char('\'')),
            Token::String,
        ),
        map(
            delimited(char('"'), |i| parse_string_content(i, b'"'), char('"')),
            Token::String,
        ),
    ))(input)
}

/// Parse integer: 42, -42
/// Uses lexical-core for 10x faster parsing
#[inline]
fn integer(input: &[u8]) -> IResult<&[u8], Token<'_>> {
    map_res(recognize(tuple((opt(char('-')), digit1))), |s: &[u8]| {
        lexical_core::parse::<i64>(s)
            .map(Token::Integer)
            .map_err(|_| "parse error")
    })(input)
}

/// Parse float: 3.14, -3.14, 1.5E-10, 0., 1.
/// IFC allows floats like "0." without decimal digits
/// Uses lexical-core for 10x faster parsing
#[inline]
fn float(input: &[u8]) -> IResult<&[u8], Token<'_>> {
    map_res(
        recognize(tuple((
            opt(char('-')),
            digit1,
            char('.'),
            opt(digit1), // Made optional to support "0." format
            opt(tuple((one_of("eE"), opt(one_of("+-")), digit1))),
        ))),
        |s: &[u8]| {
            lexical_core::parse::<f64>(s)
                .map(Token::Float)
                .map_err(|_| "parse error")
        },
    )(input)
}

/// Parse enum: .TRUE., .FALSE., .UNKNOWN., .ELEMENT.
fn enum_value(input: &[u8]) -> IResult<&[u8], Token<'_>> {
    map(
        delimited(
            char('.'),
            take_while1(|c: u8| c.is_ascii_alphanumeric() || c == b'_'),
            char('.'),
        ),
        Token::Enum,
    )(input)
}

/// Parse null: $
fn null(input: &[u8]) -> IResult<&[u8], Token<'_>> {
    map(char('$'), |_| Token::Null)(input)
}

/// Parse derived: *
fn derived(input: &[u8]) -> IResult<&[u8], Token<'_>> {
    map(char('*'), |_| Token::Derived)(input)
}

/// Maximum nesting depth for token recursion (list and typed-value bodies).
///
/// Each `(` in the input bumps depth by one. Real-world IFC entities rarely
/// nest beyond 5-10 levels; 256 leaves comfortable headroom while keeping
/// the stack bounded against pathological inputs.
const MAX_NESTING_DEPTH: u32 = 256;

/// Parse typed value: IFCPARAMETERVALUE(0.), IFCBOOLEAN(.T.)
fn typed_value_at_depth(input: &[u8], depth: u32) -> IResult<&[u8], Token<'_>> {
    map(
        pair(
            // Type name (all caps with optional numbers/underscores)
            take_while1(|c: u8| c.is_ascii_alphanumeric() || c == b'_'),
            // Arguments
            delimited(
                char('('),
                separated_list0(delimited(ws, char(','), ws), move |i| {
                    token_at_depth(i, depth)
                }),
                char(')'),
            ),
        ),
        |(type_name, args)| Token::TypedValue(type_name, args),
    )(input)
}

/// Skip whitespace
fn ws(input: &[u8]) -> IResult<&[u8], ()> {
    map(take_while(|c: u8| c.is_ascii_whitespace()), |_| ())(input)
}

/// Parse a token with optional surrounding whitespace
/// Optimized ordering: test cheapest patterns first (single-char markers)
fn token(input: &[u8]) -> IResult<&[u8], Token<'_>> {
    token_at_depth(input, 0)
}

fn token_at_depth(input: &[u8], depth: u32) -> IResult<&[u8], Token<'_>> {
    if depth > MAX_NESTING_DEPTH {
        return Err(nom::Err::Failure(nom::error::Error::new(
            input,
            nom::error::ErrorKind::TooLarge,
        )));
    }
    delimited(
        ws,
        alt((
            // Single-char markers first (O(1) check)
            null,       // $
            derived,    // *
            entity_ref, // # + digits
            // Then by complexity
            enum_value,     // .XXX.
            string_literal, // 'xxx'
            move |i| list_at_depth(i, depth + 1), // (...)
            // Numbers: float before integer since float includes '.'
            float,
            integer,
            // IFCPARAMETERVALUE(0.) - most expensive, last
            move |i| typed_value_at_depth(i, depth + 1),
        )),
        ws,
    )(input)
}

/// Parse list: (1, 2, 3) or nested lists
/// Test-only wrapper for the depth-0 entry into list.
#[cfg(test)]
fn list(input: &[u8]) -> IResult<&[u8], Token<'_>> {
    list_at_depth(input, 0)
}

fn list_at_depth(input: &[u8], depth: u32) -> IResult<&[u8], Token<'_>> {
    map(
        delimited(
            char('('),
            separated_list0(delimited(ws, char(','), ws), move |i| {
                token_at_depth(i, depth)
            }),
            char(')'),
        ),
        Token::List,
    )(input)
}

/// Parse a complete entity line from raw IFC bytes.
/// Example: #123=IFCWALL('guid','owner',$,$,'name',$,$,$);
// The nom `IResult` parser tuple type is intentionally explicit here; factoring
// it into a `type` alias would obscure the parser combinator structure.
#[allow(clippy::type_complexity)]
pub fn parse_entity<'a, T>(input: &'a T) -> Result<(u32, IfcType, Vec<Token<'a>>)>
where
    T: AsRef<[u8]> + ?Sized,
{
    let input = input.as_ref();
    let result: IResult<&[u8], (u32, &[u8], Vec<Token>)> = tuple((
        // Entity ID: #123
        delimited(
            ws,
            preceded(char('#'), map_res(digit1, lexical_core::parse::<u32>)),
            ws,
        ),
        // Equals sign
        preceded(
            char('='),
            // Entity type: IFCWALL
            delimited(
                ws,
                take_while1(|c: u8| c.is_ascii_alphanumeric() || c == b'_'),
                ws,
            ),
        ),
        // Arguments: ('guid', 'owner', ...)
        delimited(
            char('('),
            separated_list0(delimited(ws, char(','), ws), token),
            tuple((char(')'), ws, char(';'))),
        ),
    ))(input);

    match result {
        Ok((_, (id, type_str, args))) => {
            let type_str = std::str::from_utf8(type_str)
                .map_err(|_| Error::parse(0, "Entity type is not ASCII/UTF-8"))?;
            let ifc_type = IfcType::from_str(type_str);
            Ok((id, ifc_type, args))
        }
        Err(e) => Err(Error::parse(0, format!("Failed to parse entity: {}", e))),
    }
}

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

    /// Table-driven basic token parsing: (parser, input, expected token).
    #[test]
    #[allow(clippy::approx_constant)]
    fn test_basic_tokens() {
        type Parser = for<'a> fn(&'a [u8]) -> IResult<&'a [u8], Token<'a>>;
        let cases: &[(Parser, &[u8], Token)] = &[
            (entity_ref, b"#123", Token::EntityRef(123)),
            (entity_ref, b"#0", Token::EntityRef(0)),
            (string_literal, b"'hello'", Token::String(b"hello")),
            (
                string_literal,
                b"'with spaces'",
                Token::String(b"with spaces"),
            ),
            (integer, b"42", Token::Integer(42)),
            (integer, b"-42", Token::Integer(-42)),
            (integer, b"0", Token::Integer(0)),
            (float, b"3.14", Token::Float(3.14)),
            (float, b"-3.14", Token::Float(-3.14)),
            (float, b"1.5E-10", Token::Float(1.5e-10)),
            (enum_value, b".TRUE.", Token::Enum(b"TRUE")),
            (enum_value, b".FALSE.", Token::Enum(b"FALSE")),
            (enum_value, b".ELEMENT.", Token::Enum(b"ELEMENT")),
        ];
        for (parse, input, expected) in cases {
            assert_eq!(
                parse(input),
                Ok((&b""[..], expected.clone())),
                "tokenizing {input:?}"
            );
        }
    }

    #[test]
    fn test_list() {
        let result = list(b"(1,2,3)");
        assert!(result.is_ok());
        let (_, token) = result.unwrap();
        match token {
            Token::List(items) => {
                assert_eq!(items.len(), 3);
                assert_eq!(items[0], Token::Integer(1));
                assert_eq!(items[1], Token::Integer(2));
                assert_eq!(items[2], Token::Integer(3));
            }
            _ => panic!("Expected List token"),
        }
    }

    #[test]
    fn test_nested_list() {
        let result = list(b"(1,(2,3),4)");
        assert!(result.is_ok());
        let (_, token) = result.unwrap();
        match token {
            Token::List(items) => {
                assert_eq!(items.len(), 3);
                assert_eq!(items[0], Token::Integer(1));
                match &items[1] {
                    Token::List(inner) => {
                        assert_eq!(inner.len(), 2);
                        assert_eq!(inner[0], Token::Integer(2));
                        assert_eq!(inner[1], Token::Integer(3));
                    }
                    _ => panic!("Expected nested List"),
                }
                assert_eq!(items[2], Token::Integer(4));
            }
            _ => panic!("Expected List token"),
        }
    }

    #[test]
    fn test_parse_entity() {
        let input = "#123=IFCWALL('guid','owner',$,$,'name',$,$,$);";
        let result = parse_entity(input);
        assert!(result.is_ok());
        let (id, ifc_type, args) = result.unwrap();
        assert_eq!(id, 123);
        assert_eq!(ifc_type, IfcType::IfcWall);
        assert_eq!(args.len(), 8);
    }

    #[test]
    fn test_parse_entity_with_nested_list() {
        // First test: simple list (should work)
        let simple = "(0.,0.,1.)";
        println!("Testing simple list: {}", simple);
        let simple_result = list(simple.as_bytes());
        println!("Simple list result: {:?}", simple_result);

        // Second test: nested in entity (what's failing)
        let input = "#9=IFCDIRECTION((0.,0.,1.));";
        println!("\nTesting full entity: {}", input);
        let result = parse_entity(input);

        if let Err(ref e) = result {
            println!("Parse error: {:?}", e);

            // Try parsing just the arguments part
            println!("\nTrying to parse just arguments: ((0.,0.,1.))");
            let args_input = "((0.,0.,1.))";
            let args_result = list(args_input.as_bytes());
            println!("Args list result: {:?}", args_result);
        }

        assert!(result.is_ok(), "Failed to parse: {:?}", result);
        let (id, _ifc_type, args) = result.unwrap();
        assert_eq!(id, 9);
        assert_eq!(args.len(), 1);
        // First arg should be a list containing 3 floats
        if let Token::List(inner) = &args[0] {
            assert_eq!(inner.len(), 3);
        } else {
            panic!("Expected Token::List, got {:?}", args[0]);
        }
    }

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

    /// Deeply nested list arguments must return an error rather than
    /// recursing through the stack until it overflows.
    #[test]
    fn test_parse_entity_rejects_excessive_nesting() {
        let n = (MAX_NESTING_DEPTH as usize) + 64;
        let mut s = String::from("#1=IFCWALL(");
        for _ in 0..n {
            s.push('(');
        }
        s.push('1');
        for _ in 0..n {
            s.push(')');
        }
        s.push_str(");");
        // Must not panic / overflow; must return Err.
        assert!(parse_entity(&s).is_err());
    }

    /// Moderate nesting still parses successfully.
    #[test]
    fn test_parse_entity_accepts_moderate_nesting() {
        let n = 32;
        let mut s = String::from("#1=IFCWALL(");
        for _ in 0..n {
            s.push('(');
        }
        s.push('1');
        for _ in 0..n {
            s.push(')');
        }
        s.push_str(");");
        assert!(parse_entity(&s).is_ok());
    }

    fn nested(n: usize) -> String {
        let mut s = String::from("#1=IFCWALL(");
        for _ in 0..n {
            s.push('(');
        }
        s.push('1');
        for _ in 0..n {
            s.push(')');
        }
        s.push_str(");");
        s
    }

    /// Boundary: parsing succeeds exactly at MAX_NESTING_DEPTH.
    #[test]
    fn test_parse_entity_accepts_exactly_max_nesting() {
        assert!(parse_entity(&nested(MAX_NESTING_DEPTH as usize)).is_ok());
    }

    /// Boundary: parsing fails at MAX_NESTING_DEPTH + 1.
    #[test]
    fn test_parse_entity_rejects_one_over_max_nesting() {
        assert!(parse_entity(&nested(MAX_NESTING_DEPTH as usize + 1)).is_err());
    }
}
