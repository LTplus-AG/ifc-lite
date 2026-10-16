// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cold, comment-aware twins of the point-list hot loops.

/// Real point lists almost never contain comments. Pay one SIMD
/// slash search so their inner delimiter loop stays identical to the
/// pre-#4720 hot path; a false positive merely selects the slower twin.
#[inline]
pub(super) fn may_contain_step_comment(bytes: &[u8]) -> bool {
    memchr::memchr(b'/', bytes).is_some()
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
