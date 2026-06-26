// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::polygonal::PolygonalFaceSetProcessor;

impl PolygonalFaceSetProcessor {
    /// Triangulate a polygon (optionally with holes) using ear-clipping (earcutr)
    /// This works correctly for both convex and concave polygons
    /// IFC indices are 1-based, so we subtract 1 to get 0-based indices
    /// positions is flattened [x0, y0, z0, x1, y1, z1, ...]
    pub(super) fn triangulate_polygon(
        outer_indices: &[u32],
        inner_indices: &[Vec<u32>],
        positions: &[f32],
        output: &mut Vec<u32>,
    ) {
        if outer_indices.len() < 3 {
            return;
        }

        // Helper to get 3D position from flattened array
        let get_pos = |idx: u32| -> Option<(f32, f32, f32)> {
            if idx == 0 {
                return None;
            }
            let base = ((idx - 1) * 3) as usize;
            if base + 2 < positions.len() {
                Some((positions[base], positions[base + 1], positions[base + 2]))
            } else {
                None
            }
        };

        // Guard: empty outer_indices would panic on any [0] access below
        if outer_indices.is_empty() {
            return;
        }

        // For complex polygons (5+ vertices), use ear-clipping triangulation
        // This handles concave polygons correctly (like opening cutouts)

        // Extract 2D coordinates by projecting to best-fit plane
        // Find dominant normal direction to choose projection plane
        let mut sum_x = 0.0f64;
        let mut sum_y = 0.0f64;
        let mut sum_z = 0.0f64;

        // Calculate centroid-based normal approximation using Newell's method
        for i in 0..outer_indices.len() {
            let v0 = match get_pos(outer_indices[i]) {
                Some(p) => p,
                None => {
                    // Invalid vertex index — skip this polygon entirely.
                    // We cannot safely fan-triangulate with unresolvable vertices.
                    return;
                }
            };
            let v1 = match get_pos(outer_indices[(i + 1) % outer_indices.len()]) {
                Some(p) => p,
                None => {
                    return;
                }
            };

            sum_x += (v0.1 - v1.1) as f64 * (v0.2 + v1.2) as f64;
            sum_y += (v0.2 - v1.2) as f64 * (v0.0 + v1.0) as f64;
            sum_z += (v0.0 - v1.0) as f64 * (v0.1 + v1.1) as f64;
        }
        let expected_normal = (sum_x, sum_y, sum_z);

        let mut push_oriented_triangle = |a: u32, b: u32, c: u32| {
            if a == 0 || b == 0 || c == 0 {
                return;
            }
            let i0 = a - 1;
            let mut i1 = b - 1;
            let mut i2 = c - 1;

            if expected_normal.0.abs() + expected_normal.1.abs() + expected_normal.2.abs() > 1e-12 {
                if let (Some(p0), Some(p1), Some(p2)) = (get_pos(a), get_pos(b), get_pos(c)) {
                    let e1 = (
                        (p1.0 - p0.0) as f64,
                        (p1.1 - p0.1) as f64,
                        (p1.2 - p0.2) as f64,
                    );
                    let e2 = (
                        (p2.0 - p0.0) as f64,
                        (p2.1 - p0.1) as f64,
                        (p2.2 - p0.2) as f64,
                    );
                    let tri_normal = (
                        e1.1 * e2.2 - e1.2 * e2.1,
                        e1.2 * e2.0 - e1.0 * e2.2,
                        e1.0 * e2.1 - e1.1 * e2.0,
                    );
                    let dot = tri_normal.0 * expected_normal.0
                        + tri_normal.1 * expected_normal.1
                        + tri_normal.2 * expected_normal.2;
                    if dot < 0.0 {
                        std::mem::swap(&mut i1, &mut i2);
                    }
                }
            }

            output.push(i0);
            output.push(i1);
            output.push(i2);
        };

        // For triangles, no triangulation needed (but still enforce orientation)
        if inner_indices.is_empty() && outer_indices.len() == 3 {
            push_oriented_triangle(outer_indices[0], outer_indices[1], outer_indices[2]);
            return;
        }

        // For quads, use fan triangulation with orientation correction
        if inner_indices.is_empty() && outer_indices.len() == 4 {
            push_oriented_triangle(outer_indices[0], outer_indices[1], outer_indices[2]);
            push_oriented_triangle(outer_indices[0], outer_indices[2], outer_indices[3]);
            return;
        }

        // Choose projection plane based on dominant axis
        let abs_x = sum_x.abs();
        let abs_y = sum_y.abs();
        let abs_z = sum_z.abs();

        let valid_holes: Vec<&[u32]> = inner_indices
            .iter()
            .filter(|loop_indices| loop_indices.len() >= 3)
            .map(|loop_indices| loop_indices.as_slice())
            .collect();

        // Flatten all loops for earcut (outer ring first, then holes)
        let total_vertices = outer_indices.len()
            + valid_holes
                .iter()
                .map(|loop_indices| loop_indices.len())
                .sum::<usize>();
        let mut coords_2d: Vec<f64> = Vec::with_capacity(total_vertices * 2);
        let mut flattened_indices: Vec<u32> = Vec::with_capacity(total_vertices);
        let mut hole_starts: Vec<usize> = Vec::with_capacity(valid_holes.len());

        for &idx in outer_indices {
            let Some(p) = get_pos(idx) else {
                // Invalid vertex — skip polygon (fan-triangulate would include bad vertices)
                return;
            };
            flattened_indices.push(idx);

            // Project to 2D based on dominant normal axis
            if abs_z >= abs_x && abs_z >= abs_y {
                // XY plane (Z is dominant)
                coords_2d.push(p.0 as f64);
                coords_2d.push(p.1 as f64);
            } else if abs_y >= abs_x {
                // XZ plane (Y is dominant)
                coords_2d.push(p.0 as f64);
                coords_2d.push(p.2 as f64);
            } else {
                // YZ plane (X is dominant)
                coords_2d.push(p.1 as f64);
                coords_2d.push(p.2 as f64);
            }
        }

        for hole in valid_holes {
            hole_starts.push(flattened_indices.len());
            for &idx in hole {
                let Some(p) = get_pos(idx) else {
                    // Invalid hole vertex — skip polygon
                    return;
                };
                flattened_indices.push(idx);

                // Project to 2D based on dominant normal axis
                if abs_z >= abs_x && abs_z >= abs_y {
                    // XY plane (Z is dominant)
                    coords_2d.push(p.0 as f64);
                    coords_2d.push(p.1 as f64);
                } else if abs_y >= abs_x {
                    // XZ plane (Y is dominant)
                    coords_2d.push(p.0 as f64);
                    coords_2d.push(p.2 as f64);
                } else {
                    // YZ plane (X is dominant)
                    coords_2d.push(p.1 as f64);
                    coords_2d.push(p.2 as f64);
                }
            }
        }

        if flattened_indices.len() < 3 {
            return;
        }

        // Run ear-clipping triangulation (guarded — see `triangulation::safe_earcut`)
        match crate::triangulation::safe_earcut(&coords_2d, &hole_starts, 2) {
            Ok(tri_indices) => {
                for tri in tri_indices.chunks(3) {
                    if tri.len() != 3
                        || tri[0] >= flattened_indices.len()
                        || tri[1] >= flattened_indices.len()
                        || tri[2] >= flattened_indices.len()
                    {
                        continue;
                    }
                    push_oriented_triangle(
                        flattened_indices[tri[0]],
                        flattened_indices[tri[1]],
                        flattened_indices[tri[2]],
                    );
                }
            }
            Err(_) => {
                // Fallback to fan triangulation on the outer loop
                let first = outer_indices[0];
                for i in 1..outer_indices.len() - 1 {
                    push_oriented_triangle(first, outer_indices[i], outer_indices[i + 1]);
                }
            }
        }
    }
}
