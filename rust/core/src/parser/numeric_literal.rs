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
    scan_step_numeric_literal(bytes).map(|(len, _)| len)
}

/// Keep the kind found by the grammar walk so the number reader does not
/// scan the admitted literal again to distinguish INTEGER from REAL (#7779).
#[inline]
fn scan_step_numeric_literal(bytes: &[u8]) -> Option<(usize, bool)> {
    scan::<false>(bytes).map(|literal| (literal.len, literal.real))
}

/// One admitted literal as the grammar walk saw it. With `VALUE`, the walk
/// also folds every digit into `mantissa` (wrapping: it is only read when
/// `digits <= 19`, where it cannot wrap) and reads the exponent (saturated
/// far beyond any exponent the exact path accepts), so the reader need not
/// walk the literal a second time to value it.
struct Literal {
    len: usize,
    real: bool,
    /// Integer and fraction digits, leading zeros included.
    digits: usize,
    fraction_digits: usize,
    mantissa: u64,
    exponent: i64,
}

/// Saturation for the exponent read by [`scan`]: far outside both the exact
/// path's range and `f64`'s, so a saturated exponent always falls back.
const EXPONENT_CAP: i64 = 1 << 20;

/// The grammar walk of [`scan_step_numeric_literal`]: the one grammar, with
/// the value accumulation compiled in only for [`read_step_number`].
#[inline(always)]
fn scan<const VALUE: bool>(bytes: &[u8]) -> Option<Literal> {
    let mut mantissa = 0u64;
    let mut digits_from = |mut i: usize| {
        while let Some(&b) = bytes.get(i).filter(|b| b.is_ascii_digit()) {
            if VALUE {
                mantissa = mantissa.wrapping_mul(10).wrapping_add(u64::from(b - b'0'));
            }
            i += 1;
        }
        i
    };
    let mut i = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let int_end = digits_from(i);
    let mut digits = int_end - i;
    i = int_end;
    let mut real = bytes.get(i) == Some(&b'.');
    let mut fraction_digits = 0;
    if real {
        let frac_end = digits_from(i + 1);
        fraction_digits = frac_end - (i + 1);
        digits += fraction_digits;
        i = frac_end;
    }
    if digits == 0 {
        return None;
    }
    let mut exponent = 0i64;
    if matches!(bytes.get(i), Some(b'e' | b'E')) {
        real = true;
        let negative = bytes.get(i + 1) == Some(&b'-');
        let exp_start = i + 1 + usize::from(matches!(bytes.get(i + 1), Some(b'+' | b'-')));
        let mut exp_end = exp_start;
        while let Some(&b) = bytes.get(exp_end).filter(|b| b.is_ascii_digit()) {
            if VALUE {
                exponent = (exponent * 10 + i64::from(b - b'0')).min(EXPONENT_CAP);
            }
            exp_end += 1;
        }
        if exp_end == exp_start {
            return None;
        }
        if negative {
            exponent = -exponent;
        }
        i = exp_end;
    }
    let literal = Literal { len: i, real, digits, fraction_digits, mantissa, exponent };
    match bytes.get(i) {
        None => Some(literal),
        Some(&b) if b == b',' || b == b')' || is_step_space(b) => Some(literal),
        Some(&b'/') if bytes.get(i + 1) == Some(&b'*') => Some(literal),
        _ => None,
    }
}

/// Exact powers of ten: every one up to 1e22 is an `f64` exactly.
const POW10: [f64; 23] = [
    1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16,
    1e17, 1e18, 1e19, 1e20, 1e21, 1e22,
];

/// The literal's magnitude when it is exact in one IEEE operation (Clinger's
/// fast path): a mantissa of at most 2^53 is an exact `f64`, as is 10^k for
/// k <= 22, so `m * 10^k` and `m / 10^k` are each the correctly rounded value
/// of the decimal, the value `fast_float2` returns for it. `None` otherwise;
/// the caller then asks `fast_float2`. The sign is the caller's (-0. stays
/// -0.).
#[inline(always)]
fn exact_magnitude(literal: &Literal) -> Option<f64> {
    if literal.digits > 19 || literal.mantissa > 1 << 53 {
        return None;
    }
    let power = literal.exponent - literal.fraction_digits as i64;
    let m = literal.mantissa as f64;
    match power {
        0..=22 => Some(m * POW10[power as usize]),
        -22..=-1 => Some(m / POW10[(-power) as usize]),
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
/// whole of `token`, STEP whitespace trimmed, read as an admitted `f64`.
/// For readers that already split a record into attribute tokens, which used
/// `str::parse::<f64>` and so read `inf`, `NaN` and `1.E400` as numbers.
#[inline]
pub fn parse_step_real(token: &[u8]) -> Option<f64> {
    let start = token.iter().position(|&b| !is_step_space(b))?;
    let end = token.iter().rposition(|&b| !is_step_space(b))? + 1;
    let token = &token[start..end];
    let (value, len) = parse_step_numeric::<f64>(token)?;
    (len == token.len()).then_some(value)
}

/// One STEP number as the tokenizer and every byte reader see it (F4-1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StepNumber<'a> {
    /// An `INTEGER`: no `.` and no exponent.
    Integer(i64),
    /// A `REAL` that `f64` holds. `-0.` keeps its sign bit.
    Real(f64),
    /// A complete `REAL` literal `f64` cannot hold (`1.E400`), as its raw
    /// text; [`admit_step_real`] decides (#7678).
    Unrepresentable(&'a [u8]),
}

/// Read the one STEP number at the start of `bytes` and the bytes it spans.
///
/// The one number reader: the nom tokenizer's number branch and the raw-byte
/// readers share it, so the grammar is [`step_numeric_literal_len`] alone
/// (`.5`, `1E5`, `+1`, `1.`, `-0.`). A literal is a `REAL` iff it has a `.`
/// or an exponent (`1E5` is `Real(100000.0)`). `None` for anything that is
/// not exactly one literal, and for an `INTEGER` beyond `i64`.
#[inline]
pub fn read_step_number(bytes: &[u8]) -> Option<(StepNumber<'_>, usize)> {
    let scanned = scan::<true>(bytes)?;
    let len = scanned.len;
    let literal = &bytes[..len];
    let negative = literal[0] == b'-';
    if scanned.real {
        // The grammar walk already valued the literal when it is exact in one
        // operation (#7880's `N.` case among them); else it already validated
        // the entire literal for `fast_float2` (#7779).
        let value = match exact_magnitude(&scanned) {
            Some(magnitude) => if negative { -magnitude } else { magnitude },
            None => fast_float2::parse_partial::<f64, _>(literal).ok()?.0,
        };
        let number = admit_step_real(value)
            .map_or(StepNumber::Unrepresentable(literal), StepNumber::Real);
        return Some((number, len));
    }
    // At most 18 digits cannot leave `i64`, so the walk's mantissa is the
    // value; a longer integer takes the checked walk.
    if scanned.digits <= 18 {
        let magnitude = scanned.mantissa as i64;
        return Some((StepNumber::Integer(if negative { -magnitude } else { magnitude }), len));
    }
    let digits = match literal[0] {
        b'-' | b'+' => &literal[1..],
        _ => literal,
    };
    // Accumulate negatively so `i64::MIN` is representable.
    let mut value: i64 = 0;
    for &d in digits {
        value = value.checked_mul(10)?.checked_sub(i64::from(d - b'0'))?;
    }
    let value = if negative { value } else { value.checked_neg()? };
    Some((StepNumber::Integer(value), len))
}

#[cfg(test)]
#[path = "numeric_literal_tests.rs"]
mod tests;
