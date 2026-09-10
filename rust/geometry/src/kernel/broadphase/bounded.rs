// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{aabb_contains, Bvh};

impl Bvh {
    /// Conservative near-point candidates using this same tree/padding policy,
    /// charging every visited node to a caller-owned aggregate work budget.
    /// On exhaustion discard `out`: a partial candidate list is not a result.
    pub fn point_candidates_bounded(
        &self,
        point: [f64; 3],
        radius: f64,
        out: &mut Vec<u32>,
        remaining: &mut usize,
    ) -> Result<(), &'static str> {
        if !point.iter().all(|v| v.is_finite()) || !radius.is_finite() || radius < 0. {
            return Err("BVH query requires a finite point and nonnegative radius");
        }
        if self.root == u32::MAX {
            return Ok(());
        }
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
            if !aabb_contains(point, &node.aabb, self.pad + radius) {
                continue;
            }
            if node.tri != u32::MAX {
                out.push(node.tri);
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
}
