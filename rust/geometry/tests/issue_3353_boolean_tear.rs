// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #3353: booleans still tear on overlapping/rotated operands after
//! the #3341 parity fix.
//!
//! #3341 fixed one specific defect in `point_inside`'s parity ray-cast. A
//! separate, unrelated family of tears survives it: a 60000-pair random
//! sweep across Difference/Union/Intersection found 96 pairs (concentrated
//! in overlapping and rotated configurations) where the boolean output is
//! still non-manifold, and 37 of 38 drilled-into cases showed the
//! classification verdict was UNCHANGED by the #3341 fix — the tear was
//! already there, upstream or independent of it.
//!
//! Root cause, traced in this repo down to `classify.rs`
//! (`rust/geometry/src/kernel/arrangement/classify.rs`): the exact
//! arrangement recovers 100% of the input triangles (`unrecovered == 0`),
//! but `boolean_vids_components` decides whether a triangle is a coincident
//! duplicate of a face on the OTHER operand using two structurally
//! different tests depending on which operand owns the triangle:
//! - for a triangle from A: `BComponents::surface_normal`, tested against
//!   B's ORIGINAL (pre-arrangement) faces;
//! - for a triangle from B: `c_on_or_near_a`, tested against A's
//!   ORIGINAL faces.
//!
//! At a near-degenerate rotated overlap the two tests can disagree on the
//! same coincident pair, so a redundant triangle survives on BOTH operands
//! and a shared edge ends up used by three kept triangles instead of two —
//! classification reports a clean result, but the mesh is non-manifold.
//!
//! Both detectors are private to `classify.rs` (`fn c_on_or_near_a` and
//! `BComponents::surface_normal`, `pub(super)`), so they cannot be driven
//! directly from an external `tests/` binary without changing that file's
//! visibility. This test instead pins the OBSERVABLE symptom: a Union of
//! two overlapping, rotated, closed boxes comes back non-manifold. It is
//! `#[ignore]`d because it documents a known, unfixed defect rather than
//! asserting a passing invariant — do not un-ignore it without first fixing
//! the detector disagreement in `classify.rs` and re-validating with the
//! full `triangulation_invariance` census (see AGENTS.md).
//!
//! The case below was found by a local seeded sweep of rotated/overlapping
//! box pairs through `ClippingProcessor::union_mesh` (seed 6 of a
//! splitmix64-seeded run), independent of and smaller than the original
//! 60000-pair sweep in the issue, but reproducing the same symptom: a
//! closed-in, non-watertight-out Union.

use ifc_lite_geometry::{ClippingProcessor, Mesh, Point3, Vector3};
use std::collections::HashMap;

/// Outward-wound axis-aligned box.
fn boxed(min: [f64; 3], size: [f64; 3]) -> Mesh {
    let mx = [min[0] + size[0], min[1] + size[1], min[2] + size[2]];
    let c = |i: usize| -> [f64; 2] { [min[i], mx[i]] };
    let corners: Vec<Point3<f64>> = [
        (0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0),
        (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1),
    ]
    .iter()
    .map(|&(i, j, k)| Point3::new(c(0)[i], c(1)[j], c(2)[k]))
    .collect();
    let faces: [[usize; 4]; 6] = [
        [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
        [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5],
    ];
    let mut m = Mesh::with_capacity(24, 36);
    for f in &faces {
        let e1 = corners[f[1]] - corners[f[0]];
        let e2 = corners[f[2]] - corners[f[0]];
        let n = e1.cross(&e2).try_normalize(1e-12).unwrap_or(Vector3::z());
        let b = m.vertex_count() as u32;
        for &i in f {
            m.add_vertex(corners[i], n);
        }
        m.add_triangle(b, b + 1, b + 2);
        m.add_triangle(b, b + 2, b + 3);
    }
    m
}

/// The same box, rigidly rotated about Z by `theta` radians.
fn rotated_boxed(min: [f64; 3], size: [f64; 3], theta: f64) -> Mesh {
    let mut m = boxed(min, size);
    let (s, c) = theta.sin_cos();
    for p in m.positions.chunks_exact_mut(3) {
        let (x, y) = (p[0] as f64, p[1] as f64);
        p[0] = (c * x - s * y) as f32;
        p[1] = (s * x + c * y) as f32;
    }
    m
}

/// Directed-edge manifold check after welding by position: every undirected
/// edge must be used exactly once forward and once reverse. A signed-only
/// tally would let a non-manifold edge (e.g. 2 forward + 1 reverse) hide
/// behind a duplicated one that cancels; counting both directions rejects it.
fn open_edges(m: &Mesh) -> Result<usize, String> {
    if m.is_empty() {
        return Err("boolean output was empty".to_string());
    }
    let welded = m.welded_by_position(1e-6);
    let mut edges: HashMap<(u32, u32), (u32, u32)> = HashMap::new();
    for tri in welded.indices.chunks_exact(3) {
        for k in 0..3 {
            let (a, b) = (tri[k], tri[(k + 1) % 3]);
            if a == b {
                return Err(format!("degenerate edge: triangle repeats welded vertex {a}"));
            }
            let e = edges.entry((a.min(b), a.max(b))).or_insert((0, 0));
            if a < b {
                e.0 += 1;
            } else {
                e.1 += 1;
            }
        }
    }
    Ok(edges.values().filter(|&&(f, r)| f != 1 || r != 1).count())
}

/// Pins #3353: two closed, overlapping, rotated boxes in; a non-manifold
/// shell out. `#[ignore]`d — this is a known open defect (the
/// `c_on_or_near_a` / `BComponents::surface_normal` disagreement described
/// above), not a passing invariant. Un-ignore only once that disagreement
/// is reconciled AND the full `triangulation_invariance` census is clean.
#[test]
#[ignore = "known open defect, issue #3353: classify.rs's two coincident-face \
            detectors (c_on_or_near_a vs BComponents::surface_normal) disagree \
            on a near-degenerate rotated overlap, leaving a redundant triangle \
            on both operands and a non-manifold shared edge"]
fn a_rotated_overlapping_union_stays_manifold() {
    let clipper = ClippingProcessor::new();

    let a_min = [-1.064427873716452, -1.5758991032070164, -2.335934512221897];
    let a_size = [1.7582981472721038, 3.7437572581011054, 2.5580013636220693];
    let b_min = [-0.468184233137136, -1.8002926870781526, -1.0101295786317475];
    let b_size = [1.9952974802528327, 3.404965797097641, 3.2964264954246745];
    let theta = 1.3158416849982029;

    let a = boxed(a_min, a_size);
    let b = rotated_boxed(b_min, b_size, theta);

    let out = clipper.union_mesh(&a, &b).expect("union must not error");

    match open_edges(&out) {
        Ok(0) => {}
        Ok(bad) => panic!(
            "union of two closed operands came back non-manifold: \
             {bad} unmatched directed edges (see issue #3353)"
        ),
        Err(why) => panic!("union of two closed operands came back invalid: {why}"),
    }
}
