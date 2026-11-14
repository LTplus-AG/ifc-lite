// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Host-side ray parity against the cutter through a per-component BVH
//! (`BComponents::inside`). See [`BComponents::component_inside`] for why the
//! verdict equals the full scan's.

use super::super::super::broadphase::Bvh;
use super::super::ray_parity::{exact_seg_hits_tri, point_inside, ray_dir, sound_far};
use super::super::Tri;
use super::BComponents;

impl BComponents<'_> {
    /// [`point_inside`] for component `k`, with the same far endpoint (the same
    /// [`sound_far`] over the same inflated box) and the same exact crossing
    /// test, but the triangles tested come from a BVH instead of a full scan.
    ///
    /// Verdict-identical by construction:
    /// - an exact crossing means the segment meets the triangle at a point inside
    ///   the triangle's (exact) AABB, so the triangle passes the BVH's slab tests
    ///   unless rounding in those tests exceeds the pad;
    /// - the pad is at least `PAD_REL * reach`, where `reach` bounds every
    ///   coordinate of the tree and of the query segment. `operand_extent` is at
    ///   least twice the component's largest coordinate and `ray_dir`'s smallest
    ///   component is about 0.30, so every slab denominator `|far_i - p_i|` is at
    ///   least `reach / 40`, and the slab test's rounding stays below about
    ///   `500 * f64::EPSILON * reach` (about `1.1e-13 * reach`), some 8000 times
    ///   under the pad `2^-30 * reach`;
    /// - a query whose segment reaches beyond `reach` falls back to the full scan;
    /// - each triangle is one BVH leaf and a tree visits a leaf at most once, so
    ///   the candidates hold every exactly-crossed triangle exactly once and the
    ///   crossing count, hence its parity, equals the full scan's;
    /// - the exact test uses explicit `orient3d` only, so no escalation is counted
    ///   on either path and the #1109 budget trips at the same points.
    pub(super) fn component_inside(&self, k: usize, comp: &[Tri], p: [f64; 3]) -> bool {
        const PAD_REL: f64 = 1.0 / 1_073_741_824.0; // 2^-30
        if comp.is_empty() {
            return false; // no crossings to count, as in `point_inside`
        }
        #[cfg(test)]
        if super::classify_bvh_tests::FORCE_LINEAR.with(|f| f.get()) {
            return point_inside(p, comp, self.exts[k], self.aabbs[k]);
        }
        let far = sound_far(p, ray_dir(), self.exts[k], self.aabbs[k]);
        let (bvh, reach) = self.ray_bvhs[k].get_or_init(|| {
            let (lo, hi) = self.aabbs[k];
            let box_mag = (0..3).fold(0.0f64, |m, i| m.max(lo[i].abs()).max(hi[i].abs()));
            // Covers the tree and any segment that starts within a few extents of it.
            let reach = 4.0 * (box_mag + self.exts[k]);
            (Bvh::build_with_min_pad(comp, PAD_REL * reach), reach)
        });
        let query_mag = (0..3).fold(0.0f64, |m, i| m.max(p[i].abs()).max(far[i].abs()));
        if !(query_mag <= *reach) {
            return point_inside(p, comp, self.exts[k], self.aabbs[k]);
        }
        let mut candidates = Vec::new();
        bvh.ray_candidates(p, far, &mut candidates);
        candidates.iter().filter(|&&i| exact_seg_hits_tri(p, far, &comp[i as usize])).count() % 2 == 1
    }
}
