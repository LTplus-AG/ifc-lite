// SPDX-License-Identifier: MPL-2.0
//! Owned profile/placed-directrix inputs for the current RMF sweep semantics.
//! Reference-surface/fixed-direction roll retains the production limitation.
use crate::{profile::Profile2D, Mesh, Point3, Result};
use super::super::disk::build_tube_rmf;
use super::sweep_profile_along_frames;

#[derive(Debug, Clone)]
pub(crate) struct SurfaceCurveSweepPlan {
    pub(super) regions: Vec<Profile2D>,
    pub(super) points: Vec<Point3<f64>>,
    pub(super) entity_id: u32,
}

impl SurfaceCurveSweepPlan {
    pub(crate) fn evaluate(&self) -> Result<Mesh> {
        // --- Sweep the profile along the placed directrix --------------------------
        let (_, perp1s, perp2s) = build_tube_rmf(&self.points);
        let placed = self.regions.iter().map(crate::profiles::region_points).sum::<usize>() * self.points.len();
        // Base already swept holes here; only further composite areas are new.
        crate::profiles::check_sweep_vertices(placed, self.regions.len() > 1, self.entity_id)?;
        if let [region] = self.regions.as_slice() {
            return sweep_profile_along_frames(region, &self.points, &perp1s, &perp2s);
        }
        let mut mesh = Mesh::new();
        for region in &self.regions {
            mesh.merge(&sweep_profile_along_frames(region, &self.points, &perp1s, &perp2s)?);
        }
        Ok(mesh)
    }
}

#[cfg(test)]
#[path = "surface_plan_tests.rs"]
mod tests;
