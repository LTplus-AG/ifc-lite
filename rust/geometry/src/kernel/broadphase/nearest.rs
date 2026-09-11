// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{aabb_contains, Aabb, Bvh};

impl Bvh {
    /// Nearest leaf within a finite radius, visiting the nearer child first and
    /// shrinking the conservative query radius after each exact leaf distance.
    /// Retains candidates in the final nearest-distance plus ambiguity band;
    /// their exact distances let the caller reject near ties without a second walk.
    /// The callback must return the squared distance to that leaf's primitive.
    /// Equal distances retain the original left-to-right candidate order.
    /// Every node and callback consumes the caller's aggregate work budget;
    /// exhaustion returns an error, never a partial nearest result.
    pub fn nearest_point_bounded(
        &self,
        point: [f64; 3],
        radius: f64,
        remaining: &mut usize,
        ambiguity: f64,
        candidates: &mut Vec<(u32, f64)>,
        mut distance_squared: impl FnMut(u32) -> f64,
    ) -> Result<Option<(u32, f64)>, &'static str> {
        if !point.iter().all(|v| v.is_finite()) || !radius.is_finite() || radius < 0.
            || !ambiguity.is_finite() || ambiguity < 0. || !(radius + ambiguity).is_finite() {
            return Err("BVH query requires a finite point and nonnegative radius");
        }
        candidates.clear();
        if self.root == u32::MAX { return Ok(None); }
        let mut pending = [0_u32; 64];
        pending[0] = self.root;
        let mut count = 1;
        let mut best: Option<(u32, u32, f64)> = None;
        let mut limit = radius + ambiguity;
        while count > 0 {
            count -= 1;
            let index = pending[count];
            charge(remaining)?;
            let node = &self.nodes[index as usize];
            if !aabb_contains(point, &node.aabb, self.pad + limit) { continue; }
            if node.tri != u32::MAX {
                charge(remaining)?;
                let d2 = distance_squared(node.tri);
                if !d2.is_finite() || d2 < 0. {
                    return Err("BVH primitive distance must be finite and nonnegative");
                }
                if d2.sqrt() > limit { continue; }
                candidates.push((node.tri, d2));
                if best.is_none_or(|(_, old_index, old)| d2 < old || (d2 == old && index < old_index)) {
                    best = Some((node.tri, index, d2));
                    limit = d2.sqrt() + ambiguity;
                }
            } else {
                if count + 2 > pending.len() { return Err("BVH query stack budget exceeded"); }
                let left = box_distance(point, &self.nodes[node.left as usize].aabb);
                let right = box_distance(point, &self.nodes[node.right as usize].aabb);
                // Ordering only; pruning still uses the existing padded predicate.
                let (near, far) = if left <= right { (node.left, node.right) } else { (node.right, node.left) };
                pending[count] = far;
                pending[count + 1] = near;
                count += 2;
            }
        }
        *remaining = remaining.checked_sub(candidates.len()).ok_or("BVH query work budget exhausted")?;
        candidates.retain(|(_, d2)| d2.sqrt() <= limit);
        Ok(best.filter(|(_, _, d2)| d2.sqrt() <= radius).map(|(id, _, d2)| (id, d2)))
    }
}
fn charge(remaining: &mut usize) -> Result<(), &'static str> {
    *remaining = remaining.checked_sub(1).ok_or("BVH query work budget exhausted")?;
    Ok(())
}
fn box_distance(point: [f64; 3], bounds: &Aabb) -> f64 {
    (0..3).map(|axis| {
        let d = (bounds.0[axis] - point[axis]).max(point[axis] - bounds.1[axis]).max(0.);
        d * d
    }).sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn d2(a: [f64; 3], b: [f64; 3]) -> f64 {
        (0..3).map(|axis| (a[axis] - b[axis]).powi(2)).sum()
    }
    #[test]
    fn transfer_4381_nearest_and_band_match_independent_distances() {
        let points: Vec<_> = (0..125).map(|i| [f64::from(i % 5), f64::from((i / 5) % 5), f64::from(i / 25)]).collect();
        let tree = Bvh::build(&points.iter().map(|p| [*p; 3]).collect::<Vec<_>>());
        for query in [[0.1, 0.2, 0.3], [2.5, 2.5, 2.5], [-2., 1., 3.], [4., 4., 4.]] {
            let mut order = Vec::new();
            tree.point_candidates(query, 10., &mut order);
            let mut expected = None;
            for id in order {
                let distance = d2(points[id as usize], query);
                if expected.is_none_or(|(_, old)| distance < old) { expected = Some((id, distance)); }
            }
            let mut candidates = Vec::new();
            let actual = tree.nearest_point_bounded(query, 10., &mut 1000, 0.4, &mut candidates,
                |id| d2(points[id as usize], query)).unwrap();
            assert_eq!(actual, expected, "nearest and original left-to-right tie precedence");
            let nearest = expected.unwrap().1.sqrt();
            let expected_band: Vec<_> = points.iter().enumerate().filter_map(|(id, point)| {
                let distance = d2(*point, query);
                (distance.sqrt() <= nearest + 0.4).then_some((id as u32, distance))
            }).collect();
            candidates.sort_by_key(|(id, _)| *id);
            assert_eq!(candidates, expected_band, "no near-tie observation may be pruned");
        }
    }
    #[test]
    fn transfer_4381_nearest_refuses_budget_and_invalid_distance() {
        let tree = Bvh::build(&[[[0.; 3]; 3], [[2.; 3]; 3]]);
        assert!(tree.nearest_point_bounded([0.; 3], 1., &mut 0, 0., &mut Vec::new(), |_| 0.).is_err());
        assert!(tree.nearest_point_bounded([0.; 3], 1., &mut 100, 0., &mut Vec::new(), |_| f64::NAN).is_err());
        assert!(tree.nearest_point_bounded([0.; 3], 1., &mut 100, -1., &mut Vec::new(), |_| 0.).is_err());
        assert_eq!(tree.nearest_point_bounded([8.; 3], 1., &mut 100, 0., &mut Vec::new(), |_| 108.).unwrap(), None);
        assert_eq!(Bvh::build(&[]).nearest_point_bounded([0.; 3], 1., &mut 0, 0., &mut Vec::new(), |_| 0.).unwrap(), None);
    }
}
