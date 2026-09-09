// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{Bvh, Node};

/// A leaf from a conservative bounds query, retaining the identical expanded
/// bounds used by point traversal. Reuse avoids changing padding/rounding policy.
#[derive(Clone, Copy)]
pub struct PointCandidate {
    pub triangle: u32,
    min: [f64; 3],
    max: [f64; 3],
}
impl PointCandidate {
    pub fn overlaps(&self, min: [f64; 3], max: [f64; 3]) -> bool {
        (0..3).all(|a| max[a] >= self.min[a] && min[a] <= self.max[a])
    }
    pub fn contains(&self, point: [f64; 3]) -> bool {
        (0..3).all(|axis| point[axis] >= self.min[axis] && point[axis] <= self.max[axis])
    }
}
impl Bvh {
    /// Conservative near-point candidates. Exhaustion never returns a partial success.
    pub fn point_candidates_bounded(
        &self,
        point: [f64; 3],
        radius: f64,
        out: &mut Vec<u32>,
        remaining: &mut usize,
    ) -> Result<(), &'static str> {
        self.walk_bounds_bounded(point, point, radius, remaining, |node, _| {
            out.push(node.tri)
        })
    }
    /// Leaves whose padded boxes overlap the complete target region. Every point
    /// query inside min..max is a subset, in the same deterministic traversal order.
    pub fn bounds_candidates_bounded(
        &self,
        min: [f64; 3],
        max: [f64; 3],
        radius: f64,
        out: &mut Vec<PointCandidate>,
        remaining: &mut usize,
    ) -> Result<(), &'static str> {
        self.walk_bounds_bounded(min, max, radius, remaining, |node, pad| {
            out.push(PointCandidate {
                triangle: node.tri,
                min: node.aabb.0.map(|v| v - pad),
                max: node.aabb.1.map(|v| v + pad),
            })
        })
    }
    fn walk_bounds_bounded(
        &self,
        min: [f64; 3],
        max: [f64; 3],
        radius: f64,
        remaining: &mut usize,
        mut visit: impl FnMut(&Node, f64),
    ) -> Result<(), &'static str> {
        if !min.iter().chain(&max).all(|v| v.is_finite())
            || (0..3).any(|i| min[i] > max[i])
            || !radius.is_finite()
            || radius < 0.
        {
            return Err("BVH query requires finite ordered bounds and nonnegative radius");
        }
        if self.root == u32::MAX {
            return Ok(());
        }
        let pad = self.pad + radius;
        let mut pending = [0_u32; 64];
        pending[0] = self.root;
        let mut count = 1;
        while count > 0 {
            count -= 1;
            let index = pending[count];
            *remaining = remaining
                .checked_sub(1)
                .ok_or("BVH query work budget exhausted")?;
            let node = &self.nodes[index as usize];
            if !(0..3).all(|i| max[i] >= node.aabb.0[i] - pad && min[i] <= node.aabb.1[i] + pad) {
                continue;
            }
            if node.tri != u32::MAX {
                visit(node, pad);
            } else {
                if count + 2 > pending.len() {
                    return Err("BVH query stack budget exceeded");
                }
                pending[count] = node.right;
                pending[count + 1] = node.left;
                count += 2;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn issue_4381_bounded_query_matches_candidates_and_reports_exhaustion() {
        let triangles = [
            [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]],
            [[0., 0., 0.01], [1., 0., 0.01], [0., 1., 0.01]],
        ];
        let tree = Bvh::build(&triangles);
        let mut old = Vec::new();
        tree.point_candidates([0.2, 0.2, 0.], 0.02, &mut old);
        let mut actual = Vec::new();
        let mut budget = 3;
        tree.point_candidates_bounded([0.2, 0.2, 0.], 0.02, &mut actual, &mut budget)
            .unwrap();
        assert_eq!(actual, old);
        assert_eq!(actual.len(), 2);
        assert_eq!(budget, 0);
        assert!(tree
            .point_candidates_bounded([0.2, 0.2, 0.], 0.02, &mut Vec::new(), &mut 2)
            .is_err());
        assert!(tree
            .point_candidates_bounded([f64::NAN, 0., 0.], 0.02, &mut Vec::new(), &mut 10)
            .is_err());
    }
    #[test]
    fn issue_4381_region_reuse_is_identical_to_each_point_query() {
        // Include thin opposite faces, shared boundaries, distant distractors,
        // and large coordinate offsets. Compare order as well as membership:
        // exact-distance ties must retain the original deterministic choice.
        for offset in [0., 1e8, -1e8] {
            let triangles: Vec<_> = (0..64)
                .map(|i| {
                    let x = offset + (i % 8) as f64 * 0.1;
                    let y = (i / 8) as f64 * 0.1;
                    [[x, y, 0.], [x + 0.1, y, 0.], [x, y + 0.1, 0.0001]]
                })
                .collect();
            let tree = Bvh::build(&triangles);
            let min = [offset + 0.2, 0.1, -0.0001];
            let max = [offset + 0.5, 0.6, 0.0002];
            let mut region = Vec::new();
            tree.bounds_candidates_bounded(min, max, 0.001, &mut region, &mut usize::MAX)
                .unwrap();
            for x in 0..=12 {
                for y in 0..=12 {
                    for z in 0..=2 {
                        let p = [
                            min[0] + (max[0] - min[0]) * x as f64 / 12.,
                            min[1] + (max[1] - min[1]) * y as f64 / 12.,
                            min[2] + (max[2] - min[2]) * z as f64 / 2.,
                        ];
                        let cached: Vec<_> = region
                            .iter()
                            .filter(|leaf| leaf.contains(p))
                            .map(|leaf| leaf.triangle)
                            .collect();
                        let mut direct = Vec::new();
                        tree.point_candidates(p, 0.001, &mut direct);
                        assert_eq!(cached, direct);
                    }
                }
            }
            assert!(tree
                .bounds_candidates_bounded(min, max, 0.001, &mut Vec::new(), &mut 0)
                .is_err());
        }
    }
}
