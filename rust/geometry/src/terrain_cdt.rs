/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Small public boundary around the in-tree exact-predicate CDT.
//!
//! Format adapters provide an already validated planar straight-line graph;
//! this module deliberately does not assign domain semantics or invent a
//! fallback. Keeping that policy outside the geometry crate avoids coupling
//! the IFC kernel to LandXML (or another source format).

use crate::Point2;

/// Failure to build a constrained terrain mesh.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerrainCdtError {
    /// Points or segments cannot describe a finite non-degenerate PSLG.
    InvalidInput,
    /// Distinct constraint segments intersect or overlap in the plane.
    IntersectingConstraints,
    /// The exact CDT could not recover every requested constraint.
    ConstraintsUnrecoverable,
}

/// A deterministic, f64 constrained triangulation. Indices address `points`.
#[derive(Clone, Debug, PartialEq)]
pub struct TerrainCdtMesh {
    pub points: Vec<[f64; 2]>,
    pub indices: Vec<usize>,
}

/// Triangulate a non-crossing PSLG through the repository's exact-predicate
/// CDT. The output covers the convex hull; callers own closed-region/hole
/// selection because an open breakline has no fill-side meaning.
///
/// No unconstrained or ear-clipping fallback is used. Exact duplicate points,
/// bad segment indices, and all-collinear input are rejected before entering
/// the CDT so adapters can return stable source-specific diagnostics.
pub fn triangulate_terrain_pslg(
    points: &[[f64; 2]],
    segments: &[(usize, usize)],
) -> Result<TerrainCdtMesh, TerrainCdtError> {
    if points.len() < 3
        || points
            .iter()
            .any(|point| !point[0].is_finite() || !point[1].is_finite())
        || segments
            .iter()
            .any(|&(a, b)| a == b || a >= points.len() || b >= points.len())
    {
        return Err(TerrainCdtError::InvalidInput);
    }
    for (index, point) in points.iter().enumerate() {
        if points[..index].contains(point) {
            return Err(TerrainCdtError::InvalidInput);
        }
    }
    let segments = split_segments_at_vertices(points, segments);
    for (left, &(a, b)) in segments.iter().enumerate() {
        for &(c, d) in &segments[..left] {
            if a != c
                && a != d
                && b != c
                && b != d
                && segments_intersect(points[a], points[b], points[c], points[d])
            {
                return Err(TerrainCdtError::IntersectingConstraints);
            }
        }
    }
    let source: Vec<Point2<f64>> = points
        .iter()
        .map(|point| Point2::new(point[0], point[1]))
        .collect();
    let Some((output, indices)) = crate::cdt::triangulate_pslg(&source, &segments) else {
        return Err(TerrainCdtError::ConstraintsUnrecoverable);
    };
    Ok(TerrainCdtMesh {
        points: output.into_iter().map(|point| [point.x, point.y]).collect(),
        indices,
    })
}

fn split_segments_at_vertices(
    points: &[[f64; 2]],
    segments: &[(usize, usize)],
) -> Vec<(usize, usize)> {
    let mut split = Vec::new();
    for &(a, b) in segments {
        let mut vertices = vec![a, b];
        for (index, &point) in points.iter().enumerate() {
            if index != a
                && index != b
                && orientation(points[a], points[b], point) == 0
                && on_segment(points[a], points[b], point)
            {
                vertices.push(index);
            }
        }
        vertices.sort_by(|left, right| {
            let left_dx = points[*left][0] - points[a][0];
            let left_dy = points[*left][1] - points[a][1];
            let right_dx = points[*right][0] - points[a][0];
            let right_dy = points[*right][1] - points[a][1];
            (left_dx * left_dx + left_dy * left_dy)
                .total_cmp(&(right_dx * right_dx + right_dy * right_dy))
        });
        split.extend(vertices.windows(2).map(|pair| (pair[0], pair[1])));
    }
    split.sort_unstable();
    split.dedup();
    split
}

fn orientation(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> i32 {
    let value = geometry_predicates::orient2d(a, b, c);
    if value > 0.0 {
        1
    } else if value < 0.0 {
        -1
    } else {
        0
    }
}

fn on_segment(a: [f64; 2], b: [f64; 2], point: [f64; 2]) -> bool {
    (a[0] <= point[0] && point[0] <= b[0] || b[0] <= point[0] && point[0] <= a[0])
        && (a[1] <= point[1] && point[1] <= b[1] || b[1] <= point[1] && point[1] <= a[1])
}

fn segments_intersect(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    let ab_c = orientation(a, b, c);
    let ab_d = orientation(a, b, d);
    let cd_a = orientation(c, d, a);
    let cd_b = orientation(c, d, b);
    (ab_c != ab_d && ab_c != 0 && ab_d != 0 && cd_a != cd_b && cd_a != 0 && cd_b != 0)
        || ab_c == 0 && on_segment(a, b, c)
        || ab_d == 0 && on_segment(a, b, d)
        || cd_a == 0 && on_segment(c, d, a)
        || cd_b == 0 && on_segment(c, d, b)
}
