// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Broadphase — a hand-rolled f64 median-split AABB BVH over one operand's
//! triangles, queried by the other operand's triangle AABBs to replace the
//! O(|A|·|B|) all-pairs scan.
//!
//! The BVH is a conservative FILTER only: it returns the set of AABB-overlapping
//! triangle indices (the exact pairs the old all-pairs+bbox loop produced). The
//! float SAH/centroid sort never decides topology — callers canonicalise the
//! candidate pairs by exact `(i,j)` keys before processing, so the arrangement
//! topology (and the pinned determinism manifests) are byte-identical.

type Tri = [[f64; 3]; 3];
type Aabb = ([f64; 3], [f64; 3]);

pub fn tri_aabb(t: &Tri) -> Aabb {
    let mut lo = t[0];
    let mut hi = t[0];
    for p in t.iter().skip(1) {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    (lo, hi)
}

fn overlap(a: &Aabb, b: &Aabb) -> bool {
    (0..3).all(|k| a.0[k] <= b.1[k] && b.0[k] <= a.1[k])
}

struct Node {
    aabb: Aabb,
    tri: u32, // u32::MAX ⇒ inner node
    left: u32,
    right: u32,
}

pub struct Bvh {
    nodes: Vec<Node>,
    root: u32,
}

impl Bvh {
    pub fn build(tris: &[Tri]) -> Bvh {
        let mut items: Vec<(u32, Aabb, [f64; 3])> = tris
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let bb = tri_aabb(t);
                let c = [
                    0.5 * (bb.0[0] + bb.1[0]),
                    0.5 * (bb.0[1] + bb.1[1]),
                    0.5 * (bb.0[2] + bb.1[2]),
                ];
                (i as u32, bb, c)
            })
            .collect();
        let mut nodes = Vec::new();
        let root = if items.is_empty() {
            u32::MAX
        } else {
            build_node(&mut nodes, &mut items)
        };
        Bvh { nodes, root }
    }

    /// Append the indices of every triangle whose AABB overlaps `q`.
    pub fn query(&self, q: &Aabb, out: &mut Vec<u32>) {
        if self.root != u32::MAX {
            self.descend(self.root, q, out);
        }
    }

    fn descend(&self, idx: u32, q: &Aabb, out: &mut Vec<u32>) {
        let n = &self.nodes[idx as usize];
        if !overlap(&n.aabb, q) {
            return;
        }
        if n.tri != u32::MAX {
            out.push(n.tri);
        } else {
            self.descend(n.left, q, out);
            self.descend(n.right, q, out);
        }
    }
}

fn bounds(items: &[(u32, Aabb, [f64; 3])]) -> Aabb {
    let mut lo = items[0].1 .0;
    let mut hi = items[0].1 .1;
    for it in &items[1..] {
        for k in 0..3 {
            lo[k] = lo[k].min(it.1 .0[k]);
            hi[k] = hi[k].max(it.1 .1[k]);
        }
    }
    (lo, hi)
}

fn build_node(nodes: &mut Vec<Node>, items: &mut [(u32, Aabb, [f64; 3])]) -> u32 {
    let bb = bounds(items);
    if items.len() == 1 {
        let idx = nodes.len() as u32;
        nodes.push(Node { aabb: bb, tri: items[0].0, left: 0, right: 0 });
        return idx;
    }
    // split on the longest centroid axis at the median
    let mut span = [0.0f64; 3];
    let (mut clo, mut chi) = (items[0].2, items[0].2);
    for it in items.iter() {
        for k in 0..3 {
            clo[k] = clo[k].min(it.2[k]);
            chi[k] = chi[k].max(it.2[k]);
        }
    }
    for k in 0..3 {
        span[k] = chi[k] - clo[k];
    }
    let axis = if span[0] >= span[1] && span[0] >= span[2] {
        0
    } else if span[1] >= span[2] {
        1
    } else {
        2
    };
    // total_cmp: identical to partial_cmp for the finite centroids built here,
    // but a total order by construction (no Equal-on-NaN escape hatch).
    items.sort_by(|a, b| a.2[axis].total_cmp(&b.2[axis]));
    let mid = items.len() / 2;
    let (l, r) = items.split_at_mut(mid);
    let left = build_node(nodes, l);
    let right = build_node(nodes, r);
    let idx = nodes.len() as u32;
    nodes.push(Node { aabb: bb, tri: u32::MAX, left, right });
    idx
}

/// All AABB-overlapping `(i, j)` pairs between `a` and `b`, sorted by `(i, j)` —
/// a drop-in for the all-pairs+bbox loop with identical output order.
pub fn candidate_pairs(a: &[Tri], b: &[Tri]) -> Vec<(usize, usize)> {
    let bvh = Bvh::build(b);
    let mut pairs = Vec::new();
    let mut cand = Vec::new();
    for (i, ta) in a.iter().enumerate() {
        cand.clear();
        bvh.query(&tri_aabb(ta), &mut cand);
        for &j in &cand {
            pairs.push((i, j as usize));
        }
    }
    pairs.sort_unstable();
    pairs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn brute(a: &[Tri], b: &[Tri]) -> Vec<(usize, usize)> {
        let mut p = Vec::new();
        for (i, ta) in a.iter().enumerate() {
            for (j, tb) in b.iter().enumerate() {
                if overlap(&tri_aabb(ta), &tri_aabb(tb)) {
                    p.push((i, j));
                }
            }
        }
        p.sort_unstable();
        p
    }

    #[test]
    fn bvh_candidate_pairs_match_brute_force() {
        // a fan of triangles overlapping a moved fan — the BVH must return EXACTLY
        // the all-pairs+bbox result (in identical (i,j) order).
        let mk = |dx: f64| -> Vec<Tri> {
            (0..20)
                .map(|i| {
                    let x = dx + i as f64 * 0.3;
                    [[x, 0., 0.], [x + 0.5, 0., 0.], [x, 0.5, 0.4]]
                })
                .collect()
        };
        let a = mk(0.0);
        let b = mk(1.7);
        assert_eq!(candidate_pairs(&a, &b), brute(&a, &b));
        // disjoint sets → no pairs
        let far = mk(1000.0);
        assert!(candidate_pairs(&a, &far).is_empty());
    }
}
