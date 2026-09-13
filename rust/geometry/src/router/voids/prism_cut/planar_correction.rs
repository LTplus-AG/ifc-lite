// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Final overlap removal for staged mixed planar/residual differences (#4617).

use super::{
    closed_or_hairline, cut_prism, dedup_cut_vertices, directed_closed,
    extend_prism_caps, mesh_from_ptris, prepare_prism, ptris_from_mesh,
    Mesh, OpeningType, PTri,
};

/// Apply every mandatory correction atomically using the analytic prism kernel.
/// Corrections are already disjoint NonZero intersections; they must never be
/// screened by the normal opening-size threshold or silently left as residuals.
/// Failure returns no candidate so the caller retries ALL original openings.
pub(in crate::router::voids) fn correct_planar_overlap(
    mesh: &Mesh,
    cutters: &[Mesh],
) -> Option<Mesh> {
    if cutters.is_empty() {
        return Some(mesh.clone());
    }
    if !super::enabled() {
        return None;
    }
    let mut tris = ptris_from_mesh(mesh)?;
    // Reuse the established prism admission audit: the cap classifier requires
    // a closed solid, including the explicitly tolerated subdivision hairlines.
    if !directed_closed(mesh) && !closed_or_hairline(mesh) {
        return None;
    }
    for cutter in cutters {
        let (lo, hi) = cutter.bounds();
        let opening = OpeningType::NonRectangular(cutter.clone(), lo.cast(), hi.cast(), None);
        let mut prism = prepare_prism(&opening, mesh.origin)?;
        let aabbs: Vec<_> = tris.iter().map(PTri::aabb).collect();
        extend_prism_caps(&mut prism, &tris, &aabbs);
        tris = cut_prism(&tris, &prism).ok()?.tris;
    }
    let out = dedup_cut_vertices(&mesh_from_ptris(&tris, mesh), mesh);
    (directed_closed(&out) || closed_or_hairline(&out)).then_some(out)
}
