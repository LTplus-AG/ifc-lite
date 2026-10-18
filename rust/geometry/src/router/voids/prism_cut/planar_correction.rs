// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Final overlap removal for staged mixed planar/residual differences (#4617).

use super::{
    closed_enough_to_emit, cut_prism, dedup_cut_vertices, extend_prism_caps, mesh_from_ptris,
    prepare_prism, ptris_from_mesh, Mesh, OpeningType, PTri,
};

/// Apply every mandatory correction atomically using the analytic prism kernel.
/// Corrections are already disjoint NonZero intersections; they must never be
/// screened by the normal opening-size threshold or silently left as residuals.
/// Failure returns no candidate so the caller retries ALL original openings.
pub(in crate::router::voids) fn correct_planar_overlap(
    mesh: &Mesh,
    cutters: &[Mesh],
    enabled: bool,
) -> crate::Result<Option<Mesh>> {
    crate::resource::check_current()?;
    let candidate = correction_candidate(mesh, cutters, enabled);
    crate::resource::check_current()?;
    Ok(candidate)
}

fn correction_candidate(mesh: &Mesh, cutters: &[Mesh], enabled: bool) -> Option<Mesh> {
    if cutters.is_empty() {
        return Some(mesh.clone());
    }
    if !enabled {
        return None;
    }
    let mut tris = ptris_from_mesh(mesh)?;
    // Reuse the established prism admission audit: the cap classifier requires
    // a closed solid, including the explicitly tolerated subdivision hairlines.
    if !closed_enough_to_emit(mesh) {
        return None;
    }
    for cutter in cutters {
        crate::resource::check_current().ok()?;
        let (lo, hi) = cutter.bounds();
        let opening = OpeningType::NonRectangular(cutter.clone(), lo.cast(), hi.cast(), None);
        let mut prism = prepare_prism(&opening, mesh.origin)?;
        let aabbs: Vec<_> = tris.iter().map(PTri::aabb).collect();
        extend_prism_caps(&mut prism, &tris, &aabbs);
        let result = cut_prism(&tris, &prism);
        crate::resource::check_current().ok()?;
        tris = result.ok()?;
    }
    let out = dedup_cut_vertices(&mesh_from_ptris(&tris, mesh), mesh);
    closed_enough_to_emit(&out).then_some(out)
}
