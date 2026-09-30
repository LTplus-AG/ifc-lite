// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Admission and exact no-op reuse for disjoint opening batches (#6516).
use super::{GeometryRouter, Mesh, OpeningType, Vector3, NORMALIZE_EPSILON};
use super::geom::{mesh_is_closed_exact, opening_mesh_thinnest_axis_dir};
use crate::kernel::mesh_bridge::mesh_to_tris;

impl GeometryRouter {
    /// A batch-group cutter: the opening extended through `host`, welded (1 µm)
    /// to bit-identical, and kept only if it is then exactly closed (#2176: only
    /// per-component-watertight solids may join a group). The weld lets a
    /// geometrically-watertight cutter whose shared-edge f32 coords differ in
    /// bits after the placement transform pass the bit-exact gate (#098).
    /// Admission and the re-extension after a host cut both call this, so a
    /// cutter admitted because of the weld is not refused at cut time.
    pub(super) fn batch_cutter(
        opening_mesh: &Mesh,
        extrusion_dir: Option<Vector3<f64>>,
        host: &Mesh,
    ) -> Option<Mesh> {
        let raw = Self::sequential_cutter(opening_mesh, extrusion_dir, host);
        let ext = raw.welded_by_position(1.0e-6);
        #[cfg(feature = "opening-perf-trace")]
        crate::opening_perf_trace::record(|c| {
            let identical = crate::kernel::mesh_bridge::mesh_to_tris(&raw)
                == crate::kernel::mesh_bridge::mesh_to_tris(&ext);
            if identical {
                c.batch_weld_preserves_kernel_triangles = c.batch_weld_preserves_kernel_triangles.saturating_add(1);
            } else {
                c.batch_weld_changes_kernel_triangles = c.batch_weld_changes_kernel_triangles.saturating_add(1);
            }
        });
        mesh_is_closed_exact(&ext).then_some(ext)
    }

    /// The same through-host cutter the sequential path would subtract.
    pub(super) fn sequential_cutter(
        opening_mesh: &Mesh,
        extrusion_dir: Option<Vector3<f64>>,
        host: &Mesh,
    ) -> Mesh {
        let depth_dir = extrusion_dir
            .filter(|d| d.norm() > NORMALIZE_EPSILON)
            .unwrap_or_else(|| opening_mesh_thinnest_axis_dir(opening_mesh));
        Self::extend_opening_mesh_through_host(opening_mesh, host, depth_dir)
    }

    /// A batch's 1 µm weld can move vertices or drop degenerate triangles. A
    /// miss for that altered cutter is not permission to skip the raw cutter.
    /// Compare the canonical, ordered kernel operands, not bounds or volume.
    pub(super) fn batch_cutters_match_sequential(
        host: &Mesh,
        openings: &[&OpeningType],
        extended: &[(usize, Mesh)],
    ) -> bool {
        extended.iter().all(|(index, welded)| {
            let Some((opening, direction)) = openings[*index].mesh_cutter() else {
                return false;
            };
            let raw = Self::sequential_cutter(opening, direction, host);
            mesh_to_tris(&raw) == mesh_to_tris(welded)
        })
    }
}

#[cfg(test)]
#[path = "batch_miss_tests.rs"]
mod tests;
