// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! RGB point-cloud observations for registered scan transfer (#4381).
//!
//! Each target sample is answered by a local plane fitted to the scan points
//! around the sample (around the nearest point when the sample itself has none
//! within the support radius), never by the nearest colour alone: the fit must be
//! planar within `surface_band_metres`, its oriented normal must agree with the
//! target face, and the support must lie in front of the face or within the
//! behind bound. Orientation comes from the source normals, the scanner station
//! or the target face itself; in every mode a point reachable only through
//! another face of the target is refused (see `transfer_occlusion`).
use super::{
    transfer_budget::TransferBudget,
    transfer_math::*,
    transfer_occlusion::Occluder,
    transfer_points_index::PointGrid,
    transfer_surface::Observation,
    transfer_types::*,
};
use nalgebra::{Matrix3, SymmetricEigen};

const MAX_POINTS: usize = 2_000_000;
const MAX_VIEWPOINTS: usize = 4_096;

pub(super) struct PointSurface {
    positions: Vec<Point>,
    colors: Vec<u8>,
    normals: Vec<Point>,
    stations: Vec<u32>,
    viewpoints: Vec<Point>,
    grid: PointGrid,
    orientation: PointOrientation,
    radius: f64,
    min_neighbors: usize,
    max_neighbors: usize,
    band: f64,
    distance: f64,
    normal_dot: f64,
    behind: f64,
    support: Vec<(u32, f64)>,
    scratch: Vec<(u32, f64)>,
}
impl PointSurface {
    pub fn new(
        request: &MeshTransferRequest,
        spec: &TransferSourcePoints,
        payload: &TransferPointPayload<'_>,
        frame: &TransferFrame,
        budget: &mut TransferBudget,
    ) -> Result<Self, String> {
        let count = spec.point_count as usize;
        if count == 0 || count > MAX_POINTS || payload.positions.len() != count * 3 || payload.colors.len() != count * 3 {
            return Err("Transfer point payload must carry 1..2,000,000 points with matching RGB8 colours".into());
        }
        if !spec.neighborhood_radius_metres.is_finite() || spec.neighborhood_radius_metres <= 0. || spec.neighborhood_radius_metres > 0.5
            || spec.min_neighbors < 3 || spec.max_neighbors < spec.min_neighbors || spec.max_neighbors > 256
            || !spec.surface_band_metres.is_finite() || spec.surface_band_metres <= 0. || spec.surface_band_metres > spec.neighborhood_radius_metres
        {
            return Err("Transfer point fit needs a radius within 0.5 m, 3..256 neighbours and a surface band within the radius".into());
        }
        let has_normals = !payload.normals.is_empty();
        let has_stations = !payload.stations.is_empty() || !spec.viewpoints.is_empty();
        match spec.orientation {
            PointOrientation::SourceNormals if !has_normals || has_stations => return Err("Transfer source-normals orientation needs oriented per-point normals and no stations".into()),
            PointOrientation::Viewpoints if has_normals || payload.stations.len() != count || spec.viewpoints.is_empty() || spec.viewpoints.len() > MAX_VIEWPOINTS => return Err("Transfer viewpoint orientation needs one station index per point, 1..4096 stations and no normals".into()),
            PointOrientation::TargetReferenced if has_normals || has_stations => return Err("Transfer target-referenced orientation must not silently ignore supplied normals or stations".into()),
            _ => {}
        }
        if has_normals && payload.normals.len() != count * 3 {
            return Err("Transfer point normals must be one unit vector per point".into());
        }
        if payload.positions.iter().any(|v| !v.is_finite() || v.abs() > 1e12)
            || spec.viewpoints.iter().flatten().any(|v| !v.is_finite() || v.abs() > 1e12)
            || payload.stations.iter().any(|s| *s as usize >= spec.viewpoints.len())
        {
            return Err("Transfer point coordinates, stations or viewpoints exceed their finite bounds".into());
        }
        budget.reserve(count * 27 + payload.normals.len() * 8 + payload.stations.len() * 4)?;
        budget.charge(count)?;
        let positions: Vec<Point> = payload.positions.chunks_exact(3).map(|p| transform(frame, [p[0], p[1], p[2]])).collect();
        let rotate = |n: Point| -> Point { std::array::from_fn(|i| (0..3).map(|j| frame.rotation[i][j] * n[j]).sum()) };
        let mut normals = Vec::with_capacity(payload.normals.len() / 3);
        for n in payload.normals.chunks_exact(3) {
            let n = [f64::from(n[0]), f64::from(n[1]), f64::from(n[2])];
            let length = dot(n, n).sqrt();
            if !length.is_finite() || length < 0.5 || length > 2. {
                return Err("Transfer point normals must be finite unit vectors".into());
            }
            normals.push(rotate(n.map(|v| v / length)));
        }
        // Cells match the support radius: the common query. The rarer nearest
        // search out to the distance bound spans more cells (bounded by 16 per axis).
        if request.max_distance_metres > 16. * spec.neighborhood_radius_metres {
            return Err("Transfer distance bound must not exceed 16 times the point support radius".into());
        }
        let grid = PointGrid::build(&positions, spec.neighborhood_radius_metres, budget)?;
        Ok(Self {
            positions,
            colors: payload.colors.to_vec(),
            normals,
            stations: payload.stations.to_vec(),
            viewpoints: spec.viewpoints.iter().map(|p| transform(frame, *p)).collect(),
            grid,
            orientation: spec.orientation,
            radius: spec.neighborhood_radius_metres,
            min_neighbors: spec.min_neighbors as usize,
            max_neighbors: spec.max_neighbors as usize,
            band: spec.surface_band_metres,
            distance: request.max_distance_metres,
            normal_dot: request.min_normal_dot,
            behind: request.max_behind_metres,
            support: Vec::new(),
            scratch: Vec::new(),
        })
    }
    pub fn observe(
        &mut self,
        point: Point,
        target_normal: Point,
        occluder: &mut Occluder,
        budget: &mut TransferBudget,
    ) -> Result<(Observation, [f64; 4]), String> {
        budget.charge(1)?;
        let unknown = |o| Ok((o, [0.; 4]));
        // One support query around the sample point serves as the nearest-point
        // search too; only a sample with no point inside the support radius pays
        // for the wider search out to the distance bound.
        self.support.clear();
        self.grid.within(&self.positions, point, self.radius, &mut self.support, budget)?;
        let nearest = match self.support.iter().copied().min_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0))) {
            Some((index, _)) => index,
            None => match self.grid.nearest(&self.positions, point, self.distance, &mut self.scratch, budget)? {
                Some((index, _)) => index,
                None => return unknown(Observation::Distance),
            },
        };
        let anchor = self.positions[nearest as usize];
        // Never look through an incompatible nearest capture for a farther match:
        // a point facing away, or one scanned from behind the sampled face.
        let facing_away = match self.orientation {
            PointOrientation::SourceNormals => dot(self.normals[nearest as usize], target_normal) < self.normal_dot,
            PointOrientation::Viewpoints => dot(sub(self.viewpoints[self.stations[nearest as usize] as usize], anchor), target_normal) < 0.,
            PointOrientation::TargetReferenced => false,
        };
        if facing_away {
            return unknown(Observation::Normal);
        }
        // Never look through the target's own opposite face to the nearest capture.
        if occluder.blocked(point, anchor, budget)? {
            return unknown(Observation::Behind);
        }
        if self.support.is_empty() {
            // The anchor lies beyond the support radius: its own neighborhood is the surface.
            self.grid.within(&self.positions, anchor, self.radius, &mut self.support, budget)?;
        }
        if self.support.len() > self.max_neighbors {
            budget.charge(self.support.len())?;
            self.support.sort_unstable_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)));
            self.support.truncate(self.max_neighbors);
        }
        // Support beyond the item's own opposite face (deeper than its thickness
        // here), or facing away from the anchor's orientation, is another surface.
        let thickness = occluder.thickness_behind(point, target_normal, self.distance + self.radius, budget)?;
        budget.charge(self.support.len())?;
        let (positions, normals, orientation) = (&self.positions, &self.normals, self.orientation);
        self.support.retain(|&(index, _)| {
            let depth = dot(sub(positions[index as usize], point), target_normal);
            if thickness.is_some_and(|t| depth < -t) {
                return false;
            }
            orientation != PointOrientation::SourceNormals || dot(normals[index as usize], normals[nearest as usize]) > 0.
        });
        let Some(mut plane) = self.fit(budget)? else { return unknown(Observation::Sparse) };
        if self.orientation == PointOrientation::Viewpoints {
            // Points seen from the other side of this plane are the other sheet.
            let station = self.viewpoints[self.stations[nearest as usize] as usize];
            let side = dot(sub(station, plane.centroid), plane.normal).signum();
            let (viewpoints, stations) = (&self.viewpoints, &self.stations);
            self.support.retain(|(index, _)| {
                let s = viewpoints[stations[*index as usize] as usize];
                dot(sub(s, plane.centroid), plane.normal).signum() == side || *index == nearest
            });
            let Some(refit) = self.fit(budget)? else { return unknown(Observation::Sparse) };
            plane = refit;
        }
        if plane.rms > self.band {
            return unknown(Observation::Ambiguous);
        }
        let toward = match self.orientation {
            PointOrientation::SourceNormals => {
                let mut mean = [0.; 3];
                for &(index, _) in &self.support {
                    let n = self.normals[index as usize];
                    for a in 0..3 { mean[a] += n[a]; }
                }
                if dot(mean, mean).sqrt() < 0.5 * self.support.len() as f64 {
                    return unknown(Observation::Ambiguous);
                }
                mean
            }
            PointOrientation::Viewpoints => sub(self.viewpoints[self.stations[nearest as usize] as usize], plane.centroid),
            PointOrientation::TargetReferenced => target_normal,
        };
        let normal = if dot(plane.normal, toward) < 0. { plane.normal.map(|v| -v) } else { plane.normal };
        if dot(normal, target_normal) < self.normal_dot {
            return unknown(Observation::Normal);
        }
        let offset = dot(sub(point, plane.centroid), normal);
        let closest: Point = std::array::from_fn(|a| point[a] - normal[a] * offset);
        if offset.abs() > self.distance {
            return unknown(Observation::Distance);
        }
        let depth = dot(sub(closest, point), target_normal);
        let rounding = 16. * f64::EPSILON * point.iter().chain(&closest).fold(1_f64, |m, v| m.max(v.abs()));
        if depth < -(self.behind + rounding) {
            return unknown(Observation::Behind);
        }
        let mut color = [0.; 3];
        for &(index, _) in &self.support {
            let rgb = &self.colors[index as usize * 3..index as usize * 3 + 3];
            for (sum, byte) in color.iter_mut().zip(rgb) {
                *sum += f64::from(*byte) / 255.;
            }
        }
        let n = self.support.len() as f64;
        Ok((Observation::Observed, [color[0] / n, color[1] / n, color[2] / n, 1.]))
    }
    /// Least-squares plane through the current support, or None when too sparse.
    fn fit(&self, budget: &mut TransferBudget) -> Result<Option<Plane>, String> {
        budget.charge(self.support.len() + 1)?;
        if self.support.len() < self.min_neighbors {
            return Ok(None);
        }
        let n = self.support.len() as f64;
        let mut centroid = [0.; 3];
        for &(index, _) in &self.support {
            let p = self.positions[index as usize];
            for a in 0..3 { centroid[a] += p[a] / n; }
        }
        let mut covariance = Matrix3::zeros();
        for &(index, _) in &self.support {
            let d = sub(self.positions[index as usize], centroid);
            for i in 0..3 { for j in 0..3 { covariance[(i, j)] += d[i] * d[j] / n; } }
        }
        let eigen = SymmetricEigen::new(covariance);
        let values: [f64; 3] = std::array::from_fn(|i| eigen.eigenvalues[i]);
        let mut order = [0_usize, 1, 2];
        order.sort_by(|a, b| values[*a].total_cmp(&values[*b]));
        let smallest = order[0];
        let column = eigen.eigenvectors.column(smallest);
        let normal = [column[0], column[1], column[2]];
        let length = dot(normal, normal).sqrt();
        // A collinear support has no plane; the middle eigenvalue must carry extent.
        if !length.is_finite() || length == 0. || values[order[1]] <= 1e-12 * self.radius * self.radius {
            return Ok(None);
        }
        Ok(Some(Plane { centroid, normal: normal.map(|v| v / length), rms: values[smallest].max(0.).sqrt() }))
    }
}
struct Plane {
    centroid: Point,
    normal: Point,
    rms: f64,
}
#[cfg(test)]
#[path = "transfer_points_tests.rs"]
mod tests;
