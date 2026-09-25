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

/// Read the one STEP numeric literal at the start of `bytes`: its value and
/// the number of bytes it spans. `None` when [`step_numeric_literal_len`]
/// refuses it, so a malformed token is never read as its parseable prefix.
#[inline]
pub fn parse_step_numeric<T: fast_float2::FastFloat>(bytes: &[u8]) -> Option<(T, usize)> {
    let len = step_numeric_literal_len(bytes)?;
    fast_float2::parse::<T, _>(&bytes[..len]).ok().map(|v| (v, len))
}

#[cfg(test)]
#[path = "numeric_literal_tests.rs"]
mod tests;
