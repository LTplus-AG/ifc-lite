// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for [`super`] — in particular `component_groups`'s connectivity
//! notion. Split out of `clash_solid.rs` so that file stays under the
//! module-size rule.

use super::*;

/// PR #2573 review finding, pinned as a KNOWN LIMITATION rather than fixed —
/// see `component_groups`'s doc comment for the full reasoning. Two triangles
/// that share only one bit-identical vertex (no shared edge) are still
/// unioned into a single component. Demonstrated directly against this
/// private function; the review's own attempts (and this repo's 25-case
/// `clash_intersection_oracle` suite) could not construct an equivalent
/// arrangement through the public `intersection_solid` entry point, so this
/// pins a real algorithmic gap without claiming it is reachable from real
/// geometry.
///
/// If this test ever starts failing (returns `2` instead of `1`), that is
/// GOOD news — it means some future change tightened the connectivity notion
/// without regressing `rotated_near_band_overlap_is_withheld_exactly_as_the_
/// axis_aligned_one_is` the way a naive shared-edge partition did when tried
/// during this review response. Update this test's expectation and the
/// `component_groups` doc comment together at that point; do not leave the
/// doc comment claiming a limitation that no longer exists.
#[test]
fn two_triangles_sharing_only_one_vertex_are_still_pooled_into_one_component_a_known_limitation() {
    let tri_a: Tri = [[0.0, 0.0, 0.0], [0.0001, 0.0, 0.0], [0.0, 0.0001, 0.0]]; // thin sliver near origin
    let tri_b: Tri = [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [10.0, 10.0, 0.0]]; // far-flung, shares vertex [0,0,0]

    let groups = component_groups(&[tri_a, tri_b]);

    assert_eq!(
        groups.len(),
        1,
        "documented limitation: a shared vertex (no shared edge) still pools these into one \
         component; if this now returns 2, see this test's doc comment before updating it"
    );
}

/// Control for the test above: the same two triangles with no shared vertex
/// at all are two components. Confirms the fixture is not a harness
/// artifact — the merge above is specifically caused by the shared vertex,
/// not some incidental property of the triangles' shapes.
#[test]
fn two_disjoint_triangles_with_no_shared_geometry_are_two_components() {
    let tri_a: Tri = [[0.0, 0.0, 0.0], [0.0001, 0.0, 0.0], [0.0, 0.0001, 0.0]];
    let tri_b: Tri = [[20.0, 0.0, 0.0], [30.0, 0.0, 0.0], [30.0, 10.0, 0.0]];

    let groups = component_groups(&[tri_a, tri_b]);

    assert_eq!(groups.len(), 2);
}
