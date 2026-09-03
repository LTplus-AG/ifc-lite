// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! nom-combinator tokenizer for STEP/IFC entity lines.
//!
//! Zero-copy tokenization: string-like tokens borrow their original bytes.

use nom::{
    branch::alt,
    bytes::complete::take_while1,
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

/// Skip whitespace AND `/* ... */` comments -- 10303-21 allows a comment
/// anywhere whitespace is allowed, including between the attributes this
/// tokenizer decodes. Without this, `/* rev; b */ $` was not trivia: no `alt`
/// branch in `token_at_depth` starts with `/`, so a comment before a value
/// made the whole entity fail to parse rather than reading the value clean.
///
/// Reuses `skip_step_trivia`, the matched pair of the scanners' trivia skip
/// (`step-lexing.ts`'s `skipTrivia` on the TS side). An unterminated comment
/// consumes to end of input rather than failing this always-succeeds
/// combinator; the `alt` that follows then has nothing left to match and the
/// entity fails to parse, which is the existing behaviour for corrupt input.
fn ws(input: &[u8]) -> IResult<&[u8], ()> {
    let end = super::lexical::skip_step_trivia(input, 0).unwrap_or(input.len());
    Ok((&input[end..], ()))
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

#[cfg(test)]
#[path = "tokenizer_tests.rs"]
mod tokenizer_tests;
