// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The one STEP numeric-literal grammar every Rust raw-byte reader shares
//! (#5266): the Rust twin of `isCompleteStepNumericLiteral` in
//! `packages/data/src/step-numeric-literal.ts` (#5193). Keep the two
//! grammars identical.
//!
//! `fast_float2::parse_partial` is not a STEP reader. It returns the longest
//! prefix it can read and leaves the caller to decide what the rest means,
//! so a dropped comma (`1.52.3`) read as `1.52` and then `.3` became the next
//! coordinate. It also accepts `nan`, `inf` and `infinity`, which are not
//! STEP literals at all. So no reader hands bytes to `fast_float2` until
//! [`step_numeric_literal_len`] has said exactly which bytes form one whole
//! literal.

use super::lexical::is_step_space;

/// Length of the STEP `REAL`/`INTEGER` literal at the start of `bytes`, when
/// the bytes there are exactly one literal followed by something that may
/// legally follow a list item: end of input, `,`, `)`, STEP whitespace, or a
/// `/*` comment. `None` otherwise.
///
/// Grammar (ISO 10303-21 §5.3, as `isCompleteStepNumericLiteral` reads it):
/// optional sign, digits with an optional `.` and fraction digits or a
/// bare-dot fraction (`1`, `1.`, `1.5`, `.5`), at least one digit overall,
/// then an optional exponent (`e`/`E`, optional sign, at least one digit).
///
/// A hand-rolled forward scan with no allocation: it runs once per number on
/// the geometry hot path.
#[inline]
pub fn step_numeric_literal_len(bytes: &[u8]) -> Option<usize> {
    let digits_from = |mut i: usize| {
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        i
    };
    let mut i = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let int_end = digits_from(i);
    let mut digits = int_end - i;
    i = int_end;
    if bytes.get(i) == Some(&b'.') {
        let frac_end = digits_from(i + 1);
        digits += frac_end - (i + 1);
        i = frac_end;
    }
    if digits == 0 {
        return None;
    }
    if matches!(bytes.get(i), Some(b'e' | b'E')) {
        let exp_start = i + 1 + usize::from(matches!(bytes.get(i + 1), Some(b'+' | b'-')));
        let exp_end = digits_from(exp_start);
        if exp_end == exp_start {
            return None;
        }
        i = exp_end;
    }
    match bytes.get(i) {
        None => Some(i),
        Some(&b) if b == b',' || b == b')' || is_step_space(b) => Some(i),
        Some(&b'/') if bytes.get(i + 1) == Some(&b'*') => Some(i),
        _ => None,
    }
}

/// The one admission rule for a decoded STEP `REAL` (#7678): the value must be
/// finite in the type it is read into. Every Rust reader that turns STEP
/// bytes into a float goes through this, the nom [`super::tokenizer`] and
/// [`parse_step_numeric`] alike, so no reader admits what another refuses.
///
/// STEP has no spelling for NaN or infinity (the grammar above refuses `nan`
/// and `inf`), so the only way to get one is a literal the type cannot hold:
/// `1.E400` overflows `f64`, and `1.E39` overflows the `f32` the coordinate
/// fast paths read into. A refused literal has two consumers:
///
/// - geometry refuses it. The fast paths answer `None` in every mode; the
///   tokenizer yields `Token::UnrepresentableReal`, and a geometry decoder
///   (`EntityDecoder::with_strict_reals`) refuses the record with
///   `Error::UnrepresentableReal`, so the element fails closed and is
///   counted. An object definition (a product's own record) is admitted:
///   its reals are descriptive, never geometry;
/// - everything else keeps it: the default decoder is lossless and reads
///   the record as before, the literal as a signed infinity, so the data
///   model, exporters and georeferencing never lose an entity to it.
///
/// Only overflow is refused. `-0.` stays `-0.0`, sign bit included, and an
/// underflowing literal (`1.E-400`) still reads as the zero it rounds to.
#[inline]
pub(crate) fn admit_step_real<T: Copy + Into<f64>>(value: T) -> Option<T> {
    value.into().is_finite().then_some(value)
}

/// Read the one STEP numeric literal at the start of `bytes`: its value and
/// the number of bytes it spans. `None` when [`step_numeric_literal_len`]
/// refuses it, so a malformed token is never read as its parseable prefix,
/// and when [`admit_step_real`] refuses the value, so an overflowing one is
/// never read as an infinity.
#[inline]
pub fn parse_step_numeric<T: fast_float2::FastFloat + Into<f64>>(
    bytes: &[u8],
) -> Option<(T, usize)> {
    let len = step_numeric_literal_len(bytes)?;
    let value = fast_float2::parse::<T, _>(&bytes[..len]).ok()?;
    admit_step_real(value).map(|v| (v, len))
}

/// [`parse_step_numeric`] for a token that must be exactly one literal: the
/// whole of `token`, ASCII whitespace trimmed, read as an admitted `f64`.
/// For readers that already split a record into attribute tokens, which used
/// `str::parse::<f64>` and so read `inf`, `NaN` and `1.E400` as numbers.
#[inline]
pub fn parse_step_real(token: &[u8]) -> Option<f64> {
    let token = token.trim_ascii();
    let (value, len) = parse_step_numeric::<f64>(token)?;
    (len == token.len()).then_some(value)
}

#[cfg(test)]
#[path = "numeric_literal_tests.rs"]
mod tests;
