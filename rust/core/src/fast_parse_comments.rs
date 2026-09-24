// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cold, comment-aware twins of the point-list hot loops.

use super::{estimate_int_count, parse_index_value};

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
pub(super) fn parse_coordinates(bytes: &[u8]) -> Option<Vec<f32>> {
    #[cfg(test)]
    super::tests::mark_comment_aware_call();
    super::coordinates::read_coordinate_list::<f32, true>(bytes)
}

#[cold]
pub(super) fn parse_coordinates_f64(bytes: &[u8]) -> Option<Vec<f64>> {
    #[cfg(test)]
    super::tests::mark_comment_aware_call();
    super::coordinates::read_coordinate_list::<f64, true>(bytes)
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
