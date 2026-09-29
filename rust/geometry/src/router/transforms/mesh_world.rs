// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Final mesh world transform: f32 local-frame relativization + RTC fold + inverse-transpose normals.

use super::super::GeometryRouter;
use crate::{Mesh, Point3, Vector3};
use nalgebra::Matrix4;

// At 1 km an f32 coordinate has ~0.06 mm spacing; beyond this, folding a
// mapped translation into vertices can visibly perturb small IFC features.
pub(crate) const LARGE_MAPPED_ORIGIN_M: f64 = 1_000.0;

// Beyond 1,000 km an absolute f32 coordinate has 6 cm spacing or worse, which
// no longer holds an opening or a host face (#6478). Nearer RTC-frame meshes keep
// the absolute frame the native router has always used.
pub(crate) const FAR_RTC_FRAME_M: f64 = 1_000_000.0;

#[inline]
fn source_point<const HAS_ORIGIN: bool>(chunk: &[f32], origin: [f64; 3]) -> Point3<f64> {
    if HAS_ORIGIN {
        Point3::new(
            chunk[0] as f64 + origin[0],
            chunk[1] as f64 + origin[1],
            chunk[2] as f64 + origin[2],
        )
    } else {
        Point3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64)
    }
}

impl GeometryRouter {
    /// Transform mesh by a local matrix without applying model RTC.
    ///
    /// Use this for nested representation transforms (for example IfcMappedItem
    /// mapping targets). RTC belongs to the final model/world coordinate step, not
    /// intermediate local transforms.
    #[inline]
    pub(crate) fn transform_mesh_local(&self, mesh: &mut Mesh, transform: &Matrix4<f64>) {
        // Published object-frame bounds (set on RTC-rebased items, #5698)
        // must follow the geometry into the mapped frame: the enclosing box
        // of the transformed corners, rounded outward to f32.
        if let Some(bounds) = mesh.local_bounds {
            let mut min = [f64::INFINITY; 3];
            let mut max = [f64::NEG_INFINITY; 3];
            for corner in 0..8 {
                let pick = |axis: usize| bounds[axis + 3 * ((corner >> axis) & 1)] as f64;
                let t = transform.transform_point(&Point3::new(pick(0), pick(1), pick(2)));
                for (axis, value) in [t.x, t.y, t.z].into_iter().enumerate() {
                    min[axis] = min[axis].min(value);
                    max[axis] = max[axis].max(value);
                }
            }
            let down = |v: f64| {
                let f = v as f32;
                if (f as f64) > v { f.next_down() } else { f }
            };
            let up = |v: f64| {
                let f = v as f32;
                if (f as f64) < v { f.next_up() } else { f }
            };
            mesh.local_bounds = Some([
                down(min[0]),
                down(min[1]),
                down(min[2]),
                up(max[0]),
                up(max[1]),
                up(max[2]),
            ]);
        }
        // #5792: a MappingTarget at georeferenced scale cannot be written into
        // f32 positions before the final RTC step. Keep its f64 translation in
        // the mesh origin and transform only small local vectors. Preserve the
        // existing byte path for ordinary maps and their determinism snapshots.
        let needs_origin = mesh.origin != [0.0; 3]
            || (0..3).any(|axis| transform[(axis, 3)].abs() >= LARGE_MAPPED_ORIGIN_M);
        if needs_origin {
            let old_origin = Point3::new(mesh.origin[0], mesh.origin[1], mesh.origin[2]);
            let new_origin = transform.transform_point(&old_origin);
            mesh.positions.chunks_exact_mut(3).for_each(|chunk| {
                let v = transform.transform_vector(&Vector3::new(
                    chunk[0] as f64,
                    chunk[1] as f64,
                    chunk[2] as f64,
                ));
                chunk[0] = v.x as f32;
                chunk[1] = v.y as f32;
                chunk[2] = v.z as f32;
            });
            mesh.origin = [new_origin.x, new_origin.y, new_origin.z];
        } else {
            mesh.positions.chunks_exact_mut(3).for_each(|chunk| {
                let point = Point3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64);
                let t = transform.transform_point(&point);
                chunk[0] = t.x as f32;
                chunk[1] = t.y as f32;
                chunk[2] = t.z as f32;
            });
        }

        self.transform_normals(mesh, transform);
    }

    /// Transform mesh by the final world/object placement matrix.
    ///
    /// If a model RTC offset is active, subtract it uniformly for every mesh in
    /// this final coordinate step. Meshes that already had RTC subtracted in f64
    /// during raw world-coordinate triangulation are guarded by `rtc_applied`.
    #[inline]
    pub(crate) fn transform_mesh_world(&self, mesh: &mut Mesh, transform: &Matrix4<f64>) {
        // Native normally keeps absolute f32 vertices, but an intermediate
        // mapped origin at this scale needs the same local frame as the viewer.
        // Opening cutters also use this policy when their mapped origin is large.
        let needs_local_frame = self.needs_local_frame(mesh, transform);
        self.transform_mesh_world_framed(
            mesh,
            transform,
            self.local_frame_enabled() || needs_local_frame,
        );
    }

    #[inline]
    pub(crate) fn mapped_origin_needs_local_frame(
        &self,
        mesh: &Mesh,
        transform: &Matrix4<f64>,
    ) -> bool {
        mesh.origin != [0.0; 3] && {
            let o = transform.transform_point(&Point3::new(
                mesh.origin[0], mesh.origin[1], mesh.origin[2],
            ));
            let rtc = if self.has_rtc_offset() && !mesh.rtc_applied {
                self.rtc_offset
            } else {
                (0.0, 0.0, 0.0)
            };
            [o.x - rtc.0, o.y - rtc.1, o.z - rtc.2]
                .iter()
                .any(|v| v.abs() >= LARGE_MAPPED_ORIGIN_M)
        }
    }

    /// Whether a mesh placed by `transform` must be stored in a per-mesh local
    /// frame: its mapped origin is large ([`Self::mapped_origin_needs_local_frame`]),
    /// or the model RTC offset leaves it at least [`FAR_RTC_FRAME_M`] from the
    /// RTC origin. In the second case absolute f32 positions would sit on a
    /// coarse grid (0.5 m at 5,000 km), quantising host geometry and collapsing
    /// opening cutters into degenerate boxes (#6478). Shared by host and cutter
    /// placement so both are framed before any f32 cast.
    pub(crate) fn needs_local_frame(&self, mesh: &Mesh, transform: &Matrix4<f64>) -> bool {
        if self.mapped_origin_needs_local_frame(mesh, transform) {
            return true;
        }
        if !self.has_rtc_offset() || mesh.rtc_applied || mesh.is_empty() {
            return false;
        }
        let (min, max) = mesh.bounds();
        let centre = transform.transform_point(&Point3::new(
            mesh.origin[0] + (min.x as f64 + max.x as f64) / 2.0,
            mesh.origin[1] + (min.y as f64 + max.y as f64) / 2.0,
            mesh.origin[2] + (min.z as f64 + max.z as f64) / 2.0,
        ));
        let rtc = self.rtc_offset;
        [centre.x - rtc.0, centre.y - rtc.1, centre.z - rtc.2]
            .iter()
            .any(|v| v.abs() >= FAR_RTC_FRAME_M)
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
        if mesh.origin == [0.0; 3] {
            self.transform_mesh_world_framed_impl::<false>(mesh, transform, relativize);
        } else {
            self.transform_mesh_world_framed_impl::<true>(mesh, transform, relativize);
        }
    }

    #[inline]
    fn transform_mesh_world_framed_impl<const HAS_ORIGIN: bool>(
        &self,
        mesh: &mut Mesh,
        transform: &Matrix4<f64>,
        relativize: bool,
    ) {
        let source_origin = mesh.origin;
        // Local (pre-placement, object-space) AABB + the resolved placement
        // itself (issue #1474): `mesh.positions` is still untouched here — both
        // branches below only start mutating it in their own loops — so this is
        // exactly the object-space extent `transform` is about to bake into
        // world space. A single extra min/max pass, no allocation.
        mesh.local_bounds = mesh.local_bounds.or_else(|| {
            if mesh.positions.is_empty() {
                None
            } else if HAS_ORIGIN {
                // #5792: rounding each large coordinate before the min/max
                // collapses a thin mapped disk to a zero-width f32 box. Keep
                // the f64 extrema and round only the final box outward.
                let mut min = [f64::INFINITY; 3];
                let mut max = [f64::NEG_INFINITY; 3];
                for chunk in mesh.positions.chunks_exact(3) {
                    for axis in 0..3 {
                        let value = chunk[axis] as f64 + source_origin[axis];
                        min[axis] = min[axis].min(value);
                        max[axis] = max[axis].max(value);
                    }
                }
                let enclosing = super::super::processing::enclosing_f32;
                Some([
                    enclosing(min[0], true),
                    enclosing(min[1], true),
                    enclosing(min[2], true),
                    enclosing(max[0], false),
                    enclosing(max[1], false),
                    enclosing(max[2], false),
                ])
            } else {
                let mut min = [f32::INFINITY; 3];
                let mut max = [f32::NEG_INFINITY; 3];
                for chunk in mesh.positions.chunks_exact(3) {
                    for k in 0..3 {
                        let value = chunk[k];
                        if value < min[k] {
                            min[k] = value;
                        }
                        if value > max[k] {
                            max[k] = value;
                        }
                    }
                }
                Some([min[0], min[1], min[2], max[0], max[1], max[2]])
            }
        });
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
                let point = source_point::<HAS_ORIGIN>(chunk, source_origin);
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
                let point = source_point::<HAS_ORIGIN>(chunk, source_origin);
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
#[path = "mesh_world_tests.rs"]
mod local_bounds_tests;
