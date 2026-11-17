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

/// Smallest doubled projected area (the 2D cross product, m²) a triangle may
/// have and still be outlined.
///
/// Positions arrive as f32, whose spacing at the far end of building scale
/// (a few hundred metres from the origin) is about 3e-5 m. A triangle whose
/// cross product is under the square of that spacing is no bigger than one
/// representable step in each direction, so it is rounding residue or a face
/// seen edge-on, not footprint. A real 1 mm feature is a thousand times
/// larger (1e-6), so nothing drawable is near this bound.
const DEGENERATE_AREA: f64 = 1e-9;

/// Smallest height-to-longest-edge ratio a projected triangle may have and
/// still be outlined.
///
/// An absolute area bound cannot catch a long collinear triangle: f32
/// rounding lifts its middle vertex off the line by about 1e-7 of the
/// coordinate magnitude, and multiplied by a ten-metre edge that is far more
/// area than a real millimetre-sized facet has. Shape separates the two. The
/// thinnest triangle a building model legitimately holds is about 1 mm
/// across a 100 m span, a ratio of 1e-5; rounding residue sits near 1e-7.
/// The bound is placed between them, a decade clear of each. Slivers below
/// it add no visible area and are the needles that make the polygon union
/// stall.
const SLIVER_ASPECT: f64 = 1e-6;

/// Maximum number of triangles to feed into the i_overlay union. A mesh with
/// more valid projected triangles is refused with [`NoOutline::OverBudget`]
/// as soon as the projection loop crosses the cap, before the union runs, to
/// bound computation time on pathological geometry.
pub const MAX_OVERLAY_TRIANGLES: usize = 50_000;

/// Why [`mesh_outline_2d`] produced no outline. The two are different
/// answers for the caller: an `Empty` element has no footprint to draw; an
/// `OverBudget` one has a footprint that was not computed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoOutline {
    /// The mesh has no triangles, or every projected triangle is degenerate
    /// (edge-on to the view) and nothing survives the union.
    Empty,
    /// More than [`MAX_OVERLAY_TRIANGLES`] valid projected triangles; the
    /// union was not attempted. `triangles` is the mesh's own triangle count.
    OverBudget { triangles: usize },
}

/// Compute the winding-independent 2D footprint outline of a triangle mesh.
///
/// `positions` is flat XYZ (len = 3·vertexCount); `indices` is flat triangle
/// indices. Returns [`NoOutline`] when there is no outline to return, and
/// which of the two reasons applies.
pub fn mesh_outline_2d(
    positions: &[f32],
    indices: &[u32],
    axis: ProjectionAxis,
    flipped: bool,
) -> Result<MeshOutline, NoOutline> {
    if indices.len() < 3 {
        return Err(NoOutline::Empty);
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

        // A NaN or infinite position (this is a public, JS-fed entry point)
        // made `area` NaN, which fails every `<` filter below, so the triangle
        // was handed to i_overlay, and an infinite one stretched the axis
        // extent. Skip it, like an out-of-range index above (#7678, GEOM-39).
        if ![p0, p1, p2].iter().flatten().all(|c| c.is_finite()) {
            continue;
        }

        for p in [p0, p1, p2] {
            let a = axis_coord(p, axis);
            axis_min = axis_min.min(a);
            axis_max = axis_max.max(a);
        }

        let a0 = project(p0, axis, flipped);
        let a1 = project(p1, axis, flipped);
        let a2 = project(p2, axis, flipped);

        // Twice the signed area in (u, v); skip degenerate, force CCW so
        // i_overlay's NonZero fill unions (mixed winding would cancel
        // triangles instead).
        let area = (a1[0] - a0[0]) * (a2[1] - a0[1]) - (a2[0] - a0[0]) * (a1[1] - a0[1]);
        if area.abs() < DEGENERATE_AREA {
            continue;
        }
        // height / longest = area / longest², kept as a product so a
        // zero-length edge needs no special case.
        let longest_sq = [(a0, a1), (a1, a2), (a2, a0)]
            .iter()
            .map(|(p, q)| (q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2))
            .fold(0.0, f64::max);
        if area.abs() < SLIVER_ASPECT * longest_sq {
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
        // Refuse as soon as the cap is crossed: the union is the unbounded
        // part, and projecting the rest of the mesh first is wasted work.
        if subject.len() + clip.len() > MAX_OVERLAY_TRIANGLES {
            return Err(NoOutline::OverBudget { triangles: indices.len() / 3 });
        }
    }

    if subject.is_empty() {
        return Err(NoOutline::Empty);
    }

    // One triangle is its own outline; i_overlay needs a clip to union.
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
        return Err(NoOutline::Empty);
    }

    Ok(MeshOutline {
        contours,
        axis_min: axis_min as f32,
        axis_max: axis_max as f32,
    })
}

#[cfg(test)]
#[path = "projection_outline_tests.rs"]
mod tests;
