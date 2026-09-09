// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{transfer_budget::TransferBudget, transfer_math::*, transfer_types::*};
use ifc_lite_geometry::kernel::broadphase::{Bvh, PointCandidate};
use std::collections::HashMap;

pub(super) struct Triangle {
    pub points: [Point; 3],
    pub uv: [[f64; 2]; 3],
    pub normal: Point,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Observation {
    Observed,
    Distance,
    Normal,
    Ambiguous,
}
pub(super) struct Surface {
    pub triangles: Vec<Triangle>,
    tree: Bvh,
    candidates: Vec<PointCandidate>,
    matches: Vec<(u32, Point, f64)>,
    region: Option<[Point; 3]>,
    region_bounds: Option<(Point, Point)>,
    observations: HashMap<[u64; 6], (Observation, [f64; 2])>,
    cells: [Option<(usize, usize)>; 64],
    cell_candidates: Vec<usize>,
    distance: f64,
    normal_dot: f64,
    ambiguity: f64,
}
impl Surface {
    pub fn new(
        request: &MeshTransferRequest,
        frame: &TransferFrame,
        budget: &mut TransferBudget,
    ) -> Result<Self, String> {
        let mesh = &request.source_mesh;
        budget.category=0;
        budget.reserve(256 * 128 + 65536 * std::mem::size_of::<usize>() + 64 * 32)?;
        if mesh.positions.len() < 3
            || mesh.positions.len() > 200_000
            || mesh.triangles.is_empty()
            || mesh.triangles.len() > 200_000
            || mesh.uvs.len() != mesh.positions.len()
            || mesh.base_color_factor != [1.; 4]
        {
            return Err(
                "Transfer requires one bounded textured mesh with neutral opaque baseColorFactor"
                    .into(),
            );
        }
        if mesh
            .positions
            .iter()
            .flatten()
            .any(|v| !v.is_finite() || v.abs() > 1e12)
            || mesh
                .uvs
                .iter()
                .flatten()
                .any(|v| !v.is_finite() || v.abs() > 1e6)
        {
            return Err("Transfer source coordinates/UVs exceed their finite bounds".into());
        }
        // Include the full-capacity current-region leaves and exact-distance scratch.
        // Only one region is retained; no target-count multiplier is allocated.
        budget.reserve(
            mesh.triangles.len()
                * (512
                    + std::mem::size_of::<PointCandidate>()
                    + std::mem::size_of::<(u32, Point, f64)>())
                + mesh.positions.len() * 40,
        )?;
        // Balanced median BVH build: conservatively charge input sorting at every level.
        let levels = usize::BITS as usize - mesh.triangles.len().leading_zeros() as usize;
        budget.charge(mesh.triangles.len() * levels * levels + mesh.positions.len())?;
        let points: Vec<_> = mesh
            .positions
            .iter()
            .map(|p| transform(frame, *p))
            .collect();
        let mut triangles = Vec::with_capacity(mesh.triangles.len());
        for indices in &mesh.triangles {
            if indices.iter().any(|i| *i as usize >= points.len()) {
                return Err("Transfer source triangle index is out of range".into());
            }
            let points = indices.map(|i| points[i as usize]);
            let (normal, _) = normal(points)?;
            triangles.push(Triangle {
                points,
                normal,
                uv: indices.map(|i| mesh.uvs[i as usize]),
            });
        }
        let positions: Vec<_> = triangles.iter().map(|t| t.points).collect();
        let tree = Bvh::build(&positions);
        Ok(Self {
            triangles,
            tree,
            candidates: Vec::with_capacity(mesh.triangles.len()),
            matches: Vec::with_capacity(mesh.triangles.len()),
            region: None,
            region_bounds: None,
            observations: HashMap::with_capacity(128),
            cells: [None; 64],
            cell_candidates: Vec::with_capacity(65536),
            distance: request.max_distance_metres,
            normal_dot: request.min_normal_dot,
            ambiguity: request.ambiguity_distance_metres,
        })
    }
    /// One triangle cache only. Centroid and guard/interior pixel positions lie
    /// in its convex hull; numerical padding admits interpolation roundoff.
    pub fn prepare_region(
        &mut self,
        points: [Point; 3],
        budget: &mut TransferBudget,
    ) -> Result<(), String> {
        if self.region == Some(points) {
            return Ok(());
        }
        budget.category=1; budget.charge(3)?;
        let guard = points.iter().flatten().fold(1_f64, |m, v| m.max(v.abs())) * 16. * f64::EPSILON;
        let min = std::array::from_fn(|a| {
            points.iter().map(|p| p[a]).fold(f64::INFINITY, f64::min) - guard
        });
        let max = std::array::from_fn(|a| {
            points
                .iter()
                .map(|p| p[a])
                .fold(f64::NEG_INFINITY, f64::max)
                + guard
        });
        self.candidates.clear();
        self.observations.clear();
        self.cells.fill(None);
        self.cell_candidates.clear();
        let before=budget.work;
        let query=self.tree.bounds_candidates_bounded(
            min,
            max,
            self.distance + self.ambiguity,
            &mut self.candidates,
            &mut budget.work,
        );
        budget.charges[1]+=before-budget.work;
        query?;
        self.region = Some(points);
        self.region_bounds = Some((min, max));
        Ok(())
    }
    pub fn observe(
        &mut self,
        point: Point,
        target_normal: Point,
        budget: &mut TransferBudget,
    ) -> Result<(Observation, [f64; 2]), String> {
        budget.category=2; budget.charge(1)?;
        if self
            .region_bounds
            .is_none_or(|(min, max)| (0..3).any(|a| point[a] < min[a] || point[a] > max[a]))
        {
            self.prepare_region([point; 3], budget)?;
        }
        let key = std::array::from_fn(|i| {
            if i < 3 {
                point[i].to_bits()
            } else {
                target_normal[i - 3].to_bits()
            }
        });
        if let Some(result) = self.observations.get(&key) {
            budget.calls[2]+=1;return Ok(*result);
        }
        budget.calls[3]+=1;let result = self.observe_uncached(point, target_normal, budget)?;
        if self.observations.len() < 128 {
            self.observations.insert(key, result);
        }
        Ok(result)
    }
    fn cell(
        &mut self,
        point: Point,
        budget: &mut TransferBudget,
    ) -> Result<(usize, usize), String> {
        let (min, max) = self.region_bounds.ok_or("Missing transfer region bounds")?;
        let bins: [usize; 3] = std::array::from_fn(|a| {
            (((point[a] - min[a]) / (max[a] - min[a]) * 4.).floor() as usize).min(3)
        });
        let index = bins[0] + 4 * bins[1] + 16 * bins[2];
        if let Some(range) = self.cells[index] {
            return Ok(range);
        }
        let guard = point.iter().fold(1_f64, |m, v| m.max(v.abs())) * 16. * f64::EPSILON;
        let cell_min =
            std::array::from_fn(|a| min[a] + (max[a] - min[a]) * bins[a] as f64 / 4. - guard);
        let cell_max =
            std::array::from_fn(|a| min[a] + (max[a] - min[a]) * (bins[a] + 1) as f64 / 4. + guard);
        let start = self.cell_candidates.len();
        for (i, candidate) in self.candidates.iter().enumerate() {
            budget.category=2; budget.charge(1)?;
            if candidate.overlaps(cell_min, cell_max) {
                if self.cell_candidates.len() == 65536 {
                    return Err("Transfer region candidate memory budget exhausted".into());
                }
                self.cell_candidates.push(i);
            }
        }
        let range = (start, self.cell_candidates.len());
        self.cells[index] = Some(range);
        Ok(range)
    }
    fn observe_uncached(
        &mut self,
        point: Point,
        target_normal: Point,
        budget: &mut TransferBudget,
    ) -> Result<(Observation, [f64; 2]), String> {
        let (start, end) = self.cell(point, budget)?;
        self.matches.clear();
        let mut nearest = None;
        for ordinal in start..end {
            let candidate = &self.candidates[self.cell_candidates[ordinal]];
            budget.category=2; budget.charge(1)?;
            if !candidate.contains(point) { continue; }
            budget.category=2; budget.charge(1)?;
            budget.charges[2]-=1; budget.charges[3]+=1;
            let i = candidate.triangle;
            let (weights, d2) = closest(self.triangles[i as usize].points, point);
            self.matches.push((i, weights, d2));
            if nearest.as_ref().is_none_or(|(_, _, best)| d2 < *best) {
                nearest = Some((i, weights, d2));
            }
        }
        let Some((index, weights, d2)) = nearest else {
            return Ok((Observation::Distance, [0.; 2]));
        };
        let distance = d2.sqrt();
        if distance > self.distance {
            return Ok((Observation::Distance, [0.; 2]));
        }
        let nearest = &self.triangles[index as usize];
        for &(i, _, other_distance) in &self.matches {
            if i == index {
                continue;
            }
            budget.category=2; budget.charge(1)?;
            budget.charges[2]-=1; budget.charges[4]+=1;
            let other = &self.triangles[i as usize];
            if other_distance.sqrt() <= distance + self.ambiguity
                && !continuous_neighbor(nearest, other)
            {
                return Ok((Observation::Ambiguous, [0.; 2]));
            }
        }
        // Never look through an incompatible nearest face for a farther matching normal.
        if dot(nearest.normal, target_normal) < self.normal_dot {
            return Ok((Observation::Normal, [0.; 2]));
        }
        Ok((
            Observation::Observed,
            super::page_atlas::interpolate(nearest.uv, weights),
        ))
    }
}
/// Only exact shared edges with matching UVs and consistent normals are one
/// observed surface. Duplicate overlapping faces and UV seams stay ambiguous.
fn continuous_neighbor(a: &Triangle, b: &Triangle) -> bool {
    if dot(a.normal, b.normal) < 0.999999 {
        return false;
    }
    let mut shared = [(0, 0); 3];
    let mut count = 0;
    for (i, point) in a.points.iter().enumerate() {
        if let Some(j) = b.points.iter().position(|p| p == point) {
            if a.uv[i] != b.uv[j] {
                return false;
            }
            shared[count] = (i, j);
            count += 1;
        }
    }
    if count != 2 {
        return false;
    }
    let [(a0, b0), (a1, b1)] = [shared[0], shared[1]];
    let a2 = 3 - a0 - a1;
    let b2 = 3 - b0 - b1;
    let edge = sub(a.points[a1], a.points[a0]);
    // Shared-edge triangles on the same side overlap; they are not neighbors.
    dot(
        cross(edge, sub(a.points[a2], a.points[a0])),
        cross(edge, sub(b.points[b2], a.points[a0])),
    ) < 0.
}
