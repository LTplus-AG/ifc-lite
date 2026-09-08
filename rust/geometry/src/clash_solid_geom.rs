// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Geometric helpers for [`super::intersection_solid`]: enclosed volume of a
//! triangle soup, connected-component partitioning of the kernel's raw
//! arrangement output, and the per-operand near-band used to size the trust
//! gate. Split out of `clash_solid.rs` so that file stays under the
//! module-size rule; `intersection_solid` itself, and the reasoning for HOW
//! these are used, stays there.

use crate::clash_contact_axes::dot3;
use crate::kernel::arrangement::Tri;
use crate::kernel::near_band::NearBand;
use crate::mesh::Mesh;

/// Enclosed volume of a closed f64 triangle soup (divergence theorem).
pub(super) fn tri_volume(tris: &[Tri]) -> f64 {
    tris.iter()
        .map(|t| {
            let (a, b, c) = (t[0], t[1], t[2]);
            let cr = [
                b[1] * c[2] - b[2] * c[1],
                b[2] * c[0] - b[0] * c[2],
                b[0] * c[1] - b[1] * c[0],
            ];
            a[0] * cr[0] + a[1] * cr[1] + a[2] * cr[2]
        })
        .sum::<f64>()
        .abs()
        / 6.0
}

/// Partitions `tris` into disjoint connected components by shared-vertex
/// adjacency, returning each component as a list of indices into `tris`.
///
/// Two triangles are in the same component iff they share a vertex at the
/// exact same f64 bit pattern — the same equality the welding step in
/// [`intersection_solid`](super::intersection_solid) already keys on, since
/// the kernel's arrangement output shares vertex coordinates exactly between
/// adjacent triangles rather than rounding them independently. A single
/// clashing pair's exact boolean can legitimately produce more than one such
/// component (e.g. a non-convex operand overlapping the other in two
/// separate places), and each is its own solid with its own thinnest extent
/// — see the thickness gate's comment in `intersection_solid` for why
/// pooling them together was wrong.
///
/// # Known limitation: shared-VERTEX, not shared-EDGE, is a coarser notion
/// of connectedness than "one overlap region" (PR #2573 review)
///
/// Two triangles that touch at a single bit-identical vertex — no shared
/// edge — are unioned into one component here, even when they are otherwise
/// two disjoint overlap regions that merely snap to a common point (e.g. a
/// 0.1 mm sliver and a 10 m-scale triangle pinned together at one corner,
/// `clash_solid_tests::two_triangles_sharing_only_one_vertex_are_still_
/// pooled_into_one_component_a_known_limitation`). Merged that way, the
/// gate's per-component extent loop pools their bounding boxes into a span
/// as large as the operands themselves — structurally the same
/// pooled-bounding-box overshoot that
/// `two_disjoint_below_band_slivers_are_withheld_not_pooled_into_one_
/// bounding_box` (`clash_intersection_oracle.rs`) was written to close for
/// full disjointness, reached here instead via a shared touching vertex.
///
/// This is left unfixed rather than reflex-fixed to shared-EDGE adjacency
/// (the standard notion of surface connectedness), for two reasons:
///
/// 1. **Not shown reachable through the public API.** The 25-case
///    `clash_intersection_oracle` suite, and direct attempts to construct two
///    disjoint overlap wedges that snap to a shared vertex through
///    `intersection_solid`, did not produce this arrangement — only a
///    hand-built call to this private function did. It is a demonstrated
///    algorithmic gap, not a proven wrong answer from real geometry.
/// 2. **Switching to shared-EDGE adjacency was tried and regressed a real,
///    previously-passing case.** Requiring triangles to share a full edge
///    (both endpoints bit-identical, undirected) broke
///    `rotated_near_band_overlap_is_withheld_exactly_as_the_axis_aligned_
///    one_is` (`clash_intersection_oracle.rs`): at 1 snap cell, tessellation
///    1, it reported `thickness_m == 0` instead of the true ~15.26 µm depth
///    — a genuinely connected wedge the kernel's arrangement produced got
///    split into components that no longer shared a full edge with their
///    neighbours. This is consistent with (not confirmed as) a non-conforming
///    triangulation on that wedge — a T-junction where two facets share a
///    vertex along a boundary without matching it on both sides — which
///    shared-vertex adjacency tolerates and shared-edge adjacency does not.
///    Whatever the exact mechanism, the observation stands: the kernel's own
///    arrangement output does not reliably satisfy "adjacent facets share a
///    full edge," so requiring it here is not a safe tightening, and shipping
///    it would trade an unreached vertex-sharing gap for a demonstrated,
///    reproducible regression on real kernel output.
///
/// Union-find over triangle indices, unioned via a vertex-key → first-seen
/// triangle map: O(tris) with a small constant, same asymptotic cost as the
/// welding pass right below it.
pub(super) fn component_groups(tris: &[Tri]) -> Vec<Vec<usize>> {
    let mut parent: Vec<usize> = (0..tris.len()).collect();

    fn find(parent: &mut [usize], mut x: usize) -> usize {
        while parent[x] != x {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        x
    }
    fn union(parent: &mut [usize], a: usize, b: usize) {
        let (ra, rb) = (find(parent, a), find(parent, b));
        if ra != rb {
            parent[ra] = rb;
        }
    }

    let mut first_tri_for_vertex: std::collections::HashMap<[u64; 3], usize> = std::collections::HashMap::new();
    for (i, t) in tris.iter().enumerate() {
        for v in t {
            let key = [v[0].to_bits(), v[1].to_bits(), v[2].to_bits()];
            match first_tri_for_vertex.entry(key) {
                std::collections::hash_map::Entry::Occupied(e) => union(&mut parent, i, *e.get()),
                std::collections::hash_map::Entry::Vacant(e) => {
                    e.insert(i);
                }
            }
        }
    }

    let mut groups: std::collections::HashMap<usize, Vec<usize>> = std::collections::HashMap::new();
    for i in 0..tris.len() {
        let root = find(&mut parent, i);
        groups.entry(root).or_default().push(i);
    }
    groups.into_values().collect()
}

/// Per-axis coordinate extents across both operands, for sizing the trust
/// gate's band PROJECTED onto whichever candidate axis the thickness below is
/// measured along.
///
/// Until the world-frame fix this used a single scalar (max |coordinate| over
/// ALL THREE axes of both operands), which sizes the band from whichever axis
/// happens to carry the largest world offset — including one the measured
/// thickness never touches. A pair 10 km out in X but overlapping along Z
/// then got a band derived entirely from the irrelevant X magnitude,
/// ballooning the required thickness to ~9.5 mm and withholding a genuine
/// 5 mm Z overlap that is a `Solid` at the origin
/// (`clash_solid_world_frame_tests.rs`). [`NearBand::scaled_band2`] keeps the
/// extents PER AXIS so the caller can project onto the SAME axis the
/// thickness itself is measured along — exactly the fix `near_band.rs`
/// applied to the kernel's own near-coplanar reconciliation.
/// Runs the intersection-solid trust gate over `tris`, split into its
/// disjoint [`component_groups`] and measured along every axis in `axes`.
///
/// `Some((thickness, required))` when ANY (component, axis) extent sits
/// inside that axis's OWN `TRUST_BAND_MULTIPLE`-scaled band projected via
/// `band.scaled_band2` — the pair must be withheld. `None` when every single
/// one of them clears its own band — the pair can be trusted. The returned
/// pair is the (component, axis) with the SMALLEST extent, kept only for
/// `DegenerateReason::BelowKernelResolution`'s report; it does not select
/// which band was consulted (see below).
///
/// PR #2923 review finding, fixed here: the previous form tracked a single
/// global argmin-thickness `(thickness, required)` pair and compared ONLY
/// that axis's own extent against ONLY that axis's own band
/// (`if t < thickness { thickness = t; required = ...axis...; }`, then one
/// `thickness < required` check outside the loop). `required` ended up being
/// the band of whichever axis happened to have the smallest extent overall —
/// so an axis whose OWN extent sat inside its OWN band stopped being gated
/// the moment some other axis happened to be even thinner. Concretely: two
/// axis-aligned boxes 10 km out in X with a genuine 3-axis overlap of
/// X = 2 mm, Y = 1 m, Z = 0.6 mm picked Z as the argmin (0.6 mm) and checked
/// only `required_Z` (~0.49 mm, so 0.6 mm passed) — while X (2 mm) was never
/// checked against `required_X` (~9.5 mm, since the X-normal faces at 10 km
/// sit inside a ~2.4 mm near band), and X is precisely the axis the kernel
/// already collapsed. `untrusted` now accumulates `t < required` across
/// EVERY (component, axis) pair independently, so no axis's own violation
/// can be shadowed by another axis being thinner still.
pub(super) fn trust_gate_reason(
    tris: &[Tri],
    axes: &[[f64; 3]],
    band: &NearBand,
    trust_band_multiple: f64,
) -> Option<(f64, f64)> {
    let mut thickness = f64::INFINITY;
    let mut required = 0.0;
    let mut untrusted = false;
    for group in component_groups(tris) {
        for axis in axes {
            let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
            for &i in &group {
                for v in &tris[i] {
                    let p = dot3(*v, *axis);
                    lo = lo.min(p);
                    hi = hi.max(p);
                }
            }
            let t = hi - lo;
            let req = trust_band_multiple * band.scaled_band2(*axis, 1.0).sqrt();
            if t < req {
                untrusted = true;
            }
            if t < thickness {
                thickness = t;
                required = req;
            }
        }
    }
    if untrusted { Some((thickness, required)) } else { None }
}

pub(super) fn operand_near_band(a: &Mesh, b: &Mesh) -> NearBand {
    let mut band = NearBand::default();
    for chunk in a
        .positions
        .chunks_exact(3)
        .chain(b.positions.chunks_exact(3))
    {
        let p = [
            if chunk[0].is_finite() {
                chunk[0] as f64
            } else {
                0.0
            },
            if chunk[1].is_finite() {
                chunk[1] as f64
            } else {
                0.0
            },
            if chunk[2].is_finite() {
                chunk[2] as f64
            } else {
                0.0
            },
        ];
        band.observe_point(&p);
    }
    band
}
