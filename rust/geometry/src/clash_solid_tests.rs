// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for [`super`] — in particular `component_groups`'s connectivity
//! notion. Split out of `clash_solid.rs` so that file stays under the
//! module-size rule.

use super::*;
use crate::clash_contact_axes::dot3;
use crate::kernel::arrangement::Tri;
use crate::kernel::near_band::NearBand;
use clash_solid_geom::component_groups;

/// PR #2923 review finding, directly against `trust_gate_reason` rather than
/// through the full `intersection_solid` mesh-boolean pipeline: two
/// axis-aligned boxes 10 km out in X,
///
/// ```text
/// A = [10000, 0, 0] .. [10001, 1, 1]
/// B = [10000.998, 0, 0.9994] .. [10002, 1, 2]
/// overlap extents:  X = 2 mm,  Y = 1 m,  Z = 0.6 mm
/// ```
///
/// The overlap's own bounding box is exactly these extents on every axis, so
/// a single degenerate "triangle" spanning the overlap's two extreme corners
/// reproduces them without needing the real CSG kernel to resolve the actual
/// wedge. (It does not, for unrelated reasons: at this 2 mm-vs-9.5 mm X
/// near-band ratio, `intersection_tris` on two real box meshes here returns
/// only the pair's Y-normal end caps with no connecting side walls, so
/// `component_groups` splits them into two components that are each
/// perfectly flat in Y — extent exactly `0.0` — which trivially wins ANY
/// argmin, correct or buggy, and never reaches the code path under test.
/// Measured directly against `intersection_tris`, confirmed exhaustively:
/// widening or narrowing the Y overlap either keeps that flat-cap artifact
/// or collapses the pair to `NoOverlap` outright. `trust_gate_reason` is
/// exactly the function `intersection_solid` calls with the SAME geometry
/// engine's real output on every other reachable pair, so exercising it here
/// with the overlap's true numeric extents is the direct test of the fixed
/// logic, not a weaker substitute for one through the full pipeline.)
///
/// `required_X` (~9.5 mm, since the X-normal faces at 10 km sit inside a
/// ~2.4 mm-scaled near band) is well above the 2 mm X overlap — X must be
/// gated. `required_Z` (~0.49 mm) is BELOW the 0.6 mm Z overlap, so Z alone
/// would pass. The old code picked Z as the global argmin-thickness axis
/// (0.6 mm, the smallest of the three) and checked ONLY `required_Z` — 0.6 mm
/// cleared it, so the pair was wrongly trusted, and `required_X` was never
/// consulted even though X is the axis the kernel actually collapsed.
#[test]
fn an_axis_below_its_own_band_is_caught_even_when_a_different_axis_is_the_argmin() {
    let axes: [[f64; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

    // Band sized from BOTH operands' full extents (not just the overlap),
    // exactly as `operand_near_band` builds it: X reaches 10002 (from B's
    // far face), Z reaches 2 (from B's far face).
    let mut band = NearBand::default();
    for p in [
        [10000.0, 0.0, 0.0],
        [10001.0, 1.0, 1.0],
        [10000.998, 0.0, 0.9994],
        [10002.0, 1.0, 2.0],
    ] {
        band.observe_point(&p);
    }

    // The overlap region's own bounding box: [10000.998, 0, 0.9994] ..
    // [10001, 1, 1]. A degenerate "triangle" (two distinct points, one
    // repeated) reproduces those extents on every axis exactly, since the
    // gate only ever reads `lo`/`hi` over the group's vertices.
    let overlap_lo = [10000.998, 0.0, 0.9994];
    let overlap_hi = [10001.0, 1.0, 1.0];
    let tris: Vec<Tri> = vec![[overlap_lo, overlap_hi, overlap_lo]];

    // RED on the old shape: an argmin-thickness `(thickness, required)` pair
    // checked against only the argmin axis's own band.
    let mut old_thickness = f64::INFINITY;
    let mut old_required = 0.0;
    for axis in &axes {
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        for v in &tris[0] {
            let p = dot3(*v, *axis);
            lo = lo.min(p);
            hi = hi.max(p);
        }
        let t = hi - lo;
        if t < old_thickness {
            old_thickness = t;
            old_required = TRUST_BAND_MULTIPLE * band.scaled_band2(*axis, 1.0).sqrt();
        }
    }
    assert!(
        old_thickness >= old_required,
        "premise: the old argmin-only shape must wrongly trust this pair (argmin {old_thickness} \
         >= its own required {old_required}) for this test to demonstrate the fix"
    );

    // GREEN on the new shape: `trust_gate_reason` must catch the X-axis
    // violation even though Z (not X) is the argmin.
    let reason = trust_gate_reason(&tris, &axes, &band, TRUST_BAND_MULTIPLE);
    assert!(
        reason.is_some(),
        "the 2 mm X overlap sits inside the X-normal near band at 10 km and must be caught, \
         even though the 0.6 mm Z overlap alone would clear the Z-axis band and used to be the \
         only axis checked"
    );
}

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
