// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cold, comment-aware twins of the point-list hot loops.

use super::{estimate_float_count, estimate_int_count, is_number_start, parse_index_value};
use crate::parser::is_step_numeric_delimiter;

/// Same check as [`is_step_numeric_delimiter`], plus a `/* ... */` comment
/// opening right where a real STEP file may legally place one: glued onto a
/// numeric literal with no separator before it (`1.52/* note */,3.0`). Only
/// these comment-aware twins need the extra case -- their non-comment-aware
/// counterparts in `fast_parse.rs` already route here the moment a `/`
/// appears anywhere in the bytes, so a bare delimiter check is enough there.
#[inline]
fn is_step_numeric_delimiter_or_comment(bytes: &[u8], pos: usize) -> bool {
    match bytes.get(pos) {
        None => true,
        Some(&b) if is_step_numeric_delimiter(b) => true,
        Some(&b'/') => bytes.get(pos + 1) == Some(&b'*'),
        _ => false,
    }
}

/// Real point and index lists almost never contain comments. Pay one SIMD
/// slash search so their inner delimiter loop stays identical to the
/// pre-#4720 hot path; a false positive merely selects the slower twin.
#[inline]
pub(super) fn may_contain_step_comment(bytes: &[u8]) -> bool {
    memchr::memchr(b'/', bytes).is_some()
}

/// The first byte at or after `pos` that `starts_value` accepts, stepping over
/// `/* ... */` comments whole so their digits are never read as data (#4687).
fn next_value_start(bytes: &[u8], mut pos: usize, starts_value: fn(u8) -> bool) -> Option<usize> {
    loop {
        let b = *bytes.get(pos)?;
        if starts_value(b) {
            return Some(pos);
        }
        pos = if b == b'/' && bytes.get(pos + 1) == Some(&b'*') {
            crate::parser::skip_step_comment(bytes, pos)?
        } else {
            pos + 1
        };
    }
}

#[cold]
pub(super) fn parse_coordinates(bytes: &[u8]) -> Vec<f32> {
    #[cfg(test)]
    super::tests::mark_comment_aware_call();
    let mut result = Vec::with_capacity(estimate_float_count(bytes));
    let mut pos = 0;
    while let Some(start) = next_value_start(bytes, pos, is_number_start) {
        pos = start;
        match fast_float2::parse_partial::<f32, _>(&bytes[pos..]) {
            Ok((value, consumed)) if consumed > 0 => {
                // See `is_step_numeric_delimiter_or_comment` above: refuse
                // rather than let a dropped comma's leftover digits become
                // the next coordinate (#5266).
                if !is_step_numeric_delimiter_or_comment(bytes, pos + consumed) {
                    return Vec::new();
                }
                result.push(value);
                pos += consumed;
            }
            _ => pos += 1,
        }
    }
    result
}

#[cold]
pub(super) fn parse_coordinates_f64(bytes: &[u8]) -> Vec<f64> {
    #[cfg(test)]
    super::tests::mark_comment_aware_call();
    let mut result = Vec::with_capacity(estimate_float_count(bytes));
    let mut pos = 0;
    while let Some(start) = next_value_start(bytes, pos, is_number_start) {
        pos = start;
        match fast_float2::parse_partial::<f64, _>(&bytes[pos..]) {
            Ok((value, consumed)) if consumed > 0 => {
                // See `is_step_numeric_delimiter_or_comment` above (#5266).
                if !is_step_numeric_delimiter_or_comment(bytes, pos + consumed) {
                    return Vec::new();
                }
                result.push(value);
                pos += consumed;
            }
            _ => pos += 1,
        }
    }
    result
}

#[cold]
pub(super) fn parse_indices(bytes: &[u8]) -> Vec<u32> {
    #[cfg(test)]
    super::tests::mark_comment_aware_call();
    let mut result = Vec::with_capacity(estimate_int_count(bytes));
    let mut pos = 0;
    while let Some(start) = next_value_start(bytes, pos, |b| b.is_ascii_digit()) {
        pos = start;
        parse_index_value(bytes, &mut pos, &mut result);
    }
    result
}
