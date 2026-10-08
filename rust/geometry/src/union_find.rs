// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Minimal union-find with path halving, shared by mesh cavity removal and
//! scan plane merging (`ifc_lite_processing::scan_segmentation`).
//!
//! `union(a, b)` always re-parents `b`'s root under `a`'s root, so the root of
//! a set depends only on the sequence of unions, never on hashing or memory
//! layout: callers that union in a deterministic order get deterministic roots.

/// Disjoint sets over `0..n`.
pub struct UnionFind {
    parent: Vec<u32>,
}

impl UnionFind {
    /// `n` singleton sets.
    pub fn new(n: usize) -> Self {
        Self {
            parent: (0..n as u32).collect(),
        }
    }

    /// Representative of `x`'s set (halves the path as it walks; the walk is
    /// iterative and bounded by the set size).
    pub fn find(&mut self, mut x: u32) -> u32 {
        while self.parent[x as usize] != x {
            let grand = self.parent[self.parent[x as usize] as usize];
            self.parent[x as usize] = grand;
            x = grand;
        }
        x
    }

    /// Merge the sets of `a` and `b`; `b`'s root is re-parented under `a`'s.
    /// Returns whether two distinct sets were joined.
    pub fn union(&mut self, a: u32, b: u32) -> bool {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            self.parent[rb as usize] = ra;
        }
        ra != rb
    }
}
