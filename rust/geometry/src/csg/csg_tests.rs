// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for [`super`] (plane clipping, triangle/plane primitives and
//! the mesh-boolean entry points). Split into a `*_tests.rs` file
//! (module-size-ratchet exempt) and attached via `#[path]`, the same shape
//! `bool2d_tests.rs` / `facet_weld_scoped_tests.rs` already use.

use super::*;
/// Build a box mesh from AABB min/max bounds (12 triangles, 2 per face).
/// Test-only fixture builder for `subtract_mesh_many_chunks_match_sequential`
/// below; production code has no AABB-box-to-mesh path (D10 dead-code sweep
/// deleted `subtract_box`/`aabb_to_mesh`, whose only callers were tests).
fn aabb_to_mesh(min: Point3<f64>, max: Point3<f64>) -> Mesh {
    let mut mesh = Mesh::with_capacity(8, 36);

    let v0 = Point3::new(min.x, min.y, min.z);
    let v1 = Point3::new(max.x, min.y, min.z);
    let v2 = Point3::new(max.x, max.y, min.z);
    let v3 = Point3::new(min.x, max.y, min.z);
    let v4 = Point3::new(min.x, min.y, max.z);
    let v5 = Point3::new(max.x, min.y, max.z);
    let v6 = Point3::new(max.x, max.y, max.z);
    let v7 = Point3::new(min.x, max.y, max.z);

    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v2, v1));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v3, v2));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v4, v5, v6));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v4, v6, v7));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v4, v7));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v7, v3));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v1, v2, v6));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v1, v6, v5));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v1, v5));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v5, v4));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v3, v7, v6));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v3, v6, v2));

    mesh
}

/// More cutters than MAX_CUTTERS_PER_ARRANGEMENT force the chunked path in
/// `subtract_mesh_many`; the result must match the sequential subtract chain.
/// Set difference is order-independent (`host - {all}` equals
/// `host - {chunk1} - {chunk2} - ...`), so chunking is solid-equivalent. Guards
/// the chunk boundary (the perf fix for the 86 MB model that stalled the
/// geometry stream on a ~90-opening host packed into one arrangement).
#[test]
fn subtract_mesh_many_chunks_match_sequential() {
    fn vol(m: &Mesh) -> f64 {
        let p = |i: u32| {
            let k = i as usize * 3;
            [
                m.positions[k] as f64,
                m.positions[k + 1] as f64,
                m.positions[k + 2] as f64,
            ]
        };
        let mut v = 0.0;
        for t in m.indices.chunks_exact(3) {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            v += a[0] * (b[1] * c[2] - c[1] * b[2])
                - a[1] * (b[0] * c[2] - c[0] * b[2])
                + a[2] * (b[0] * c[1] - c[0] * b[1]);
        }
        (v / 6.0).abs()
    }
    let csg = ClippingProcessor::new();
    // Long wall + 20 disjoint through-openings (>16 ⇒ 2 chunks at the cap).
    let wall = aabb_to_mesh(Point3::new(0., 0., 0.), Point3::new(40., 3., 0.2));
    let cutters: Vec<Mesh> = (0..20)
        .map(|i| {
            let x = 1.0 + i as f64 * 2.0; // 2 m spacing ⇒ pairwise disjoint
            aabb_to_mesh(Point3::new(x, 1., -0.5), Point3::new(x + 1.0, 2., 0.7))
        })
        .collect();
    let refs: Vec<&Mesh> = cutters.iter().collect();
    let batched = csg
        .subtract_mesh_many(&wall, &refs)
        .expect("chunked subtract must conform");
    let mut seq = wall.clone();
    for c in &cutters {
        seq = csg.subtract_mesh(&seq, c).expect("sequential subtract");
    }
    let (vb, vs) = (vol(&batched), vol(&seq));
    assert!(
        (vb - vs).abs() < 1e-4,
        "chunked volume {vb} != sequential {vs} on 20 disjoint cutters"
    );
    // Sanity: ~20 holes (~0.2 m³ each) actually removed from the ~24 m³ wall.
    assert!(
        vb < vol(&wall) - 3.0,
        "expected ~20 holes removed; wall {} -> {vb}",
        vol(&wall)
    );
}

#[test]
fn test_plane_signed_distance() {
    let plane = Plane::new(Point3::new(0.0, 0.0, 0.0), Vector3::new(0.0, 0.0, 1.0));

    assert_eq!(plane.signed_distance(&Point3::new(0.0, 0.0, 5.0)), 5.0);
    assert_eq!(plane.signed_distance(&Point3::new(0.0, 0.0, -5.0)), -5.0);
    assert_eq!(plane.signed_distance(&Point3::new(5.0, 5.0, 0.0)), 0.0);
}

#[test]
fn test_clip_triangle_all_front() {
    let processor = ClippingProcessor::new();
    let triangle = Triangle::new(
        Point3::new(0.0, 0.0, 1.0),
        Point3::new(1.0, 0.0, 1.0),
        Point3::new(0.5, 1.0, 1.0),
    );
    let plane = Plane::new(Point3::new(0.0, 0.0, 0.0), Vector3::new(0.0, 0.0, 1.0));

    match processor.clip_triangle(&triangle, &plane) {
        ClipResult::AllFront(_) => {}
        _ => panic!("Expected AllFront"),
    }
}

#[test]
fn test_clip_triangle_all_behind() {
    let processor = ClippingProcessor::new();
    let triangle = Triangle::new(
        Point3::new(0.0, 0.0, -1.0),
        Point3::new(1.0, 0.0, -1.0),
        Point3::new(0.5, 1.0, -1.0),
    );
    let plane = Plane::new(Point3::new(0.0, 0.0, 0.0), Vector3::new(0.0, 0.0, 1.0));

    match processor.clip_triangle(&triangle, &plane) {
        ClipResult::AllBehind => {}
        _ => panic!("Expected AllBehind"),
    }
}

#[test]
fn test_clip_triangle_split_one_front() {
    let processor = ClippingProcessor::new();
    let triangle = Triangle::new(
        Point3::new(0.0, 0.0, 1.0),  // Front
        Point3::new(1.0, 0.0, -1.0), // Behind
        Point3::new(0.5, 1.0, -1.0), // Behind
    );
    let plane = Plane::new(Point3::new(0.0, 0.0, 0.0), Vector3::new(0.0, 0.0, 1.0));

    match processor.clip_triangle(&triangle, &plane) {
        ClipResult::Split(triangles) => {
            assert_eq!(triangles.len(), 1);
        }
        _ => panic!("Expected Split"),
    }
}

#[test]
fn test_clip_triangle_split_two_front() {
    let processor = ClippingProcessor::new();
    let triangle = Triangle::new(
        Point3::new(0.0, 0.0, 1.0),  // Front
        Point3::new(1.0, 0.0, 1.0),  // Front
        Point3::new(0.5, 1.0, -1.0), // Behind
    );
    let plane = Plane::new(Point3::new(0.0, 0.0, 0.0), Vector3::new(0.0, 0.0, 1.0));

    match processor.clip_triangle(&triangle, &plane) {
        ClipResult::Split(triangles) => {
            assert_eq!(triangles.len(), 2);
        }
        _ => panic!("Expected Split with 2 triangles"),
    }
}

#[test]
fn test_triangle_normal() {
    let triangle = Triangle::new(
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(0.0, 1.0, 0.0),
    );

    let normal = triangle.normal();
    assert!((normal.z - 1.0).abs() < 1e-6);
}

#[test]
fn test_triangle_area() {
    let triangle = Triangle::new(
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(0.0, 1.0, 0.0),
    );

    let area = triangle.area();
    assert!((area - 0.5).abs() < 1e-6);
}

/// A zero-area triangle has no defined plane normal. The old
/// `cross.normalize()` returned `0/0` = NaN for these; the contract is now
/// the crate's `+Z` undefined-normal convention. Covers both flavours the
/// clipper actually produces: two coincident vertices (a collapsed sliver
/// from a cut that grazed an existing vertex) and three exactly-collinear
/// vertices (a cut that landed on an edge).
#[test]
fn degenerate_triangle_normal_is_plus_z_not_nan() {
    let collapsed = Triangle::new(
        Point3::new(1.0, 2.0, 3.0),
        Point3::new(1.0, 2.0, 3.0),
        Point3::new(4.0, 5.0, 6.0),
    );
    let collinear = Triangle::new(
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(2.0, 0.0, 0.0),
    );
    for (label, tri) in [("collapsed", collapsed), ("collinear", collinear)] {
        let n = tri.normal();
        assert!(
            n.x.is_finite() && n.y.is_finite() && n.z.is_finite(),
            "{label} triangle normal must be finite, got {n:?}"
        );
        assert_eq!(
            n,
            Vector3::new(0.0, 0.0, 1.0),
            "{label} triangle must get the +Z convention"
        );
    }
}

/// End-to-end guard for the wire format: no mesh leaving `clip_mesh` may
/// carry a non-finite normal, even when the input contains degenerate
/// triangles. This is the property `@ifc-lite/provenance`'s geometry-mesh
/// domain check enforces on the other side of the boundary — a NaN there is
/// a second-preimage hazard, not a cosmetic wart.
#[test]
fn clip_mesh_never_emits_non_finite_normals() {
    let clipper = ClippingProcessor::new();
    // A real box plus a zero-area sliver welded onto one of its faces.
    let mut mesh = aabb_to_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(1.0, 1.0, 1.0));
    add_triangle_to_mesh(
        &mut mesh,
        &Triangle::new(
            Point3::new(0.0, 0.0, 0.0),
            Point3::new(0.5, 0.0, 0.0),
            Point3::new(1.0, 0.0, 0.0),
        ),
    );
    assert!(
        mesh.normals.iter().all(|v| v.is_finite()),
        "the sliver's own normal must already be finite at insertion"
    );

    // Clip through the middle in both directions (the layer-slicing pattern:
    // band = below the interface, remainder = above it).
    let plane = Plane::new(Point3::new(0.0, 0.0, 0.5), Vector3::new(0.0, 0.0, 1.0));
    let flipped = Plane::new(plane.point, -plane.normal);
    for (label, p) in [("front", &plane), ("back", &flipped)] {
        let out = clipper.clip_mesh(&mesh, p).expect("clip must succeed");
        assert!(
            out.normals.iter().all(|v| v.is_finite()),
            "{label} half produced a non-finite normal"
        );
    }
}

/// `PlaneEps::for_normal` must be invariant under negating the normal.
///
/// `eps(n)` is a bound on the f32 rounding noise in `|dot(v - p, n)|` — an
/// ABSOLUTE magnitude. Flipping `n` flips the sign of every signed distance
/// but changes no vertex's rounding error, so the tolerance band must be the
/// same width for `+n` and `-n`. The `.abs()` on each component in
/// `for_normal` is what enforces that; without it the weighted sum goes
/// negative for any normal with a negative component and `.max(self.floor)`
/// collapses the whole thing back to the bare `1e-6` floor — the exact defect
/// this module exists to fix, silently reintroduced for roughly half of all
/// clip directions.
///
/// This is not a hypothetical direction set. Both production `clip_mesh`
/// callers feed in negated normals:
///
/// - `router/layers.rs` clips the SAME remainder with `+n` (remainder above
///   the material interface) and `-n` (the band below it) and welds the two
///   results edge-for-edge. That only works while `eps(+n) == eps(-n)`; a
///   difference leaves every material interface with an overlap or a gap.
/// - `processors/boolean/mod.rs` negates the half-space normal whenever the
///   `IfcHalfSpaceSolid`'s `AgreementFlag` is `.F.`.
///
/// Asserted here against the private `PlaneEps` directly — the integration
/// test `negated_plane_normal_must_get_the_same_tolerance` in
/// `tests/csg_clip_epsilon_scale_regression.rs` pins the same property at the
/// `clip_mesh` level, where it is actually observable by a caller.
#[test]
fn plane_eps_is_invariant_under_negating_the_normal() {
    use super::plane_eps::PlaneEps;

    // Deliberately anisotropic: a mesh whose three axis extents differ, so a
    // sign error on any one component moves the sum by a different amount and
    // cannot be masked by symmetry.
    let mesh = Mesh {
        positions: vec![
            5.0e4, 0.0, 0.0, //
            0.0, 3.0e3, 0.0, //
            0.0, 0.0, 7.0e2, //
        ],
        indices: vec![0, 1, 2],
        ..Default::default()
    };
    let eps = PlaneEps::new(&mesh, 1e-6);

    // Every sign pattern, plus a couple of oblique normals, so no single
    // component's `.abs()` can be dropped without a failure here.
    let normals = [
        Vector3::new(0.0, 0.0, 1.0),
        Vector3::new(1.0, 0.0, 0.0),
        Vector3::new(0.0, 1.0, 0.0),
        Vector3::new(1.0, 1.0, 1.0).normalize(),
        Vector3::new(0.6, 0.0, 0.8),
        Vector3::new(1.0, 2.0, 3.0).normalize(),
    ];

    for n in normals {
        let pos = eps.for_normal(&n);
        let neg = eps.for_normal(&(-n));
        assert_eq!(
            pos, neg,
            "eps({n:?}) = {pos:e} but eps({:?}) = {neg:e}: the classification \
             tolerance must depend on the plane's ORIENTATION, not on which \
             way its normal happens to point. `router/layers.rs` clips one \
             remainder with both `+n` and `-n` and welds the halves, so a \
             direction-dependent epsilon opens a gap or an overlap at every \
             material interface",
            -n
        );

        // And it must not have collapsed to the floor: a test that only
        // compared two floored values would pass with the `.abs()` removed
        // from BOTH branches.
        assert!(
            pos > 1e-6,
            "fixture is vacuous: at this magnitude eps({n:?}) = {pos:e} must \
             be set by the projected term, not by the 1e-6 floor, or the \
             equality above is trivially true"
        );
    }
}

// World-frame corpus tests: a sibling test file, attached here rather than
// from `mod.rs` because that allowlisted production module is at its
// module-size-ratchet budget and test files are exempt. The file itself
// imports via `crate::csg::`, so the attachment depth does not matter.
#[path = "world_frame_tests.rs"]
mod world_frame_tests;
