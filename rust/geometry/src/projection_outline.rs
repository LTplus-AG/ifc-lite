/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Winding-independent 2D footprint outline of a mesh, for construction
//! projection on 2D floor plans (issue #979).
//!
//! Normal-based silhouette extraction (the TypeScript `EdgeExtractor`
//! fallback) needs consistent triangle winding to tell front faces from back
//! faces — but ifc-lite meshes are rendered double-sided precisely because
//! their winding is *not* reliable, so a globally-flipped roof or stair can
//! lose its silhouette entirely.
//!
//! This module is robust to winding because it works on triangle **areas**,
//! not normals: every triangle is projected onto the section plane, each
//! projected triangle is forced counter-clockwise, and the whole set is
//! unioned with `i_overlay` (the same 2D boolean engine the CSG/void paths
//! use). The boundary of that union is the true projected footprint outline
//! regardless of the source winding.
//!
//! The 2D projection matches `projectTo2D` in `@ifc-lite/drawing-2d` exactly
//! (`getProjectionAxes` + the flipped-U mirror), so the returned contours land
//! in the same drawing space as the section-cut polygons.

use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::single::SingleFloatOverlay;

/// Section axis perpendicular to the cut plane (geometric, WebGL Y-up).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProjectionAxis {
    X,
    Y,
    Z,
}

impl ProjectionAxis {
    /// Decode the 0/1/2 = x/y/z convention used across the WASM boundary.
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(ProjectionAxis::X),
            1 => Some(ProjectionAxis::Y),
            2 => Some(ProjectionAxis::Z),
            _ => None,
        }
    }
}

/// One element's projected footprint outline.
#[derive(Clone, Debug, Default)]
pub struct MeshOutline {
    /// Boundary rings (outer + holes) in drawing 2D space. Each ring is a
    /// closed loop given WITHOUT a duplicated closing vertex; consumers should
    /// connect the last point back to the first.
    pub contours: Vec<Vec<[f32; 2]>>,
    /// Element extent along the cut axis (world units, NOT flip-adjusted), so
    /// the caller can classify the outline into the visible/overhead band.
    pub axis_min: f32,
    pub axis_max: f32,
}

/// Project a world point to drawing 2D, matching `projectTo2D`:
///   x → (u=z, v=y),  y → (u=x, v=z),  z → (u=x, v=y);  u mirrored if flipped.
#[inline]
fn project(p: [f64; 3], axis: ProjectionAxis, flipped: bool) -> [f64; 2] {
    let (u, v) = match axis {
        ProjectionAxis::X => (p[2], p[1]),
        ProjectionAxis::Y => (p[0], p[2]),
        ProjectionAxis::Z => (p[0], p[1]),
    };
    [if flipped { -u } else { u }, v]
}

#[inline]
fn axis_coord(p: [f64; 3], axis: ProjectionAxis) -> f64 {
    match axis {
        ProjectionAxis::X => p[0],
        ProjectionAxis::Y => p[1],
        ProjectionAxis::Z => p[2],
    }
}

/// Area below which a projected triangle is treated as degenerate (edge-on to
/// the view) and skipped. In drawing metres² — generous enough to drop f32
/// slivers, small enough to keep real footprints.
const DEGENERATE_AREA: f64 = 1.0e-12;

/// Compute the winding-independent 2D footprint outline of a triangle mesh.
///
/// `positions` is flat XYZ (len = 3·vertexCount); `indices` is flat triangle
/// indices. Returns `None` when the mesh has no triangles or the projection
/// collapses to nothing (e.g. a mesh entirely edge-on to the view).
pub fn mesh_outline_2d(
    positions: &[f32],
    indices: &[u32],
    axis: ProjectionAxis,
    flipped: bool,
) -> Option<MeshOutline> {
    if indices.len() < 3 {
        return None;
    }
    let vertex_count = positions.len() / 3;

    let mut subject: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut clip: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut axis_min = f64::INFINITY;
    let mut axis_max = f64::NEG_INFINITY;

    for tri in indices.chunks_exact(3) {
        let (i0, i1, i2) = (tri[0] as usize, tri[1] as usize, tri[2] as usize);
        if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
            continue;
        }
        let p0 = [
            positions[i0 * 3] as f64,
            positions[i0 * 3 + 1] as f64,
            positions[i0 * 3 + 2] as f64,
        ];
        let p1 = [
            positions[i1 * 3] as f64,
            positions[i1 * 3 + 1] as f64,
            positions[i1 * 3 + 2] as f64,
        ];
        let p2 = [
            positions[i2 * 3] as f64,
            positions[i2 * 3 + 1] as f64,
            positions[i2 * 3 + 2] as f64,
        ];

        for p in [p0, p1, p2] {
            let a = axis_coord(p, axis);
            axis_min = axis_min.min(a);
            axis_max = axis_max.max(a);
        }

        let a0 = project(p0, axis, flipped);
        let a1 = project(p1, axis, flipped);
        let a2 = project(p2, axis, flipped);

        // Signed area in (u, v); skip degenerate, force CCW so i_overlay's
        // NonZero fill unions (mixed winding would cancel triangles instead).
        let area = (a1[0] - a0[0]) * (a2[1] - a0[1]) - (a2[0] - a0[0]) * (a1[1] - a0[1]);
        if area.abs() < DEGENERATE_AREA {
            continue;
        }
        let path: Vec<[f64; 2]> = if area >= 0.0 {
            vec![a0, a1, a2]
        } else {
            vec![a0, a2, a1]
        };

        if subject.is_empty() {
            subject.push(path);
        } else {
            clip.push(path);
        }
    }

    if subject.is_empty() {
        return None;
    }

    // Single triangle → its own outline (skip the union round-trip).
    let shapes: Vec<Vec<Vec<[f64; 2]>>> = if clip.is_empty() {
        vec![subject.clone()]
    } else {
        subject.overlay(&clip, OverlayRule::Union, FillRule::NonZero)
    };

    let mut contours: Vec<Vec<[f32; 2]>> = Vec::new();
    for shape in shapes {
        for ring in shape {
            if ring.len() >= 3 {
                contours.push(ring.iter().map(|pt| [pt[0] as f32, pt[1] as f32]).collect());
            }
        }
    }

    if contours.is_empty() {
        return None;
    }

    Some(MeshOutline {
        contours,
        axis_min: axis_min as f32,
        axis_max: axis_max as f32,
    })
}

#[cfg(test)]
mod tests {
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

    #[test]
    fn empty_or_degenerate_returns_none() {
        assert!(mesh_outline_2d(&[], &[], ProjectionAxis::Y, false).is_none());
        // Single zero-area triangle (all colinear in projection): edge-on strip.
        let pos = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0];
        let idx = vec![0, 1, 2];
        assert!(mesh_outline_2d(&pos, &idx, ProjectionAxis::Y, false).is_none());
    }
}
