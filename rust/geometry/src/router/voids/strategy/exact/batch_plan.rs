// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The disjoint-batch plan: which prepared openings are cut together.

use super::ExactState;
use crate::program::openings::execute::Execution;
use crate::router::voids::admission::{aabb_engulfs, admit_cutter, min_opening_volume, ENGULF_TOLERANCE};
use crate::router::voids::CutterKind;
use crate::{GeometryRouter, Mesh, Point3};

impl ExactState {
    /// DISJOINT-CUTTER BATCHING plan: group cutters whose pad-inflated AABBs
    /// are pairwise disjoint, so each group is subtracted in ONE conforming
    /// arrangement at its first member (see [`ExactState::cut_group`]).
    /// Planned after the coaxial union, against the host it left, and only
    /// over openings it did not consume.
    pub(in crate::router::voids) fn plan_groups(
        &mut self,
        execution: &Execution,
        result: &Mesh,
        all_openings: &[&CutterKind],
        wall_min: Point3<f64>,
        wall_max: Point3<f64>,
    ) {
        if all_openings.len() >= 2 {
            // Inflation pad: ≥ 2×(promote band 8·2⁻¹⁶ ≈ 122 µm + snap radius);
            // 1 mm is conservative and far below any real opening separation.
            // Touching/overlapping cutters land in DIFFERENT groups, cut in
            // sequence — overlap degrades gracefully to sequential behavior.
            const BATCH_PAD: f64 = 1.0e-3;
            struct Cand {
                idx: usize,
                /// The admission-time extended cutter (host PRE-cut). Reused at
                /// cut time while the host is still unmutated — the common case
                /// (groups are cut at their FIRST member, usually before any
                /// sequential cut) — so extension isn't paid twice.
                mesh: Mesh,
                lo: [f64; 3],
                hi: [f64; 3],
            }
            let mut cands: Vec<Cand> = Vec::new();
            for (idx, opening) in all_openings.iter().enumerate() {
                // Already cut by the coaxial/overlap-union prepass above.
                if self.consumed[idx] {
                    continue;
                }
                let Some((opening_mesh, extrusion_dir)) = opening.cutter().mesh_cutter() else { continue };
                // Same admission guards as the sequential loop.
                if admit_cutter(
                    opening_mesh,
                    result.bounds(),
                    min_opening_volume(execution.tessellation_quality),
                )
                .is_none()
                {
                    continue;
                }
                let Some(ext) = GeometryRouter::batch_cutter(opening_mesh, extrusion_dir, result) else {
                    continue;
                };
                let (lo, hi) = ext.bounds();
                // Engulf-class exclusion: a cutter whose extended AABB covers
                // the whole host on EVERY axis (3% slack, the sequential
                // engulf test) stays on the sequential path, where the
                // near-engulf and redundant-void guards live — batched it can
                // shave the host's outer shell (the #559171-family residual).
                let engulfs = aabb_engulfs(
                    [lo.x as f64, lo.y as f64, lo.z as f64],
                    [hi.x as f64, hi.y as f64, hi.z as f64],
                    [wall_min.x, wall_min.y, wall_min.z],
                    [wall_max.x, wall_max.y, wall_max.z],
                    ENGULF_TOLERANCE,
                );
                if engulfs {
                    continue;
                }
                cands.push(Cand {
                    idx,
                    mesh: ext,
                    lo: [
                        lo.x as f64 - BATCH_PAD,
                        lo.y as f64 - BATCH_PAD,
                        lo.z as f64 - BATCH_PAD,
                    ],
                    hi: [
                        hi.x as f64 + BATCH_PAD,
                        hi.y as f64 + BATCH_PAD,
                        hi.z as f64 + BATCH_PAD,
                    ],
                });
            }
            // Greedy disjoint grouping, deterministic in opening order: a
            // candidate joins the first group whose EVERY member's inflated
            // AABB is disjoint from its own.
            let mut groups: Vec<Vec<usize>> = Vec::new();
            'cand: for ci in 0..cands.len() {
                for g in groups.iter_mut() {
                    let disjoint_from_all = g.iter().all(|&cj| {
                        let (a, b) = (&cands[ci], &cands[cj]);
                        a.hi[0] < b.lo[0]
                            || a.lo[0] > b.hi[0]
                            || a.hi[1] < b.lo[1]
                            || a.lo[1] > b.hi[1]
                            || a.hi[2] < b.lo[2]
                            || a.lo[2] > b.hi[2]
                    });
                    if disjoint_from_all {
                        g.push(ci);
                        continue 'cand;
                    }
                }
                groups.push(vec![ci]);
            }
            for g in &groups {
                if g.len() < 2 {
                    continue; // singleton: sequential loop handles it (full guards)
                }
                let gid = self.groups.len();
                for &ci in g {
                    self.group_of.insert(cands[ci].idx, gid);
                }
                self.groups
                    .push(g.iter().map(|&ci| (cands[ci].idx, cands[ci].mesh.clone())).collect());
            }
        }
    }
}
