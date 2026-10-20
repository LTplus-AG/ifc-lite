// SPDX-License-Identifier: MPL-2.0
//! Owned production swept-disk inputs, sampled in raw IFC file length units.
use crate::{Mesh, Point3};

#[derive(Debug, Clone)]
pub(crate) struct SweptDiskPlan {
    pub(super) curve_points: Vec<Point3<f64>>,
    pub(super) radius: f64,
    pub(super) inner_radius: Option<f64>,
    pub(super) segments: usize,
}

impl SweptDiskPlan {
    pub(crate) fn evaluate(&self) -> Mesh {
        // Generate tube mesh by sweeping circle along curve
        // 24 segments around the circle at Medium; scaled by quality.
        let (positions, indices) = super::build_tube(
            &self.curve_points,
            self.radius,
            self.inner_radius,
            self.segments,
        );

        let mut mesh = Mesh {
            positions,
            normals: Vec::new(),
            indices,
            rtc_applied: false,
            origin: [0.0; 3],
            welded_in_object_frame: false,
            plane_tags: None,
            instance_meta: None,
            local_bounds: None,
            local_to_world: None,
        };

        // Ship smooth per-vertex normals, computed here in the directrix-local
        // frame where the coordinates are small (0..directrix-length) and so
        // precise. Without this the swept-disk mesh carried empty normals and
        // downstream consumers recomputed them from world-space f32 positions.
        // At a georef-scale placement (national-grid rebar sits ~6 km from the
        // origin) the edge differences `v1 - v0` cancel catastrophically — the
        // tube renders as a field of specular sparkles. A round tube wants
        // smooth (area-weighted) normals, unlike the crease-heavy revolved
        // solid which is flat-shaded. (#1164)
        crate::calculate_normals(&mut mesh);

        mesh
    }
}

#[cfg(test)]
#[path = "disk_plan_tests.rs"]
mod tests;
