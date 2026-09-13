// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Bounded candidate selection for the 3D opening-union consumer (#3925).

use super::{accept_cut, mesh_is_closed_exact, UnionCand};
use super::super::sweep::mesh_to_keep;
use crate::{ClippingProcessor, GeometryRouter, Mesh};

pub(super) fn subtract(
    result: &mut Mesh,
    cands: &[UnionCand],
    members: &[usize],
    clipper: &ClippingProcessor,
) -> bool {
    let extended: Vec<Mesh> = members
        .iter()
        .map(|&m| {
            GeometryRouter::extend_opening_mesh_through_host(&cands[m].mesh, result, cands[m].dir)
        })
        .collect();
    let refs: Vec<&Mesh> = extended.iter().collect();
    // Preserve the existing accepted union: choosing an unpromoted candidate
    // first changes valid large-model cuts. Only an unusable union gets a retry.
    let mut union =
        ClippingProcessor::consolidate_coplanar(crate::kernel::mesh_bridge::union_many(&refs));
    if union.is_empty() || !mesh_is_closed_exact(&union) {
        // Never conceal an exhausted operation behind another candidate.
        if crate::kernel::budget::tripped() {
            return false;
        }
        union = ClippingProcessor::consolidate_coplanar(
            crate::kernel::mesh_bridge::union_many_preserving_coordinates(&refs),
        );
        if union.is_empty() || !mesh_is_closed_exact(&union) {
            return false;
        }
    }
    let Some(cut) = mesh_to_keep(clipper.subtract_mesh(result, &union), result) else {
        return false;
    };
    accept_cut(result, cut, f64::INFINITY)
}
