// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for the geometry kernel modules that `tests.rs` only reached
//! through the session API: `aabb`, `bvh`, `triangle`, `tri_mesh`, and the
//! branches of `narrow`/`session` that the axis-aligned cube fixtures cannot
//! distinguish.
//!
//! Every test here was written to kill a specific surviving mutation; the
//! mutation is named in the test's comment so a future edit that makes the
//! assertion vacuous is visible.

use crate::aabb::Aabb;
use crate::bvh::Bvh;
use crate::narrow::test_pair;
use crate::triangle::{closest_pt_point_triangle, closest_pt_seg_seg, tri_tri_distance};
use crate::tri_mesh::TriMesh;
use crate::{ClashSession, ClashStatus};

const HARD: u8 = 0;

/// Axis-aligned box mesh (12 triangles) as `(positions, local indices, aabb)` in `f32`,
/// with independent half-extents so the fixture is never a symmetric cube.
fn box_mesh(c: [f32; 3], h: [f32; 3]) -> (Vec<f32>, Vec<u32>, Vec<f32>) {
    let corners = [
        [c[0] - h[0], c[1] - h[1], c[2] - h[2]],
        [c[0] + h[0], c[1] - h[1], c[2] - h[2]],
        [c[0] + h[0], c[1] + h[1], c[2] - h[2]],
        [c[0] - h[0], c[1] + h[1], c[2] - h[2]],
        [c[0] - h[0], c[1] - h[1], c[2] + h[2]],
        [c[0] + h[0], c[1] - h[1], c[2] + h[2]],
        [c[0] + h[0], c[1] + h[1], c[2] + h[2]],
        [c[0] - h[0], c[1] + h[1], c[2] + h[2]],
    ];
    let mut positions = Vec::with_capacity(24);
    for p in &corners {
        positions.extend_from_slice(p);
    }
    let indices: Vec<u32> = vec![
        0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 5, 1, 0, 4, 5, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4,
        1, 5, 6, 1, 6, 2,
    ];
    let aabb = vec![
        c[0] - h[0],
        c[1] - h[1],
        c[2] - h[2],
        c[0] + h[0],
        c[1] + h[1],
        c[2] + h[2],
    ];
    (positions, indices, aabb)
}

fn session_of(parts: &[(Vec<f32>, Vec<u32>, Vec<f32>)]) -> ClashSession {
    let mut positions = Vec::new();
    let mut pos_ranges = Vec::new();
    let mut indices = Vec::new();
    let mut idx_ranges = Vec::new();
    let mut aabbs = Vec::new();
    for (p, i, a) in parts {
        pos_ranges.push(positions.len() as u32);
        pos_ranges.push(p.len() as u32);
        positions.extend_from_slice(p);
        idx_ranges.push(indices.len() as u32);
        idx_ranges.push(i.len() as u32);
        indices.extend_from_slice(i);
        aabbs.extend_from_slice(a);
    }
    let mut session = ClashSession::new();
    session.ingest(&positions, &pos_ranges, &indices, &idx_ranges, &aabbs);
    session
}

/// f64 mesh straight from a `box_mesh` part (no session round-trip).
fn tri_mesh_of(part: &(Vec<f32>, Vec<u32>, Vec<f32>)) -> TriMesh {
    TriMesh::new(part.0.iter().map(|&v| v as f64).collect(), part.1.clone())
}

// ---------------------------------------------------------------- aabb

#[test]
fn aabb_from_positions_uses_every_vertex_and_guards_short_buffers() {
    // `Aabb::from_positions` is a published entry point with no in-crate caller,
    // so nothing pinned either of its two boundaries.
    // Kills: guard `positions.len() < 3` -> `< 4`; loop bound `i + 2 <` -> `i + 3 <`.

    // A single vertex is exactly 3 floats: it must be USED, not rejected.
    let one = Aabb::from_positions(&[1.0, 2.0, 3.0]);
    assert_eq!(one.min, [1.0, 2.0, 3.0]);
    assert_eq!(one.max, [1.0, 2.0, 3.0]);

    // An under-length buffer degrades to the zero box (never panics, never
    // returns an inverted infinity box).
    let short = Aabb::from_positions(&[7.0, 8.0]);
    assert_eq!(short.min, [0.0; 3]);
    assert_eq!(short.max, [0.0; 3]);

    // The LAST vertex carries the extremes on two axes, so an off-by-one in the
    // walk bound drops them.
    let three = Aabb::from_positions(&[0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 5.0, -5.0, 2.0]);
    assert_eq!(three.min, [0.0, -5.0, 0.0]);
    assert_eq!(three.max, [5.0, 1.0, 2.0]);
}

// ---------------------------------------------------------------- bvh

#[test]
fn bvh_splits_on_the_longest_axis() {
    // The BVH build order decides the order candidate pairs (and therefore clash
    // records) come back in, which is user-visible in the results list. Items are
    // handed in SHUFFLED along X — by far the longest axis — so a longest-axis
    // median split has to reorder them; a different axis leaves the input order
    // (the sort is stable and every other centre is equal).
    // Kills: forcing the split axis away from the longest one.
    let at = |x: f64, id: u32| (id, Aabb::new([x - 0.4, -0.4, -0.4], [x + 0.4, 0.4, 0.4]));
    let bvh = Bvh::build(&[at(3.0, 30), at(1.0, 10), at(0.0, 0), at(2.0, 20)]);
    let hits = bvh.query_aabb(&Aabb::new([-10.0; 3], [10.0; 3]));
    assert_eq!(
        hits,
        vec![0, 10, 20, 30],
        "an all-covering query must return items in longest-axis (X) order"
    );
}

#[test]
fn bvh_query_excludes_non_overlapping_items() {
    let at = |x: f64, id: u32| (id, Aabb::new([x - 0.4, -0.4, -0.4], [x + 0.4, 0.4, 0.4]));
    let bvh = Bvh::build(&[at(0.0, 0), at(1.0, 1), at(2.0, 2), at(3.0, 3)]);
    // Touching counts as an overlap (`Box3::Intersects` is inclusive).
    assert_eq!(bvh.query_aabb(&Aabb::new([0.6, -0.1, -0.1], [1.4, 0.1, 0.1])), vec![1]);
    assert_eq!(bvh.query_aabb(&Aabb::new([10.0; 3], [11.0; 3])), Vec::<u32>::new());
    assert!(Bvh::build(&[]).query_aabb(&Aabb::new([0.0; 3], [1.0; 3])).is_empty());
}

// ------------------------------------------------------------ triangle

#[test]
fn closest_pt_seg_seg_clamps_the_second_segment_to_its_start() {
    // A perpendicular segment whose unclamped parameter is NEGATIVE: the answer
    // must clamp to `p2`, the segment's START.
    // Kills: the `t < 0.0` clamp writing `t = 1.0` instead of `t = 0.0`.
    let (d2, c1, c2) = closest_pt_seg_seg(
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.5, 1.0, 0.0],
        [0.5, 2.0, 0.0],
    );
    assert!((d2 - 1.0).abs() < 1e-12, "squared distance, got {d2}");
    assert_eq!(c1, [0.5, 0.0, 0.0]);
    assert_eq!(c2, [0.5, 1.0, 0.0], "must clamp to the START of the second segment");
}

#[test]
fn closest_pt_seg_seg_does_not_collapse_short_segments_to_points() {
    // Millimetre-scale segments are ordinary IFC geometry. The degenerate-segment
    // epsilon compares SQUARED lengths, so a loose epsilon silently treats a real
    // 20 mm segment as a point and returns the wrong witness.
    // Kills: `EPS: f64 = 1e-12` -> `1e-3`.
    let (d2, c1, c2) = closest_pt_seg_seg(
        [0.0, 0.0, 0.0],
        [0.02, 0.0, 0.0],
        [0.01, 0.02, 0.0],
        [0.01, 0.04, 0.0],
    );
    assert!((d2 - 4e-4).abs() < 1e-15, "squared distance, got {d2}");
    assert_eq!(c1, [0.01, 0.0, 0.0], "closest point must be INSIDE the short segment");
    assert_eq!(c2, [0.01, 0.02, 0.0]);
}

#[test]
fn closest_pt_point_triangle_returns_the_vertex_of_its_own_voronoi_region() {
    let (a, b, c) = ([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]);
    // Beyond vertex A.
    assert_eq!(closest_pt_point_triangle([-1.0, -1.0, 0.0], a, b, c), a);
    // Beyond vertex B — the region that returns `b`, not `c`.
    // Kills: the `d3 >= 0 && d4 <= d3` arm returning `c`.
    assert_eq!(closest_pt_point_triangle([2.0, -1.0, 0.0], a, b, c), b);
    // Beyond vertex C.
    assert_eq!(closest_pt_point_triangle([-1.0, 2.0, 0.0], a, b, c), c);
    // Above the interior: projects straight down onto the face.
    assert_eq!(closest_pt_point_triangle([0.25, 0.25, 3.0], a, b, c), [0.25, 0.25, 0.0]);
}

#[test]
fn tri_tri_distance_reports_each_witness_on_its_own_triangle() {
    // The minimum is achieved by a VERTEX OF B over the interior of A, which is
    // the only branch where the two witnesses come from different loops — so it
    // is the only branch that can silently return them swapped. The clash record
    // derives its report point from these, and the geometry is deliberately
    // asymmetric so a swap is observable.
    // Kills: the b-vertex loop assigning `p_a = v; p_b = c;`.
    let (d, p_a, p_b) = tri_tri_distance(
        [0.0, 0.0, 0.0],
        [4.0, 0.0, 0.0],
        [0.0, 4.0, 0.0],
        [1.0, 1.0, 1.0],
        [1.2, 1.0, 1.0],
        [1.0, 1.2, 1.0],
    );
    assert!((d - 1.0).abs() < 1e-12, "gap should be 1.0, got {d}");
    assert_eq!(p_a, [1.0, 1.0, 0.0], "witness A must lie on triangle A (z = 0)");
    assert_eq!(p_b, [1.0, 1.0, 1.0], "witness B must lie on triangle B (z = 1)");
}

// ------------------------------------------------------------ tri_mesh

#[test]
fn tri_mesh_drops_out_of_range_triangles_instead_of_panicking() {
    // The sanitizer is the guard that keeps a malformed mesh from panicking: under
    // the release `panic = abort` profile a panic traps the shared wasm module for
    // geometry and parsing too. `index == vertex_count` is already out of range.
    // Kills: `(indices[o] as usize) < vertex_count` -> `<=`.
    let positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let mesh = TriMesh::new(positions, vec![0, 1, 2, 0, 1, 3]);
    assert_eq!(mesh.count, 1, "the triangle referencing vertex 3 of 3 must be dropped");
    // Touch every retained triangle: an accepted bad index would panic here.
    assert_eq!(mesh.tri(0)[2], [0.0, 1.0, 0.0]);
}

#[test]
fn tri_mesh_tri_bounds_covers_all_three_vertices() {
    // Cube fixtures hide a dropped vertex: two of a box face's three corners already
    // carry the extreme on every axis. This triangle puts the Z extreme on the THIRD
    // vertex alone.
    // Kills: `va[2].max(vb[2]).max(vc[2])` -> `va[2].max(vb[2])`.
    let mesh = TriMesh::new(vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 5.0], vec![0, 1, 2]);
    let b = mesh.tri_bounds(0);
    assert_eq!(b.min, [0.0, 0.0, 0.0]);
    assert_eq!(b.max, [1.0, 1.0, 5.0]);
}

#[test]
fn tri_mesh_vertex_centroid_is_the_plain_mean() {
    // The narrow phase probes the midpoint of two vertex centroids for shared
    // volume. Every existing fixture is centred on the origin, where any scaling
    // of the centroid is the identity — so the divisor was unpinned. This mesh is
    // deliberately off-origin.
    // Kills: `let nf = n as f64` -> `(n + 1) as f64`.
    let mesh = TriMesh::new(vec![10.0, 0.0, 0.0, 12.0, 0.0, 0.0, 10.0, 2.0, 0.0], vec![0, 1, 2]);
    let c = mesh.vertex_centroid();
    assert!((c[0] - 32.0 / 3.0).abs() < 1e-12, "x, got {}", c[0]);
    assert!((c[1] - 2.0 / 3.0).abs() < 1e-12, "y, got {}", c[1]);
    assert_eq!(c[2], 0.0);
    assert_eq!(TriMesh::new(Vec::new(), Vec::new()).vertex_centroid(), [0.0; 3]);
}

// -------------------------------------------------------------- narrow

#[test]
fn crossing_members_report_the_real_penetration_depth() {
    // Two bars crossing at right angles: the surfaces genuinely intersect, so the
    // depth comes from the AABB signed gap, NEGATED. Existing tests only asserted
    // `distance < 0.0`, which a lost negation still satisfies (it yields `-0.0`).
    // Kills: `(-signed_gap(a, b)).max(0.0)` -> `(signed_gap(a, b)).max(0.0)`.
    let a = box_mesh([0.0, 0.0, 0.0], [2.0, 0.25, 0.25]);
    let b = box_mesh([0.0, 0.0, 0.0], [0.25, 2.0, 0.25]);
    let session = session_of(&[a, b]);
    let result = session.run_rule(&[0, 1], &[], HARD, 0.001, 0.0, false);
    assert_eq!(result.records.len(), 1, "crossing bars are one hard clash");
    let rec = &result.records[0];
    assert_eq!(rec.status, ClashStatus::Hard);
    // Overlap box is 0.5 x 0.5 x 0.5, so the minimum-axis penetration is 0.5.
    assert!(
        (rec.distance + 0.5).abs() < 1e-6,
        "depth must be -0.5 (the negated signed gap), got {}",
        rec.distance
    );
}

#[test]
fn sub_tolerance_aabb_penetration_is_not_promoted_to_a_hard_clash() {
    // Two boxes whose faces overlap by 0.5 mm with a 1 mm tolerance: that is a
    // touch, not a clash, and the AABB-penetration gate must require the overlap
    // to exceed the tolerance before the volumetric probe runs at all.
    // Kills: `if gap < -tolerance` -> `if gap < tolerance`.
    let a = box_mesh([0.0, 0.0, 0.0], [0.5, 0.5, 0.5]);
    let b = box_mesh([0.9995, 0.0, 0.0], [0.5, 0.5, 0.5]);
    let session = session_of(&[a, b]);
    let result = session.run_rule(&[0, 1], &[], HARD, 0.001, 0.0, false);
    assert!(
        result.records.is_empty(),
        "a 0.5 mm overlap inside a 1 mm tolerance is a touch, got {:?}",
        result.records.iter().map(|r| r.distance).collect::<Vec<_>>()
    );
}

#[test]
fn exact_touch_is_caught_at_tolerance_zero() {
    // The touch band is documented as `<=` precisely so an EXACT face contact at
    // tolerance 0 still reports. Every existing touch test uses a 1 mm tolerance,
    // where the strict and non-strict comparisons agree.
    // Kills: `if min_dist <= tolerance` -> `<` in the touch band.
    let a = box_mesh([0.0, 0.0, 0.0], [0.5, 0.5, 0.5]);
    let b = box_mesh([1.0, 0.0, 0.0], [0.5, 0.5, 0.5]);
    let session = session_of(&[a, b]);
    let result = session.run_rule(&[0, 1], &[], HARD, 0.0, 0.0, true);
    assert_eq!(result.records.len(), 1, "an exact face touch at tolerance 0 must report");
    assert_eq!(result.records[0].status, ClashStatus::Touch);
    assert_eq!(result.records[0].distance, 0.0);
    // ...and stays suppressed when the rule does not opt in.
    let quiet = session.run_rule(&[0, 1], &[], HARD, 0.0, 0.0, false);
    assert!(quiet.records.is_empty());
}

#[test]
fn enclosure_probes_the_first_meshs_vertex_when_the_bounds_are_equal() {
    // With equal bounds the enclosure test is documented to try B-contains-A
    // FIRST, which means the representative vertex probed is `tri_a`'s — the
    // deterministic pick shared with the TS kernel. Reversing the two arms
    // probes the wrong mesh and loses the clash.
    // Kills: swapping the `aabb_contains` arms.
    let small = tri_mesh_of(&box_mesh([0.0, 0.0, 0.0], [0.2, 0.2, 0.2]));
    let big = tri_mesh_of(&box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]));
    let bounds = Aabb::new([-1.0; 3], [1.0; 3]);
    let hit = test_pair(&bounds, &small, &bounds, &big, HARD, 0.001, 0.0, false)
        .expect("A enclosed in B must be a hard clash");
    assert_eq!(hit.status, ClashStatus::Hard);
}

// ------------------------------------------------------------- session

#[test]
fn run_rule_ignores_out_of_range_global_indices() {
    // `run_rule` takes raw global indices across the wasm boundary. An index past
    // the ingested element count must be dropped, not indexed — under
    // `panic = abort` an out-of-bounds index aborts the shared module.
    // Kills: dropping the `filter(|&g| g < n)` on either group.
    let session = session_of(&[
        box_mesh([0.0, 0.0, 0.0], [0.5, 0.5, 0.5]),
        box_mesh([0.5, 0.0, 0.0], [0.5, 0.5, 0.5]),
    ]);
    let result = session.run_rule(&[0], &[1, 99], HARD, 0.001, 0.0, false);
    assert_eq!(result.records.len(), 1, "the bogus index must be dropped, not indexed");
    let both_bogus = session.run_rule(&[7, 8], &[1], HARD, 0.001, 0.0, false);
    assert!(both_bogus.records.is_empty());
}

#[test]
fn overlapping_groups_yield_one_record_per_unordered_pair() {
    // Both groups hold BOTH elements, so the pair (0, 1) is reachable from either
    // direction. The dedup key is normalised to `(min, max)` exactly so the second
    // direction is suppressed; an un-normalised key reports the same clash twice.
    // Kills: `let dedup = if a_global < b_global {...}` -> `(a_global, b_global)`.
    let session = session_of(&[
        box_mesh([0.0, 0.0, 0.0], [0.5, 0.5, 0.5]),
        box_mesh([0.5, 0.0, 0.0], [0.5, 0.5, 0.5]),
    ]);
    let result = session.run_rule(&[0, 1], &[0, 1], HARD, 0.001, 0.0, false);
    assert_eq!(
        result.records.len(),
        1,
        "one unordered pair -> one record, got {:?}",
        result.records.iter().map(|r| (r.a, r.b)).collect::<Vec<_>>()
    );
}
