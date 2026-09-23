// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The `parse_coordinates_direct` / `parse_coordinates_direct_f64` pair and
//! the one list walk both of them (and their comment-aware twins) share,
//! split out of `fast_parse.rs` to keep that module under the house ~400-line
//! budget.

use super::{comments, estimate_float_count};
use crate::parser::{is_step_space, parse_step_numeric, skip_step_comment};

/// Walk a `((x,y,z),(…))` coordinate list. Structure bytes (`(`, `)`, `,`,
/// STEP whitespace, and `/* … */` comments when `COMMENTS`) are stepped over;
/// every other byte must start one whole STEP numeric literal, read through
/// the shared grammar ([`parse_step_numeric`]). Anything else refuses the
/// whole list (empty), the same as the full tokenizer refusing the record: a
/// corrupted token (`1.52.3`) is never read as its prefix, and a non-numeric
/// one (`nan`, `$`) never silently vanishes, so no later coordinate shifts
/// (#5266).
///
/// `COMMENTS` is a const so the hot, comment-free instantiation carries no
/// comment check at all (#4720 / #4735): callers dispatch to the `true`
/// instantiation only after `may_contain_step_comment` finds a `/`.
#[inline(always)]
pub(super) fn read_coordinate_list<T: fast_float2::FastFloat, const COMMENTS: bool>(
    bytes: &[u8],
) -> Vec<T> {
    let mut result = Vec::with_capacity(estimate_float_count(bytes));
    let (mut pos, len) = (0, bytes.len());
    while pos < len {
        let b = bytes[pos];
        if b == b'(' || b == b')' || b == b',' || is_step_space(b) {
            pos += 1;
            continue;
        }
        if COMMENTS && b == b'/' {
            match skip_step_comment(bytes, pos) {
                Some(end) => {
                    pos = end;
                    continue;
                }
                None => return Vec::new(),
            }
        }
        match parse_step_numeric::<T>(&bytes[pos..]) {
            Some((value, consumed)) => {
                result.push(value);
                pos += consumed;
            }
            None => return Vec::new(),
        }
    }
    result
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
    read_coordinate_list::<f32, false>(bytes)
}

/// Parse coordinate list directly from raw bytes to `Vec<f64>`
///
/// Same as parse_coordinates_direct but with f64 precision.
#[inline]
pub fn parse_coordinates_direct_f64(bytes: &[u8]) -> Vec<f64> {
    if comments::may_contain_step_comment(bytes) {
        return comments::parse_coordinates_f64(bytes);
    }
    read_coordinate_list::<f64, false>(bytes)
}
