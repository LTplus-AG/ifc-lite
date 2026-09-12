// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Target self-occlusion for point-cloud sources (#4381). A scan point that can
//! only be reached from the sampled IFC face by passing through another face of
//! the same item lies beyond that solid: the far side of a thin wall, or clutter
//! behind it. Unlike an oriented mesh, unoriented points cannot say which way
//! they face, so this rule is what keeps opposite thin-wall faces separate under
//! every orientation source, independent of the behind bound.
use super::{transfer_budget::TransferBudget, transfer_math::*, transfer_target::TargetTriangle};
use ifc_lite_geometry::kernel::broadphase::Bvh;

pub(super) struct Occluder {
    triangles: Vec<[Point; 3]>,
    normals: Vec<Point>,
    tree: Bvh,
    candidates: Vec<u32>,
}
impl Occluder {
    pub fn new(targets: &[TargetTriangle], budget: &mut TransferBudget) -> Result<Self, String> {
        budget.reserve(targets.len() * 192)?;
        let levels = usize::BITS as usize - targets.len().leading_zeros() as usize;
        budget.charge(targets.len() * levels * levels + 1)?;
        let triangles: Vec<_> = targets.iter().map(|t| t.points).collect();
        Ok(Self {
            normals: targets.iter().map(|t| t.normal).collect(),
            tree: Bvh::build(&triangles),
            triangles,
            candidates: Vec::new(),
        })
    }
    /// Whether the open segment from the sampled face point `from` to the scan
    /// point `to` crosses a target face other than the plane `from` lies on.
    /// Coplanar faces (the sampled face and its neighbors) never block; a
    /// crossing at the segment's far end does, because a scan point exactly on
    /// another face belongs to that face.
    pub fn blocked(&mut self, from: Point, to: Point, budget: &mut TransferBudget) -> Result<bool, String> {
        self.candidates.clear();
        self.tree
            .ray_candidates_bounded(from, to, &mut self.candidates, &mut budget.work)
            .map_err(str::to_owned)?;
        budget.charge(self.candidates.len() + 1)?;
        let magnitude = from.iter().chain(&to).fold(1_f64, |m, v| m.max(v.abs()));
        let tolerance = 64. * f64::EPSILON * magnitude;
        let direction = sub(to, from);
        for &index in &self.candidates {
            let triangle = self.triangles[index as usize];
            let normal = self.normals[index as usize];
            let offset = dot(sub(from, triangle[0]), normal);
            if offset.abs() <= tolerance {
                continue; // `from` lies on this face's plane: the sampled face or a coplanar neighbor.
            }
            let slope = dot(direction, normal);
            if slope.abs() <= f64::MIN_POSITIVE {
                continue;
            }
            let t = -offset / slope;
            if t < 0. || t > 1. + 1e-9 {
                continue;
            }
            let hit: Point = std::array::from_fn(|a| from[a] + direction[a] * t);
            if inside(triangle, normal, hit, tolerance) {
                return Ok(true);
            }
        }
        Ok(false)
    }
}
/// Conservative containment: edge-touching hits count as inside.
fn inside(triangle: [Point; 3], normal: Point, hit: Point, tolerance: f64) -> bool {
    let [a, b, c] = triangle;
    let edge = |p: Point, q: Point| dot(cross(sub(q, p), sub(hit, p)), normal);
    let (ab, bc, ca) = (edge(a, b), edge(b, c), edge(c, a));
    let scale = dot(cross(sub(b, a), sub(c, a)), normal).abs().max(f64::MIN_POSITIVE);
    let slack = tolerance * scale.sqrt();
    (ab >= -slack && bc >= -slack && ca >= -slack) || (ab <= slack && bc <= slack && ca <= slack)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wall() -> Vec<TargetTriangle> {
        // 4 mm partition: front face at y=0 facing -Y, back face at y=0.004 facing +Y.
        let quad = move |y: f64, sign: f64| {
            let corners = [[0., y, 0.], [1., y, 0.], [1., y, 1.], [0., y, 1.]];
            [[corners[0], corners[1], corners[2]], [corners[0], corners[2], corners[3]]]
                .into_iter()
                .map(move |points| TargetTriangle { points, normal: [0., sign, 0.], area: 0.5 })
        };
        quad(0., -1.).chain(quad(0.004, 1.)).collect()
    }
    #[test]
    fn issue_4381_points_beyond_the_opposite_face_are_blocked_but_own_side_and_edges_are_not() {
        let mut budget = TransferBudget::new();
        let mut occluder = Occluder::new(&wall(), &mut budget).unwrap();
        let front = [0.3, 0., 0.5];
        assert!(!occluder.blocked(front, [0.3, -0.001, 0.5], &mut budget).unwrap(), "own side");
        assert!(!occluder.blocked(front, [0.3, 0.002, 0.5], &mut budget).unwrap(), "inside the solid");
        assert!(occluder.blocked(front, [0.3, 0.005, 0.5], &mut budget).unwrap(), "beyond the back face");
        assert!(occluder.blocked(front, [0.3, 0.004, 0.5], &mut budget).unwrap(), "exactly on the back face");
        let back = [0.3, 0.004, 0.5];
        assert!(!occluder.blocked(back, [0.3, 0.005, 0.5], &mut budget).unwrap());
        assert!(occluder.blocked(back, [0.3, -0.001, 0.5], &mut budget).unwrap());
        assert!(!occluder.blocked(back, [0.31, 0.004, 0.52], &mut budget).unwrap(), "coplanar neighbor");
        // Around the wall's open edge nothing is crossed.
        assert!(!occluder.blocked([0.999, 0., 0.5], [1.002, 0.006, 0.5], &mut budget).unwrap());
        let mut exhausted = TransferBudget::new();
        exhausted.work = 1;
        assert!(occluder.blocked(front, [0.3, 0.005, 0.5], &mut exhausted).unwrap_err().contains("budget"));
    }
}
