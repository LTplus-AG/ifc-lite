// SPDX-License-Identifier: MPL-2.0
use super::ExactState;
use crate::{GeometryRouter, Mesh};
use crate::csg::{ClippingProcessor, GroupCut};
use crate::router::voids::CutterKind;
use crate::router::voids::admission::cut_retains_triangles;

impl ExactState {
    /// Attempt once at the first member; misses retain sequential eligibility.
    pub(in crate::router::voids) fn cut_group(
        &mut self, result: &mut Mesh, all_openings: &[&CutterKind],
        clipper: &ClippingProcessor, opening_idx: usize,
    ) -> bool {
        if let Some(&gid) = self.group_of.get(&opening_idx) {
            let members = std::mem::take(&mut self.groups[gid]);
            if members.len() >= 2 {
                // While the host is unmutated, the admission-time extended
                // cutters (built against this exact host) are reused as-is;
                // after any cut, members are re-extended against the
                // CURRENT host — matching the sequential loop's reference,
                // which extends each cutter against the (k−1)-cut host.
                let mut extended: Vec<(usize, Mesh)> = Vec::with_capacity(members.len());
                let mut admissible = true;
                if !self.host_mutated {
                    extended = members;
                } else {
                    for &(m_idx, _) in &members {
                        let ext = all_openings[m_idx]
                            .cutter()
                            .mesh_cutter()
                            .and_then(|(m, dir)| GeometryRouter::batch_cutter(m, dir, result));
                        let Some(ext) = ext else {
                            admissible = false;
                            break;
                        };
                        extended.push((m_idx, ext));
                    }
                }
                if admissible {
                    let cutters: Vec<&Mesh> = extended.iter().map(|(_, m)| m).collect();
                    let tri_before = result.triangle_count();
                    let outcome = if GeometryRouter::batch_cutters_match_sequential(result, all_openings, &extended) {
                        clipper.subtract_mesh_many_retaining_miss(result, &cutters)
                    } else {
                        clipper.subtract_mesh_many(result, &cutters)
                    };
                    // #6516: retain the group's validated consolidation on
                    // a conforming miss; keeping the original host instead
                    // can discard useful seam repairs made by the singles.
                    if let GroupCut::Cut(csg_result) | GroupCut::Retessellated(csg_result) = outcome {
                        if cut_retains_triangles(tri_before, &csg_result) {
                            *result = csg_result;
                            self.host_mutated = true;
                            for &(m_idx, _) in &extended {
                                self.consumed[m_idx] = true;
                            }
                        }
                    }
                }
            }
        }
        self.consumed[opening_idx]
    }
}
