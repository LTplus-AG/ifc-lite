// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for the coaxial footprint-union overlapping-cluster void path.

use super::*;
use crate::bool2d::{compute_signed_area, union_contours_to_shapes};
use crate::csg::ClippingProcessor;
use crate::mesh::Mesh;
use crate::router::GeometryRouter;
use nalgebra::{Point2, Point3, Vector3};

/// Closed axis-aligned box mesh (per-face vertices, outward normals) spanning
/// `[min, max]`.
fn box_mesh(min: [f64; 3], max: [f64; 3]) -> Mesh {
    let c = |sx: usize, sy: usize, sz: usize| {
        [
            if sx == 0 { min[0] } else { max[0] },
            if sy == 0 { min[1] } else { max[1] },
            if sz == 0 { min[2] } else { max[2] },
        ]
    };
    let corners = [
        c(0, 0, 0),
        c(1, 0, 0),
        c(1, 1, 0),
        c(0, 1, 0),
        c(0, 0, 1),
        c(1, 0, 1),
        c(1, 1, 1),
        c(0, 1, 1),
    ];
    let faces: [[usize; 4]; 6] = [
        [0, 3, 2, 1],
        [4, 5, 6, 7],
        [0, 1, 5, 4],
        [2, 3, 7, 6],
        [0, 4, 7, 3],
        [1, 2, 6, 5],
    ];
    let mut m = Mesh::new();
    for f in &faces {
        let a = corners[f[0]];
        let b = corners[f[1]];
        let d = corners[f[2]];
        let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
        let n = [
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
        ];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt().max(1e-30);
        let nn = [(n[0] / len) as f32, (n[1] / len) as f32, (n[2] / len) as f32];
        let base = (m.positions.len() / 3) as u32;
        for &i in f {
            m.positions.extend_from_slice(&[
                corners[i][0] as f32,
                corners[i][1] as f32,
                corners[i][2] as f32,
            ]);
            m.normals.extend_from_slice(&nn);
        }
        m.indices
            .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    m
}

/// A 4 m (X) × 0.3 m (Y, thin) × 3 m (Z) slab-like host, centred at origin.
fn host_wall() -> Mesh {
    box_mesh([-2.0, -0.15, -1.5], [2.0, 0.15, 1.5])
}

/// A `NonRectangular` box opening spanning `[min, max]`, penetration axis +Y.
fn box_opening_y(min: [f64; 3], max: [f64; 3]) -> OpeningType {
    let m = box_mesh(min, max);
    OpeningType::NonRectangular(
        m,
        Point3::new(min[0], min[1], min[2]),
        Point3::new(max[0], max[1], max[2]),
        Some(Vector3::new(0.0, 1.0, 0.0)),
    )
}

fn vol(m: &Mesh) -> f64 {
    super::mesh_signed_volume(m).abs()
}

fn watertight(m: &Mesh) -> bool {
    super::super::geom::param_cut_watertight(m)
}

// ---------------------------------------------------------------------------
// 2D union primitive
// ---------------------------------------------------------------------------

#[test]
fn overlapping_squares_union_to_one_shape() {
    // Two unit squares overlapping by half → one shape, area = union (1.5), not
    // the pairwise sum (2.0).
    let a: Vec<Point2<f64>> = vec![
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        Point2::new(1.0, 1.0),
        Point2::new(0.0, 1.0),
    ];
    let b: Vec<Point2<f64>> = vec![
        Point2::new(0.5, 0.0),
        Point2::new(1.5, 0.0),
        Point2::new(1.5, 1.0),
        Point2::new(0.5, 1.0),
    ];
    let shapes = union_contours_to_shapes(&[a, b]);
    assert_eq!(shapes.len(), 1, "overlapping squares merge to one shape");
    assert!(shapes[0].holes.is_empty());
    let area = compute_signed_area(&shapes[0].outer).abs();
    assert!((area - 1.5).abs() < 1e-6, "union area {area}, expected 1.5");
}

#[test]
fn ring_of_bars_unions_to_one_shape_with_a_hole() {
    // Four bars forming a square frame → one outer shape with one hole (mullion).
    let bar = |min: [f64; 2], max: [f64; 2]| -> Vec<Point2<f64>> {
        vec![
            Point2::new(min[0], min[1]),
            Point2::new(max[0], min[1]),
            Point2::new(max[0], max[1]),
            Point2::new(min[0], max[1]),
        ]
    };
    let bars = vec![
        bar([0.0, 0.0], [3.0, 1.0]), // bottom
        bar([0.0, 2.0], [3.0, 3.0]), // top
        bar([0.0, 0.0], [1.0, 3.0]), // left
        bar([2.0, 0.0], [3.0, 3.0]), // right
    ];
    let shapes = union_contours_to_shapes(&bars);
    assert_eq!(shapes.len(), 1, "frame is one connected shape");
    assert_eq!(shapes[0].holes.len(), 1, "the frame leaves one central hole");
}

#[test]
fn far_apart_squares_yield_two_shapes() {
    // Two disjoint squares (a clustered pair that does NOT actually overlap in 2D)
    // → two shapes → two disjoint prisms downstream.
    let a: Vec<Point2<f64>> = vec![
        Point2::new(0.0, 0.0),
        Point2::new(1.0, 0.0),
        Point2::new(1.0, 1.0),
        Point2::new(0.0, 1.0),
    ];
    let b: Vec<Point2<f64>> = vec![
        Point2::new(5.0, 0.0),
        Point2::new(6.0, 0.0),
        Point2::new(6.0, 1.0),
        Point2::new(5.0, 1.0),
    ];
    let shapes = union_contours_to_shapes(&[a, b]);
    assert_eq!(shapes.len(), 2, "disjoint squares stay two shapes");
}

// ---------------------------------------------------------------------------
// footprint + frame helpers
// ---------------------------------------------------------------------------

#[test]
fn ortho_frame_is_orthonormal() {
    for axis in [
        Vector3::new(0.0, 1.0, 0.0),
        Vector3::new(1.0, 0.0, 0.0),
        Vector3::new(0.3, 0.5, -0.8),
    ] {
        let (u, v, d) = super::ortho_frame(&axis).expect("frame");
        assert!((u.norm() - 1.0).abs() < 1e-9);
        assert!((v.norm() - 1.0).abs() < 1e-9);
        assert!((d.norm() - 1.0).abs() < 1e-9);
        assert!(u.dot(&v).abs() < 1e-9);
        assert!(u.dot(&d).abs() < 1e-9);
        assert!(v.dot(&d).abs() < 1e-9);
    }
}

#[test]
fn cutter_footprint_recovers_box_cross_section_and_depth() {
    let m = box_mesh([-1.0, -0.4, -0.6], [0.2, 0.4, 0.6]); // penetrate +Y
    let (u, v, d) = super::ortho_frame(&Vector3::new(0.0, 1.0, 0.0)).unwrap();
    let fp = super::cutter_footprint(&m, &u, &v, &d).expect("box has caps");
    assert!((fp.z_lo - (-0.4)).abs() < 1e-6);
    assert!((fp.z_hi - 0.4).abs() < 1e-6);
    // Union of the footprint contours = the X×Z cross-section = 1.2 × 1.2 = 1.44.
    let shapes = union_contours_to_shapes(&fp.contours);
    assert_eq!(shapes.len(), 1);
    let area = compute_signed_area(&shapes[0].outer).abs();
    assert!((area - 1.44).abs() < 1e-4, "footprint area {area}");
}

// ---------------------------------------------------------------------------
// end-to-end prepass
// ---------------------------------------------------------------------------

/// Run just the prepass on a fresh host + opening set, returning
/// (result, consumed, host_mutated).
fn run_prepass(openings: &[OpeningType]) -> (Mesh, Vec<bool>, bool) {
    super::set_enabled_override(Some(true));
    let router = GeometryRouter::new();
    let clipper = ClippingProcessor::new();
    let mut result = host_wall();
    let refs: Vec<&OpeningType> = openings.iter().collect();
    let mut consumed = vec![false; openings.len()];
    let mut mutated = false;
    router.coaxial_union_prepass(&mut result, &refs, &mut consumed, &mut mutated, &clipper);
    super::set_enabled_override(None);
    (result, consumed, mutated)
}

#[test]
fn two_overlapping_coaxial_boxes_union_into_one_void() {
    // A: X∈[-1.0,0.2], B: X∈[-0.2,1.0]; both Z∈[-0.6,0.6], through +Y.
    let openings = [
        box_opening_y([-1.0, -0.4, -0.6], [0.2, 0.4, 0.6]),
        box_opening_y([-0.2, -0.4, -0.6], [1.0, 0.4, 0.6]),
    ];
    let host_v = vol(&host_wall());
    let (result, consumed, mutated) = run_prepass(&openings);
    assert!(mutated, "prepass must cut the overlapping cluster");
    assert!(consumed.iter().all(|&c| c), "both openings consumed by the union");
    assert!(watertight(&result), "union cut must be watertight");
    // Union footprint X∈[-1.0,1.0] (2.0) × Z∈[-0.6,0.6] (1.2) = 2.4, × 0.3 thick.
    let removed = host_v - vol(&result);
    assert!(
        (removed - 0.72).abs() < 5e-3,
        "removed {removed}, expected union 0.72 (not the pairwise sum 0.864)"
    );
}

#[test]
fn mixed_depth_bands_slice_into_multiple_prisms() {
    // A through-cut (Y∈[-0.4,0.4]) plus a shallower cutter (Y∈[-0.4,0.0]) sharing
    // a face. Depth-slicing splits the axis at 0.0 → 2 slabs → ≥ 2 prisms, and the
    // shallow cutter is NEVER stretched past its authored Y=0.0.
    let router = GeometryRouter::new();
    let a = box_mesh([-0.6, -0.4, -0.6], [0.6, 0.4, 0.6]);
    let b = box_mesh([-0.6, -0.4, -0.6], [0.6, 0.0, 0.6]);
    let mk = |m: Mesh| super::UnionCand {
        idx: 0,
        mesh: m,
        dir: Vector3::new(0.0, 1.0, 0.0),
        lo: [0.0; 3],
        hi: [0.0; 3],
    };
    let cands = vec![mk(a), mk(b)];
    let host = host_wall();
    let (prisms, multi_slab) = router
        .build_coaxial_prisms(&host, &cands, &[0, 1], &Vector3::new(0.0, 1.0, 0.0))
        .expect("depth-slicing handles mixed bands");
    assert!(prisms.len() >= 2, "two depth bands slice into >= 2 prisms");
    assert!(multi_slab, "two depth bands flag multi-slab fusion");
}

#[test]
fn partial_depth_cutter_is_not_over_cut_end_to_end() {
    // A: through-cut over X∈[-1.0,0.2]. B: a recess from the -Y face to mid
    // (Y∈[-0.4,0.0]) over X∈[-0.2,1.0], overlapping A. The FULL void pipeline (the
    // coaxial union path, or the exact kernel it defers to on the watertight
    // self-check) must remove the true 2.5D union (0.576 m³), NEVER the naive
    // through-union (0.72) that would wrongly bore B all the way through the slab.
    super::set_enabled_override(Some(true));
    let router = GeometryRouter::new();
    let openings = vec![
        box_opening_y([-1.0, -0.4, -0.6], [0.2, 0.4, 0.6]), // through
        box_opening_y([-0.2, -0.4, -0.6], [1.0, 0.0, 0.6]), // recess to Y=0
    ];
    let ctx = super::super::VoidContext {
        merged_openings: openings.clone(),
        openings,
        param: None,
        bool2d: None,
    };
    let host = host_wall();
    let host_v = vol(&host);
    let cut = router.apply_void_context(host, &ctx, 1);
    super::set_enabled_override(None);
    assert!(watertight(&cut), "partial-depth cut must be watertight");
    let removed = host_v - vol(&cut);
    assert!(
        (removed - 0.576).abs() < 5e-3,
        "removed {removed}, expected true 2.5D union 0.576 (not through-union 0.72)"
    );
}

#[test]
fn non_coaxial_cluster_routes_through_union3d() {
    // Two overlapping boxes with PERPENDICULAR penetration axes (+Y and +X). Not
    // coaxial → the 3D union_many fallback cuts them; both consumed, watertight.
    let a = box_opening_y([-0.6, -0.4, -0.6], [0.6, 0.4, 0.6]); // dir +Y
    let m = box_mesh([-1.6, -0.15, -0.4], [-0.4, 0.15, 0.4]);
    let b = OpeningType::NonRectangular(
        m,
        Point3::new(-1.6, -0.15, -0.4),
        Point3::new(-0.4, 0.15, 0.4),
        Some(Vector3::new(1.0, 0.0, 0.0)), // dir +X (perpendicular)
    );
    let (result, consumed, mutated) = run_prepass(&[a, b]);
    assert!(mutated, "non-coaxial overlap still cut via union_many");
    assert!(consumed.iter().all(|&c| c), "both consumed by the 3D union");
    assert!(watertight(&result), "union3d cut must be watertight");
}

#[test]
fn touching_but_padded_disjoint_boxes_stay_unclustered() {
    // A 3 mm gap: after the 1 mm pad each side (2 mm), the padded AABBs are still
    // 1 mm apart → separate components → the prepass leaves BOTH for the disjoint
    // batching / sequential path (no consumption, no mutation).
    let openings = [
        box_opening_y([-1.0, -0.4, -0.6], [-0.2, 0.4, 0.6]),
        box_opening_y([-0.197, -0.4, -0.6], [0.6, 0.4, 0.6]), // 3 mm gap
    ];
    let host_v = vol(&host_wall());
    let (result, consumed, mutated) = run_prepass(&openings);
    assert!(!mutated, "padded-disjoint boxes must not be clustered/cut here");
    assert!(consumed.iter().all(|&c| !c), "nothing consumed by the prepass");
    assert!((vol(&result) - host_v).abs() < 1e-9, "host untouched");
}

#[test]
fn feature_off_is_a_noop_and_deterministic() {
    // With the override OFF the prepass early-returns: host untouched, nothing
    // consumed — identical to the pre-#129 behaviour (the sequential path then
    // cuts these openings). Byte-identical across repeated runs.
    let openings = [
        box_opening_y([-1.0, -0.4, -0.6], [0.2, 0.4, 0.6]),
        box_opening_y([-0.2, -0.4, -0.6], [1.0, 0.4, 0.6]),
    ];
    let router = GeometryRouter::new();
    let clipper = ClippingProcessor::new();
    let run = || -> (Vec<f32>, Vec<u32>, Vec<bool>, bool) {
        super::set_enabled_override(Some(false));
        let mut result = host_wall();
        let refs: Vec<&OpeningType> = openings.iter().collect();
        let mut consumed = vec![false; openings.len()];
        let mut mutated = false;
        router.coaxial_union_prepass(&mut result, &refs, &mut consumed, &mut mutated, &clipper);
        super::set_enabled_override(None);
        (result.positions.clone(), result.indices.clone(), consumed, mutated)
    };
    let host = host_wall();
    let (p1, i1, c1, m1) = run();
    let (p2, i2, _, _) = run();
    assert!(!m1, "feature-off prepass does not mutate");
    assert!(c1.iter().all(|&c| !c), "feature-off consumes nothing");
    assert_eq!(p1, host.positions, "feature-off leaves the host byte-identical");
    assert_eq!(i1, host.indices);
    assert_eq!((p1, i1), (p2, i2), "deterministic across runs");
}
