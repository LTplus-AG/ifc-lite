// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Legacy SAT + Sutherland-Hodgman AABB box clip (issue #635 fallback only).

use super::GeometryRouter;
use crate::csg::{tri_is_needle, ClippingProcessor, Plane, Triangle, TriangleVec};
use crate::{Mesh, Point3, Vector3};


/// Reusable buffers for triangle clipping operations
///
/// This struct eliminates per-triangle allocations in clip_triangle_against_box
/// by reusing Vec buffers across multiple clipping operations.
struct ClipBuffers {
    /// Triangles to output (outside the box)
    result: TriangleVec,
    /// Triangles remaining to be processed
    remaining: TriangleVec,
    /// Next iteration's remaining triangles (swap buffer)
    next_remaining: TriangleVec,
}

impl ClipBuffers {
    /// Create new empty buffers
    fn new() -> Self {
        Self {
            result: TriangleVec::new(),
            remaining: TriangleVec::new(),
            next_remaining: TriangleVec::new(),
        }
    }

    /// Clear all buffers for reuse
    #[inline]
    fn clear(&mut self) {
        self.result.clear();
        self.remaining.clear();
        self.next_remaining.clear();
    }
}

impl GeometryRouter {

    /// Cut a rectangular opening from a mesh using AABB clipping — the LEGACY
    /// Sutherland-Hodgman box clip, now retained ONLY as the issue-#635
    /// no-op fallback (a genuinely round/curved opening, or a grazing/coplanar
    /// engulfing cutter, that the exact kernel returns un-cut). The PRIMARY path
    /// for every opening — axis-aligned rectangular included — is the exact mesh
    /// subtract in `apply_void_context` (PART B); this clip is no longer on it.
    pub(in crate::router) fn cut_rectangular_opening(
        &self,
        mesh: &Mesh,
        open_min: Point3<f64>,
        open_max: Point3<f64>,
    ) -> Mesh {
        self.cut_rectangular_opening_no_faces(mesh, open_min, open_max)
    }

    /// Cut a rectangular opening using AABB clipping WITHOUT generating internal faces.
    /// Used for diagonal openings where internal face generation causes rotation artifacts.
    pub(super) fn cut_rectangular_opening_no_faces(
        &self,
        mesh: &Mesh,
        open_min: Point3<f64>,
        open_max: Point3<f64>,
    ) -> Mesh {
        use nalgebra::Vector3;

        const EPSILON: f64 = 1e-6;

        let mut result = Mesh::with_capacity(mesh.positions.len() / 3, mesh.indices.len() / 3);

        let mut clip_buffers = ClipBuffers::new();

        let num_vertices = mesh.positions.len() / 3;
        for chunk in mesh.indices.chunks_exact(3) {
            let i0 = chunk[0] as usize;
            let i1 = chunk[1] as usize;
            let i2 = chunk[2] as usize;

            // Bounds check: skip triangles with out-of-range vertex indices
            if i0 >= num_vertices || i1 >= num_vertices || i2 >= num_vertices {
                continue;
            }

            let v0 = Point3::new(
                mesh.positions[i0 * 3] as f64,
                mesh.positions[i0 * 3 + 1] as f64,
                mesh.positions[i0 * 3 + 2] as f64,
            );
            let v1 = Point3::new(
                mesh.positions[i1 * 3] as f64,
                mesh.positions[i1 * 3 + 1] as f64,
                mesh.positions[i1 * 3 + 2] as f64,
            );
            let v2 = Point3::new(
                mesh.positions[i2 * 3] as f64,
                mesh.positions[i2 * 3 + 1] as f64,
                mesh.positions[i2 * 3 + 2] as f64,
            );

            let n0 = if mesh.normals.len() >= mesh.positions.len() {
                Vector3::new(
                    mesh.normals[i0 * 3] as f64,
                    mesh.normals[i0 * 3 + 1] as f64,
                    mesh.normals[i0 * 3 + 2] as f64,
                )
            } else {
                let edge1 = v1 - v0;
                let edge2 = v2 - v0;
                edge1
                    .cross(&edge2)
                    .try_normalize(1e-10)
                    .unwrap_or(Vector3::new(0.0, 0.0, 1.0))
            };

            let tri_min_x = v0.x.min(v1.x).min(v2.x);
            let tri_max_x = v0.x.max(v1.x).max(v2.x);
            let tri_min_y = v0.y.min(v1.y).min(v2.y);
            let tri_max_y = v0.y.max(v1.y).max(v2.y);
            let tri_min_z = v0.z.min(v1.z).min(v2.z);
            let tri_max_z = v0.z.max(v1.z).max(v2.z);

            // Per-axis "completely outside" slack, scaled by the box-plane
            // coordinate magnitude. The host mesh is stored f32 and promoted to
            // f64 here, while the opening box bounds are pure f64; at
            // building-scale world coordinates (tens of metres) the f32 quantum
            // (|coord| * 2^-23 ≈ 1.2e-7 * |coord|, ~4e-6 m at 33 m) exceeds a
            // fixed 1e-6 m EPSILON. A wall face authored exactly flush with the
            // opening's near plane (door extruded from the back surface —
            // ISSUE_126 #77438 / #83694) then rounds ~1.4e-6 m *outside* the
            // box, so a fixed-epsilon test mis-classifies it as "completely
            // outside", the back face survives un-cut, and the opening is sealed
            // (non-manifold). Track the f32 round-trip error per axis.
            let eps_x = EPSILON.max(open_min.x.abs().max(open_max.x.abs()) * 1e-6);
            let eps_y = EPSILON.max(open_min.y.abs().max(open_max.y.abs()) * 1e-6);
            let eps_z = EPSILON.max(open_min.z.abs().max(open_max.z.abs()) * 1e-6);

            // If triangle is completely outside opening, keep it as-is
            if tri_max_x <= open_min.x - eps_x
                || tri_min_x >= open_max.x + eps_x
                || tri_max_y <= open_min.y - eps_y
                || tri_min_y >= open_max.y + eps_y
                || tri_max_z <= open_min.z - eps_z
                || tri_min_z >= open_max.z + eps_z
            {
                let base = result.vertex_count() as u32;
                result.add_vertex(v0, n0);
                result.add_vertex(v1, n0);
                result.add_vertex(v2, n0);
                result.add_triangle(base, base + 1, base + 2);
                continue;
            }

            // Check if triangle is completely inside opening (remove it)
            if tri_min_x >= open_min.x + EPSILON
                && tri_max_x <= open_max.x - EPSILON
                && tri_min_y >= open_min.y + EPSILON
                && tri_max_y <= open_max.y - EPSILON
                && tri_min_z >= open_min.z + EPSILON
                && tri_max_z <= open_max.z - EPSILON
            {
                continue;
            }

            // Triangle may intersect opening - clip it
            if self.triangle_intersects_box(&v0, &v1, &v2, &open_min, &open_max) {
                self.clip_triangle_against_box(
                    &mut result,
                    &mut clip_buffers,
                    &v0,
                    &v1,
                    &v2,
                    &n0,
                    &open_min,
                    &open_max,
                );
            } else {
                let base = result.vertex_count() as u32;
                result.add_vertex(v0, n0);
                result.add_vertex(v1, n0);
                result.add_vertex(v2, n0);
                result.add_triangle(base, base + 1, base + 2);
            }
        }

        // Caller accepts the open rim (degraded #635 mode; reveal generation
        // was deleted with the legacy path).
        result
    }

    /// Test if a triangle intersects an axis-aligned bounding box using Separating Axis Theorem (SAT)
    /// Returns true if triangle and box intersect, false if they are separated.
    ///
    /// All separation tests use a small `SAT_EPSILON` slack so that a triangle
    /// **lying exactly on a box face** (e.g. an extruded wall's outer face
    /// that is coplanar with the opening AABB's `max.x` face after the opening
    /// has been extended through the wall thickness) is reported as
    /// intersecting and gets routed into the actual clipping path. Without
    /// this slack, FP rounding can produce a tiny gap (the wall mesh is
    /// stored in f32 and re-promoted to f64 here, while the opening box is
    /// computed in pure f64) that the strict `<` reads as a separation — and
    /// the wall's outer face survives un-clipped, leaving the wall solid
    /// around its opening (issue #584 / Smiley-West balconies, follow-up:
    /// the per-axis 1e-6 epsilon was correct for the box-axis tests but
    /// undersized for the triangle-plane test, which uses an un-normalized
    /// `triangle_normal` whose magnitude scales with triangle area).
    fn triangle_intersects_box(
        &self,
        v0: &Point3<f64>,
        v1: &Point3<f64>,
        v2: &Point3<f64>,
        box_min: &Point3<f64>,
        box_max: &Point3<f64>,
    ) -> bool {
        use nalgebra::Vector3;

        /// Float slack for SAT separation tests (1 micrometre at the IFC's
        /// length unit). Big enough to absorb double-precision rounding
        /// (`v.z - box_center.z` vs `(box_max.z - box_min.z) * 0.5`) on
        /// box-coplanar triangles, small enough to not pull genuinely
        /// separated triangles into the clipper.
        const SAT_EPSILON: f64 = 1e-6;

        // Box center and half-extents
        let box_center = Point3::new(
            (box_min.x + box_max.x) * 0.5,
            (box_min.y + box_max.y) * 0.5,
            (box_min.z + box_max.z) * 0.5,
        );
        let box_half_extents = Vector3::new(
            (box_max.x - box_min.x) * 0.5,
            (box_max.y - box_min.y) * 0.5,
            (box_max.z - box_min.z) * 0.5,
        );

        // Translate triangle to box-local space
        let t0 = v0 - box_center;
        let t1 = v1 - box_center;
        let t2 = v2 - box_center;

        // Triangle edges
        let e0 = t1 - t0;
        let e1 = t2 - t1;
        let e2 = t0 - t2;

        // Test 1: Box axes (X, Y, Z)
        // Project triangle onto each axis and check overlap
        for axis_idx in 0..3 {
            let axis = match axis_idx {
                0 => Vector3::new(1.0, 0.0, 0.0),
                1 => Vector3::new(0.0, 1.0, 0.0),
                2 => Vector3::new(0.0, 0.0, 1.0),
                _ => unreachable!(),
            };

            let p0 = t0.dot(&axis);
            let p1 = t1.dot(&axis);
            let p2 = t2.dot(&axis);

            let tri_min = p0.min(p1).min(p2);
            let tri_max = p0.max(p1).max(p2);
            let box_extent = box_half_extents[axis_idx];

            // Scale the separation slack by the world-coordinate magnitude on
            // this axis so it absorbs the f32 round-trip slop of the host mesh
            // (stored f32, promoted to f64 here) at building-scale coordinates;
            // a fixed 1e-6 m is below the f32 quantum at tens of metres, so a
            // triangle exactly coplanar with the box face (ISSUE_126 #77438 back
            // face, flush with the door opening's near plane) reads as separated
            // and survives the cut un-clipped.
            let axis_eps =
                SAT_EPSILON.max(box_center[axis_idx].abs().max(box_extent.abs()) * 1e-6);
            if tri_max < -box_extent - axis_eps || tri_min > box_extent + axis_eps {
                return false; // Separated on this axis
            }
        }

        // Test 2: Triangle face normal
        let triangle_normal = e0.cross(&e2);
        let triangle_offset = t0.dot(&triangle_normal);

        // Project box onto triangle normal
        let mut box_projection = 0.0;
        for i in 0..3 {
            let axis = match i {
                0 => Vector3::new(1.0, 0.0, 0.0),
                1 => Vector3::new(0.0, 1.0, 0.0),
                2 => Vector3::new(0.0, 0.0, 1.0),
                _ => unreachable!(),
            };
            box_projection += box_half_extents[i] * triangle_normal.dot(&axis).abs();
        }

        // Normalize the per-axis epsilon by the triangle-normal magnitude.
        //
        // `triangle_normal` is the un-normalized cross product `e0 × e2`, so
        // `|triangle_normal| ≈ 2 * triangle_area`. Both `triangle_offset` and
        // `box_projection` scale linearly with that magnitude, but the
        // physical-space rounding error a "near-coplanar" face needs to absorb
        // does NOT scale with triangle area. Without scaling SAT_EPSILON, a
        // tall/wide wall face sitting ~3e-7 m outside the opening box (well
        // within the f32 → f64 round-trip slop introduced by the mesh
        // pipeline) becomes a separation gap of ~1.7e-6 in projection units,
        // which a fixed 1e-6 epsilon misses — leaving the wall's outer face
        // un-clipped (Smiley-West uncut walls, follow-up to #584).
        //
        // The *physical* slack must additionally absorb the f32 round-trip slop
        // of the host mesh: at building-scale world coordinates (tens of metres)
        // the f32 quantum is |coord| * 2^-23 ≈ 1.2e-7 * |coord|, which exceeds a
        // fixed 1e-6 m. A wall face flush with the opening's near plane (door
        // extruded from the back surface — ISSUE_126 #77438 / #83694, coords
        // ~33 m) lands ~1.4e-6 m outside the box; a fixed 1e-6 physical slack
        // still reports separation and the back face survives un-cut, sealing
        // the opening. Scale the physical slack by the box-center magnitude so
        // it tracks the f32 error, then by the normal magnitude as before.
        let phys_slack = SAT_EPSILON
            .max(box_center.x.abs().max(box_center.y.abs()).max(box_center.z.abs()) * 1e-6);
        let normal_magnitude = triangle_normal.norm();
        let t2_epsilon = phys_slack * normal_magnitude.max(1.0);
        if triangle_offset.abs() > box_projection + t2_epsilon {
            return false; // Separated by triangle plane
        }

        // Test 3: 9 cross-product axes (3 box edges x 3 triangle edges)
        let box_axes = [
            Vector3::new(1.0, 0.0, 0.0),
            Vector3::new(0.0, 1.0, 0.0),
            Vector3::new(0.0, 0.0, 1.0),
        ];
        let tri_edges = [e0, e1, e2];

        for box_axis in &box_axes {
            for tri_edge in &tri_edges {
                let axis = box_axis.cross(tri_edge);

                // Skip degenerate axes (parallel edges)
                if axis.norm_squared() < 1e-10 {
                    continue;
                }

                let axis_normalized = axis.normalize();

                // Project triangle onto axis
                let p0 = t0.dot(&axis_normalized);
                let p1 = t1.dot(&axis_normalized);
                let p2 = t2.dot(&axis_normalized);
                let tri_min = p0.min(p1).min(p2);
                let tri_max = p0.max(p1).max(p2);

                // Project box onto axis
                let mut box_projection = 0.0;
                for i in 0..3 {
                    let box_axis_vec = box_axes[i];
                    box_projection +=
                        box_half_extents[i] * axis_normalized.dot(&box_axis_vec).abs();
                }

                // Same f32-round-trip-aware physical slack as Test 2: the
                // cross-product axis is normalized, so projections are physical
                // units and a fixed 1e-6 m misses building-scale f32 slop on a
                // triangle coplanar with a box face (ISSUE_126 #77438 back face
                // — box-edge × triangle-edge yields a ±X axis, the very axis the
                // coplanar back face is separated on).
                if tri_max < -box_projection - phys_slack
                    || tri_min > box_projection + phys_slack
                {
                    return false; // Separated on this axis
                }
            }
        }

        // No separating axis found - triangle and box intersect
        true
    }

    /// Clip a triangle against an opening box using clip-and-collect algorithm.
    /// Removes the part of the triangle that's inside the box.
    /// Collects "outside" parts directly to result, continues processing "inside" parts.
    ///
    /// Uses reusable ClipBuffers to avoid per-triangle allocations (6+ Vec allocations
    /// per intersecting triangle without buffers).
    ///
    /// ## FIX (2026-03-18): Direct back-part computation
    ///
    /// The previous implementation clipped the original triangle against a **flipped plane**
    /// to obtain "outside" parts. When triangle vertices were within epsilon (1e-6) of the
    /// clipping plane, `clip_triangle` classified them as "front" for **both** the original
    /// and flipped planes — returning `Split` on the original but `AllFront` on the flipped.
    /// This added the **entire original triangle** to the result as an "outside" piece while
    /// the clipped front parts also continued processing, duplicating geometry.
    ///
    fn clip_triangle_against_box(
        &self,
        result: &mut Mesh,
        buffers: &mut ClipBuffers,
        v0: &Point3<f64>,
        v1: &Point3<f64>,
        v2: &Point3<f64>,
        normal: &Vector3<f64>,
        open_min: &Point3<f64>,
        open_max: &Point3<f64>,
    ) {
        let clipper = ClippingProcessor::new();
        // The plane classification (`d >= -epsilon` = inside/front) must absorb
        // the host mesh's f32 round-trip slop: the mesh is stored f32 and
        // promoted to f64 here while the box planes are pure f64. At
        // building-scale world coordinates (tens of metres) the f32 quantum
        // (|coord| * 2^-23 ≈ 1.2e-7 * |coord|) exceeds a fixed 1e-6 m, so a wall
        // face flush with a box plane (ISSUE_126 #77438 back face, ~33 m,
        // ~1.4e-6 m off the +X plane) is classified entirely "outside" and the
        // whole triangle survives un-clipped — the opening is sealed by the
        // un-cut back face. Scale the classification epsilon by the box-plane
        // coordinate magnitude so it tracks that f32 error.
        let coord_mag = open_min
            .x
            .abs()
            .max(open_max.x.abs())
            .max(open_min.y.abs())
            .max(open_max.y.abs())
            .max(open_min.z.abs())
            .max(open_max.z.abs());
        let epsilon = clipper.epsilon.max(coord_mag * 1e-6);

        // Clear buffers for reuse (retains capacity)
        buffers.clear();

        // Planes with INWARD normals (so "front" = inside box, "behind" = outside box)
        // We clip to keep geometry OUTSIDE the box (behind these planes)
        let planes = [
            // +X inward: inside box where x >= open_min.x
            Plane::new(
                Point3::new(open_min.x, 0.0, 0.0),
                Vector3::new(1.0, 0.0, 0.0),
            ),
            // -X inward: inside box where x <= open_max.x
            Plane::new(
                Point3::new(open_max.x, 0.0, 0.0),
                Vector3::new(-1.0, 0.0, 0.0),
            ),
            // +Y inward: inside box where y >= open_min.y
            Plane::new(
                Point3::new(0.0, open_min.y, 0.0),
                Vector3::new(0.0, 1.0, 0.0),
            ),
            // -Y inward: inside box where y <= open_max.y
            Plane::new(
                Point3::new(0.0, open_max.y, 0.0),
                Vector3::new(0.0, -1.0, 0.0),
            ),
            // +Z inward: inside box where z >= open_min.z
            Plane::new(
                Point3::new(0.0, 0.0, open_min.z),
                Vector3::new(0.0, 0.0, 1.0),
            ),
            // -Z inward: inside box where z <= open_max.z
            Plane::new(
                Point3::new(0.0, 0.0, open_max.z),
                Vector3::new(0.0, 0.0, -1.0),
            ),
        ];

        // Guard: skip if input vertices contain NaN (from degenerate prior clips)
        if !v0.x.is_finite()
            || !v0.y.is_finite()
            || !v0.z.is_finite()
            || !v1.x.is_finite()
            || !v1.y.is_finite()
            || !v1.z.is_finite()
            || !v2.x.is_finite()
            || !v2.y.is_finite()
            || !v2.z.is_finite()
        {
            // Keep the triangle as-is (don't clip degenerate geometry)
            let base = result.vertex_count() as u32;
            result.add_vertex(*v0, *normal);
            result.add_vertex(*v1, *normal);
            result.add_vertex(*v2, *normal);
            result.add_triangle(base, base + 1, base + 2);
            return;
        }
        // Initialize remaining with the input triangle
        buffers.remaining.push(Triangle::new(*v0, *v1, *v2));

        // Clip-and-collect: collect "outside" parts, continue processing "inside" parts
        for plane in &planes {
            buffers.next_remaining.clear();

            for tri in &buffers.remaining {
                // Compute signed distances
                let d0 = plane.signed_distance(&tri.v0);
                let d1 = plane.signed_distance(&tri.v1);
                let d2 = plane.signed_distance(&tri.v2);

                // Guard: NaN distances from degenerate vertices (from prior interpolation)
                if !d0.is_finite() || !d1.is_finite() || !d2.is_finite() {
                    buffers.result.push(tri.clone()); // keep as-is
                    continue;
                }

                let f0 = d0 >= -epsilon;
                let f1 = d1 >= -epsilon;
                let f2 = d2 >= -epsilon;
                let front_count = f0 as u8 + f1 as u8 + f2 as u8;

                match front_count {
                    3 => {
                        buffers.next_remaining.push(tri.clone());
                    }
                    0 => {
                        buffers.result.push(tri.clone());
                    }
                    1 => {
                        let (front, back1, back2, d_f, d_b1, d_b2) = if f0 {
                            (tri.v0, tri.v1, tri.v2, d0, d1, d2)
                        } else if f1 {
                            (tri.v1, tri.v2, tri.v0, d1, d2, d0)
                        } else {
                            (tri.v2, tri.v0, tri.v1, d2, d0, d1)
                        };

                        let denom1 = d_f - d_b1;
                        let denom2 = d_f - d_b2;
                        if denom1.abs() < 1e-12 || denom2.abs() < 1e-12 {
                            buffers.next_remaining.push(tri.clone());
                            continue;
                        }
                        let t1 = (d_f / denom1).clamp(0.0, 1.0);
                        let t2 = (d_f / denom2).clamp(0.0, 1.0);
                        let p1 = front + (back1 - front) * t1;
                        let p2 = front + (back2 - front) * t2;

                        // Validate interpolated points
                        if !p1.x.is_finite()
                            || !p1.y.is_finite()
                            || !p1.z.is_finite()
                            || !p2.x.is_finite()
                            || !p2.y.is_finite()
                            || !p2.z.is_finite()
                        {
                            buffers.next_remaining.push(tri.clone());
                            continue;
                        }

                        buffers.next_remaining.push(Triangle::new(front, p1, p2));
                        buffers.result.push(Triangle::new(p1, back1, back2));
                        buffers.result.push(Triangle::new(p1, back2, p2));
                    }
                    2 => {
                        let (front1, front2, back, d_f1, d_f2, d_b) = if !f0 {
                            (tri.v1, tri.v2, tri.v0, d1, d2, d0)
                        } else if !f1 {
                            (tri.v2, tri.v0, tri.v1, d2, d0, d1)
                        } else {
                            (tri.v0, tri.v1, tri.v2, d0, d1, d2)
                        };

                        let denom1 = d_f1 - d_b;
                        let denom2 = d_f2 - d_b;
                        if denom1.abs() < 1e-12 || denom2.abs() < 1e-12 {
                            buffers.next_remaining.push(tri.clone());
                            continue;
                        }
                        let t1 = (d_f1 / denom1).clamp(0.0, 1.0);
                        let t2 = (d_f2 / denom2).clamp(0.0, 1.0);
                        let p1 = front1 + (back - front1) * t1;
                        let p2 = front2 + (back - front2) * t2;

                        // Validate interpolated points
                        if !p1.x.is_finite()
                            || !p1.y.is_finite()
                            || !p1.z.is_finite()
                            || !p2.x.is_finite()
                            || !p2.y.is_finite()
                            || !p2.z.is_finite()
                        {
                            buffers.next_remaining.push(tri.clone());
                            continue;
                        }

                        buffers
                            .next_remaining
                            .push(Triangle::new(front1, front2, p1));
                        buffers.next_remaining.push(Triangle::new(front2, p2, p1));
                        buffers.result.push(Triangle::new(p1, p2, back));
                    }
                    _ => {
                        // Should be unreachable, but guard against corruption
                        buffers.result.push(tri.clone());
                    }
                }
            }

            // Swap buffers instead of reallocating
            std::mem::swap(&mut buffers.remaining, &mut buffers.next_remaining);
        }

        // 'remaining' triangles are inside ALL planes = inside box = discard
        // Add collected result_triangles to mesh
        for tri in &buffers.result {
            // Drop hairline needle slivers the Sutherland-Hodgman box clip leaves
            // on a host edge near-tangent to an opening face (the diagonal
            // window-wedge artifact, e.g. schependomlaan). Same scale-relative
            // power-of-two needle test the exact-kernel consolidate pass uses; a
            // ~zero-area needle can't open a real gap — the frame around the
            // opening is closed by the neighbouring non-degenerate triangles.
            if tri_is_needle(&[tri.v0, tri.v1, tri.v2]) {
                continue;
            }
            let base = result.vertex_count() as u32;
            result.add_vertex(tri.v0, *normal);
            result.add_vertex(tri.v1, *normal);
            result.add_vertex(tri.v2, *normal);
            result.add_triangle(base, base + 1, base + 2);
        }
    }
}
