// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Final hygiene, ulp welding, and closure audit for analytic cuts.

use super::{dedup_cut_vertices, ClosureVerdict, Mesh};
use crate::csg::ConsolidationBoundary;
#[cfg(test)]
use crate::exact_topology::kernel_grid;
#[cfg(test)]
use super::closed_enough_to_emit;

/// Optional refinement must retain the adopted remote repair's certificate;
/// the established coarser probes alone can hide newly collapsed faces.
pub(super) fn can_adopt_refinement(boundary: ConsolidationBoundary, refined: &Mesh, probe: &Mesh) -> bool {
    super::directed_closed(refined) && super::closed_enough_to_emit(probe)
        && boundary.accepts(refined)
}

/// Return an audited cut, preferring the fully hygienic fixed point.
///
/// Cleaning must precede the ulp weld: a removable sliver must not seed the
/// weld pool and choose the surviving seam coordinate (#4754). The weld can in
/// turn collapse a previously valid triangle, so clean again and repeat only
/// while cleaning makes strict triangle-count progress. If hygiene opens a
/// surface, preserve the established compatibility result (the original
/// candidate welded once) provided that exact returned mesh passes closure.
#[cfg(test)]
pub(in crate::router::voids) fn finish_cut(candidate: Mesh, host: &Mesh) -> Option<Mesh> {
    finish_cut_verdict(candidate, host, ConsolidationBoundary::Established).map(|(mesh, _)| mesh)
}

/// [`finish_cut`], also returning whether the returned mesh is strictly
/// directed-closed (from the same closure walk, not a second one).
pub(in crate::router::voids) fn finish_cut_verdict(
    candidate: Mesh,
    host: &Mesh,
    boundary: ConsolidationBoundary,
) -> Option<(Mesh, bool)> {
    // Only adopted remote repairs carry the stronger kernel-grid contract.
    // Keep ordinary prism hygiene unchanged (#7633).
    let preserve_grid_closure = boundary == ConsolidationBoundary::CertifiedRemote;
    let mut hygienic = candidate.clone();
    let before = hygienic.indices.len();
    hygienic.clean_degenerate();
    if hygienic.indices.len() > before || !hygienic.indices.len().is_multiple_of(3) {
        return None;
    }
    hygienic = dedup_cut_vertices(&hygienic, host);

    loop {
        crate::progress::tick();
        let before = hygienic.indices.len();
        hygienic.clean_degenerate();
        let after = hygienic.indices.len();
        if after > before || !after.is_multiple_of(3) {
            return None;
        }
        if after == before {
            break;
        }
        hygienic = dedup_cut_vertices(&hygienic, host);
    }
    let verdict = ClosureVerdict::for_mesh(&hygienic);
    if verdict.closed_enough_to_emit()
        && boundary.accepts(&hygienic)
    {
        return Some((hygienic, verdict.is_directed_closed()));
    }

    let compatibility = dedup_cut_vertices(&candidate, host);
    let verdict = ClosureVerdict::for_mesh(&compatibility);
    if verdict.closed_enough_to_emit()
        && boundary.accepts(&compatibility)
    {
        return Some((compatibility, verdict.is_directed_closed()));
    }
    // Neither normalization may degrade a certified boundary. Retaining the
    // unchanged candidate still requires the established emission contract.
    if !preserve_grid_closure { return None; }
    let original = ClosureVerdict::for_mesh(&candidate);
    original.closed_enough_to_emit()
        .then(|| (candidate, original.is_directed_closed()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nalgebra::{Point3, Vector3};

    fn push_triangle(mesh: &mut Mesh, points: [[f64; 3]; 3]) {
        let base = mesh.vertex_count() as u32;
        for p in points {
            mesh.add_vertex(Point3::new(p[0], p[1], p[2]), Vector3::zeros());
        }
        mesh.add_triangle(base, base + 1, base + 2);
    }

    fn tetrahedron(offset: f64) -> Mesh {
        let mut mesh = Mesh::new();
        let p = |x, y, z| [offset + x, y, z];
        for tri in [
            [p(0.0, 0.0, 0.0), p(1.0, 0.0, 0.0), p(0.0, 1.0, 0.0)],
            [p(0.0, 0.0, 0.0), p(0.0, 0.0, 1.0), p(1.0, 0.0, 0.0)],
            [p(0.0, 0.0, 0.0), p(0.0, 1.0, 0.0), p(0.0, 0.0, 1.0)],
            [p(1.0, 0.0, 0.0), p(0.0, 0.0, 1.0), p(0.0, 1.0, 0.0)],
        ] {
            push_triangle(&mut mesh, tri);
        }
        mesh
    }

    #[test]
    fn issue_7633_refinement_rejects_grid_collapse_only_for_certified_repairs() {
        let probe = tetrahedron(0.0);
        assert!(can_adopt_refinement(ConsolidationBoundary::CertifiedRemote, &probe, &probe));
        let mut refined = probe.clone();
        // A nonzero-area face whose three vertices collapse into one grid cell
        // is invisible to the coarse closure walk, but invalidates the certificate.
        push_triangle(&mut refined, [
            [2.0, 0.0, 0.0], [2.000_001, 0.0, 0.0], [2.0, 0.000_001, 0.0],
        ]);
        assert!(super::super::directed_closed(&refined));
        assert!(closed_enough_to_emit(&refined));
        assert!(!kernel_grid::is_closed(&refined));
        assert!(can_adopt_refinement(ConsolidationBoundary::Established, &refined, &probe));
        assert!(!can_adopt_refinement(ConsolidationBoundary::CertifiedRemote, &refined, &probe));
    }

    #[test]
    fn issue_7633_finalizer_preserves_kernel_grid_closure_across_hygiene() {
        let (a, b, c, d, apex) = (
            [0.0, 0.000_049, 0.0], [1.0, 0.000_049, 0.0],
            [0.0, 1.0, 0.0], [0.5, 0.000_061, 0.0], [0.0, 0.0, 1.0],
        );
        let mut candidate = Mesh::new();
        for face in [[a, b, d], [a, d, c], [d, b, c], [a, apex, b],
            [a, c, apex], [b, apex, c]] {
            push_triangle(&mut candidate, face);
        }
        // One f32 seam copy differs within the SAME kernel cell. Exact-bit
        // closure cannot stand in for the source's kernel-grid certificate.
        candidate.positions[0] = f32::EPSILON;
        assert!(!crate::exact_topology::strict_closed_mesh(&candidate));
        assert!(kernel_grid::is_closed(&candidate));
        let mut cleaned = candidate.clone();
        cleaned.clean_degenerate();
        assert!(!kernel_grid::is_closed(&cleaned),
            "dropping the 12 micrometre face opens a real grid boundary");
        let (finished, _) = finish_cut_verdict(
            candidate.clone(), &candidate, ConsolidationBoundary::CertifiedRemote,
        ).expect("normalization must preserve the certified candidate");
        assert!(kernel_grid::is_closed(&finished));
        assert!(closed_enough_to_emit(&finished));
        assert_eq!(finished.triangle_count(), candidate.triangle_count());
    }

    #[test]
    fn weld_created_degenerate_is_cleaned_before_return_4754() {
        let host = tetrahedron(100.0);
        let mut candidate = host.clone();
        push_triangle(
            &mut candidate,
            [[100.0, 0.0, 0.0], [100.000_03, 0.0, 0.0], [100.0, 0.1, 0.0]],
        );
        let mut first_clean = candidate.clone();
        first_clean.clean_degenerate();
        assert_eq!(
            first_clean.triangle_count(),
            5,
            "premise: cleaning alone keeps the sliver"
        );
        let mut welded = dedup_cut_vertices(&first_clean, &host);
        welded.clean_degenerate();
        assert_eq!(
            welded.triangle_count(),
            4,
            "premise: the weld creates the removable triangle"
        );

        let finished = finish_cut(candidate, &host).expect("the hygienic tetrahedron is closed");
        assert_eq!(finished.triangle_count(), 4);
        assert!(closed_enough_to_emit(&finished));
    }

    #[test]
    fn cleaned_orphan_cannot_seed_the_weld_pool_4754() {
        let mut candidate = Mesh::new();
        candidate.add_vertex(Point3::new(100.000_02, 0.0, 0.0), Vector3::zeros());
        candidate.merge(&tetrahedron(100.000_04));
        candidate.indices.extend_from_slice(&[0, 1, 1]);
        let referenced_x = candidate.positions[3];

        let finished = finish_cut(candidate, &Mesh::new()).expect("the tetrahedron is closed");
        assert_eq!(
            finished.positions[3], referenced_x,
            "an unreferenced earlier vertex must not displace a surviving seam vertex"
        );
        assert!(closed_enough_to_emit(&finished));
    }

    #[test]
    fn closed_unclean_candidate_remains_the_compatibility_fallback_4754() {
        let mut candidate = Mesh::new();
        // Each tetrahedron has one face split through D. A-B-D is only 12 µm
        // high and hygiene removes it, but its vertices straddle the closure
        // grid's rounding boundary (49/61 µm), so the missing patch is real to
        // the audit. Twenty-two components exceed the deliberately bounded
        // hairline matcher and make the cleaned candidate unambiguously open.
        for component in 0..22 {
            let x = component as f64 * 2.0;
            let (a, b, c, d, apex) = (
                [x, 0.000_049, 0.0],
                [x + 1.0, 0.000_049, 0.0],
                [x, 1.0, 0.0],
                [x + 0.5, 0.000_061, 0.0],
                [x, 0.0, 1.0],
            );
            for tri in [
                [a, b, d],
                [a, d, c],
                [d, b, c],
                [a, apex, b],
                [a, c, apex],
                [b, apex, c],
            ] {
                push_triangle(&mut candidate, tri);
            }
        }
        assert!(
            closed_enough_to_emit(&candidate),
            "premise: the subdivided tetrahedron is closed"
        );
        let mut cleaned = candidate.clone();
        cleaned.clean_degenerate();
        assert_eq!(
            cleaned.triangle_count(),
            110,
            "premise: hygiene removes each thin face"
        );
        assert!(
            !closed_enough_to_emit(&cleaned),
            "premise: removing that face opens the tetrahedron"
        );

        let finished = finish_cut(candidate.clone(), &candidate).expect("compatibility fallback");
        assert_eq!(finished.indices, candidate.indices);
        assert_eq!(finished.positions, candidate.positions);
        assert!(closed_enough_to_emit(&finished));
    }
}
