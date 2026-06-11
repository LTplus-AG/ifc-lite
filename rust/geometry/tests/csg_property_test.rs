// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Property-based invariants for the CSG pipeline (proptest).
//!
//! Everything else in `tests/` is example-based (specific IFC fixtures /
//! regression scenarios). This suite instead checks *invariants* over
//! bounded randomized inputs:
//!
//! 1. Axis-aligned box difference (`ClippingProcessor::subtract_mesh`,
//!    which dispatches to the Manifold kernel under the default
//!    `manifold-csg` feature and to the legacy BSP port without it):
//!    NaN/Inf-freedom, volume bounds, exact analytic volume for AABB
//!    pairs, emptiness under containment, identity under disjointness,
//!    and watertightness of the output.
//! 2. Star-shaped polygon extrusion (`extrude_profile`): non-empty,
//!    NaN-free, watertight, volume == shoelace-area × depth.
//! 3. 2D boolean rect-pair subtraction (`bool2d::subtract_2d`): area
//!    bounds + exact analytic area, and no self-intersecting output
//!    contours.
//!
//! Case counts are set explicitly per property (48–64) so the whole
//! suite stays well under a minute. Volumes are checked against the
//! f32-quantized inputs (Mesh stores f32 positions), with tolerances
//! that account for the kernel's deliberate ~10 µm cutter inflation
//! (`manifold_kernel::mesh_to_manifold_perturbed`) and f32 round-trips.
//!
//! If a property ever fails, proptest shrinks to a minimal
//! counterexample and records it in
//! `tests/csg_property_test.proptest-regressions` — commit that file so
//! the counterexample is replayed forever.

use ifc_lite_geometry::{
    compute_signed_area, extrude_profile, subtract_2d, ClippingProcessor, Mesh, Point2, Point3,
    Profile2D, Vector3,
};
use proptest::prelude::*;
use std::collections::HashMap;
use std::f64::consts::TAU;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Quantize an f64 coordinate through f32, the precision `Mesh` actually
/// stores. Analytic expectations are computed from quantized values so
/// the properties measure *kernel* error, not authoring error.
fn q(v: f64) -> f64 {
    v as f32 as f64
}

/// Axis-aligned box mesh `[min, min+size]` with outward-CCW winding
/// (same layout as the `manifold_kernel` unit tests).
fn box_mesh(min: [f64; 3], size: [f64; 3]) -> Mesh {
    let mut m = Mesh::with_capacity(8, 36);
    let n = Vector3::new(0.0, 0.0, 0.0);
    let p = |dx: f64, dy: f64, dz: f64| {
        Point3::new(
            min[0] + dx * size[0],
            min[1] + dy * size[1],
            min[2] + dz * size[2],
        )
    };
    let corners = [
        p(0.0, 0.0, 0.0),
        p(1.0, 0.0, 0.0),
        p(1.0, 1.0, 0.0),
        p(0.0, 1.0, 0.0),
        p(0.0, 0.0, 1.0),
        p(1.0, 0.0, 1.0),
        p(1.0, 1.0, 1.0),
        p(0.0, 1.0, 1.0),
    ];
    for c in &corners {
        m.add_vertex(*c, n);
    }
    let faces: [[u32; 6]; 6] = [
        [0, 2, 1, 0, 3, 2],
        [4, 5, 6, 4, 6, 7],
        [0, 4, 7, 0, 7, 3],
        [1, 2, 6, 1, 6, 5],
        [0, 1, 5, 0, 5, 4],
        [3, 7, 6, 3, 6, 2],
    ];
    for f in &faces {
        m.add_triangle(f[0], f[1], f[2]);
        m.add_triangle(f[3], f[4], f[5]);
    }
    m
}

/// Signed volume of a (closed) triangle mesh via the divergence theorem,
/// accumulated in f64. Positive for outward-CCW shells.
fn mesh_volume(mesh: &Mesh) -> f64 {
    let pos = &mesh.positions;
    let mut six_v = 0.0f64;
    for tri in mesh.indices.chunks_exact(3) {
        let v = |i: u32| {
            let b = i as usize * 3;
            [pos[b] as f64, pos[b + 1] as f64, pos[b + 2] as f64]
        };
        let (a, b, c) = (v(tri[0]), v(tri[1]), v(tri[2]));
        six_v += a[0] * (b[1] * c[2] - b[2] * c[1])
            + a[1] * (b[2] * c[0] - b[0] * c[2])
            + a[2] * (b[0] * c[1] - b[1] * c[0]);
    }
    six_v / 6.0
}

/// Every position component must be finite (no NaN / Inf).
fn all_finite(mesh: &Mesh) -> bool {
    mesh.positions.iter().all(|v| v.is_finite())
}

/// Watertightness: after welding by position, every undirected edge must be
/// used by exactly two triangles, once in each direction (manifold edge with
/// consistent winding). Counting *totals* per direction — not just the signed
/// difference — also rejects non-manifold edges with 2+2 opposite incidences
/// and duplicated closed shells, which a pure cancellation check would pass.
/// Empty meshes count as watertight (the empty shell is closed).
///
/// Returns `None` when watertight, otherwise a description of the first
/// violating edge (endpoint indices/positions and the directed-use split).
fn watertight_violation(mesh: &Mesh) -> Option<String> {
    if mesh.is_empty() {
        return None;
    }
    let welded = mesh.welded_by_position(1e-6);
    // (min,max) vertex pair -> (uses as (min..max), uses as (max..min)).
    let mut edges: HashMap<(u32, u32), (u32, u32)> = HashMap::new();
    for tri in welded.indices.chunks_exact(3) {
        for k in 0..3 {
            let a = tri[k];
            let b = tri[(k + 1) % 3];
            if a == b {
                return Some(format!(
                    "degenerate edge ({a}, {b}): triangle repeats a welded vertex"
                ));
            }
            let entry = edges.entry((a.min(b), a.max(b))).or_insert((0, 0));
            if a < b {
                entry.0 += 1;
            } else {
                entry.1 += 1;
            }
        }
    }
    edges
        .iter()
        .find(|(_, &(fwd, rev))| (fwd, rev) != (1, 1))
        .map(|(&(a, b), &(fwd, rev))| {
            let p = |i: u32| {
                let base = i as usize * 3;
                &welded.positions[base..base + 3]
            };
            format!(
                "edge ({a}, {b}) [{:?} -> {:?}] has {} directed uses \
                 ({fwd} forward, {rev} reverse); expected exactly one in each direction",
                p(a),
                p(b),
                fwd + rev
            )
        })
}

/// Guard the checker itself: a signed-cancellation-only check would pass a
/// duplicated closed shell (every edge gets 2 forward + 2 reverse uses, net
/// 0) and an open mesh with a flipped patch. The total-incidence check must
/// reject both while accepting a plain closed box.
#[test]
fn watertight_checker_rejects_non_manifold_and_open_meshes() {
    let unit = [0.0, 0.0, 0.0];
    let size = [1.0, 1.0, 1.0];

    // Closed box: watertight.
    let mesh = box_mesh(unit, size);
    assert_eq!(watertight_violation(&mesh), None);

    // Duplicated shell: signed counts still cancel, but every edge has
    // 4 total uses (2 forward, 2 reverse) — must be rejected.
    let mut doubled = box_mesh(unit, size);
    let tris = doubled.indices.clone();
    for tri in tris.chunks_exact(3) {
        doubled.add_triangle(tri[0], tri[1], tri[2]);
    }
    let violation = watertight_violation(&doubled).expect("duplicated shell must be rejected");
    assert!(
        violation.contains("4 directed uses (2 forward, 2 reverse)"),
        "unexpected message: {violation}"
    );

    // Open mesh (one triangle removed): boundary edges have one use.
    let mut open = box_mesh(unit, size);
    open.indices.truncate(open.indices.len() - 3);
    let violation = watertight_violation(&open).expect("open mesh must be rejected");
    assert!(
        violation.contains("expected exactly one in each direction"),
        "unexpected message: {violation}"
    );
}

/// Shoelace area of a simple polygon (positive for CCW input).
fn shoelace_area(pts: &[Point2<f64>]) -> f64 {
    let n = pts.len();
    let mut sum = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        sum += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    sum / 2.0
}

/// Proper-crossing self-intersection scan over a closed loop, O(n²).
/// Mirrors the (private) `profiles::closed_loop_self_intersects` logic:
/// only interior crossings of non-adjacent segments count; shared
/// endpoints between neighbouring segments do not.
fn closed_loop_self_intersects(loop_: &[Point2<f64>]) -> bool {
    let n = loop_.len();
    if n < 4 {
        return false;
    }
    let orient = |a: &Point2<f64>, b: &Point2<f64>, c: &Point2<f64>| -> f64 {
        (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    };
    let crosses = |a: &Point2<f64>, b: &Point2<f64>, c: &Point2<f64>, d: &Point2<f64>| -> bool {
        let d1 = orient(a, b, c);
        let d2 = orient(a, b, d);
        let d3 = orient(c, d, a);
        let d4 = orient(c, d, b);
        d1 * d2 < 0.0 && d3 * d4 < 0.0
    };
    for i in 0..n {
        let a = &loop_[i];
        let b = &loop_[(i + 1) % n];
        for j_off in 2..n - 1 {
            let j = (i + j_off) % n;
            let c = &loop_[j];
            let d = &loop_[(j + 1) % n];
            if crosses(a, b, c, d) {
                return true;
            }
        }
    }
    false
}

/// Analytic AABB ∩ AABB volume from (already-quantized) min/size pairs.
fn aabb_intersection_volume(
    a_min: [f64; 3],
    a_size: [f64; 3],
    b_min: [f64; 3],
    b_size: [f64; 3],
) -> f64 {
    let mut vol = 1.0;
    for axis in 0..3 {
        let lo = a_min[axis].max(b_min[axis]);
        let hi = (a_min[axis] + a_size[axis]).min(b_min[axis] + b_size[axis]);
        if hi <= lo {
            return 0.0;
        }
        vol *= hi - lo;
    }
    vol
}

// ---------------------------------------------------------------------------
// Property 1: box-pair boolean difference
// ---------------------------------------------------------------------------

/// A box pair plus the configuration it was generated under (kept for
/// debuggability when proptest prints a counterexample).
#[derive(Debug, Clone)]
struct BoxPair {
    config: &'static str,
    a_min: [f64; 3],
    a_size: [f64; 3],
    b_min: [f64; 3],
    b_size: [f64; 3],
}

fn quantized(min: [f64; 3], size: [f64; 3]) -> ([f64; 3], [f64; 3]) {
    // Quantize the *corners* (that's what add_vertex stores), then derive
    // the size from the quantized corners so analytic volume matches the
    // authored mesh bit-for-bit.
    let qmin = [q(min[0]), q(min[1]), q(min[2])];
    let qmax = [
        q(min[0] + size[0]),
        q(min[1] + size[1]),
        q(min[2] + size[2]),
    ];
    (
        qmin,
        [qmax[0] - qmin[0], qmax[1] - qmin[1], qmax[2] - qmin[2]],
    )
}

prop_compose! {
    fn arb_box_a()(
        min in proptest::array::uniform3(-10.0f64..10.0),
        size in proptest::array::uniform3(0.1f64..5.0),
    ) -> ([f64; 3], [f64; 3]) {
        (min, size)
    }
}

fn arb_box_pair() -> impl Strategy<Value = BoxPair> {
    arb_box_a().prop_flat_map(|(a_min, a_size)| {
        let random = (
            proptest::array::uniform3(-12.0f64..12.0),
            proptest::array::uniform3(0.1f64..6.0),
        )
            .prop_map(move |(b_min, b_size)| BoxPair {
                config: "random",
                a_min,
                a_size,
                b_min,
                b_size,
            });
        // B strictly contains A (uniform margin on every side).
        let contained = (0.05f64..1.0).prop_map(move |margin| BoxPair {
            config: "b-contains-a",
            a_min,
            a_size,
            b_min: [a_min[0] - margin, a_min[1] - margin, a_min[2] - margin],
            b_size: [
                a_size[0] + 2.0 * margin,
                a_size[1] + 2.0 * margin,
                a_size[2] + 2.0 * margin,
            ],
        });
        // B disjoint from A: shifted past A's max corner along one axis.
        let disjoint = (
            0usize..3,
            0.01f64..2.0,
            proptest::array::uniform3(0.1f64..5.0),
        )
            .prop_map(move |(axis, gap, b_size)| {
                let mut b_min = a_min;
                b_min[axis] = a_min[axis] + a_size[axis] + gap;
                BoxPair {
                    config: "disjoint",
                    a_min,
                    a_size,
                    b_min,
                    b_size,
                }
            });
        // B exactly face-touching A (gap = 0): the coplanar-classifier
        // precision boundary the cutter inflation exists for.
        let touching =
            (0usize..3, proptest::array::uniform3(0.1f64..5.0)).prop_map(move |(axis, b_size)| {
                let mut b_min = a_min;
                b_min[axis] = a_min[axis] + a_size[axis];
                BoxPair {
                    config: "touching",
                    a_min,
                    a_size,
                    b_min,
                    b_size,
                }
            });
        prop_oneof![
            3 => random,
            1 => contained,
            1 => disjoint,
            1 => touching,
        ]
    })
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 64,
        // Failures (if any) are persisted next to this file; commit the
        // generated csg_property_test.proptest-regressions.
        ..ProptestConfig::default()
    })]

    /// difference(A, B) over axis-aligned box pairs:
    /// (a) no NaN/Inf vertices,
    /// (b) vol(A) − vol(B) − ε ≤ vol(A−B) ≤ vol(A) + ε,
    /// (c) empty when B strictly contains A,
    /// (d) vol(A−B) == vol(A) when disjoint,
    /// plus the exact analytic identity vol(A−B) == vol(A) − vol(A∩B)
    /// and watertightness of the result.
    #[test]
    fn box_difference_volume_invariants(pair in arb_box_pair()) {
        let (a_min, a_size) = quantized(pair.a_min, pair.a_size);
        let (b_min, b_size) = quantized(pair.b_min, pair.b_size);

        let a = box_mesh(a_min, a_size);
        let b = box_mesh(b_min, b_size);
        let vol_a = a_size[0] * a_size[1] * a_size[2];
        let vol_b = b_size[0] * b_size[1] * b_size[2];
        let vol_ab = aabb_intersection_volume(a_min, a_size, b_min, b_size);

        let processor = ClippingProcessor::new();
        let result = processor
            .subtract_mesh(&a, &b)
            .expect("subtract_mesh must not error");

        // (a) numeric sanity
        prop_assert!(all_finite(&result), "result has NaN/Inf positions");

        let vol = mesh_volume(&result);
        prop_assert!(vol.is_finite(), "result volume is not finite");

        // Tolerance: f32 round-trips of ~10-unit coordinates plus the
        // deliberate ~10 µm cutter inflation, both scaled by operand
        // surface areas. 1e-3·(1 + volA + volB) bounds that comfortably
        // while staying far below any meaningful feature volume.
        let eps = 1e-3 * (1.0 + vol_a + vol_b);

        // (b) volume bounds
        prop_assert!(
            vol <= vol_a + eps,
            "vol(A-B)={vol} exceeds vol(A)={vol_a} (config {})",
            pair.config
        );
        prop_assert!(
            vol >= vol_a - vol_b - eps,
            "vol(A-B)={vol} below vol(A)-vol(B)={} (config {})",
            vol_a - vol_b,
            pair.config
        );

        // Exact analytic identity for AABB pairs (subsumes (c)/(d) but we
        // keep those as explicit, more legible assertions below).
        prop_assert!(
            (vol - (vol_a - vol_ab)).abs() <= eps,
            "vol(A-B)={vol} != vol(A)-vol(A∩B)={} (config {})",
            vol_a - vol_ab,
            pair.config
        );

        // (c) containment ⇒ empty
        if pair.config == "b-contains-a" {
            prop_assert!(
                result.is_empty() || vol.abs() <= eps,
                "B contains A but result is non-empty with vol={vol}"
            );
        }

        // (d) disjoint ⇒ A unchanged
        if pair.config == "disjoint" {
            prop_assert!(
                (vol - vol_a).abs() <= eps,
                "disjoint subtraction changed volume: {vol} vs {vol_a}"
            );
        }

        // Watertightness. Guaranteed by construction on the Manifold
        // kernel. The legacy BSP port (`bsp_csg.rs`,
        // --no-default-features) is not watertight in general (per-node
        // re-triangulation can leave T-junctions on oblique cuts), but
        // for axis-aligned box pairs every clip plane is axis-aligned
        // and the property holds empirically (640+ random cases) — so
        // keep it asserted on both kernels. If this ever fails under
        // --no-default-features it is the known server-vs-viewer kernel
        // drift surfacing; commit the recorded counterexample.
        let violation = watertight_violation(&result);
        prop_assert!(
            violation.is_none(),
            "difference result is not watertight (config {}): {}",
            pair.config,
            violation.as_deref().unwrap_or("")
        );
    }
}

// ---------------------------------------------------------------------------
// Property 2: star-shaped polygon extrusion
// ---------------------------------------------------------------------------

/// Star-shaped simple polygon around the origin: strictly increasing
/// angles (built from normalized positive gaps so no two vertices
/// coincide) with bounded radii. Always simple, always CCW.
///
/// The "angle-sorted ⇒ simple CCW polygon" guarantee only holds when the
/// origin is interior, i.e. every angular gap is < π. With gaps drawn
/// from 0.1..1.0 a 3-gon could get a normalized gap of up to
/// 2π/1.2 ≈ 5.2 rad > π, flipping orientation (proptest shrank this to a
/// CW triangle spanning angles 0.56/5.72/6.28 — a generator bug, not a
/// kernel bug). Gaps in 0.55..1.0 cap the worst case (n = 3) at
/// 2π·(1.0/2.1) ≈ 2.99 < π.
fn arb_star_polygon() -> impl Strategy<Value = Vec<Point2<f64>>> {
    (3usize..10)
        .prop_flat_map(|n| {
            (
                proptest::collection::vec(0.55f64..1.0, n),
                proptest::collection::vec(0.3f64..4.0, n),
            )
        })
        .prop_map(|(gaps, radii)| {
            let total: f64 = gaps.iter().sum();
            let mut angle = 0.0;
            gaps.iter()
                .zip(&radii)
                .map(|(gap, r)| {
                    angle += gap / total * TAU;
                    Point2::new(r * angle.cos(), r * angle.sin())
                })
                .collect()
        })
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 64, ..ProptestConfig::default() })]

    /// extrude_profile over random star-shaped polygons: mesh is
    /// non-empty, NaN-free, watertight, and its volume equals
    /// shoelace-area × depth.
    #[test]
    fn extrusion_volume_equals_area_times_depth(
        polygon in arb_star_polygon(),
        depth in 0.1f64..5.0,
    ) {
        let area = shoelace_area(&polygon);
        prop_assert!(area > 0.0, "generator must produce CCW polygons");

        let profile = Profile2D::new(polygon);
        let mesh = extrude_profile(&profile, depth, None)
            .expect("extrusion of a simple CCW polygon must succeed");

        prop_assert!(!mesh.is_empty(), "extrusion produced an empty mesh");
        prop_assert!(all_finite(&mesh), "extrusion has NaN/Inf positions");
        let violation = watertight_violation(&mesh);
        prop_assert!(
            violation.is_none(),
            "extrusion is not watertight: {}",
            violation.as_deref().unwrap_or("")
        );

        // Caps + side walls are authored in f32; coordinates stay < 4, so
        // a relative 1e-3 tolerance dwarfs the f32 quantization error.
        let expected = area * depth;
        let vol = mesh_volume(&mesh).abs();
        prop_assert!(
            (vol - expected).abs() <= 1e-6 + 1e-3 * expected,
            "extruded volume {vol} != area×depth {expected}"
        );
    }
}

// ---------------------------------------------------------------------------
// Property 3: 2D boolean rect-pair subtraction
// ---------------------------------------------------------------------------

fn rect_contour(min: [f64; 2], size: [f64; 2]) -> Vec<Point2<f64>> {
    vec![
        Point2::new(min[0], min[1]),
        Point2::new(min[0] + size[0], min[1]),
        Point2::new(min[0] + size[0], min[1] + size[1]),
        Point2::new(min[0], min[1] + size[1]),
    ]
}

/// Total area of a profile: |outer| minus the sum of |holes|.
fn profile_area(p: &Profile2D) -> f64 {
    let outer = compute_signed_area(&p.outer).abs();
    let holes: f64 = p.holes.iter().map(|h| compute_signed_area(h).abs()).sum();
    outer - holes
}

prop_compose! {
    /// Rect pair where B is strictly smaller than A in BOTH dimensions.
    /// This guarantees B can neither contain A nor split A into multiple
    /// disjoint pieces — `subtract_2d` documents that it keeps only the
    /// FIRST shape of a multi-shape result, so a splitting cutter would
    /// test that API truncation, not the boolean kernel.
    fn arb_rect_pair()(
        a_min in proptest::array::uniform2(-10.0f64..10.0),
        a_size in proptest::array::uniform2(1.0f64..10.0),
        b_scale in proptest::array::uniform2(0.05f64..0.95),
        // B's center offset relative to A's center, in units of A's size:
        // covers disjoint (|offset| ≥ ~1), straddling, and fully interior.
        b_offset in proptest::array::uniform2(-1.5f64..1.5),
    ) -> (Vec<Point2<f64>>, Vec<Point2<f64>>, f64, f64, f64) {
        let b_size = [a_size[0] * b_scale[0], a_size[1] * b_scale[1]];
        let b_min = [
            a_min[0] + (0.5 + b_offset[0]) * a_size[0] - 0.5 * b_size[0],
            a_min[1] + (0.5 + b_offset[1]) * a_size[1] - 0.5 * b_size[1],
        ];
        let overlap_w = (a_min[0] + a_size[0]).min(b_min[0] + b_size[0])
            - a_min[0].max(b_min[0]);
        let overlap_h = (a_min[1] + a_size[1]).min(b_min[1] + b_size[1])
            - a_min[1].max(b_min[1]);
        let overlap = overlap_w.max(0.0) * overlap_h.max(0.0);
        (
            rect_contour(a_min, a_size),
            rect_contour(b_min, b_size),
            a_size[0] * a_size[1],
            b_size[0] * b_size[1],
            overlap,
        )
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 48, ..ProptestConfig::default() })]

    /// subtract_2d over random rect pairs (B smaller than A in both
    /// dimensions): area(A) − area(B) − ε ≤ area(A−B) ≤ area(A) + ε,
    /// exact analytic identity area(A−B) == area(A) − overlap, and no
    /// self-intersecting output contours.
    #[test]
    fn rect_subtraction_area_invariants(
        (a, b, area_a, area_b, overlap) in arb_rect_pair(),
    ) {
        let profile = Profile2D::new(a);
        let result = subtract_2d(&profile, &b)
            .expect("rect-rect subtract_2d must succeed");

        let area = profile_area(&result);
        // i_overlay runs an exact integer overlay on an adaptive grid;
        // observed error is far below 1e-6 relative at these magnitudes.
        let eps = 1e-6 * (1.0 + area_a);

        prop_assert!(area <= area_a + eps, "area(A-B)={area} > area(A)={area_a}");
        prop_assert!(
            area >= area_a - area_b - eps,
            "area(A-B)={area} < area(A)-area(B)={}",
            area_a - area_b
        );
        prop_assert!(
            (area - (area_a - overlap)).abs() <= eps,
            "area(A-B)={area} != area(A)-overlap={}",
            area_a - overlap
        );

        prop_assert!(
            !closed_loop_self_intersects(&result.outer),
            "output outer contour self-intersects"
        );
        for hole in &result.holes {
            prop_assert!(
                !closed_loop_self_intersects(hole),
                "output hole contour self-intersects"
            );
        }
    }
}
