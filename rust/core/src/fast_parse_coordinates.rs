// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The `parse_coordinates_direct` / `parse_coordinates_direct_f64` pair and
//! their shared helpers, split out of `fast_parse.rs` to keep that module
//! under the house ~400-line budget (a genuine cohesion boundary: this pair
//! is the one reader group in `fast_parse.rs` that owns the corrupted-literal
//! refusal added for #5266, distinct from the index/entity-extraction
//! functions that stayed behind).

use super::{comments, estimate_float_count, is_number_start};
use crate::parser::is_step_numeric_delimiter;

/// `fast_float2::parse_partial` reads only the longest valid prefix, so a
/// corrupted literal like `1.52.3` (a dropped comma) parses as `1.52` with
/// `.3` left dangling to be misread as the next coordinate. Require a STEP
/// delimiter right after what was consumed, or refuse the whole list rather
/// than fabricate a shifted point (#5266). Shared by the f32 and f64 readers
/// below, which are otherwise identical but for the float width.
#[inline(always)]
fn literal_ends_in_a_step_delimiter(bytes: &[u8], pos: usize, consumed: usize) -> bool {
    bytes.get(pos + consumed).is_none_or(|&b| is_step_numeric_delimiter(b))
}

/// Parse coordinate list directly from raw bytes to `Vec<f32>`
///
/// This parses IFC coordinate data like:
/// `((0.,0.,150.),(0.,40.,140.),...)`
///
/// Returns flattened f32 array: [x0, y0, z0, x1, y1, z1, ...]
///
/// # Performance
/// - Zero intermediate allocations (no Token, no AttributeValue)
/// - Uses fast-float for SIMD-accelerated parsing
/// - Pre-allocates result vector
#[inline]
pub fn parse_coordinates_direct(bytes: &[u8]) -> Vec<f32> {
    if comments::may_contain_step_comment(bytes) {
        return comments::parse_coordinates(bytes);
    }
    let mut result = Vec::with_capacity(estimate_float_count(bytes));
    let (mut pos, len) = (0, bytes.len());
    while pos < len {
        while pos < len && !is_number_start(bytes[pos]) {
            pos += 1;
        }
        if pos >= len {
            break;
        }
        match fast_float2::parse_partial::<f32, _>(&bytes[pos..]) {
            Ok((value, consumed)) if consumed > 0 => {
                if !literal_ends_in_a_step_delimiter(bytes, pos, consumed) {
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

/// Parse coordinate list directly from raw bytes to `Vec<f64>`
///
/// Same as parse_coordinates_direct but with f64 precision.
#[inline]
pub fn parse_coordinates_direct_f64(bytes: &[u8]) -> Vec<f64> {
    if comments::may_contain_step_comment(bytes) {
        return comments::parse_coordinates_f64(bytes);
    }
    let mut result = Vec::with_capacity(estimate_float_count(bytes));
    let (mut pos, len) = (0, bytes.len());
    while pos < len {
        while pos < len && !is_number_start(bytes[pos]) {
            pos += 1;
        }
        if pos >= len {
            break;
        }
        match fast_float2::parse_partial::<f64, _>(&bytes[pos..]) {
            Ok((value, consumed)) if consumed > 0 => {
                if !literal_ends_in_a_step_delimiter(bytes, pos, consumed) {
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
