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
            // Checked so a huge 1-based index in malformed input drops the vertex
            // (returns None) instead of overflowing the `(idx - 1) * 3` u32
            // multiply and panicking in debug builds (idx > ~1.43e9). The
            // `checked_add` keeps the bound test safe on wasm32, where usize is
            // 32-bit and `base + 2` could itself overflow.
            let base = (idx - 1).checked_mul(3)? as usize;
            if base.checked_add(2).is_some_and(|b2| b2 < positions.len()) {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A huge 1-based index (idx > ~1.43e9) makes the old `(idx - 1) * 3` u32
    /// multiply overflow and panic in debug builds. The checked multiply must
    /// instead drop the vertex, leaving the polygon untriangulated.
    #[test]
    fn triangulate_polygon_drops_overflowing_index_without_panic() {
        let positions = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let outer = [u32::MAX, u32::MAX, u32::MAX];
        let mut output: Vec<u32> = Vec::new();
        PolygonalFaceSetProcessor::triangulate_polygon(&outer, &[], &positions, &mut output);
        assert!(
            output.is_empty(),
            "polygon with unresolvable (overflowing) indices must be dropped"
        );
    }

    /// Indices straddling the u32 multiply-overflow threshold (idx - 1 >
    /// u32::MAX / 3 ≈ 1431655765): just below overflows nothing (merely out of
    /// bounds), just above trips `checked_mul`. Both must drop the polygon.
    #[test]
    fn triangulate_polygon_drops_indices_around_multiply_threshold() {
        let positions = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        for idx in [1_431_655_766u32, 1_431_655_767, u32::MAX - 1] {
            let outer = [1, 2, idx];
            let mut output: Vec<u32> = Vec::new();
            PolygonalFaceSetProcessor::triangulate_polygon(&outer, &[], &positions, &mut output);
            assert!(output.is_empty(), "idx {idx} must drop the whole polygon");
        }
    }

    /// One bad index out of three drops the WHOLE triangle (the code's stated
    /// intent: never fan-triangulate with unresolvable vertices) — no partial
    /// output, no garbage position read. First out-of-range value is
    /// vertex_count + 1 (1-based).
    #[test]
    fn triangulate_polygon_drops_whole_polygon_on_single_bad_index() {
        let positions = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]; // 3 vertices
        for bad in [0u32, 4, 5, 1_000_000] {
            // 4 = vertex_count + 1, the first out-of-range 1-based index.
            let outer = [1, 2, bad];
            let mut output: Vec<u32> = Vec::new();
            PolygonalFaceSetProcessor::triangulate_polygon(&outer, &[], &positions, &mut output);
            assert!(
                output.is_empty(),
                "triangle with one bad index ({bad}) must be dropped whole"
            );
        }
        // A bad HOLE index must also drop the polygon (5-vertex ear-clip path).
        let positions5 = [
            0.0f32, 0.0, 0.0, 4.0, 0.0, 0.0, 4.0, 4.0, 0.0, 0.0, 4.0, 0.0, 2.0, 2.0, 0.0,
        ];
        let outer = [1u32, 2, 3, 4];
        let holes = vec![vec![5u32, 6, 7]]; // 6, 7 out of range
        let mut output: Vec<u32> = Vec::new();
        PolygonalFaceSetProcessor::triangulate_polygon(&outer, &holes, &positions5, &mut output);
        assert!(output.is_empty(), "polygon with a bad hole index must be dropped");
    }

    /// Valid in-range indices still triangulate exactly as before: the last
    /// valid index (== vertex_count, 1-based) works, and a plain CCW triangle
    /// comes out as [0, 1, 2] with no winding swap.
    #[test]
    fn triangulate_polygon_valid_indices_unchanged() {
        let positions = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]; // 3 vertices
        let outer = [1u32, 2, 3]; // 3 == vertex_count: last valid 1-based index
        let mut output: Vec<u32> = Vec::new();
        PolygonalFaceSetProcessor::triangulate_polygon(&outer, &[], &positions, &mut output);
        assert_eq!(output, vec![0, 1, 2]);

        // Quad fan path.
        let positions4 = [
            0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0,
        ];
        let outer4 = [1u32, 2, 3, 4];
        let mut output4: Vec<u32> = Vec::new();
        PolygonalFaceSetProcessor::triangulate_polygon(&outer4, &[], &positions4, &mut output4);
        assert_eq!(output4, vec![0, 1, 2, 0, 2, 3]);
    }
}
