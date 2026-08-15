// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Analytic oracle for the clash intersection solid (`clash_solid`).
//!
//! The engine half of the BIMcollab-style clash visualisation renders the
//! *overlap volume* of a clashing pair as an opaque solid. This file pins the
//! two properties that visualisation depends on:
//!
//! 1. When a solid IS returned, its volume is the true analytic overlap volume,
//!    independent of how finely either operand is tessellated.
//! 2. When the kernel cannot resolve the overlap, the API says so instead of
//!    returning the wrong solid.
//!
//! The tessellation sweep is not decoration. This repository previously shipped
//! a clash depth metric that silently measured operand tessellation instead of
//! geometry; it passed on a coarse box and failed on a fine one. Every oracle
//! here therefore runs at 12, 48 and 192 triangles per box and asserts the SAME
//! answer, so a sampling artifact cannot pass.

use ifc_lite_geometry::{intersection_solid, DegenerateReason, IntersectionSolid, Mesh};

/// Axis-aligned box as a `Mesh`, each face subdivided `n`×`n`.
///
/// Triangle count is `12·n²`: `n = 1 → 12`, `n = 2 → 48`, `n = 4 → 192`. The
/// surface is identical for every `n` — only the tessellation changes — so any
/// quantity that varies across `n` is measuring the mesh, not the solid.
fn box_mesh(lo: [f64; 3], hi: [f64; 3], n: usize) -> Mesh {
    assert!(n >= 1);
    let mut m = Mesh::new();
    let mut push = |p: [f64; 3]| -> u32 {
        let idx = (m.positions.len() / 3) as u32;
        m.positions.push(p[0] as f32);
        m.positions.push(p[1] as f32);
        m.positions.push(p[2] as f32);
        m.normals.extend_from_slice(&[0.0, 0.0, 0.0]);
        idx
    };
    for axis in 0..3usize {
        let (u, v) = ((axis + 1) % 3, (axis + 2) % 3);
        for (side, &w) in [lo[axis], hi[axis]].iter().enumerate() {
            for i in 0..n {
                for j in 0..n {
                    let fu = |k: usize| lo[u] + (hi[u] - lo[u]) * (k as f64) / (n as f64);
                    let fv = |k: usize| lo[v] + (hi[v] - lo[v]) * (k as f64) / (n as f64);
                    let corner = |cu: f64, cv: f64| {
                        let mut p = [0.0f64; 3];
                        p[axis] = w;
                        p[u] = cu;
                        p[v] = cv;
                        p
                    };
                    let a = push(corner(fu(i), fv(j)));
                    let b = push(corner(fu(i + 1), fv(j)));
                    let c = push(corner(fu(i + 1), fv(j + 1)));
                    let d = push(corner(fu(i), fv(j + 1)));
                    // Wind the low and high faces oppositely so the box is
                    // consistently outward-oriented.
                    if side == 0 {
                        m.indices.extend_from_slice(&[a, c, b, a, d, c]);
                    } else {
                        m.indices.extend_from_slice(&[a, b, c, a, c, d]);
                    }
                }
            }
        }
    }
    m
}

/// `box_mesh`, then every vertex mapped by the rotation `r` (row-major 3×3).
fn rotated_box_mesh(lo: [f64; 3], hi: [f64; 3], n: usize, r: [[f64; 3]; 3]) -> Mesh {
    let mut m = box_mesh(lo, hi, n);
    for p in m.positions.chunks_exact_mut(3) {
        let v = [p[0] as f64, p[1] as f64, p[2] as f64];
        for k in 0..3 {
            p[k] = (r[k][0] * v[0] + r[k][1] * v[1] + r[k][2] * v[2]) as f32;
        }
    }
    m
}

/// The three tessellation levels every oracle sweeps: 12, 48 and 192 triangles.
const TESSELLATIONS: [usize; 3] = [1, 2, 4];

/// Analytic agreement bound. The API returns f64 positions taken straight from
/// the exact kernel, so the observed error on every case below is ≤ 2e-15;
/// 1e-12 leaves three orders of headroom without being able to hide a real
/// geometric error (the smallest defect this file guards against is a 33 %
/// volume loss).
const EXACT: f64 = 1.0e-12;

/// Volume of a returned solid; panics with the degenerate reason otherwise, so
/// a test that expected a solid fails with the diagnosis rather than `None`.
fn volume_of(s: &IntersectionSolid, ctx: &str) -> f64 {
    match s {
        IntersectionSolid::Solid { volume_m3, .. } => *volume_m3,
        IntersectionSolid::Degenerate(r) => panic!("{ctx}: expected a solid, got {r:?}"),
    }
}

fn degenerate_reason(s: &IntersectionSolid, ctx: &str) -> DegenerateReason {
    match s {
        IntersectionSolid::Degenerate(r) => *r,
        IntersectionSolid::Solid { volume_m3, .. } => {
            panic!("{ctx}: expected degenerate, got a solid of {volume_m3} m³")
        }
    }
}

// ---------------------------------------------------------------------------
// The instrument itself.
// ---------------------------------------------------------------------------

#[test]
fn box_mesh_helper_has_the_triangle_counts_the_sweep_claims() {
    // The sweep only detects sampling artifacts if the operands really do get
    // finer. Pin that before trusting any assertion that uses it.
    let counts: Vec<usize> = TESSELLATIONS
        .iter()
        .map(|&n| box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], n).indices.len() / 3)
        .collect();
    assert_eq!(counts, vec![12, 48, 192]);
}

#[test]
fn returned_solid_is_indexed_and_every_index_is_in_range() {
    // The viewer uploads `positions`/`indices` straight to a GPU buffer.
    let a = box_mesh([0.0, 0.0, 0.0], [2.0, 2.0, 2.0], 2);
    let b = box_mesh([1.0, 1.0, 1.0], [3.0, 3.0, 3.0], 2);
    match intersection_solid(&a, &b) {
        IntersectionSolid::Solid {
            positions, indices, ..
        } => {
            assert_eq!(positions.len() % 3, 0);
            assert_eq!(indices.len() % 3, 0);
            let verts = (positions.len() / 3) as u32;
            assert!(verts > 0 && !indices.is_empty());
            assert!(
                indices.iter().all(|&i| i < verts),
                "index out of range: {verts} vertices, max index {:?}",
                indices.iter().max()
            );
            // Welding must actually weld: a closed solid has far fewer unique
            // vertices than 3 per triangle.
            assert!(
                (verts as usize) < indices.len(),
                "{verts} vertices for {} indices — the weld did nothing",
                indices.len()
            );
        }
        IntersectionSolid::Degenerate(r) => panic!("expected a solid, got {r:?}"),
    }
}

// ---------------------------------------------------------------------------
// Analytic volume — axis-aligned.
// ---------------------------------------------------------------------------

/// A = [0,2] × [0,3] × [0,4], B = [1.25,5] × [-1,1.5] × [2.5,10].
/// Overlap = [1.25,2] × [0,1.5] × [2.5,4] = 0.75 · 1.5 · 1.5 = 1.6875 m³.
/// Every coordinate is an exact binary fraction and an exact multiple of the
/// kernel's `2^-16` snap grid, so the analytic answer is reachable exactly.
const AA_EXPECTED: f64 = 0.75 * 1.5 * 1.5;

#[test]
fn axis_aligned_overlap_volume_is_analytic_at_every_tessellation() {
    assert_eq!(AA_EXPECTED, 1.6875);
    for &n in &TESSELLATIONS {
        let a = box_mesh([0.0, 0.0, 0.0], [2.0, 3.0, 4.0], n);
        let b = box_mesh([1.25, -1.0, 2.5], [5.0, 1.5, 10.0], n);
        let v = volume_of(&intersection_solid(&a, &b), &format!("n={n}"));
        assert!(
            (v - AA_EXPECTED).abs() < EXACT,
            "n={n} ({} tris/box): volume {v}, expected {AA_EXPECTED}",
            a.indices.len() / 3
        );
    }
}

#[test]
fn overlap_volume_does_not_drift_when_only_one_operand_is_refined() {
    // A sampling artifact that happens to cancel when BOTH operands are refined
    // together still shows up when they are refined independently.
    for &na in &TESSELLATIONS {
        for &nb in &TESSELLATIONS {
            let a = box_mesh([0.0, 0.0, 0.0], [2.0, 3.0, 4.0], na);
            let b = box_mesh([1.25, -1.0, 2.5], [5.0, 1.5, 10.0], nb);
            let v = volume_of(&intersection_solid(&a, &b), &format!("na={na} nb={nb}"));
            assert!(
                (v - AA_EXPECTED).abs() < EXACT,
                "na={na} nb={nb}: volume {v}, expected {AA_EXPECTED}"
            );
        }
    }
}

#[test]
fn intersection_is_commutative_in_volume() {
    for &n in &TESSELLATIONS {
        let a = box_mesh([0.0, 0.0, 0.0], [2.0, 3.0, 4.0], n);
        let b = box_mesh([1.25, -1.0, 2.5], [5.0, 1.5, 10.0], n);
        let ab = volume_of(&intersection_solid(&a, &b), "A∩B");
        let ba = volume_of(&intersection_solid(&b, &a), "B∩A");
        assert!(
            (ab - ba).abs() < EXACT && (ab - AA_EXPECTED).abs() < EXACT,
            "n={n}: A∩B = {ab}, B∩A = {ba}, expected {AA_EXPECTED}"
        );
    }
}

#[test]
fn containment_returns_the_contained_solid_not_a_shell() {
    // B entirely inside A: A ∩ B = B, volume 0.5³ = 0.125.
    for &n in &TESSELLATIONS {
        let a = box_mesh([0.0, 0.0, 0.0], [4.0, 4.0, 4.0], n);
        let b = box_mesh([1.0, 1.0, 1.0], [1.5, 1.5, 1.5], n);
        let v = volume_of(&intersection_solid(&a, &b), &format!("n={n}"));
        assert!(
            (v - 0.125).abs() < EXACT,
            "n={n}: contained-box volume {v}, expected 0.125"
        );
    }
}

// ---------------------------------------------------------------------------
// Analytic volume — rotated, with a hand derivation.
// ---------------------------------------------------------------------------

/// Rotation by the exact Pythagorean angle `cos θ = 3/5, sin θ = 4/5` about Z.
///
/// Chosen over 45° deliberately: every entry is an exact binary fraction, so the
/// rotated operand's vertices land exactly on the kernel's `2^-16` snap grid and
/// the analytic answer stays reachable to f64. A `√2/2` rotation would smear
/// corners by up to half a snap cell and force a tolerance loose enough to hide
/// a real error.
const ROT_Z_3_4_5: [[f64; 3]; 3] = [[0.6, -0.8, 0.0], [0.8, 0.6, 0.0], [0.0, 0.0, 1.0]];

/// The rotated operand: a 5 × 2.5 box in XY (cross-section 12.5 m², preserved by
/// rotation) spanning z ∈ [0.25, 5], turned by `ROT_Z_3_4_5`.
fn rotated_operand(n: usize) -> Mesh {
    rotated_box_mesh([-2.5, -1.25, 0.25], [2.5, 1.25, 5.0], n, ROT_Z_3_4_5)
}

#[test]
fn rotated_operand_has_the_exact_footprint_the_derivation_assumes() {
    // The expected volumes below are derived BY HAND from these four corners. If
    // the rotation does not actually put the corners here the derivation is
    // void, so pin the corners themselves, independently of any intersection.
    let m = rotated_operand(1);
    let mut footprint: Vec<(f32, f32)> = m
        .positions
        .chunks_exact(3)
        .filter(|p| p[2] == 0.25)
        .map(|p| (p[0], p[1]))
        .collect();
    footprint.sort_by(|a, b| a.partial_cmp(b).unwrap());
    footprint.dedup();
    assert_eq!(
        footprint,
        vec![(-2.5, -1.25), (-0.5, -2.75), (0.5, 2.75), (2.5, 1.25)],
        "rotated footprint is not the one the analytic derivation assumes"
    );
}

#[test]
fn rotated_box_overlap_volume_matches_the_hand_derivation() {
    // A: an axis-aligned slab z ∈ [0,1], wide enough in XY to contain the whole
    //    rotated footprint. B: `rotated_operand`, z ∈ [0.25, 5].
    //
    // Derived independently of this crate: rotation is an isometry, so B's
    // cross-section is still 5 × 2.5 = 12.5 m². A contains that footprint
    // entirely, so the intersection is a prism of that cross-section over the
    // z-overlap [0.25, 1] = 0.75 m.  V = 12.5 · 0.75 = 9.375 m³.
    const EXPECTED: f64 = 12.5 * 0.75;
    assert_eq!(EXPECTED, 9.375);
    for &n in &TESSELLATIONS {
        let a = box_mesh([-10.0, -10.0, 0.0], [10.0, 10.0, 1.0], n);
        let v = volume_of(&intersection_solid(&a, &rotated_operand(n)), &format!("n={n}"));
        assert!(
            (v - EXPECTED).abs() < EXACT,
            "n={n}: rotated volume {v}, expected {EXPECTED}"
        );
    }
}

#[test]
fn rotated_box_clipped_on_an_oblique_corner_matches_the_hand_derivation() {
    // Same operands, but A's +X face now cuts the rotated footprint at x = 1.0,
    // so one oblique corner is sliced off and the intersection is no longer a
    // prism of the full cross-section.
    //
    // Hand derivation (independent of this crate):
    //   Only corner (2.5, 1.25) has x > 1. Its two incident edges are
    //     (2.5,1.25) → (0.5,2.75),   direction (-2, 1.5): x = 1 at t = 0.75
    //       ⇒ (1.0, 1.25 + 0.75·1.5) = (1.0, 2.375)
    //     (2.5,1.25) → (-0.5,-2.75), direction (-3, -4):  x = 1 at t = 0.5
    //       ⇒ (1.0, 1.25 − 0.5·4)    = (1.0, −0.75)
    //   The removed piece is the triangle (2.5,1.25), (1.0,2.375), (1.0,−0.75):
    //     base on x = 1 has length 2.375 − (−0.75) = 3.125, height 2.5 − 1 = 1.5
    //     area = ½ · 3.125 · 1.5 = 2.34375 m²
    //   Clipped cross-section = 12.5 − 2.34375 = 10.15625 m²
    //   V = 10.15625 · 0.75 = 7.6171875 m³
    const CLIPPED_AREA: f64 = 12.5 - 0.5 * 3.125 * 1.5;
    assert_eq!(CLIPPED_AREA, 10.15625);
    const EXPECTED: f64 = CLIPPED_AREA * 0.75;
    assert_eq!(EXPECTED, 7.6171875);
    for &n in &TESSELLATIONS {
        let a = box_mesh([-10.0, -10.0, 0.0], [1.0, 10.0, 1.0], n);
        let v = volume_of(&intersection_solid(&a, &rotated_operand(n)), &format!("n={n}"));
        assert!(
            (v - EXPECTED).abs() < EXACT,
            "n={n}: oblique-clipped volume {v}, expected {EXPECTED}"
        );
    }
}

// ---------------------------------------------------------------------------
// Degenerate cases — the norm in real clash data, not the exception.
// ---------------------------------------------------------------------------

#[test]
fn empty_operand_is_reported_not_crashed() {
    let a = box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], 1);
    let empty = Mesh::new();
    assert_eq!(
        degenerate_reason(&intersection_solid(&a, &empty), "A ∩ ∅"),
        DegenerateReason::EmptyOperand
    );
    assert_eq!(
        degenerate_reason(&intersection_solid(&empty, &a), "∅ ∩ A"),
        DegenerateReason::EmptyOperand
    );
}

#[test]
fn disjoint_boxes_report_no_overlap() {
    for &n in &TESSELLATIONS {
        let a = box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], n);
        let b = box_mesh([5.0, 5.0, 5.0], [6.0, 6.0, 6.0], n);
        assert_eq!(
            degenerate_reason(&intersection_solid(&a, &b), &format!("n={n}")),
            DegenerateReason::NoOverlap
        );
    }
}

#[test]
fn coplanar_touching_boxes_yield_no_solid_and_do_not_crash() {
    // Two boxes sharing the face x = 1 exactly. The true intersection is a 2D
    // patch of zero volume; there is no solid to draw.
    for &n in &TESSELLATIONS {
        let a = box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], n);
        let b = box_mesh([1.0, 0.0, 0.0], [2.0, 1.0, 1.0], n);
        assert_eq!(
            degenerate_reason(&intersection_solid(&a, &b), &format!("n={n}")),
            DegenerateReason::NoOverlap,
            "n={n}: coplanar touching boxes must produce no solid"
        );
    }
}

#[test]
fn sub_micron_grazes_degenerate_instead_of_producing_a_sliver() {
    // The genuine coordination issues on the real infrastructure model graze by
    // 0.3–1.5 µm. The kernel snaps every input coordinate to `2^-16 m ≈ 15.26
    // µm`, so an overlap four orders of magnitude below one grid cell collapses
    // to the coplanar touching case above. There is no exact solid at that
    // scale; the honest answer is to say so, and the viewer keeps its contact
    // marker.
    for depth in [0.3e-6f64, 1.0e-6, 1.5e-6] {
        for &n in &TESSELLATIONS {
            let a = box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], n);
            let b = box_mesh([1.0 - depth, 0.0, 0.0], [2.0, 1.0, 1.0], n);
            assert_eq!(
                degenerate_reason(&intersection_solid(&a, &b), &format!("{depth} m")),
                DegenerateReason::NoOverlap,
                "n={n}, graze {depth} m must degenerate, never yield a sliver"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// The trust gate. These are the tests that stop the wrong solid shipping.
// ---------------------------------------------------------------------------

/// The kernel's near-coplanar band floor, `8 · SNAP_GRID`, in metres. Mirrored
/// here (not imported — it is `pub(crate)`) so a change to it breaks these
/// tests loudly rather than silently shifting the gate.
const NEAR_BAND_FLOOR: f64 = 8.0 / 65536.0;

#[test]
fn an_overlap_inside_the_near_coplanar_band_is_withheld_not_reported_wrong() {
    // THE point of this file. Measured against the raw kernel, a slab overlap at
    // or below 8 snap cells (122 µm) comes back as EXACTLY 2/3 of its true
    // volume at every world scale — the arrangement resolves it as a coplanar
    // contact and returns a wedge. A −33 % solid is worse than no solid: it
    // looks plausible and is wrong. The API must withhold it.
    for cells in [1u32, 2, 4, 6, 8] {
        let depth = (cells as f64) / 65536.0;
        for &n in &TESSELLATIONS {
            let a = box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], n);
            let b = box_mesh([1.0 - depth, 0.0, 0.0], [2.0, 1.0, 1.0], n);
            match degenerate_reason(&intersection_solid(&a, &b), &format!("{cells} cells")) {
                DegenerateReason::BelowKernelResolution {
                    thickness_m,
                    required_m,
                } => {
                    assert!(
                        (thickness_m - depth).abs() < 1.0e-9,
                        "{cells} cells n={n}: reported thickness {thickness_m}, actual {depth}"
                    );
                    assert!(
                        required_m >= 4.0 * NEAR_BAND_FLOOR - 1e-12,
                        "{cells} cells: required {required_m} below the band floor"
                    );
                }
                other => panic!("{cells} cells n={n}: expected BelowKernelResolution, got {other:?}"),
            }
        }
    }
}

#[test]
fn rotated_near_band_overlap_is_withheld_exactly_as_the_axis_aligned_one_is() {
    // The rotation-invariance counterpart of the test above, and the one that
    // caught the review finding on #2573. The operands are the SAME pair —
    // rigidly rotated as a unit by `ROT_Z_3_4_5`, which is an isometry, so the
    // true overlap is the same 1-to-8-snap-cell slab and the answer must be the
    // same too: withheld.
    //
    // Measured before the fix, with `thickness` taken against the world axes:
    // every one of these cases came back as a SOLID, because the rotated
    // wedge's thinnest WORLD-axis extent is ~0.6 m rather than the 15–122 µm
    // the contact actually is. At 1, 2, 4 and 8 cells the volumes it returned
    // ranged from 36 % to 103 % of the truth — not merely wrong but drifting
    // with the tessellation at a fixed depth, which is the exact failure mode
    // this whole file exists to catch. The gate now measures along the contact
    // normal derived from the operands' own face planes, so the rotation makes
    // no difference.
    for cells in [1u32, 2, 4, 6, 8] {
        let depth = (cells as f64) / 65536.0;
        for &n in &TESSELLATIONS {
            let a = rotated_box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], n, ROT_Z_3_4_5);
            let b = rotated_box_mesh([1.0 - depth, 0.0, 0.0], [2.0, 1.0, 1.0], n, ROT_Z_3_4_5);
            let ctx = format!("{cells} cells n={n}");
            match degenerate_reason(&intersection_solid(&a, &b), &ctx) {
                DegenerateReason::BelowKernelResolution {
                    thickness_m,
                    required_m,
                } => {
                    // The measured thickness must be the TRUE contact depth,
                    // not some world-frame projection of it. The tolerance is
                    // one snap cell: the rotated operands' vertices no longer
                    // land on the kernel's `2^-16` grid, so the arranged
                    // geometry is the snapped one, and f32 `Mesh` positions add
                    // ~6e-8 m on top. Both are far below the 488 µm gate.
                    assert!(
                        (thickness_m - depth).abs() < 1.0 / 65536.0,
                        "{ctx}: reported thickness {thickness_m}, true depth {depth}"
                    );
                    assert!(
                        required_m >= 4.0 * NEAR_BAND_FLOOR - 1e-12,
                        "{ctx}: required {required_m} below the band floor"
                    );
                }
                other => panic!("{ctx}: expected BelowKernelResolution, got {other:?}"),
            }
        }
    }
}

#[test]
fn intersection_is_exact_at_and_above_the_trust_threshold_at_every_world_scale() {
    // Above the gate the volume must be EXACT — not approximately right. The
    // world-offset sweep matters because the kernel's near-coplanar band widens
    // with coordinate magnitude (`max(8·SNAP_GRID, extent·2^-22)`), so a gate
    // validated only at the origin would pass here and leak a wrong solid on a
    // bridge sited at its real survey coordinates.
    for x0 in [0.0f64, 10.0, 100.0, 1000.0] {
        // 64 cells = 976 µm clears 4× the band at every one of these offsets
        // (the band is 122 µm up to ~512 m, and 238 µm at 1000 m).
        for cells in [64u32, 128, 1024] {
            let depth = (cells as f64) / 65536.0;
            for &n in &TESSELLATIONS {
                let a = box_mesh([x0, 0.0, 0.0], [x0 + 1.0, 1.0, 1.0], n);
                let b = box_mesh([x0 + 1.0 - depth, 0.0, 0.0], [x0 + 2.0, 1.0, 1.0], n);
                let ctx = format!("x0={x0} cells={cells} n={n}");
                let v = volume_of(&intersection_solid(&a, &b), &ctx);
                // The slab is depth × 1 × 1, so its volume IS its depth.
                assert!(
                    (v - depth).abs() < EXACT,
                    "{ctx}: volume {v}, expected {depth} (err {:.3e})",
                    v - depth
                );
            }
        }
    }
}

#[test]
fn the_gate_widens_with_world_distance_as_the_kernel_band_does() {
    // A fixed-metres gate would be wrong: at 1000 m the kernel's band is
    // `1000 · 2^-22 = 238 µm`, wider than the 122 µm floor, and a 488 µm overlap
    // that is exact at the origin is measurably wrong out there. Pin that the
    // gate actually tracks the operand extent rather than being a constant.
    const DEPTH: f64 = 32.0 / 65536.0; // 488 µm
    let near = {
        let a = box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], 1);
        let b = box_mesh([1.0 - DEPTH, 0.0, 0.0], [2.0, 1.0, 1.0], 1);
        intersection_solid(&a, &b)
    };
    let far = {
        let a = box_mesh([1000.0, 0.0, 0.0], [1001.0, 1.0, 1.0], 1);
        let b = box_mesh([1001.0 - DEPTH, 0.0, 0.0], [1002.0, 1.0, 1.0], 1);
        intersection_solid(&a, &b)
    };
    let v = volume_of(&near, "488 µm at the origin");
    assert!(
        (v - DEPTH).abs() < EXACT,
        "488 µm at the origin should be exact, got {v} for {DEPTH}"
    );
    assert!(
        matches!(
            degenerate_reason(&far, "488 µm at 1000 m"),
            DegenerateReason::BelowKernelResolution { .. }
        ),
        "the same 488 µm overlap at 1000 m must be withheld, not reported"
    );
}

#[test]
fn a_deep_overlap_is_never_withheld_however_far_from_the_origin() {
    // The counterpart: the gate must not swallow real clashes. A 12.5 cm overlap
    // is a serious coordination issue and must survive at any world coordinate.
    // 0.875 = 7/8 is exact on the snap grid, so the expectation is exact too.
    for x0 in [0.0f64, 100.0, 1000.0, 10_000.0] {
        for &n in &TESSELLATIONS {
            let a = box_mesh([x0, 0.0, 0.0], [x0 + 1.0, 1.0, 1.0], n);
            let b = box_mesh([x0 + 0.875, 0.0, 0.0], [x0 + 2.0, 1.0, 1.0], n);
            let ctx = format!("x0={x0} n={n}");
            let v = volume_of(&intersection_solid(&a, &b), &ctx);
            assert!(
                (v - 0.125).abs() < EXACT,
                "{ctx}: 12.5 cm overlap gave {v}, expected 0.125"
            );
        }
    }
}

#[test]
fn an_off_grid_face_quantizes_to_the_snap_grid_and_no_further() {
    // Real models do not place faces on binary fractions. The kernel snaps every
    // input coordinate to `2^-16 m`, so a face at x = 0.9 is arranged at
    // `round(0.9 · 65536) / 65536 = 0.899993896484375` and the reported overlap
    // is 0.100006103515625, not 0.1.
    //
    // This is a real 6.1 µm bias on the reported volume and it is worth stating
    // plainly rather than hiding under a loose tolerance: the intersection solid
    // is exact with respect to the SNAPPED operands, and the snap is the
    // accuracy floor a viewer readout inherits. It is bounded by half a grid
    // cell (7.63 µm) per face, and it is what makes the 15 µm / 122 µm
    // thresholds elsewhere in this file the right order of magnitude.
    const SNAPPED_OVERLAP: f64 = 1.0 - 0.899993896484375;
    assert_eq!(SNAPPED_OVERLAP, 0.100006103515625);
    assert!(
        (SNAPPED_OVERLAP - 0.1).abs() < 1.0 / 65536.0,
        "the snap bias must stay within one grid cell"
    );
    for &n in &TESSELLATIONS {
        let a = box_mesh([0.0, 0.0, 0.0], [1.0, 1.0, 1.0], n);
        let b = box_mesh([0.9, 0.0, 0.0], [2.0, 1.0, 1.0], n);
        let v = volume_of(&intersection_solid(&a, &b), &format!("n={n}"));
        assert!(
            (v - SNAPPED_OVERLAP).abs() < EXACT,
            "n={n}: off-grid overlap gave {v}, expected the snapped {SNAPPED_OVERLAP}"
        );
    }
}

#[test]
fn f64_output_is_what_makes_the_volume_exact() {
    // Justifies `IntersectionSolid` carrying f64 rather than reusing the f32
    // `Mesh`: on the rotated oracle the f32 round-trip is off by ~1.2e-7, a
    // thousand times the 1e-12 bound the rest of this file asserts. If someone
    // "simplifies" the API back to `Mesh`, this fails.
    let a = box_mesh([-10.0, -10.0, 0.0], [10.0, 10.0, 1.0], 1);
    let b = rotated_operand(1);
    let exact = volume_of(&intersection_solid(&a, &b), "f64 path");

    let via_f32 = {
        let m = ifc_lite_geometry::kernel::mesh_bridge::intersection(&a, &b);
        let vert = |i: u32| {
            let o = (i as usize) * 3;
            [
                m.positions[o] as f64,
                m.positions[o + 1] as f64,
                m.positions[o + 2] as f64,
            ]
        };
        m.indices
            .chunks_exact(3)
            .map(|t| {
                let (p, q, r) = (vert(t[0]), vert(t[1]), vert(t[2]));
                let cr = [
                    q[1] * r[2] - q[2] * r[1],
                    q[2] * r[0] - q[0] * r[2],
                    q[0] * r[1] - q[1] * r[0],
                ];
                p[0] * cr[0] + p[1] * cr[1] + p[2] * cr[2]
            })
            .sum::<f64>()
            .abs()
            / 6.0
    };

    assert!((exact - 9.375).abs() < EXACT, "f64 path gave {exact}");
    assert!(
        (via_f32 - 9.375).abs() > 1.0e-9,
        "the f32 round-trip is no longer lossy ({via_f32}); this test's premise \
         is stale and the f64 output may no longer be justified"
    );
}

// ---------------------------------------------------------------------------
// Non-box operands — the #2573 adversarial-review rotation blind spot.
//
// `gate_axes` used to add the analytic box-derived candidate axes only when
// BOTH operands presented a detected box frame; otherwise it fell back to the
// three world axes alone. For a unit contact normal `n`, `max_i(|n_i)| >=
// 1/sqrt(3)`, so that fallback could overstate a true perpendicular contact
// depth by up to sqrt(3) ~ 1.73x — enough to certify a genuinely-shallow,
// below-threshold contact as `Solid` whenever either operand was not a box
// (a chamfered beam end, a mitred pipe joint, a sloped member — the common
// case in real IFC, not the exception). The fix in `clash_contact_axes.rs`
// generalises the candidate-axis set to EVERY operand's own face normals,
// box-shaped or not, plus their pairwise cross products.
// ---------------------------------------------------------------------------

/// A right-angle corner tetrahedron chamfering a box's own corner `corner`,
/// with legs of length `t` retreating along -x, -y, -z from `corner`. This is
/// a NON-box mesh (4 triangular faces; `orthogonal_face_axes` returns `None`
/// for it), and for any [`box_mesh`] whose own corner is `corner`, the
/// tetrahedron sits entirely inside it, so `intersection(box, tet) == tet`
/// exactly. The tetrahedron's own "cut face" (the one opposite the apex) has
/// unit normal `(1,1,1)/sqrt(3)`, an oblique direction none of the box's
/// three world-aligned face normals can represent — the review's rotation
/// blind spot.
///
/// True perpendicular penetration depth, measured from the apex to the
/// opposite face along that `(1,1,1)/sqrt(3)` normal, is `t / sqrt(3)`.
/// Analytic volume is `t^3 / 6`.
fn corner_tet(corner: [f64; 3], t: f64) -> Mesh {
    let apex = corner;
    let p_x = [corner[0] - t, corner[1], corner[2]];
    let p_y = [corner[0], corner[1] - t, corner[2]];
    let p_z = [corner[0], corner[1], corner[2] - t];
    let mut m = Mesh::new();
    for v in [apex, p_x, p_y, p_z] {
        m.positions.push(v[0] as f32);
        m.positions.push(v[1] as f32);
        m.positions.push(v[2] as f32);
    }
    // Outward-oriented faces (apex=0, p_x=1, p_y=2, p_z=3), verified by hand:
    // for each face, cross(edge1, edge2) dotted with (centroid - face_point)
    // is negative (normal points away from the centroid).
    m.indices = vec![
        0, 1, 2, // apex, p_x, p_y
        0, 2, 3, // apex, p_y, p_z
        0, 3, 1, // apex, p_z, p_x
        1, 3, 2, // p_x, p_z, p_y (the oblique cut face)
    ];
    m
}

fn tet_volume_analytic(t: f64) -> f64 {
    t * t * t / 6.0
}

#[test]
fn corner_tet_fixture_matches_its_own_analytic_volume() {
    // Validate the fixture independently before trusting any measurement
    // built on it. `t` chosen well clear of the trust threshold (true depth
    // `t/sqrt(3)` in the multi-millimetre range) so the documented snap-grid
    // quantization error near the gate boundary does not leak into this
    // check — this is a check on the FIXTURE, not on the gate.
    for &t in &[5.0e-3f64, 1.0e-2, 5.0e-2] {
        let corner = [10.0, 10.0, 10.0];
        let big_box = box_mesh([0.0, 0.0, 0.0], [10.0, 10.0, 10.0], 1);
        let tet = corner_tet(corner, t);
        let expected = tet_volume_analytic(t);
        let ctx = format!("t={t}");
        let v = volume_of(&intersection_solid(&big_box, &tet), &ctx);
        let rel_err = (v - expected).abs() / expected;
        assert!(
            rel_err < 0.005,
            "{ctx}: clip volume {v}, analytic {expected}, rel_err {rel_err}"
        );
    }
}

#[test]
fn oblique_non_box_contact_below_the_trust_threshold_is_withheld() {
    // THE #2573 review finding. Before the fix: at true perpendicular depths
    // of 450 um and 488 um — both below the 488.28 um trust threshold this
    // 10 m extent computes (4 * near_band_from_extent(10)) — this returned
    // `Solid` instead of `Degenerate(BelowKernelResolution)`, because the
    // world-axis fallback measured the wedge's world-axis extent (up to
    // 1.73x the true depth) instead of the true (1,1,1)/sqrt(3) thickness.
    let corner = [10.0, 10.0, 10.0];
    for depth_um in [450.0f64, 488.0] {
        let true_depth = depth_um * 1.0e-6;
        let t = true_depth * 3.0f64.sqrt();
        for &n in &TESSELLATIONS {
            let big_box = box_mesh([0.0, 0.0, 0.0], [10.0, 10.0, 10.0], n);
            let tet = corner_tet(corner, t);
            let ctx = format!("depth={depth_um}um n={n}");
            match degenerate_reason(&intersection_solid(&big_box, &tet), &ctx) {
                DegenerateReason::BelowKernelResolution {
                    thickness_m,
                    required_m,
                } => {
                    // Tolerance: one snap cell, matching the rotated box-box
                    // oracle's own bound above — the tetrahedron's vertices
                    // don't land exactly on the kernel's 2^-16 grid either,
                    // and f32 `Mesh` positions add their own ~1e-7 m noise.
                    assert!(
                        (thickness_m - true_depth).abs() < 1.0 / 65536.0,
                        "{ctx}: measured thickness {thickness_m}, true perpendicular depth {true_depth}"
                    );
                    assert!(
                        required_m >= 4.0 * NEAR_BAND_FLOOR - 1e-12,
                        "{ctx}: required {required_m} below the band floor"
                    );
                }
                other => panic!("{ctx}: expected BelowKernelResolution, got {other:?}"),
            }
        }
    }
}

#[test]
fn oblique_non_box_contact_above_the_trust_threshold_returns_the_exact_solid() {
    // Counterpart: the fix must not withhold a contact that IS deep enough.
    // At 500 um (just over the 488.28 um threshold) this correctly returned
    // `Solid` even before the fix, per the review; pinned here as the
    // boundary partner of the withheld case above, now also checked against
    // the analytic volume.
    let corner = [10.0, 10.0, 10.0];
    for depth_um in [500.0f64, 1000.0, 2000.0] {
        let true_depth = depth_um * 1.0e-6;
        let t = true_depth * 3.0f64.sqrt();
        let big_box = box_mesh([0.0, 0.0, 0.0], [10.0, 10.0, 10.0], 1);
        let tet = corner_tet(corner, t);
        let expected = tet_volume_analytic(t);
        let ctx = format!("depth={depth_um}um");
        let v = volume_of(&intersection_solid(&big_box, &tet), &ctx);
        let rel_err = (v - expected).abs() / expected;
        assert!(
            rel_err < 0.02,
            "{ctx}: volume {v}, expected {expected}, rel_err {rel_err}"
        );
    }
}

#[test]
fn oblique_non_box_sweep_never_returns_a_grossly_wrong_volume() {
    // The review's second, unrelated-looking observation: sweeping this same
    // construction from 50 to 2000 um true depth, the UNFIXED code returned
    // a volume of 2.36e-6 m^3 at exactly 400 um against an expected 5.5e-11
    // m^3 (~42,500x), with sane behaviour at the depths either side.
    //
    // Root-caused independently here (not merely reproduced): with the old
    // world-axis-only fallback, this fixture's world-axis wedge thickness
    // cleared the 488.28 um gate for true depths roughly 280-450 um even
    // though the TRUE perpendicular depth was still below it. Admitted at
    // that penetration, the kernel's arrangement returns a genuinely
    // UNCLOSED partial shell for this fixture (6 triangles, `tris=6`, one
    // directed edge in each pair unmatched — instrumented and confirmed
    // directly against `tris.len()` and a directed-edge-pairing check before
    // this fix), not a closed 10-triangle solid. `tri_volume`'s divergence-
    // theorem sum is only meaningful on a closed 2-manifold; on that open
    // shell it returns a number with no geometric relationship to the true
    // volume — the 42,500x outlier. It is NOT `BudgetExhausted` (the
    // arrangement completes) and NOT an artifact of the reviewer's probe: it
    // reproduces deterministically on this exact construction and is a real,
    // if narrow, gap in `tri_volume`'s precondition.
    //
    // Fixing the gate to measure the TRUE contact-normal thickness (this
    // file's other two tests above) withholds every one of these before
    // `tri_volume` ever runs on the bad shell, which is what this sweep
    // checks: no depth in this below-threshold range may return `Solid` at
    // all, let alone a wrong one.
    let corner = [10.0, 10.0, 10.0];
    let big_box = box_mesh([0.0, 0.0, 0.0], [10.0, 10.0, 10.0], 1);
    for depth_um in [50.0f64, 100.0, 200.0, 300.0, 350.0, 380.0, 390.0, 395.0, 400.0, 405.0, 410.0, 420.0, 450.0, 488.0] {
        let true_depth = depth_um * 1.0e-6;
        let t = true_depth * 3.0f64.sqrt();
        let tet = corner_tet(corner, t);
        let ctx = format!("depth={depth_um}um");
        match intersection_solid(&big_box, &tet) {
            IntersectionSolid::Degenerate(DegenerateReason::BelowKernelResolution { .. }) => {}
            other => panic!(
                "{ctx}: every depth here is below the 488.28um trust threshold, \
                 expected BelowKernelResolution, got {other:?}"
            ),
        }
    }
}
