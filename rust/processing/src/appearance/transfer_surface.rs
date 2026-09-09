// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{transfer_budget::TransferBudget, transfer_math::*, transfer_types::*};
use ifc_lite_geometry::kernel::broadphase::Bvh;

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
    candidates: Vec<u32>,
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
        budget.reserve(mesh.triangles.len() * 512 + mesh.positions.len() * 40)?;
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
            candidates: Vec::new(),
            distance: request.max_distance_metres,
            normal_dot: request.min_normal_dot,
            ambiguity: request.ambiguity_distance_metres,
        })
    }
    pub fn observe(
        &mut self,
        point: Point,
        target_normal: Point,
        budget: &mut TransferBudget,
    ) -> Result<(Observation, [f64; 2]), String> {
        budget.charge(1)?;
        self.candidates.clear();
        self.tree.point_candidates_bounded(
            point,
            self.distance + self.ambiguity,
            &mut self.candidates,
            &mut budget.work,
        )?;
        let mut nearest = None;
        for &i in &self.candidates {
            budget.charge(1)?;
            let (weights, d2) = closest(self.triangles[i as usize].points, point);
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
        for &i in &self.candidates {
            if i == index {
                continue;
            }
            budget.charge(1)?;
            let other = &self.triangles[i as usize];
            let (_, other_distance) = closest(other.points, point);
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
