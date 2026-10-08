/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Small public boundary around the in-tree exact-predicate CDT.
//!
//! Format adapters provide an already validated planar straight-line graph;
//! this module deliberately does not assign domain semantics or invent a
//! fallback. Keeping that policy outside the geometry crate avoids coupling
//! the IFC kernel to LandXML (or another source format).

use crate::geom2d::{on_segment, orientation, segments_intersect};
use crate::Point2;
use rustc_hash::FxHashSet;

/// Failure to build a constrained terrain mesh.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerrainCdtError {
    /// Points or segments cannot describe a finite non-degenerate PSLG.
    InvalidInput,
    /// Distinct constraint segments intersect or overlap in the plane.
    IntersectingConstraints,
    /// The exact CDT could not recover every requested constraint.
    ConstraintsUnrecoverable,
    WorkLimitExceeded,
    Cancelled,
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
/// No unconstrained or ear-clipping fallback is used. Exact duplicate points
/// and bad segment indices are rejected before entering the CDT. All-collinear
/// input is detected by the CDT and reported as `ConstraintsUnrecoverable`.
pub fn triangulate_terrain_pslg(
    points: &[[f64; 2]],
    segments: &[(usize, usize)],
) -> Result<TerrainCdtMesh, TerrainCdtError> {
    triangulate_terrain_pslg_with_progress(points, segments, &mut || Ok(()))
}

/// Triangulate while checking a caller-supplied cancellation/work callback in
/// source validation, exact CDT construction/recovery, and output emission.
pub fn triangulate_terrain_pslg_with_progress(
    points: &[[f64; 2]],
    segments: &[(usize, usize)],
    progress: &mut dyn FnMut() -> Result<(), TerrainCdtError>,
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
    let mut seen = FxHashSet::default();
    for point in points {
        progress()?;
        let key = (if point[0] == 0.0 { 0 } else { point[0].to_bits() }, if point[1] == 0.0 { 0 } else { point[1].to_bits() });
        if !seen.insert(key) {
            return Err(TerrainCdtError::InvalidInput);
        }
    }
    // Validate the producer's graph before the collinear-vertex split.  Doing
    // this afterwards silently normalises repeated/overlapping source edges
    // into a harmless-looking deduplicated edge set.
    validate_original_segments(points, segments, progress)?;
    let segments = split_segments_at_vertices(points, segments, progress)?;
    let mut source = Vec::with_capacity(points.len());
    for point in points {
        progress()?;
        source.push(Point2::new(point[0], point[1]));
    }
    let Some((output, indices)) = crate::cdt::triangulate_pslg_with_progress(&source, &segments, progress)? else {
        return Err(TerrainCdtError::ConstraintsUnrecoverable);
    };
    let mut output_points = Vec::with_capacity(output.len());
    for point in output {
        progress()?;
        output_points.push([point.x, point.y]);
    }
    Ok(TerrainCdtMesh { points: output_points, indices })
}

fn validate_original_segments(
    points: &[[f64; 2]],
    segments: &[(usize, usize)],
    progress: &mut dyn FnMut() -> Result<(), TerrainCdtError>,
) -> Result<(), TerrainCdtError> {
    for (left, &(a, b)) in segments.iter().enumerate() {
        for &(c, d) in &segments[..left] {
            progress()?;
            if !segments_intersect(points[a], points[b], points[c], points[d]) {
                continue;
            }
            // A common authored vertex, or a single endpoint landing on a
            // different segment, is a legitimate PSLG junction: the latter
            // is split below.  All other contacts (proper crossings,
            // repeated edges, and collinear overlap) are ambiguous source
            // constraints.
            let shared = [a, b]
                .into_iter()
                .filter(|vertex| *vertex == c || *vertex == d)
                .count();
            if shared == 0 {
                let endpoint_contacts = [a, b]
                    .into_iter()
                    .filter(|vertex| on_segment(points[c], points[d], points[*vertex]))
                    .count()
                    + [c, d]
                        .into_iter()
                        .filter(|vertex| on_segment(points[a], points[b], points[*vertex]))
                        .count();
                if endpoint_contacts == 1 {
                    continue;
                }
                return Err(TerrainCdtError::IntersectingConstraints);
            }
            if shared != 1 {
                return Err(TerrainCdtError::IntersectingConstraints);
            }
            let shared_vertex = [a, b]
                .into_iter()
                .find(|vertex| *vertex == c || *vertex == d)
                .expect("one shared vertex checked above");
            let ab_other = if a == shared_vertex { b } else { a };
            let cd_other = if c == shared_vertex { d } else { c };
            if on_segment(points[a], points[b], points[cd_other])
                || on_segment(points[c], points[d], points[ab_other])
            {
                return Err(TerrainCdtError::IntersectingConstraints);
            }
        }
    }
    Ok(())
}

fn split_segments_at_vertices(
    points: &[[f64; 2]],
    segments: &[(usize, usize)],
    progress: &mut dyn FnMut() -> Result<(), TerrainCdtError>,
) -> Result<Vec<(usize, usize)>, TerrainCdtError> {
    let mut split = Vec::new();
    for &(a, b) in segments {
        let mut vertices = vec![a, b];
        for (index, &point) in points.iter().enumerate() {
            progress()?;
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
    Ok(split)
}

#[cfg(test)]
#[path = "terrain_cdt_tests.rs"]
mod terrain_cdt_tests;
