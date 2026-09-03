// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for [`super`] (plane clipping, triangle/plane primitives and
//! the mesh-boolean entry points). Split into a `*_tests.rs` file
//! (module-size-ratchet exempt) and attached via `#[path]`, the same shape
//! `bool2d_tests.rs` / `facet_weld_scoped_tests.rs` already use.

#[cfg(not(feature = "csg_topology_gate"))]
use super::topology_diagnostic::OPEN_TOPOLOGY_MESSAGE;
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

/// `difference_result_looks_degenerate`'s "wrong piece" bbox check must use
/// PER-AXIS slack (1 % of each axis's own host span), not a single scalar
/// derived from the host's longest dimension — see the doc comment on
/// `ClippingProcessor::difference_result_looks_degenerate` (CodeRabbit review
/// on PR #861, house.ifc wall #3448).
///
/// Fixture: a thin wall, 5 m (X) x 0.4 m (Y) x 7 m (Z). A malformed-cutter
/// "wrong piece" result pokes 1 cm past the wall's 0.4 m Y face — a real
/// wrong-piece defect on the wall's thin axis. Per-axis Y slack is 1 % of
/// 0.4 m = 4 mm, so a 1 cm overshoot must be flagged. A tolerance instead
/// derived from the LONGEST axis (Z, 7 m -> 7 cm slack) would let that same
/// 1 cm overshoot through unflagged, because 1 cm < 7 cm.
#[test]
fn difference_result_wrong_piece_check_is_per_axis_not_longest_dimension() {
    let host = aabb_to_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(5.0, 0.4, 7.0));
    // Same shape as the host, but overshoots the host's Y max by 1 cm —
    // 1 % of the 5 m X span is 5 cm and 1 % of the 7 m Z span is 7 cm, so
    // this result sits well within tolerance on BOTH the longest dimension
    // and X; only the thin Y axis's own 4 mm slack can catch it.
    let result = aabb_to_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(5.0, 0.41, 7.0));

    assert!(
        ClippingProcessor::difference_result_looks_degenerate(&host, &result),
        "a result overshooting the host's thin Y face by 1 cm (4 mm per-axis \
         slack on that axis) must be flagged as a wrong-piece degenerate result"
    );
}

/// Build an open box: the same 6-face box as [`aabb_to_mesh`] minus its top
/// face (z = max). Finite positions/normals and every index in bounds, so
/// `validate_mesh` accepts it — but the missing face leaves a boundary loop
/// with no reverse edge to cancel it, so `directed_closed` rejects it.
fn open_box_mesh(min: Point3<f64>, max: Point3<f64>) -> Mesh {
    let mut mesh = Mesh::with_capacity(8, 30);

    let v0 = Point3::new(min.x, min.y, min.z);
    let v1 = Point3::new(max.x, min.y, min.z);
    let v2 = Point3::new(max.x, max.y, min.z);
    let v3 = Point3::new(min.x, max.y, min.z);
    let v4 = Point3::new(min.x, min.y, max.z);
    let v5 = Point3::new(max.x, min.y, max.z);
    let v6 = Point3::new(max.x, max.y, max.z);
    let v7 = Point3::new(min.x, max.y, max.z);

    // Bottom (z = min): present.
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v2, v1));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v3, v2));
    // Top (z = max): DELETED — this is the open edge.
    // -X side.
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v4, v7));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v7, v3));
    // +X side.
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v1, v2, v6));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v1, v6, v5));
    // -Y side.
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v1, v5));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v5, v4));
    // +Y side.
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v3, v7, v6));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v3, v6, v2));

    mesh
}

/// Step 1 of #3440: every boolean op's ACCEPT path must record the tear, and
/// must still return the kernel result it returned before. Driving the four
/// public ops (not `record_topology_tear` directly) is the point — the call
/// sites are the change, so reverting any one of them has to turn this red.
#[cfg(not(feature = "csg_topology_gate"))] // step-1-only: asserts the non-gating KernelError record; superseded under the feature by OpenTopologyRejected + fallback
#[test]
fn topology_tear_recorded_by_every_boolean_op_without_gating() {
    // An open host makes every op's kernel output open too, which is what
    // `validate_mesh` cannot see: it accepts all four results below.
    let open_host = open_box_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(1.0, 1.0, 1.0));
    let through_cutter = aabb_to_mesh(Point3::new(0.4, 0.4, -0.1), Point3::new(0.6, 0.6, 1.1));
    let overlapping = aabb_to_mesh(Point3::new(0.5, 0.5, 0.5), Point3::new(1.5, 1.5, 1.5));

    let expected = BoolFailureReason::KernelError(OPEN_TOPOLOGY_MESSAGE.to_string());

    let cases: Vec<(&str, BoolOp, Mesh)> = {
        let p = ClippingProcessor::new();
        let subtract = p.subtract_mesh(&open_host, &through_cutter).unwrap();
        let batched = p.subtract_mesh_many(&open_host, &[&through_cutter]).unwrap();
        let union = p.union_mesh(&open_host, &overlapping).unwrap();
        let intersection = p.intersection_mesh(&open_host, &overlapping).unwrap();
        // One processor, four ops, four records — in call order.
        let failures = p.take_failures();
        assert_eq!(
            failures.iter().map(|f| (f.op, f.reason.clone())).collect::<Vec<_>>(),
            vec![
                (BoolOp::Difference, expected.clone()),
                (BoolOp::Difference, expected.clone()),
                (BoolOp::Union, expected.clone()),
                (BoolOp::Intersection, expected.clone()),
            ],
            "each of the four accept paths must record exactly one open-topology tear"
        );
        vec![
            ("subtract_mesh", BoolOp::Difference, subtract),
            ("subtract_mesh_many", BoolOp::Difference, batched),
            ("union_mesh", BoolOp::Union, union),
            ("intersection_mesh", BoolOp::Intersection, intersection),
        ]
    };

    // The recording half is above; this is the NOT-GATING half. Every op
    // handed back a non-empty kernel result that `validate_mesh` accepts and
    // `directed_closed` rejects — i.e. the torn mesh, not a fallback.
    let p = ClippingProcessor::new();
    for (name, _, mesh) in &cases {
        assert!(!mesh.is_empty(), "{name} must return the kernel result, not an empty fallback");
        assert!(p.validate_mesh(mesh), "{name}: validate_mesh must still accept the torn result");
        assert!(
            !crate::router::voids::prism_cut::closure_checks::directed_closed(mesh)
                && !crate::router::voids::prism_cut::closure_checks::closed_or_hairline(mesh),
            "{name}: the returned mesh must fail BOTH halves of the audit's predicate, \
             or this test cannot tell the hairline tolerance from its absence"
        );
    }
    assert!(p.take_failures().is_empty());
}

/// The same four ops on a CLOSED host record nothing — the diagnostic is
/// specific to open topology, not a blanket record on every accepted mesh.
/// Without this the test above would pass on a helper that always records.
#[test]
fn topology_tear_not_recorded_for_closed_results() {
    let closed_host = aabb_to_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(1.0, 1.0, 1.0));
    let through_cutter = aabb_to_mesh(Point3::new(0.4, 0.4, -0.1), Point3::new(0.6, 0.6, 1.1));
    let overlapping = aabb_to_mesh(Point3::new(0.5, 0.5, 0.5), Point3::new(1.5, 1.5, 1.5));

    let p = ClippingProcessor::new();
    p.subtract_mesh(&closed_host, &through_cutter).unwrap();
    p.subtract_mesh_many(&closed_host, &[&through_cutter]).unwrap();
    p.union_mesh(&closed_host, &overlapping).unwrap();
    p.intersection_mesh(&closed_host, &overlapping).unwrap();

    assert_eq!(
        p.take_failures(),
        vec![],
        "closed results must not record an open-topology tear"
    );
}

/// `subtract_mesh_many` must audit the mesh it RETURNS, once — not each
/// chunk's intermediate. The cutter cap per arrangement is 16, so 17 cutters
/// run two chunks over one returned mesh; auditing intermediates records
/// twice, inflating the very per-host census this diagnostic exists to feed.
/// 16 cutters (one chunk) is the control: same host, same tear, one record
/// either way.
#[cfg(not(feature = "csg_topology_gate"))] // step-1-only: asserts the non-gating KernelError record; superseded under the feature by OpenTopologyRejected + fallback
#[test]
fn topology_tear_recorded_once_per_batched_subtract_not_once_per_chunk() {
    let open_host = open_box_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(20.0, 1.0, 1.0));
    // Disjoint slabs cutting clean through the host in Y, one per metre.
    let cutters: Vec<Mesh> = (0..17)
        .map(|i| {
            let x = 0.5 + f64::from(i);
            aabb_to_mesh(Point3::new(x, -0.1, 0.3), Point3::new(x + 0.4, 1.1, 0.7))
        })
        .collect();
    let expected = vec![BoolFailure {
        op: BoolOp::Difference,
        reason: BoolFailureReason::KernelError(OPEN_TOPOLOGY_MESSAGE.to_string()),
        product_id: None,
    }];

    for cutter_count in [16usize, 17] {
        let refs: Vec<&Mesh> = cutters.iter().take(cutter_count).collect();
        let p = ClippingProcessor::new();
        let result = p.subtract_mesh_many(&open_host, &refs).unwrap();
        // The group must have been CUT, not rejected — a rejected group returns
        // the host un-cut and records nothing, which would make this vacuous.
        assert!(
            result.triangle_count() > open_host.triangle_count(),
            "{cutter_count} cutters: the group was rejected, so this proves nothing"
        );
        assert!(
            !crate::router::voids::prism_cut::closure_checks::directed_closed(&result)
                && !crate::router::voids::prism_cut::closure_checks::closed_or_hairline(&result),
            "{cutter_count} cutters: the returned mesh must fail BOTH halves of the predicate"
        );
        assert_eq!(
            p.take_failures(),
            expected,
            "{cutter_count} cutters: one returned mesh, one record, whatever the chunk count"
        );
    }
}

/// The same closed unit box, but the -X face is FANNED through an extra vertex
/// at the midpoint of the v0-v4 edge it shares with the -Y face, which keeps
/// that edge undivided. No hole and no missing surface — a pure T-junction:
/// the directed edge v4->v0 on -Y is answered by the two half-edges v0->m and
/// m->v4 on -X, which `directed_closed` cannot cancel but the hairline
/// tolerance covers exactly.
fn t_junction_box_mesh(min: Point3<f64>, max: Point3<f64>) -> Mesh {
    let mut mesh = Mesh::with_capacity(8, 39);

    let v0 = Point3::new(min.x, min.y, min.z);
    let v1 = Point3::new(max.x, min.y, min.z);
    let v2 = Point3::new(max.x, max.y, min.z);
    let v3 = Point3::new(min.x, max.y, min.z);
    let v4 = Point3::new(min.x, min.y, max.z);
    let v5 = Point3::new(max.x, min.y, max.z);
    let v6 = Point3::new(max.x, max.y, max.z);
    let v7 = Point3::new(min.x, max.y, max.z);
    let m = Point3::new(min.x, min.y, 0.5 * (min.z + max.z)); // midpoint of v0-v4

    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v2, v1));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v3, v2));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v4, v5, v6));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v4, v6, v7));
    // -X: (v0, v4, v7) fanned through `m` — the only change from `aabb_to_mesh`.
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, m, v7));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(m, v4, v7));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v7, v3));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v1, v2, v6));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v1, v6, v5));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v1, v5));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v0, v5, v4));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v3, v7, v6));
    add_triangle_to_mesh(&mut mesh, &Triangle::new(v3, v6, v2));

    mesh
}

/// The audit's predicate must be the analytic path's REJECTION gate
/// (`prism_cut.rs:2674`, `:2913` — `directed_closed` OR `closed_or_hairline`),
/// not `directed_closed` alone. A T-junction host fails the strict half and
/// passes the tolerant one; `prism_cut` accepts it at every gate, so recording
/// it would fill the #3440 census — and the user-facing `totalCsgFailures`
/// count that rides the same channel — with a class this crate already ruled
/// benign, and the step-2 flip set could not be read off it.
///
/// Driven through `record_topology_tear` rather than a boolean op because the
/// predicate is what is under test and no op can be made to hand back this
/// exact mesh: the kernel re-meshes its output, and the empty-operand
/// pass-throughs never reach the audit.
#[test]
fn hairline_t_junction_is_not_recorded_as_a_topology_tear() {
    use crate::router::voids::prism_cut::closure_checks::{closed_or_hairline, directed_closed};
    let hairline = t_junction_box_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(1.0, 1.0, 1.0));
    assert!(
        !directed_closed(&hairline),
        "fixture must fail the strict audit, or it cannot separate the two predicates"
    );
    assert!(
        closed_or_hairline(&hairline),
        "fixture must pass the hairline gate, or it cannot separate the two predicates"
    );

    let p = ClippingProcessor::new();
    p.record_topology_tear(BoolOp::Union, &hairline);
    assert_eq!(
        p.take_failures(),
        vec![],
        "a T-junction the analytic path accepts at every gate must not be recorded as a tear"
    );
}

/// `union_meshes` must audit the mesh it RETURNS, once — not every
/// intermediate its pairwise loop throws away. `processors/boolean` unions the
/// cutter prisms through this method and drains the same clipper into the
/// HOST's failure list, so an over-count here is attributed to a host whose
/// own geometry may be perfectly closed, and the per-host census is the only
/// deliverable of #3440 step 1.
#[cfg(not(feature = "csg_topology_gate"))] // step-1-only: asserts the non-gating KernelError record; superseded under the feature by OpenTopologyRejected + fallback
#[test]
fn topology_tear_recorded_once_per_union_meshes_not_once_per_intermediate() {
    use crate::router::voids::prism_cut::closure_checks::{closed_or_hairline, directed_closed};
    // Three overlapping boxes, the first of them open: two pairwise unions run,
    // so auditing per pair records the discarded first intermediate as well.
    let parts = vec![
        open_box_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(1.0, 1.0, 1.0)),
        aabb_to_mesh(Point3::new(0.5, 0.5, 0.5), Point3::new(1.5, 1.5, 1.5)),
        aabb_to_mesh(Point3::new(1.2, 1.2, 1.2), Point3::new(2.2, 2.2, 2.2)),
    ];

    let p = ClippingProcessor::new();
    let result = p.union_meshes(&parts).unwrap();
    assert!(
        !directed_closed(&result) && !closed_or_hairline(&result),
        "the returned union must be torn, or one record is not the right answer either"
    );
    assert_eq!(
        p.take_failures(),
        vec![BoolFailure {
            op: BoolOp::Union,
            reason: BoolFailureReason::KernelError(OPEN_TOPOLOGY_MESSAGE.to_string()),
            product_id: None,
        }],
        "one returned mesh, one record, whatever the intermediate count"
    );

    // A pass-through: nothing was unioned, so the torn mesh is the caller's
    // own input and no union can be blamed for it.
    let p = ClippingProcessor::new();
    let passthrough = p.union_meshes(&[parts[0].clone(), Mesh::new()]).unwrap();
    assert_eq!(passthrough.triangle_count(), parts[0].triangle_count());
    assert_eq!(
        p.take_failures(),
        vec![],
        "no pair ever met, so there is no union result to record a tear against"
    );
}

/// `union_mesh` also audits the mesh it returns when `union_pair` takes an
/// empty-operand fallback.  That return path can carry file-supplied malformed
/// indices, while the closure predicates index positions directly.  Validation
/// must therefore happen before the topology predicate: keep the legacy
/// pass-through result and, most importantly, do not abort the process.
#[test]
fn union_fallback_validates_indices_before_topology_audit() {
    let mut malformed = aabb_to_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(1.0, 1.0, 1.0));
    malformed.indices[0] = malformed.vertex_count() as u32;

    let p = ClippingProcessor::new();
    let returned = p.union_mesh(&malformed, &Mesh::new()).unwrap();

    assert_eq!(returned.indices, malformed.indices, "the fallback remains non-gating");
    assert!(
        !p.validate_mesh(&returned),
        "fixture must retain the out-of-bounds index or it cannot prove the guard"
    );
    assert!(
        p.take_failures().is_empty(),
        "an empty-operand pass-through is not a kernel result and must not gain a diagnostic"
    );
}

/// #3440 step 2, WITHOUT the `csg_topology_gate` feature: `topology_gate_reject`
/// must be a true no-op, not merely a flag checked after the work. Reuses the
/// exact fixtures `topology_tear_recorded_by_every_boolean_op_without_gating`
/// (above) proves make every op's kernel output torn, and re-asserts the SAME
/// invariant that test already pins — every op still hands back the torn
/// kernel result, none falls back — so a default (non-feature) build stays
/// byte-identical to what step 1 shipped. Compiled in EVERY build (this is
/// the "gate off" proof, so it must run without the feature); the mirror
/// below only compiles under the feature.
#[cfg(not(feature = "csg_topology_gate"))]
#[test]
fn topology_gate_is_a_true_noop_without_the_feature() {
    let open_host = open_box_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(1.0, 1.0, 1.0));
    let through_cutter = aabb_to_mesh(Point3::new(0.4, 0.4, -0.1), Point3::new(0.6, 0.6, 1.1));
    let overlapping = aabb_to_mesh(Point3::new(0.5, 0.5, 0.5), Point3::new(1.5, 1.5, 1.5));

    let p = ClippingProcessor::new();
    let subtract = p.subtract_mesh(&open_host, &through_cutter).unwrap();
    let batched = p.subtract_mesh_many(&open_host, &[&through_cutter]).unwrap();
    let union = p.union_mesh(&open_host, &overlapping).unwrap();
    let intersection = p.intersection_mesh(&open_host, &overlapping).unwrap();

    for (name, mesh) in [
        ("subtract_mesh", &subtract),
        ("subtract_mesh_many", &batched),
        ("union_mesh", &union),
        ("intersection_mesh", &intersection),
    ] {
        assert!(
            !mesh.is_empty() && mesh.triangle_count() > 4,
            "{name}: gate must not have rejected this torn result without the feature"
        );
    }
    assert!(
        p.take_failures().iter().all(|f| f.reason != BoolFailureReason::OpenTopologyRejected),
        "OpenTopologyRejected must never be recorded without csg_topology_gate"
    );
}

/// The `csg_topology_gate` mirror of the test above: WITH the feature, the
/// same four torn results are REJECTED — each op falls back exactly like an
/// existing `KernelOutputInvalid` (un-cut host / empty / plain merge) — and
/// each records the dedicated `OpenTopologyRejected` reason once.
#[cfg(feature = "csg_topology_gate")]
#[test]
fn topology_gate_rejects_every_torn_boolean_result_when_enabled() {
    let open_host = open_box_mesh(Point3::new(0.0, 0.0, 0.0), Point3::new(1.0, 1.0, 1.0));
    let through_cutter = aabb_to_mesh(Point3::new(0.4, 0.4, -0.1), Point3::new(0.6, 0.6, 1.1));
    let overlapping = aabb_to_mesh(Point3::new(0.5, 0.5, 0.5), Point3::new(1.5, 1.5, 1.5));

    let p = ClippingProcessor::new();
    let subtract = p.subtract_mesh(&open_host, &through_cutter).unwrap();
    let batched = p.subtract_mesh_many(&open_host, &[&through_cutter]).unwrap();
    let union = p.union_mesh(&open_host, &overlapping).unwrap();
    let intersection = p.intersection_mesh(&open_host, &overlapping).unwrap();

    assert_eq!(subtract.indices, open_host.indices, "subtract_mesh must fall back to the un-cut host");
    assert_eq!(batched.indices, open_host.indices, "subtract_mesh_many must fall back to the un-cut host");
    assert!(intersection.is_empty(), "intersection_mesh must fall back to an empty mesh");
    let mut expected_union_merge = open_host.clone();
    expected_union_merge.merge(&overlapping);
    assert_eq!(
        union.triangle_count(),
        expected_union_merge.triangle_count(),
        "union_mesh must fall back to the plain merge"
    );

    let failures = p.take_failures();
    assert_eq!(
        failures.iter().map(|f| (f.op, f.reason.clone())).collect::<Vec<_>>(),
        vec![
            (BoolOp::Difference, BoolFailureReason::OpenTopologyRejected),
            (BoolOp::Difference, BoolFailureReason::OpenTopologyRejected),
            (BoolOp::Union, BoolFailureReason::OpenTopologyRejected),
            (BoolOp::Intersection, BoolFailureReason::OpenTopologyRejected),
        ],
        "each of the four accept paths must reject and record OpenTopologyRejected exactly once"
    );
}

// World-frame corpus tests: a sibling test file, attached here rather than
// from `mod.rs` because that allowlisted production module is at its
// module-size-ratchet budget and test files are exempt. The file itself
// imports via `crate::csg::`, so the attachment depth does not matter.
#[path = "world_frame_tests.rs"]
mod world_frame_tests;
