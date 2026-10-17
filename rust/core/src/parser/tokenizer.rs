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
use crate::step_encoding::step_string_literal_end;
use super::numeric_literal::admit_step_real;

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
    /// A complete STEP `REAL` literal that `f64` cannot hold (`1.E400`),
    /// carried as its raw text. [`super::numeric_literal::admit_step_real`]
    /// decides which literals land here (#7678): the decoder refuses the
    /// record for geometry and keeps it, as an infinity, for the data model.
    UnrepresentableReal(&'a [u8]),
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
///
/// An apostrophe literal ends where the shared rule says it does
/// ([`step_string_literal_end`]): `''` is an escaped quote and the operand of
/// a `\S\` PAGE directive is text. Ending at that operand left the rest of
/// `'Para \S\' 5'` as unparseable input, so the whole entity failed to
/// decode (#7589). The token borrows the content between the quotes, still
/// escaped; consumers un-double `''` and decode backslash escapes.
fn string_literal(input: &[u8]) -> IResult<&[u8], Token<'_>> {
    match input.first() {
        Some(b'\'') => match step_string_literal_end(input, 0) {
            Some(past_close) => Ok((
                &input[past_close..],
                Token::String(&input[1..past_close - 1]),
            )),
            None => Err(nom::Err::Error(nom::error::Error::new(
                input,
                nom::error::ErrorKind::Char,
            ))),
        },
        _ => map(
            delimited(char('"'), double_quoted_content, char('"')),
            Token::String,
        )(input),
    }
}

/// Content of a `"..."` literal up to its closing `"`; a doubled `""` stays
/// inside. Uses memchr for SIMD-accelerated quote searching.
#[inline]
fn double_quoted_content(input: &[u8]) -> IResult<&[u8], &[u8]> {
    let mut pos = 0;
    while let Some(found) = memchr::memchr(b'"', &input[pos..]) {
        let idx = pos + found;
        if input.get(idx + 1) == Some(&b'"') {
            pos = idx + 2;
            continue;
        }
        return Ok((&input[idx..], &input[..idx]));
    }
    Err(nom::Err::Error(nom::error::Error::new(
        input,
        nom::error::ErrorKind::Char,
    )))
}

/// Parse integer: 42, -42, +42
///
/// ISO 10303-21 spells `INTEGER` as `[ SIGN ] DIGIT { DIGIT }` with
/// `SIGN = '+' | '-'`, so a leading `+` is as legal as a leading `-`. Accepting
/// only `-` dropped the WHOLE entity, not just the attribute: every caller of
/// `parse_entity` discards a record that fails to tokenize
/// (`let Ok(..) = .. else { continue }`). The exponent sign below already
/// accepted both, `fast_float2::parse_partial` (the fast reader in `decoder.rs`)
/// accepts `+`, and the TypeScript half reads values with `parseFloat`, so the
/// same file used to decode differently in the browser and in wasm.
/// Uses lexical-core for 10x faster parsing
#[inline]
fn integer(input: &[u8]) -> IResult<&[u8], Token<'_>> {
    map_res(recognize(tuple((opt(one_of("+-")), digit1))), |s: &[u8]| {
        lexical_core::parse::<i64>(s)
            .map(Token::Integer)
            .map_err(|_| "parse error")
    })(input)
}

/// Parse float: 3.14, -3.14, +3.14, 1.5E-10, 0., 1.
/// IFC allows floats like "0." without decimal digits
///
/// `REAL` carries the same `[ SIGN ]` as `INTEGER`; see [`integer`] for why a
/// rejected sign costs the whole entity. A literal `f64` cannot hold
/// (`1.E400`) becomes [`Token::UnrepresentableReal`], by [`admit_step_real`]
/// (#7678); the decoder, not the tokenizer, decides what that costs.
/// Uses lexical-core for 10x faster parsing
#[inline]
fn float(input: &[u8]) -> IResult<&[u8], Token<'_>> {
    map_res(
        recognize(tuple((
            opt(one_of("+-")),
            digit1,
            char('.'),
            opt(digit1), // Made optional to support "0." format
            opt(tuple((one_of("eE"), opt(one_of("+-")), digit1))),
        ))),
        |s: &[u8]| {
            lexical_core::parse::<f64>(s)
                .map(|v| admit_step_real(v).map_or(Token::UnrepresentableReal(s), Token::Float))
                .map_err(|_| "parse error")
        },
    )(input)
}

/// Whether `literal` is exactly one number token this tokenizer reads
/// ([`float`] or [`integer`]). Stricter than the shared raw-byte grammar
/// (`numeric_literal`): no bare-dot fraction (`.5`), no exponent without a
/// `.` (`1E5`), no `INTEGER` past `i64`. A raw-byte reader that must agree
/// with the full decode (`decoder::leaf_read`) checks its literals here.
pub(crate) fn is_decodable_number(literal: &[u8]) -> bool {
    matches!(alt((float, integer))(literal), Ok((rest, _)) if rest.is_empty())
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
///
/// The type name and its `(` are usually adjacent, but a STEP writer's line
/// wrap can land exactly between them - measured on a real file where 39 of
/// 175 `IFCSURFACESTYLERENDERING` entities wrap as `…MEASURE\r\n(1.)`. Without
/// `ws` here, `char('(')` sees `\r` and the whole entity fails to parse, which
/// silently dropped it from every full-file walk (`decode_at_uncached` returns
/// `Err`, and every caller's `let Ok(..) = .. else { continue }` skips it) -
/// the entity was never malformed, just wrapped where the parser assumed it
/// never would be.
///
/// An EMPTY argument list also needs `ws` on both sides of the parens
/// (`IFCLABEL(\r\n)`), not just before `(`: `separated_list0` matches zero
/// items without consuming anything, so with a bare `char(')')` any
/// whitespace or comment before the `)` left it unconsumed and the whole
/// typed value failed to parse (#3789).
fn typed_value_at_depth(input: &[u8], depth: u32) -> IResult<&[u8], Token<'_>> {
    map(
        pair(
            // Type name (all caps with optional numbers/underscores)
            take_while1(|c: u8| c.is_ascii_alphanumeric() || c == b'_'),
            // Arguments
            delimited(
                pair(ws, char('(')),
                preceded(
                    ws,
                    separated_list0(delimited(ws, char(','), ws), move |i| {
                        token_at_depth(i, depth)
                    }),
                ),
                pair(ws, char(')')),
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

/// An EMPTY list (`( )`, `(\r\n)`, `(/* empty */)`) needs `ws` explicitly
/// around the empty `separated_list0`: it matches zero items without
/// consuming anything, so a bare `char(')')` failed to parse past any
/// whitespace or comment left between the parens (#3789, same shape as
/// `typed_value_at_depth`'s empty-args fix).
fn list_at_depth(input: &[u8], depth: u32) -> IResult<&[u8], Token<'_>> {
    map(
        delimited(
            pair(char('('), ws),
            separated_list0(delimited(ws, char(','), ws), move |i| {
                token_at_depth(i, depth)
            }),
            pair(ws, char(')')),
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
        // Arguments: ('guid', 'owner', ...). `ws` around the empty
        // `separated_list0` handles an EMPTY argument list separated from
        // its `)` by whitespace or a comment (`#1=IFCX(\r\n);`), the same
        // shape as `list_at_depth`'s and `typed_value_at_depth`'s fix
        // (#3789): with zero items `separated_list0` consumes nothing, so
        // a bare `char(')')` failed to parse past it.
        delimited(
            pair(char('('), ws),
            separated_list0(delimited(ws, char(','), ws), token),
            tuple((ws, char(')'), ws, char(';'))),
        ),
    ))(input);

    match result {
        Ok((_, (id, type_str, args))) => {
            let type_str = std::str::from_utf8(type_str)
                .map_err(|_| Error::parse(0, "Entity type is not ASCII/UTF-8"))?;
            let ifc_type = IfcType::from_str(type_str);
            Ok((id, ifc_type, args))
        }
        Err(e) => Err(entity_parse_error(input, e)),
    }
}

/// Bytes of the failing input quoted in a parse error.
const ERROR_CONTEXT_BYTES: usize = 64;

/// A nom failure as a bounded [`Error`]: the byte offset, nom's error kind and
/// at most [`ERROR_CONTEXT_BYTES`] of lossy context. nom 7's `Display` for
/// `Err` writes the inner error with `{:?}`, which is every REMAINING input byte
/// as a decimal number, so formatting it built a message 4-5x the record (a
/// 20 MB point list: ~100 MB of text per failed decode, built and dropped by
/// every `let Ok(..) else continue` walk; #7675, CORE-5).
fn entity_parse_error(input: &[u8], e: nom::Err<nom::error::Error<&[u8]>>) -> Error {
    match e {
        nom::Err::Incomplete(_) => Error::parse(input.len(), "Failed to parse entity: incomplete input"),
        nom::Err::Error(inner) | nom::Err::Failure(inner) => {
            let rest = inner.input;
            let near = &rest[..rest.len().min(ERROR_CONTEXT_BYTES)];
            Error::parse(
                input.len().saturating_sub(rest.len()),
                format!(
                    "Failed to parse entity: {:?} near {:?}",
                    inner.code,
                    String::from_utf8_lossy(near)
                ),
            )
        }
    }
}

#[cfg(test)]
#[path = "tokenizer_tests.rs"]
mod tokenizer_tests;
