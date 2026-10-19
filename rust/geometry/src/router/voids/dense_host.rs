// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Reached host refinement for the exact multi-opening cut.
use crate::Mesh;

// OPENING-DENSE HOST REFINEMENT: when many openings target the same host
// (a window wall is usually 2 big face-triangles per side), every cut's
// intersection segments pile onto those few triangles — the exact
// arrangement then re-triangulates a single triangle carrying dozens of
// constraints (O(k²)), and the batched N-ary subtract leaves unrecovered
// constraints and degrades to the O(N²) sequential path. Pre-subdividing
// the host spreads the segments across many small triangles (small k each)
// so the batched cut recovers. `consolidate_coplanar` re-triangulates each
// coplanar group afterwards, so the temporary interior vertices don't
// bloat the final mesh. Levels are scaled to opening count and capped.
pub(super) fn refine(mut mesh: Mesh, n_openings: usize) -> Mesh {
    if n_openings >= 8 {
        // Just enough subdivision that each host triangle carries only a few
        // intersection segments, so the batched N-ary subtract RECOVERS rather
        // than degrading to the O(N²) sequential path — that recovery is the
        // win (≈10× on the densest walls), not the per-triangle segment count
        // itself. Over-subdividing is counter-productive: the extra triangles
        // cost more in the arrangement than the spreading saves (level 3 was
        // ~3× slower than level 1 on a 14-opening wall). Aim for ≳ a handful of
        // host triangles per opening, capped at 2 levels.
        let host_tris = mesh.triangle_count().max(1);
        let target = 4 * n_openings;
        let mut levels = 0usize;
        while host_tris * (1usize << (2 * (levels + 1))) < target && levels < 2 {
            levels += 1;
        }
        // A COARSE host (a box wall is ~12 triangles) still needs one split
        // even when the next level would overshoot the target; an ALREADY-dense
        // host (e.g. a faceted-BREP wall whose triangle count already meets the
        // target) is left untouched — extra geometry there only slows the cut.
        if levels == 0 && host_tris < target {
            levels = 1;
        }
        if levels > 0 {
            mesh = mesh.subdivided(levels);
        }
    }
    mesh
}
