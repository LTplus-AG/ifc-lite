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
use crate::tri_mesh::{TriMesh, RAY_DIR, RAY_EPS};
use crate::vec3::{cross, dot, Vec3};
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
    let result = session.run_rule(&[0, 1], None, HARD, 0.001, 0.0, false);
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
    let result = session.run_rule(&[0, 1], None, HARD, 0.001, 0.0, false);
    assert!(
        result.records.is_empty(),
        "a 0.5 mm overlap inside a 1 mm tolerance is a touch, got {:?}",
        result.records.iter().map(|r| r.distance).collect::<Vec<_>>()
    );
}

#[test]
fn a_crossing_within_f32_noise_is_a_touch_not_hard() {
    // Two bars crossing at right angles, positioned far from the origin
    // (z ~ 60, where float32 ULP is 2^-18 ≈ 3.8e-6) so the x/y overlap is a
    // generous 0.5 m but the z overlap is squeezed to 1e-5 m: above one f32
    // ULP at this scale but below the f32 noise of these coordinates
    // (~60.75 * 2^-22 ≈ 1.45e-5 m). This is the shape of the Infra-Bridge.ifc
    // false positives (#2536-follow-up): a crossing that cannot be told apart
    // from f32 rounding at this coordinate scale must be `Touch`, not `Hard`.
    //
    // Until #5406 the tri-tri predicate reported this as a crossing (its
    // separation test was an exact tie) and the precision floor demoted it to a
    // `Touch` at the depth path's constant 0.0. The predicate now reads
    // overlap within the f32 noise band of the tested axis as contact itself,
    // so the pair never reaches the depth path: still `Touch`, still no
    // `Hard`, and the reported distance is the mesh-measured one, which for
    // surfaces in contact to within that noise is itself noise-scale.
    let a = box_mesh([50.0, 0.0, 60.0], [2.0, 0.25, 0.25]);
    let b = box_mesh([50.0, 0.0, 60.5 - 0.00001], [0.25, 2.0, 0.25]);
    let session = session_of(&[a, b]);

    let hard_only = session.run_rule(&[0, 1], None, HARD, 0.001, 0.0, false);
    assert!(
        hard_only.records.is_empty(),
        "a crossing within f32 noise must not report as a hard clash, got {:?}",
        hard_only
            .records
            .iter()
            .map(|r| (r.status, r.distance))
            .collect::<Vec<_>>()
    );

    let with_touch = session.run_rule(&[0, 1], None, HARD, 0.001, 0.0, true);
    assert_eq!(with_touch.records.len(), 1, "the touch itself is real information and must still report");
    assert_eq!(with_touch.records[0].status, ClashStatus::Touch);
    let noise = 4.0 * crate::world_frame_corpus::ulp32(60.75);
    assert!(
        with_touch.records[0].distance.abs() <= noise,
        "a touch within f32 noise reports a noise-scale distance, got {} (4 ULP = {noise})",
        with_touch.records[0].distance
    );
}

#[test]
fn genuine_small_overlap_above_the_precision_floor_stays_hard() {
    // Same crossing-bars construction and coordinate scale as
    // `a_crossing_within_f32_noise_is_a_touch_not_hard` (Z floor ≈
    // 1.45e-5 m), but the z overlap (1e-4 m) is ~7x the floor: a real,
    // measurable penetration that must NOT be swallowed by the
    // precision-floor gate. Guards against an over-generalized fix that
    // suppresses genuine small clashes.
    let a = box_mesh([50.0, 0.0, 60.0], [2.0, 0.25, 0.25]);
    let b = box_mesh([50.0, 0.0, 60.5 - 0.0001], [0.25, 2.0, 0.25]);
    let session = session_of(&[a, b]);
    let result = session.run_rule(&[0, 1], None, HARD, 0.001, 0.0, false);
    assert_eq!(result.records.len(), 1, "a real overlap above the precision floor must still clash");
    assert_eq!(result.records[0].status, ClashStatus::Hard);
    assert!(
        (result.records[0].distance + 0.0001).abs() < 1e-6,
        "must report the z-axis penetration depth, got {}",
        result.records[0].distance
    );
}

/// `depth_clash_result` for one candidate, with a 0.5 m estimate unless
/// the test is about the estimate itself. `true` = Touch, `false` = Hard.
fn is_touch(
    box_pen: Option<crate::depth::BoxPenetration>,
    estimate: f64,
    evidence: Option<crate::depth::VertexPenetration>,
    a: &Aabb,
    b: &Aabb,
) -> bool {
    let r = crate::depth::depth_clash_result(box_pen, estimate, evidence, a, b, true, [0.0; 3], *a)
        .expect("report_touch is on, so a result always comes back");
    r.status == ClashStatus::Touch
}

fn next_up(x: f64) -> f64 {
    f64::from_bits(x.to_bits() + 1)
}

#[test]
fn a_depth_exactly_at_its_own_directions_floor_is_touch_and_one_ulp_above_is_hard_5405() {
    // The floor boundary is inclusive (`<=`), for each of the three depth
    // candidates, and each is judged against the floor OF ITS OWN DIRECTION
    // (#5405). Both boxes sit 10,000 out along X and reach Z = 64, and their
    // own sizes are 2 and 1, so the Z noise is exactly (64 + 2 + 1) * 2^-22
    // (position + size, see `BoxNoise`) while the X noise is ~150x larger: a max-over-all-axes floor (the old `precision_floor`, 10,001 *
    // 2^-22 ~ 2.4e-3) would call every Z depth below 2.4 mm Touch. The old
    // session-level pin reached this boundary through a crossing whose floor
    // came from the X extent; with the floor projected onto Z it coincides
    // with the tri-tri contact band (#5406, same rule), so such a crossing
    // is contact before it ever gets here, and the boundary is pinned where
    // it lives.
    let a = Aabb::new([9_999.0, -1.0, 63.0], [10_001.0, 1.0, 64.0]);
    let b = Aabb::new([9_999.5, -0.5, 63.5], [10_000.5, 0.5, 64.0]);
    let z_floor = 67.0 / 4_194_304.0;
    let z: Vec3 = [0.0, 0.0, 1.0];
    let bp = |mtd: f64| Some(crate::depth::BoxPenetration { mtd, axis: z, through: false });
    let ev = |depth: f64| Some(crate::depth::VertexPenetration { depth, axis: z });

    assert!(is_touch(bp(z_floor), 0.5, None, &a, &b), "box MTD at its floor");
    assert!(!is_touch(bp(next_up(z_floor)), 0.5, None, &a, &b), "box MTD one ulp above");
    assert!(is_touch(None, 0.5, ev(z_floor), &a, &b), "crossing-vertex evidence at its floor");
    assert!(!is_touch(None, 0.5, ev(next_up(z_floor)), &a, &b), "evidence one ulp above");
    // The same depth along X IS within X's (much larger) noise.
    let x: Vec3 = [1.0, 0.0, 0.0];
    let bp_x = Some(crate::depth::BoxPenetration { mtd: 1e-3, axis: x, through: false });
    assert!(is_touch(bp_x, 0.5, None, &a, &b), "1 mm along X, 10 km out in X");
    assert!(!is_touch(bp(1e-3), 0.5, None, &a, &b), "1 mm along Z, 10 km out in X");
}

#[test]
fn the_aabb_estimate_is_judged_on_the_axis_it_measures_5405() {
    // The estimate `-signed_gap` is the smallest per-axis AABB overlap, so
    // its floor is that axis's noise. B overlaps A by exactly (65 + 2 + 2) *
    // 2^-22 on Z (the Z noise: Z reaches 65, both elements are 2 across) and
    // by far more on X and Y; the pair sits 10,000 out along X.
    let d = 69.0 / 4_194_304.0;
    let a = Aabb::new([9_999.0, -1.0, 63.0], [10_001.0, 1.0, 64.0]);
    let b = Aabb::new([9_999.0, -0.5, 64.0 - d], [10_001.0, 0.5, 65.0]);
    let est = -crate::aabb::signed_gap(&a, &b);
    assert_eq!(est, d, "fixture premise: the estimate is the Z overlap, exactly");
    assert_eq!(crate::aabb::estimate_floor(&a, &b), d);
    assert!(is_touch(None, est, None, &a, &b));
    assert!(!is_touch(None, next_up(est), None, &a, &b));
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
    let result = session.run_rule(&[0, 1], None, HARD, 0.0, 0.0, true);
    assert_eq!(result.records.len(), 1, "an exact face touch at tolerance 0 must report");
    assert_eq!(result.records[0].status, ClashStatus::Touch);
    assert_eq!(result.records[0].distance, 0.0);
    // ...and stays suppressed when the rule does not opt in.
    let quiet = session.run_rule(&[0, 1], None, HARD, 0.0, 0.0, false);
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
    let result = session.run_rule(&[0], Some(&[1, 99]), HARD, 0.001, 0.0, false);
    assert_eq!(result.records.len(), 1, "the bogus index must be dropped, not indexed");
    let both_bogus = session.run_rule(&[7, 8], Some(&[1]), HARD, 0.001, 0.0, false);
    assert!(both_bogus.records.is_empty());
}

#[test]
fn a_b_side_that_is_entirely_out_of_range_yields_nothing_not_a_self_clash_5354() {
    // The out-of-range filter and the self-clash decision must not be allowed
    // to interact. Filtering first and THEN asking "is group_b empty?" turns a
    // two-sided rule whose B indices are all bogus into a self-clash of A --
    // the #5354 conflation reached by a second route, and the reason
    // `candidate_pairs` filters inside the `Some` arm.
    //
    // The two boxes overlap, so a self-clash here would produce a record.
    // Kills: hoisting the `filter(|&g| g < n)` above the `Some`/`None` branch.
    let session = session_of(&[
        box_mesh([0.0, 0.0, 0.0], [0.5, 0.5, 0.5]),
        box_mesh([0.5, 0.0, 0.0], [0.5, 0.5, 0.5]),
    ]);
    let all_bogus_b = session.run_rule(&[0, 1], Some(&[98, 99]), HARD, 0.001, 0.0, false);
    assert!(
        all_bogus_b.records.is_empty(),
        "every B index was out of range, so there is no B side to clash against, got {:?}",
        all_bogus_b.records.iter().map(|r| (r.a, r.b)).collect::<Vec<_>>()
    );
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
    let result = session.run_rule(&[0, 1], Some(&[0, 1]), HARD, 0.001, 0.0, false);
    assert_eq!(
        result.records.len(),
        1,
        "one unordered pair -> one record, got {:?}",
        result.records.iter().map(|r| (r.a, r.b)).collect::<Vec<_>>()
    );
}

/// Two tiny, far-apart triangles that together give a wide AABB — the AABB
/// overlaps a target while neither triangle does. Same shape as the
/// TS-side `dumbbellElement` fixture in `packages/clash/src/regression.test.ts`
/// and
/// `packages/clash/src/differential.test.ts`'s #5220 case: one sub-prim of a
/// split entity that is a broad-phase false positive.
fn dumbbell_mesh(cx_near: f32, cx_far: f32) -> (Vec<f32>, Vec<u32>, Vec<f32>) {
    let eps = 0.01f32;
    #[rustfmt::skip]
    let positions = vec![
        cx_near, 0.0, 0.0, cx_near + eps, 0.0, 0.0, cx_near, eps, 0.0,
        cx_far, 0.0, 0.0, cx_far + eps, 0.0, 0.0, cx_far, eps, 0.0,
    ];
    let indices = vec![0u32, 1, 2, 3, 4, 5];
    // Bounds padded by a fixed margin around the two triangle centers (not the
    // triangles' own eps-sized extent) — matching the TS fixture exactly.
    let margin = 0.05f32;
    let aabb = vec![cx_near - margin, -margin, -margin, cx_far + margin, margin, margin];
    (positions, indices, aabb)
}

#[test]
fn candidate_pairs_dedups_by_global_index_not_entity_key_5220() {
    // #5220 part 2 / #5194: the TS engine's now-removed cross-group broad-phase
    // dedup collapsed candidate pairs by entity KEY before the narrow phase, so
    // when a same-key false-positive submesh (A1, the dumbbell) was visited
    // before the genuinely-clashing submesh (A2) for the same target B, A2's
    // real candidate pair against B was dropped along with A1's spurious one.
    // The Rust session has no key concept at all — `candidate_pairs` dedups
    // strictly by GLOBAL ELEMENT INDEX pair (`(a_global, b_global)`, see
    // `session.rs`), so A1-B and A2-B are always distinct pairs and this
    // failure mode cannot occur here. This pins that claim: A2 must clash with
    // B regardless of whether the false-positive A1 precedes or follows it in
    // `group_a`.
    //
    // B: box at x=10, half-extent 1 -> spans [9, 11].
    // A2: box at x=10.5, half-extent 1 -> genuinely interpenetrates B.
    // A1: dumbbell spanning ~[0.45, 20.55] in its AABB (overlaps B's broad
    // phase) but whose actual triangles (near x=0.5 and x=20.5) are nowhere
    // near B.
    let b = box_mesh([10.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
    let a2 = box_mesh([10.5, 0.0, 0.0], [1.0, 1.0, 1.0]);
    let a1 = dumbbell_mesh(0.5, 20.5);

    // [A1, A2, B] order.
    let session = session_of(&[a1.clone(), a2.clone(), b.clone()]);
    let result = session.run_rule(&[0, 1], Some(&[2]), HARD, 0.001, 0.0, false);
    assert_eq!(
        result.records.len(),
        1,
        "A2 must clash with B even with the false-positive A1 listed first, got {:?}",
        result.records.iter().map(|r| (r.a, r.b)).collect::<Vec<_>>()
    );
    assert_eq!(result.records[0].a, 1);
    assert_eq!(result.records[0].b, 2);

    // [A2, A1, B] order — same result regardless of which submesh comes first.
    let session2 = session_of(&[a2, a1, b]);
    let result2 = session2.run_rule(&[0, 1], Some(&[2]), HARD, 0.001, 0.0, false);
    assert_eq!(result2.records.len(), 1);
    assert_eq!(result2.records[0].a, 0);
    assert_eq!(result2.records[0].b, 2);
}

/// Triangular prism: footprint (0,0)-(2,0)-(0,2), extruded z 0 -> 1. The
/// slanted face makes most of the expected distances irrational, so a
/// wrong-but-close candidate set cannot coincidentally reproduce them.
fn probe_prism() -> TriMesh {
    let positions: Vec<f64> = vec![
        0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 2.0, 0.0, //
        0.0, 0.0, 1.0, 2.0, 0.0, 1.0, 0.0, 2.0, 1.0,
    ];
    let indices: Vec<u32> = vec![
        0, 1, 2, 3, 4, 5, 0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 2, 0, 3, 2, 3, 5,
    ];
    TriMesh::new(positions, indices)
}

/// Exact-value pins for the two BVH-driven point probes. The literals are the
/// values the pre-BVH linear scans produced, to the last bit, and
/// `packages/clash/src/engine-ts/tri-mesh.test.ts` asserts the SAME literals on
/// the SAME fixture. Two things are pinned at once: that BVH traversal did not
/// change the answer, and that the TS and Rust kernels still agree bit-for-bit
/// (`assert_eq!` on `f64` is exact - the differential suite's 1e-6 epsilon would
/// not catch a one-ulp drift). Keep the two fixtures in lockstep.
///
/// Kills: any BVH candidate set that drops the closest triangle (dropping the
/// second, widened `query_aabb`, or seeding the probe cube from the wrong
/// extent), and any divergence of the ray traversal from the TS BVH.
#[test]
fn probe_fixture_matches_the_ts_kernel() {
    let mesh = probe_prism();
    let probes: [([f64; 3], bool, f64); 6] = [
        // Closest feature is the slanted face -> irrational.
        ([0.9, 0.85, 0.5], true, 0.176_776_695_296_636_89),
        // Closest feature is the x = 0 face -> exact.
        ([0.3, 0.4, 0.5], true, 0.299_999_999_999_999_99),
        // Outside, past the slanted face.
        ([1.5, 1.5, 0.5], false, 0.707_106_781_186_547_57),
        // Inside, closest to the z = 0 cap (a different closest-point branch).
        ([0.05, 0.05, 0.02], true, 0.02),
        // Outside and above: closest feature is the slanted face's top EDGE.
        ([1.9, 1.9, 1.5], false, 1.367_479_433_117_734_2),
        // Outside along -x, closest to the x = 0 face's interior.
        ([-0.75, 0.125, 0.5], false, 0.75),
    ];
    for (p, inside, distance) in probes {
        assert_eq!(mesh.contains_point(p), inside, "contains_point {p:?}");
        assert_eq!(
            mesh.closest_on_surface(p).0,
            distance,
            "closest_on_surface {p:?}"
        );
    }
}

/// The BVH-accelerated `closest_on_surface` must equal an exhaustive scan when
/// the answer lies OUTSIDE the first probe cube. The DECOY is one big slanted
/// triangle whose AABB swallows the probe cube while its own surface sits 0.548
/// away; the real nearest surface is a fine grid at z = 0.435, outside the seed
/// cube (half-size 0.29 for this extent and triangle count). The first candidate
/// set therefore holds only the decoy, and its minimum is NOT the answer - the
/// widened second query is what pulls in the grid.
///
/// Kills: `if d <= h` -> `if d <= h * 2.0`, and -> an unconditional return (both
/// hand back the decoy's 0.548), and dropping the widened query entirely.
/// Mirrors `tri-mesh.test.ts` "finds a near triangle the seed cube missed".
#[test]
fn closest_on_surface_finds_a_near_triangle_behind_a_wide_aabb_decoy() {
    const A: f64 = 0.95;
    const SPAN: f64 = 1.16;
    const Z: f64 = 0.435;
    let mut positions: Vec<f64> = vec![-A, -A, -A, A, -A, A, -A, A, A];
    let mut indices: Vec<u32> = vec![0, 1, 2];
    let k = 16usize;
    let base = 3u32;
    for j in 0..=k {
        for i in 0..=k {
            positions.push(-SPAN + 2.0 * SPAN * i as f64 / k as f64);
            positions.push(-SPAN + 2.0 * SPAN * j as f64 / k as f64);
            positions.push(Z);
        }
    }
    for j in 0..k {
        for i in 0..k {
            let p0 = base + (j * (k + 1) + i) as u32;
            let kk = (k + 1) as u32;
            indices.extend_from_slice(&[p0, p0 + 1, p0 + kk + 1, p0, p0 + kk + 1, p0 + kk]);
        }
    }
    let mesh = TriMesh::new(positions, indices);
    assert_eq!(mesh.count, 513);

    let scan = |p: [f64; 3]| -> f64 {
        let mut best = f64::INFINITY;
        for t in 0..mesh.count {
            let [a, b, c] = mesh.tri(t);
            let q = closest_pt_point_triangle(p, a, b, c);
            let d2 = (q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2) + (q[2] - p[2]).powi(2);
            if d2 < best {
                best = d2;
            }
        }
        best.sqrt()
    };

    // The probe that discriminates: the answer must be the grid (~0.435), not
    // the decoy (~0.548) that the seed cube found first.
    let centre = [0.0, 0.0, 0.0];
    assert_eq!(mesh.closest_on_surface(centre).0, scan(centre));
    assert!(
        mesh.closest_on_surface(centre).0 < 0.5,
        "must reach the grid at z = 0.435, got {}",
        mesh.closest_on_surface(centre).0
    );

    for p in [
        [0.1, -0.2, 0.05],
        [0.0, 0.0, -0.8],
        [0.4, 0.4, 0.3],
        [9.0, 9.0, 9.0],
    ] {
        assert_eq!(mesh.closest_on_surface(p).0, scan(p), "probe {p:?}");
    }
}

/// Brute-force `contains_point`: the SAME Möller–Trumbore crossing count, over
/// EVERY triangle instead of the BVH's candidate set. This is the oracle the
/// BVH acceleration never had — `closest_on_surface` has one (`scan` above),
/// but `contains_point`'s "the candidate set is a superset of what a linear
/// scan would count" was asserted only in a doc comment, so nothing in the
/// suite would have noticed the traversal starting to prune a triangle the ray
/// really hits. Mirrors `containsPointByScan` in `engine-ts/tri-mesh.test.ts`.
#[allow(clippy::manual_range_contains)]
fn contains_point_by_scan(mesh: &TriMesh, p: Vec3) -> bool {
    let mut crossings: u32 = 0;
    for t in 0..mesh.count {
        let [v0, v1, v2] = mesh.tri(t);
        let e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
        let e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
        let pv = cross(RAY_DIR, e2);
        let det = dot(e1, pv);
        if det > -RAY_EPS && det < RAY_EPS {
            continue;
        }
        let inv = 1.0 / det;
        let tv = [p[0] - v0[0], p[1] - v0[1], p[2] - v0[2]];
        let u = dot(tv, pv) * inv;
        if u < 0.0 || u > 1.0 {
            continue;
        }
        let qv = cross(tv, e1);
        let v = dot(RAY_DIR, qv) * inv;
        if v < 0.0 || u + v > 1.0 {
            continue;
        }
        if dot(e2, qv) * inv > RAY_EPS {
            crossings += 1;
        }
    }
    crossings & 1 == 1
}

/// Closed UV sphere, radius `r`, `lon` segments x `lat` rings: `lon*(lat-1)*2`
/// triangles — a mesh whose triangles are small relative to the whole, so the
/// BVH actually has something to prune (a 12-triangle box does not). The pole
/// rings' outer triangle is zero-area, which Möller–Trumbore's parallel-reject
/// drops in the BVH path and the scan alike.
fn uv_sphere(r: f64, lon: usize, lat: usize) -> TriMesh {
    let mut pos: Vec<f64> = Vec::new();
    for j in 0..lat {
        let phi = std::f64::consts::PI * j as f64 / (lat - 1) as f64;
        for i in 0..lon {
            let th = 2.0 * std::f64::consts::PI * i as f64 / lon as f64;
            pos.extend_from_slice(&[
                r * phi.sin() * th.cos(),
                r * phi.sin() * th.sin(),
                r * phi.cos(),
            ]);
        }
    }
    let mut idx: Vec<u32> = Vec::new();
    for j in 0..(lat - 1) {
        for i in 0..lon {
            let a = (j * lon + i) as u32;
            let b = (j * lon + (i + 1) % lon) as u32;
            let c = a + lon as u32;
            let d = b + lon as u32;
            idx.extend_from_slice(&[a, b, d, a, d, c]);
        }
    }
    TriMesh::new(pos, idx)
}

/// Closed CONCAVE L-prism: the L footprint extruded z = 0..1. Concavity means
/// the ray can re-enter, so the crossing count is genuinely > 1 and a dropped
/// candidate flips the parity rather than being masked.
fn l_prism_mesh() -> TriMesh {
    let fp: [[f64; 2]; 6] = [
        [0.0, 0.0],
        [2.0, 0.0],
        [2.0, 1.0],
        [1.0, 1.0],
        [1.0, 2.0],
        [0.0, 2.0],
    ];
    let mut pos: Vec<f64> = Vec::new();
    for v in fp {
        pos.extend_from_slice(&[v[0], v[1], 0.0]);
    }
    for v in fp {
        pos.extend_from_slice(&[v[0], v[1], 1.0]);
    }
    let mut idx: Vec<u32> = Vec::new();
    for k in 1..5u32 {
        idx.extend_from_slice(&[0, k + 1, k, 6, 6 + k, 6 + k + 1]);
    }
    for k in 0..6u32 {
        let b = (k + 1) % 6;
        idx.extend_from_slice(&[k, b, 6 + b, k, 6 + b, 6 + k]);
    }
    TriMesh::new(pos, idx)
}

/// The BVH-accelerated `contains_point` must agree with the exhaustive scan on
/// every probe: 20 000 pseudo-random points straddling each surface, plus every
/// triangle vertex nudged +/- 1e-9 in z (the grazing cases, where a pruned
/// candidate is likeliest to flip the parity).
///
/// Kills: dropping either recursion in the BVH's internal-node branch, and
/// tightening the leaf-level AABB test. Mirrors the TS twin in
/// `engine-ts/tri-mesh.test.ts` — verified non-vacuous there by pruning one
/// `raycastNode` recursion, which produced 10 430 and 6 188 mismatches.
#[test]
fn contains_point_agrees_with_a_brute_force_scan_over_every_triangle() {
    let sphere = uv_sphere(1.0, 32, 33);
    assert_eq!(sphere.count, 2048, "fixture must stay a 2048-triangle sphere");
    let l = l_prism_mesh();
    for (mesh, origin, span) in [
        (&sphere, [-1.3, -1.3, -1.3], [2.6, 2.6, 2.6]),
        (&l, [-0.3, -0.3, -0.3], [2.6, 2.6, 1.6]),
    ] {
        // Deterministic LCG: the same probes on every run, in both kernels.
        let mut seed: i64 = 987_654_321;
        let mut rnd = || {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345) & 0x7fff_ffff;
            seed as f64 / 0x7fff_ffff as f64
        };
        let mut probes = 0usize;
        let mut mismatches = 0usize;
        let mut inside = 0usize;
        let probe = |p: Vec3, probes: &mut usize, mismatches: &mut usize, inside: &mut usize| {
            let got = mesh.contains_point(p);
            if got != contains_point_by_scan(mesh, p) {
                *mismatches += 1;
            }
            if got {
                *inside += 1;
            }
            *probes += 1;
        };
        for _ in 0..20_000 {
            let p = [
                origin[0] + rnd() * span[0],
                origin[1] + rnd() * span[1],
                origin[2] + rnd() * span[2],
            ];
            probe(p, &mut probes, &mut mismatches, &mut inside);
        }
        for t in 0..mesh.count {
            for v in mesh.tri(t) {
                probe(
                    [v[0], v[1], v[2] + 1e-9],
                    &mut probes,
                    &mut mismatches,
                    &mut inside,
                );
                probe(
                    [v[0], v[1], v[2] - 1e-9],
                    &mut probes,
                    &mut mismatches,
                    &mut inside,
                );
            }
        }
        assert_eq!(
            mismatches, 0,
            "BVH disagreed with the scan on {mismatches} of {probes} probes"
        );
        assert!(probes > 20_000);
        // Guard against a vacuous sweep: the probe cloud must straddle the
        // surface, or "0 mismatches" would only prove both sides say `false`.
        assert!(
            inside > 1000 && inside < probes - 1000,
            "degenerate probe cloud: {inside} inside of {probes}"
        );
    }
}

// #5220: a NaN vertex must NaN a triangle's own bounds (matching the TS
// `triBounds`), not fabricate finite bounds from the other two vertices.

/// A single triangle whose first vertex is entirely NaN (all three coords).
fn nan_triangle_mesh() -> TriMesh {
    #[rustfmt::skip]
    let positions = vec![
        f64::NAN, f64::NAN, f64::NAN,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    ];
    let indices = vec![0u32, 1, 2];
    TriMesh::new(positions, indices)
}

#[test]
fn nan_vertex_makes_tri_bounds_non_finite() {
    let mesh = nan_triangle_mesh();
    let bounds = mesh.tri_bounds(0);
    // Every component must be NaN, not merely one axis: a finite component
    // fabricated from the two clean vertices is exactly the `f64::min`/
    // `f64::max`-dropped-NaN regression this pins.
    for axis in 0..3 {
        assert!(bounds.min[axis].is_nan(), "min[{axis}] should be NaN, got {}", bounds.min[axis]);
        assert!(bounds.max[axis].is_nan(), "max[{axis}] should be NaN, got {}", bounds.max[axis]);
    }
}

#[test]
fn nan_vertex_excludes_triangle_from_every_query() {
    let mesh = nan_triangle_mesh();
    // A huge query box that would certainly contain the triangle if its
    // bounds were finite (e.g. fabricated from the two non-NaN vertices,
    // which lie inside [-10, 10]^3).
    let huge = Aabb::new([-10.0, -10.0, -10.0], [10.0, 10.0, 10.0]);
    let hits = mesh.query_tris(&huge);
    assert!(hits.is_empty(), "NaN-vertex triangle must not be queryable, got {hits:?}");
}

#[test]
fn clean_triangle_is_still_queryable() {
    // Control: without a NaN vertex, the same-shaped triangle IS found, so
    // the exclusion above is caused by the NaN, not by an unrelated bug.
    #[rustfmt::skip]
    let positions = vec![
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
    ];
    let mesh = TriMesh::new(positions, vec![0u32, 1, 2]);
    let huge = Aabb::new([-10.0, -10.0, -10.0], [10.0, 10.0, 10.0]);
    assert_eq!(mesh.query_tris(&huge), vec![0u32]);
}

#[test]
fn crossing_vertex_evidence_carries_the_direction_it_was_measured_along_5405() {
    // A 1 m cube dipping 10 mm into the top of a slab: its bottom vertices
    // are the deepest crossing vertices, 10 mm below the slab's top face, so
    // the evidence is 0.01 measured straight along Z — the direction its
    // precision floor is projected onto. Well inside the slab's X/Y extent,
    // so no side face is nearer.
    let slab = tri_mesh_of(&box_mesh([0.0, 0.0, 0.0], [5.0, 5.0, 0.5]));
    let cube = tri_mesh_of(&box_mesh([0.0, 0.0, 0.99], [0.5, 0.5, 0.5]));
    let flags = vec![true; cube.count];
    let e = crate::depth::crossing_vertex_penetration(&cube, &slab, &flags).expect("vertices inside");
    assert!((e.depth - 0.01).abs() < 1e-6, "{}", e.depth); // f32 corners
    assert!(e.axis[0].abs() < 1e-9 && e.axis[1].abs() < 1e-9, "{:?}", e.axis);
    assert!((e.axis[2].abs() - 1.0).abs() < 1e-9, "{:?}", e.axis);
}

#[test]
fn a_hard_result_reports_the_floor_of_the_depth_it_reports_5639() {
    // The pair sits 10,000 out along X, so the X floor is ~150x the Z floor.
    // A certified box MTD measured along X is reported with the X floor; the
    // AABB estimate (smallest overlap: Z here) with the Z floor — whichever
    // depth `distance` carries, `depth_floor` is that depth's own floor.
    let a = Aabb::new([9_999.0, -1.0, 63.0], [10_001.0, 1.0, 64.0]);
    let b = Aabb::new([9_999.5, -0.5, 63.5], [10_000.5, 0.5, 64.0]);
    let x: Vec3 = [1.0, 0.0, 0.0];
    let hard = |box_pen, estimate| {
        let r = crate::depth::depth_clash_result(box_pen, estimate, None, &a, &b, true, [0.0; 3], a)
            .expect("a result");
        assert_eq!(r.status, ClashStatus::Hard);
        (r.distance, r.depth_floor.expect("a Hard result carries its floor"))
    };
    let x_floor = crate::aabb::depth_floor(x, &a, &b);
    let est_floor = crate::aabb::estimate_floor(&a, &b);
    assert!(x_floor > 100.0 * est_floor, "fixture premise: {x_floor} vs {est_floor}");

    let measured = Some(crate::depth::BoxPenetration { mtd: 0.1, axis: x, through: false });
    assert_eq!(hard(measured, 0.5), (-0.1, x_floor), "certified MTD: its own axis's floor");
    let through = Some(crate::depth::BoxPenetration { mtd: 0.1, axis: x, through: true });
    assert_eq!(hard(through, 0.5), (-0.1, x_floor), "through-penetration capped by its MTD (#5742): the MTD's floor");
    let through_deep = Some(crate::depth::BoxPenetration { mtd: 0.9, axis: x, through: true });
    assert_eq!(hard(through_deep, 0.5), (-0.5, est_floor), "through-penetration below its MTD: the estimate");
    assert_eq!(hard(None, 0.5), (-0.5, est_floor), "no box: the estimate");
}

#[test]
fn a_through_penetration_is_capped_by_its_mtd_and_stays_an_estimate_5742() {
    // The #5742 tie: a member overlapping a 26 mm plate by 26 mm pokes out of
    // the far face by microns, so `through` is decided by f32 noise per
    // placement. The partial side reported the certified 0.026 MTD, the
    // through side the rotated boxes' 0.786 AABB estimate: a 30x swing.
    // Capping by the MTD makes both sides report 0.026; only the label
    // says which side of the tie the pair fell on. Mirrors the TS
    // `never reports a through-penetration deeper than its MTD`.
    let a = Aabb::new([-1.0, -1.0, -1.0], [1.0, 1.0, 1.0]);
    let b = Aabb::new([-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]);
    let at = |through| {
        let pen = crate::depth::BoxPenetration { mtd: 0.026078, axis: [1.0, 0.0, 0.0], through };
        let r = crate::depth::depth_clash_result(Some(pen), 0.78598, None, &a, &b, true, [0.0; 3], a)
            .expect("a result");
        (r.status, r.distance, r.distance_kind)
    };
    assert_eq!(at(false), (ClashStatus::Hard, -0.026078, crate::narrow::DistanceKind::Mesh));
    assert_eq!(at(true), (ClashStatus::Hard, -0.026078, crate::narrow::DistanceKind::Estimate));
}
