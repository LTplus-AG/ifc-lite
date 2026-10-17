// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::polygonal::PolygonalFaceSetProcessor;

impl PolygonalFaceSetProcessor {
    /// Triangulate a polygon (optionally with holes) using ear-clipping (earcutr)
    /// This works correctly for both convex and concave polygons
    /// IFC indices are 1-based, so we subtract 1 to get 0-based indices
    /// positions is flattened [x0, y0, z0, x1, y1, z1, ...]
    ///
    /// A face with a corner that does not resolve to a position (`0`, past the
    /// end of the point list) is dropped whole and counted under `face_type`
    /// (D3); so is a holed face whose triangulation fails.
    pub(super) fn triangulate_polygon(
        face_type: &ifc_lite_core::IfcType,
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
        // A dangling corner drops the whole face (a fan would include bad
        // vertices); it used to vanish silently, now it is counted (D3).
        if outer_indices.iter().chain(inner_indices.iter().flatten()).any(|&i| get_pos(i).is_none()) {
            super::super::advanced_face::note_face_refused(face_type);
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
            // Every corner resolved above; this `else` is unreachable.
            let (Some(v0), Some(v1)) =
                (get_pos(outer_indices[i]), get_pos(outer_indices[(i + 1) % outer_indices.len()]))
            else {
                return;
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

        // Everything past a triangle goes through the ONE planar-face home
        // (`triangulation::quad_split_3d` / `triangulate_planar_face`, shared with
        // faceted breps, surface models and planar advanced faces), so the
        // concave-quad and hole-failure rules cannot drift from it again (#7795).
        // Positions are widened to f64 first, as the Newell sum above already is.
        let widen = |idx: u32| -> Option<nalgebra::Point3<f64>> {
            get_pos(idx).map(|p| nalgebra::Point3::new(p.0 as f64, p.1 as f64, p.2 as f64))
        };
        let valid_holes: Vec<&[u32]> = inner_indices
            .iter()
            .filter(|loop_indices| loop_indices.len() >= 3)
            .map(|loop_indices| loop_indices.as_slice())
            .collect();

        let mut flattened_indices: Vec<u32> = Vec::with_capacity(
            outer_indices.len() + valid_holes.iter().map(|h| h.len()).sum::<usize>(),
        );
        let mut outer_points = Vec::with_capacity(outer_indices.len());
        for &idx in outer_indices {
            let Some(p) = widen(idx) else { return };
            flattened_indices.push(idx);
            outer_points.push(p);
        }
        let mut hole_points: Vec<Vec<nalgebra::Point3<f64>>> = Vec::with_capacity(valid_holes.len());
        for hole in &valid_holes {
            let mut ring = Vec::with_capacity(hole.len());
            for &idx in *hole {
                let Some(p) = widen(idx) else { return };
                flattened_indices.push(idx);
                ring.push(p);
            }
            hole_points.push(ring);
        }

        // A hole-free quad takes the diagonal that lies INSIDE the ring; the
        // fixed `0-2` fan covered the convex hull twice for a reflex vertex
        // 1 or 3 (#7795, GEOM-3 / PROC-S10).
        if hole_points.is_empty() && outer_points.len() == 4 {
            for tri in crate::triangulation::quad_split_3d(&outer_points).chunks_exact(3) {
                push_oriented_triangle(
                    flattened_indices[tri[0] as usize],
                    flattened_indices[tri[1] as usize],
                    flattened_indices[tri[2] as usize],
                );
            }
            return;
        }

        match crate::triangulation::triangulate_planar_face(&outer_points, &hole_points) {
            Ok(tri_indices) => {
                for tri in tri_indices.chunks_exact(3) {
                    let [a, b, c] = [tri[0], tri[1], tri[2]].map(|i| flattened_indices.get(i as usize));
                    if let (Some(&a), Some(&b), Some(&c)) = (a, b, c) {
                        push_oriented_triangle(a, b, c);
                    }
                }
            }
            // `triangulate_planar_face` only fails with holes (D3): the face is
            // refused and counted. It used to fan the outer loop, rendering the
            // face filled over its authored openings (#7795, PROC-S5).
            Err(_) => {
                super::super::advanced_face::note_face_refused(face_type);
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
        PolygonalFaceSetProcessor::triangulate_polygon(&ifc_lite_core::IfcType::IfcIndexedPolygonalFace, &outer, &[], &positions, &mut output);
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
            PolygonalFaceSetProcessor::triangulate_polygon(&ifc_lite_core::IfcType::IfcIndexedPolygonalFace, &outer, &[], &positions, &mut output);
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
            PolygonalFaceSetProcessor::triangulate_polygon(&ifc_lite_core::IfcType::IfcIndexedPolygonalFace, &outer, &[], &positions, &mut output);
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
        PolygonalFaceSetProcessor::triangulate_polygon(&ifc_lite_core::IfcType::IfcIndexedPolygonalFace, &outer, &holes, &positions5, &mut output);
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
        PolygonalFaceSetProcessor::triangulate_polygon(&ifc_lite_core::IfcType::IfcIndexedPolygonalFace, &outer, &[], &positions, &mut output);
        assert_eq!(output, vec![0, 1, 2]);

        // Quad fan path.
        let positions4 = [
            0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0,
        ];
        let outer4 = [1u32, 2, 3, 4];
        let mut output4: Vec<u32> = Vec::new();
        PolygonalFaceSetProcessor::triangulate_polygon(&ifc_lite_core::IfcType::IfcIndexedPolygonalFace, &outer4, &[], &positions4, &mut output4);
        assert_eq!(output4, vec![0, 1, 2, 0, 2, 3]);
    }
}
