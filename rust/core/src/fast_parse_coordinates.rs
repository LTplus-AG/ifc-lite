// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The `parse_coordinates_direct` / `parse_coordinates_direct_f64` pair and
//! the one list walk both of them (and their comment-aware twins) share,
//! split out of `fast_parse.rs` to keep that module under the house ~400-line
//! budget.

use super::{comments, estimate_float_count};
use crate::parser::{is_step_space, parse_step_numeric, skip_step_trivia};

/// Walk a `((x,y,z),(…))` coordinate list the way the tokenizer reads it:
/// items separated by exactly one `,`, lists opened by `(` and closed by `)`,
/// STEP whitespace (and `/* … */` comments when `COMMENTS`) as trivia, and
/// every value one whole STEP numeric literal read through the shared grammar
/// ([`parse_step_numeric`]). Anything else is `None`, the same as the
/// tokenizer refusing the record: a corrupted token (`1.52.3`), a non-STEP
/// one (`nan`, `$`), a dropped comma (`1.52 .3`), a missing value (`1.,,2.`),
/// a trailing comma (`(1.,2.,)`) or an unbalanced list (`((1.,2.,3.)`). A
/// refused list is never read as a shorter or shifted one (#5266).
///
/// `COMMENTS` is a const so the hot, comment-free instantiation carries no
/// comment check at all (#4720 / #4735): callers dispatch to the `true`
/// instantiation only after `may_contain_step_comment` finds a `/`.
#[inline(always)]
pub(super) fn read_coordinate_list<T: fast_float2::FastFloat, const COMMENTS: bool>(
    bytes: &[u8],
) -> Option<Vec<T>> {
    let mut result = Vec::with_capacity(estimate_float_count(bytes));
    let (mut pos, len) = (0, bytes.len());
    // `after_item`: a value or a closed list was just read, so `,` or `)`
    // must come next. `after_comma`: a `,` was just read, so an item must.
    // `depth`: open lists, which must all close by the end of input.
    let (mut after_item, mut after_comma, mut depth) = (false, false, 0usize);
    loop {
        if COMMENTS {
            pos = skip_step_trivia(bytes, pos)?;
        } else {
            while pos < len && is_step_space(bytes[pos]) {
                pos += 1;
            }
        }
        let Some(&b) = bytes.get(pos) else { break };
        match b {
            b',' if after_item => {
                (after_item, after_comma) = (false, true);
                pos += 1;
            }
            b')' if !after_comma && depth > 0 => {
                after_item = true;
                depth -= 1;
                pos += 1;
            }
            b'(' if !after_item => {
                after_comma = false;
                depth += 1;
                pos += 1;
            }
            _ if !after_item => {
                let (value, consumed) = parse_step_numeric::<T>(&bytes[pos..])?;
                result.push(value);
                (after_item, after_comma) = (true, false);
                pos += consumed;
            }
            _ => return None,
        }
    }
    (!after_comma && depth == 0).then_some(result)
}

/// [`parse_coordinates_direct`] that says when it refused the list (`None`)
/// rather than answering with an empty one. [`super::extract_coordinate_list_from_entity`]
/// uses this so a corrupt coordinate record is refused, not read as a
/// successful record with no positions.
#[inline]
pub(super) fn try_parse_coordinates_direct(bytes: &[u8]) -> Option<Vec<f32>> {
    if comments::may_contain_step_comment(bytes) {
        return comments::parse_coordinates(bytes);
    }
    read_coordinate_list::<f32, false>(bytes)
}

/// Parse coordinate list directly from raw bytes to `Vec<f32>`
///
/// This parses IFC coordinate data like:
/// `((0.,0.,150.),(0.,40.,140.),...)`
///
/// Returns flattened f32 array: [x0, y0, z0, x1, y1, z1, ...], or an empty
/// one when the list is refused (see [`read_coordinate_list`]).
///
/// # Performance
/// - Zero intermediate allocations (no Token, no AttributeValue)
/// - Uses fast-float for SIMD-accelerated parsing
/// - Pre-allocates result vector
#[inline]
pub fn parse_coordinates_direct(bytes: &[u8]) -> Vec<f32> {
    try_parse_coordinates_direct(bytes).unwrap_or_default()
}

/// Parse coordinate list directly from raw bytes to `Vec<f64>`
///
/// Same as parse_coordinates_direct but with f64 precision.
#[inline]
pub fn parse_coordinates_direct_f64(bytes: &[u8]) -> Vec<f64> {
    try_parse_coordinates_direct_f64(bytes).unwrap_or_default()
}

/// [`try_parse_coordinates_direct`] at f64 precision, for callers that must
/// subtract a large offset before narrowing (#5698).
#[inline]
pub(super) fn try_parse_coordinates_direct_f64(bytes: &[u8]) -> Option<Vec<f64>> {
    if comments::may_contain_step_comment(bytes) {
        return comments::parse_coordinates_f64(bytes);
    }
    read_coordinate_list::<f64, false>(bytes)
}
