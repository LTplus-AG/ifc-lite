// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Final mesh world transform: f32 local-frame relativization + RTC fold + inverse-transpose normals.

use super::super::GeometryRouter;
use crate::{Mesh, Point3, Vector3};
use nalgebra::Matrix4;

impl GeometryRouter {
    /// Transform mesh by a local matrix without applying model RTC.
    ///
    /// Use this for nested representation transforms (for example IfcMappedItem
    /// mapping targets). RTC belongs to the final model/world coordinate step, not
    /// intermediate local transforms.
    #[inline]
    pub(crate) fn transform_mesh_local(&self, mesh: &mut Mesh, transform: &Matrix4<f64>) {
        mesh.positions.chunks_exact_mut(3).for_each(|chunk| {
            let point = Point3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64);
            let t = transform.transform_point(&point);
            chunk[0] = t.x as f32;
            chunk[1] = t.y as f32;
            chunk[2] = t.z as f32;
        });

        self.transform_normals(mesh, transform);
    }

    /// Transform mesh by the final world/object placement matrix.
    ///
    /// If a model RTC offset is active, subtract it uniformly for every mesh in
    /// this final coordinate step. Meshes that already had RTC subtracted in f64
    /// during raw world-coordinate triangulation are guarded by `rtc_applied`.
    #[inline]
    pub(crate) fn transform_mesh_world(&self, mesh: &mut Mesh, transform: &Matrix4<f64>) {
        self.transform_mesh_world_framed(mesh, transform, super::local_frame_enabled());
    }

    /// World placement with an explicit choice of whether to relativize positions
    /// into a per-mesh local `origin`.
    ///
    /// `relativize = true` defers the building/georef-scale world magnitude into
    /// `mesh.origin` (the AABB centre) and stores positions RELATIVE to it, so f32
    /// can't collapse adjacent vertices into degenerate needles (the gross-fan bug).
    ///
    /// `relativize = false` keeps absolute world/RTC coordinates in `positions`.
    /// The void-cut path needs this: `apply_void_context` matches the host against
    /// world-coordinate opening cutters, so the host must stay in the world frame
    /// for the CSG (relativizing only the host silently breaks every cut). The
    /// void path applies its own shared-origin relativization to the CSG OUTPUT.
    #[inline]
    pub(crate) fn transform_mesh_world_framed(
        &self,
        mesh: &mut Mesh,
        transform: &Matrix4<f64>,
        relativize: bool,
    ) {
        // Local (pre-placement, object-space) AABB + the resolved placement
        // itself (issue #1474): `mesh.positions` is still untouched here — both
        // branches below only start mutating it in their own loops — so this is
        // exactly the object-space extent `transform` is about to bake into
        // world space. A single extra min/max pass, no allocation.
        mesh.local_bounds = if mesh.positions.is_empty() {
            None
        } else {
            let mut min = [f32::INFINITY; 3];
            let mut max = [f32::NEG_INFINITY; 3];
            for chunk in mesh.positions.chunks_exact(3) {
                for k in 0..3 {
                    if chunk[k] < min[k] {
                        min[k] = chunk[k];
                    }
                    if chunk[k] > max[k] {
                        max[k] = chunk[k];
                    }
                }
            }
            Some([min[0], min[1], min[2], max[0], max[1], max[2]])
        };
        mesh.local_to_world = Some(super::mat4_to_row_major(transform));

        let rtc = self.rtc_offset;
        let needs_rtc = self.has_rtc_offset() && !mesh.rtc_applied;
        let (rx, ry, rz) = if needs_rtc {
            (rtc.0, rtc.1, rtc.2)
        } else {
            (0.0, 0.0, 0.0)
        };

        // Fast path — absolute world/RTC coordinates (origin == 0). Used by the
        // native/server default and the void-cut host (see the doc comment), and
        // bit-identical to the framed path with origin [0,0,0]
        // (`(w - 0) as f32 == w as f32`), so determinism snapshots are unaffected.
        // Avoids the per-element `Vec<[f64;3]>` allocation + second pass the AABB
        // framing below needs, keeping the absolute path at its original cost.
        if !relativize {
            for chunk in mesh.positions.chunks_exact_mut(3) {
                let point = Point3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64);
                let t = transform.transform_point(&point);
                chunk[0] = (t.x - rx) as f32;
                chunk[1] = (t.y - ry) as f32;
                chunk[2] = (t.z - rz) as f32;
            }
            mesh.origin = [0.0; 3];
            if needs_rtc {
                mesh.rtc_applied = true;
            }
            self.transform_normals(mesh, transform);
            return;
        }

        // Pass 1 — transform every vertex into the world/RTC frame in f64 and track
        // the AABB. The exact kernel built `positions` in a small local frame, so the
        // f32 input is precise here; the precision is only lost if we store the
        // world-magnitude result (building placement ~hundreds of metres) back to f32,
        // where one ULP (~15 µm at 220 m) collapses adjacent vertices into degenerate
        // needles. So we defer the world magnitude into a per-mesh `origin`.
        let mut min = [f64::INFINITY; 3];
        let mut max = [f64::NEG_INFINITY; 3];
        let world: Vec<[f64; 3]> = mesh
            .positions
            .chunks_exact(3)
            .map(|chunk| {
                let point = Point3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64);
                let t = transform.transform_point(&point);
                let w = [t.x - rx, t.y - ry, t.z - rz];
                for k in 0..3 {
                    if w[k] < min[k] {
                        min[k] = w[k];
                    }
                    if w[k] > max[k] {
                        max[k] = w[k];
                    }
                }
                w
            })
            .collect();

        // Per-element local origin = AABB centre (f64), deterministic (not a running
        // mean). Vertices are stored RELATIVE to it, so they stay element-small and
        // f32-exact at any building/georef scale; the world position is `origin + p`.
        let origin = if !relativize || world.is_empty() {
            [0.0; 3]
        } else {
            // Snap the AABB-centre origin to the kernel reconcile grid. The void
            // CSG relativizes its operands by this origin (subtract it) and then
            // snaps to SNAP_GRID; `round((x-o)/G) == round(x/G) - o/G` holds ONLY
            // when `o` is itself a grid multiple. An off-grid origin shifts every
            // operand off the snap lattice → the cut emits slivers / zero-area
            // tris (the ~1.4% void loss). Must use the SAME grid as the kernel.
            const G: f64 = crate::kernel::mesh_bridge::SNAP_GRID;
            let snap = |lo: f64, hi: f64| (((lo + hi) * 0.5) / G).round() * G;
            [
                snap(min[0], max[0]),
                snap(min[1], max[1]),
                snap(min[2], max[2]),
            ]
        };

        // Pass 2 — store (world - origin) as f32. When relativized, small + exact +
        // collapse-free; otherwise absolute world/RTC (origin == 0).
        for (chunk, w) in mesh.positions.chunks_exact_mut(3).zip(world.iter()) {
            chunk[0] = (w[0] - origin[0]) as f32;
            chunk[1] = (w[1] - origin[1]) as f32;
            chunk[2] = (w[2] - origin[2]) as f32;
        }
        mesh.origin = origin;
        if needs_rtc {
            mesh.rtc_applied = true;
        }

        self.transform_normals(mesh, transform);
    }

    #[inline]
    fn transform_normals(&self, mesh: &mut Mesh, transform: &Matrix4<f64>) {
        // Normals transform by the inverse-transpose, not the raw linear block:
        // under a non-uniform `IfcCartesianTransformationOperator3DnonUniform`
        // scale the raw upper-3x3 skews a normal off the true surface normal and
        // the trailing normalize() only fixes magnitude, not direction. Matches
        // `extrusion.rs`. For pure rotation / uniform scale this equals the
        // rotation block, so the common path is unchanged.
        let normal_matrix = transform.try_inverse().unwrap_or(*transform).transpose();
        mesh.normals.chunks_exact_mut(3).for_each(|chunk| {
            let normal = Vector3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64);
            let t = (normal_matrix * normal.to_homogeneous()).xyz().normalize();
            chunk[0] = t.x as f32;
            chunk[1] = t.y as f32;
            chunk[2] = t.z as f32;
        });
    }
}

#[cfg(test)]
mod local_bounds_tests {
    //! Issue #1474: `local_bounds`/`local_to_world` must capture the mesh's
    //! object-space extent and the exact placement `apply_placement` resolved,
    //! independent of `origin` (a world-space AABB-centre translation captured
    //! by this same function for an unrelated reason — f32 precision).
    use super::super::mat4_to_row_major;
    use super::*;
    use crate::Mesh;
    use nalgebra::{Rotation3, Translation3};

    /// A unit box [0,1]^3, un-rotated, in object space.
    fn unit_box() -> Mesh {
        let mut mesh = Mesh::new();
        mesh.positions = vec![
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0,
            1.0, 1.0, 1.0, 1.0, 0.0, 1.0, 1.0,
        ];
        mesh.normals = vec![0.0; mesh.positions.len()];
        mesh.indices = (0..8).collect();
        mesh
    }

    #[test]
    fn captures_local_bounds_and_transform_independent_of_origin() {
        // 90 degree rotation about Z, then translate far from the origin (so
        // `mesh.origin`, a WORLD-space AABB-centre, ends up nowhere near the
        // object-space [0,1]^3 box local_bounds must still report).
        let rotation = Rotation3::from_axis_angle(&Vector3::z_axis(), std::f64::consts::FRAC_PI_2);
        let translation = Translation3::new(1000.0, 2000.0, 3000.0);
        let transform = translation.to_homogeneous() * rotation.to_homogeneous();

        let router = GeometryRouter::new();

        // Relativized path (local-frame origin factored out).
        let mut mesh = unit_box();
        router.transform_mesh_world_framed(&mut mesh, &transform, true);
        assert_eq!(
            mesh.local_bounds,
            Some([0.0, 0.0, 0.0, 1.0, 1.0, 1.0]),
            "local_bounds must be the pre-rotation object-space box, not the world box"
        );
        assert_eq!(
            mesh.local_to_world,
            Some(mat4_to_row_major(&transform)),
            "local_to_world must be exactly the resolved placement"
        );
        assert_ne!(
            mesh.origin, [0.0; 3],
            "sanity: origin should have picked up the world-space translation"
        );

        // Absolute (non-relativized) path — same capture, different `origin` handling.
        let mut mesh2 = unit_box();
        router.transform_mesh_world_framed(&mut mesh2, &transform, false);
        assert_eq!(mesh2.local_bounds, mesh.local_bounds);
        assert_eq!(mesh2.local_to_world, mesh.local_to_world);
        assert_eq!(mesh2.origin, [0.0; 3], "absolute path never sets origin");
    }
}
