// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `projection_outline.rs`.

use super::*;

/// Axis-aligned box positions, X[x0,x1] Y[y0,y1] Z[z0,z1]. `flip_winding`
/// reverses every triangle so we can prove winding-independence.
fn box_mesh(
    x0: f32,
    x1: f32,
    y0: f32,
    y1: f32,
    z0: f32,
    z1: f32,
    flip_winding: bool,
) -> (Vec<f32>, Vec<u32>) {
    let positions = vec![
        x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, // z0 face corners 0..3
        x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, // z1 face corners 4..7
    ];
    let mut indices = vec![
        0, 1, 2, 0, 2, 3, // z0
        4, 6, 5, 4, 7, 6, // z1
        0, 4, 5, 0, 5, 1, // y0
        1, 5, 6, 1, 6, 2, // x1
        2, 6, 7, 2, 7, 3, // y1
        3, 7, 4, 3, 4, 0, // x0
    ];
    if flip_winding {
        for tri in indices.chunks_exact_mut(3) {
            tri.swap(1, 2);
        }
    }
    (positions, indices)
}

fn bbox_2d(contours: &[Vec<[f32; 2]>]) -> (f32, f32, f32, f32) {
    let mut minx = f32::INFINITY;
    let mut miny = f32::INFINITY;
    let mut maxx = f32::NEG_INFINITY;
    let mut maxy = f32::NEG_INFINITY;
    for c in contours {
        for p in c {
            minx = minx.min(p[0]);
            miny = miny.min(p[1]);
            maxx = maxx.max(p[0]);
            maxy = maxy.max(p[1]);
        }
    }
    (minx, miny, maxx, maxy)
}

#[test]
fn box_footprint_is_a_rectangle_viewed_down() {
    // View down Y: footprint = X×Z rectangle.
    let (pos, idx) = box_mesh(1.0, 4.0, 0.0, 2.0, -1.0, 1.0, false);
    let out = mesh_outline_2d(&pos, &idx, ProjectionAxis::Y, false).expect("outline");
    // One closed outer ring.
    assert_eq!(out.contours.len(), 1, "expected a single footprint ring");
    let (minx, miny, maxx, maxy) = bbox_2d(&out.contours);
    // axis='y' → 2D (u=x, v=z): u ∈ [1,4], v ∈ [-1,1].
    assert!((minx - 1.0).abs() < 1e-4 && (maxx - 4.0).abs() < 1e-4, "u range {minx}..{maxx}");
    assert!((miny + 1.0).abs() < 1e-4 && (maxy - 1.0).abs() < 1e-4, "v range {miny}..{maxy}");
    assert!((out.axis_min - 0.0).abs() < 1e-4 && (out.axis_max - 2.0).abs() < 1e-4);
}

#[test]
fn outline_is_winding_independent() {
    // Same box, all triangles reversed — must yield the SAME footprint.
    let (pos_a, idx_a) = box_mesh(0.0, 2.0, 0.0, 3.0, 0.0, 2.0, false);
    let (pos_b, idx_b) = box_mesh(0.0, 2.0, 0.0, 3.0, 0.0, 2.0, true);
    let a = mesh_outline_2d(&pos_a, &idx_a, ProjectionAxis::Y, false).expect("a");
    let b = mesh_outline_2d(&pos_b, &idx_b, ProjectionAxis::Y, false).expect("b");
    assert_eq!(bbox_2d(&a.contours), bbox_2d(&b.contours), "footprint must not depend on winding");
    assert!(!b.contours.is_empty(), "flipped winding must still yield a footprint");
}

#[test]
fn flipped_axis_mirrors_u() {
    let (pos, idx) = box_mesh(1.0, 4.0, 0.0, 2.0, -1.0, 1.0, false);
    let unflipped = mesh_outline_2d(&pos, &idx, ProjectionAxis::Y, false).expect("unflipped");
    let flipped = mesh_outline_2d(&pos, &idx, ProjectionAxis::Y, true).expect("flipped");
    let (uminx, _, umaxx, _) = bbox_2d(&unflipped.contours);
    let (fminx, _, fmaxx, _) = bbox_2d(&flipped.contours);
    // Flipping mirrors U: [1,4] → [-4,-1].
    assert!((fminx + umaxx).abs() < 1e-4, "min should mirror max: {fminx} vs {umaxx}");
    assert!((fmaxx + uminx).abs() < 1e-4, "max should mirror min: {fmaxx} vs {uminx}");
}

#[test]
fn two_disjoint_boxes_give_two_contours() {
    let (mut pos, mut idx) = box_mesh(0.0, 1.0, 0.0, 1.0, 0.0, 1.0, false);
    let (pos2, idx2) = box_mesh(5.0, 6.0, 0.0, 1.0, 0.0, 1.0, false);
    let base = (pos.len() / 3) as u32;
    pos.extend_from_slice(&pos2);
    idx.extend(idx2.iter().map(|i| i + base));
    let out = mesh_outline_2d(&pos, &idx, ProjectionAxis::Y, false).expect("outline");
    assert_eq!(out.contours.len(), 2, "two disjoint footprints expected");
}

/// The other five tests in this module all pass `ProjectionAxis::Y`, and
/// the only other in-crate caller (`contour_bool2d_tests`) passes `Z`. So
/// the `X` arm of `project`/`axis_coord` — the plan/section axis used for
/// elevations looking along world X — had no test at all: swapping it to
/// `(p[1], p[2])` left the whole `ifc-lite-geometry` lib suite green.
/// `ProjectionAxis::from_u8`, the WASM-boundary decode
/// (`wasm-bindings/src/api/mesh_outline.rs`), was likewise untested, so
/// exchanging its `0` and `2` arms was invisible too.
///
/// One box with three DISTINCT extents pins all three axes against each
/// other: any axis permutation moves at least one of the ranges below.
#[test]
fn each_projection_axis_picks_its_own_two_drawing_coordinates() {
    // x ∈ [1,4], y ∈ [0,2], z ∈ [-1,2]. Three properties, and the third is
    // the one a symmetric range silently destroys: no two extents are
    // equal; no extent equals ANOTHER's negation; and no extent equals ITS
    // OWN negation. z was [-1,1], which satisfies the first two and fails
    // the third, so the mirror assertion below held at 0 == 0 with
    // flipping deleted entirely.
    let (pos, idx) = box_mesh(1.0, 4.0, 0.0, 2.0, -1.0, 2.0, false);

    // axis = X → (u = z, v = y); the cut axis is x.
    let x = mesh_outline_2d(&pos, &idx, ProjectionAxis::X, false).expect("x outline");
    let (minu, minv, maxu, maxv) = bbox_2d(&x.contours);
    assert!(
        (minu + 1.0).abs() < 1e-4 && (maxu - 2.0).abs() < 1e-4,
        "axis=X u must be the z extent, got {minu}..{maxu}"
    );
    assert!(
        (minv - 0.0).abs() < 1e-4 && (maxv - 2.0).abs() < 1e-4,
        "axis=X v must be the y extent, got {minv}..{maxv}"
    );
    assert!(
        (x.axis_min - 1.0).abs() < 1e-4 && (x.axis_max - 4.0).abs() < 1e-4,
        "axis=X band must be the x extent, got {}..{}",
        x.axis_min,
        x.axis_max
    );

    // axis = Z → (u = x, v = y); the cut axis is z.
    let z = mesh_outline_2d(&pos, &idx, ProjectionAxis::Z, false).expect("z outline");
    let (minu, minv, maxu, maxv) = bbox_2d(&z.contours);
    assert!(
        (minu - 1.0).abs() < 1e-4 && (maxu - 4.0).abs() < 1e-4,
        "axis=Z u must be the x extent, got {minu}..{maxu}"
    );
    assert!(
        (minv - 0.0).abs() < 1e-4 && (maxv - 2.0).abs() < 1e-4,
        "axis=Z v must be the y extent, got {minv}..{maxv}"
    );
    assert!(
        (z.axis_min + 1.0).abs() < 1e-4 && (z.axis_max - 2.0).abs() < 1e-4,
        "axis=Z band must be the z extent, got {}..{}",
        z.axis_min,
        z.axis_max
    );

    // Flipping mirrors U and leaves V alone — `flipped_axis_mirrors_u`
    // above never checks that V survives.
    let xf = mesh_outline_2d(&pos, &idx, ProjectionAxis::X, true).expect("x flipped");
    let (fminu, fminv, fmaxu, fmaxv) = bbox_2d(&xf.contours);
    let (uminu, _, umaxu, _) = bbox_2d(&x.contours);
    assert!(
        (fminu + umaxu).abs() < 1e-4 && (fmaxu + uminu).abs() < 1e-4,
        "flip must mirror u: {fminu}..{fmaxu} vs {uminu}..{umaxu}"
    );
    assert!(
        (fminv - 0.0).abs() < 1e-4 && (fmaxv - 2.0).abs() < 1e-4,
        "flip must leave v alone, got {fminv}..{fmaxv}"
    );
}

/// The 0/1/2 = x/y/z decode crossing the WASM boundary.
#[test]
fn from_u8_decodes_the_wasm_axis_convention() {
    assert_eq!(ProjectionAxis::from_u8(0), Some(ProjectionAxis::X));
    assert_eq!(ProjectionAxis::from_u8(1), Some(ProjectionAxis::Y));
    assert_eq!(ProjectionAxis::from_u8(2), Some(ProjectionAxis::Z));
    assert_eq!(ProjectionAxis::from_u8(3), None);
}

#[test]
fn empty_or_degenerate_is_empty() {
    assert_eq!(
        mesh_outline_2d(&[], &[], ProjectionAxis::Y, false).err(),
        Some(NoOutline::Empty)
    );
    // Single zero-area triangle (all colinear in projection): edge-on strip.
    let pos = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0];
    let idx = vec![0, 1, 2];
    assert_eq!(
        mesh_outline_2d(&pos, &idx, ProjectionAxis::Y, false).err(),
        Some(NoOutline::Empty)
    );
}

/// The budget refusal used to be `None`, the same answer as "no footprint",
/// and the wasm boundary forwarded both as `undefined`. A mesh one triangle
/// past the cap has a footprint (a unit square, every triangle valid); the
/// caller is told the outline was not computed, not that there is none.
/// Mutation: return `Err(NoOutline::Empty)` at the cap, or drop the cap.
#[test]
fn over_budget_is_reported_as_over_budget_not_as_empty() {
    // MAX + 1 copies of one CCW unit triangle (four shared vertices).
    let pos = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0, 1.0];
    let n = MAX_OVERLAY_TRIANGLES + 1;
    let mut idx = Vec::with_capacity(n * 3);
    for i in 0..n {
        idx.extend_from_slice(if i % 2 == 0 { &[0, 1, 2] } else { &[0, 2, 3] });
    }
    assert_eq!(
        mesh_outline_2d(&pos, &idx, ProjectionAxis::Y, false).err(),
        Some(NoOutline::OverBudget { triangles: n })
    );
    // Exactly at the cap it is computed: the union of the two triangles is
    // the unit square.
    let at_cap = &idx[..MAX_OVERLAY_TRIANGLES * 3];
    let out = mesh_outline_2d(&pos, at_cap, ProjectionAxis::Y, false).expect("at cap");
    assert_eq!(bbox_2d(&out.contours), (0.0, 0.0, 1.0, 1.0));
}
