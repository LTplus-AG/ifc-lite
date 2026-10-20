// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The existing #7292 proposal pipeline, with #6940's separate-surface guard before writes.
use super::{diag, incidence, selection, source_axes, transversal, separate_incidence};
use super::axis_rescue::{complete_axis_rescue, AxisPlane};
use super::lift::{exact_axis_plane_foot, exact_on_plane_weld};
use super::selection::Face;
use crate::kernel::{arrangement::Tri, near_band::NearBand};

pub(super) fn promote<const KEEP_INCIDENCE: bool, const FINITE_INCIDENCE: bool>(cutter: &mut [Tri], host: &[Tri]) -> usize {
    if cutter.is_empty() || host.is_empty() {
        return 0;
    }
    let (mut welded, mut band) = (0usize, NearBand::default());
    [cutter as &[Tri], host].into_iter().for_each(|t| band.observe_tris(t));
    let host_verts = crate::kernel::near_band::exact_vertex_set(host); // #3353 N-ary half

    let faces: Vec<Face> = host.iter().filter_map(|&t| Face::new(t, &band)).collect();

    let mut guard = separate_incidence::Guard::new(&faces, host);
    let mut axis_planes: Option<Vec<AxisPlane>> = None;
    let mut proposals = Vec::new();
    for (ti, t) in cutter.iter().enumerate() {
        for (vi, v) in t.iter().enumerate() {
            if host_verts.contains(&crate::kernel::near_band::vertex_bits(v)) { continue; } // #3353
            // Begin with the nearest noisy plane. Covering-face preference
            // only revises an admitted noncorner lift on a distinct plane.
            let best = selection::select(*v, &faces, &band, &host_verts);
            // EXACT-PLANE LIFT (the crack-family fix): re-express the foot of
            // the perpendicular in the host triangle's EDGE BASIS and recombine
            // it with EXACT f64 arithmetic, so the welded vertex lies EXACTLY on
            // the host face's plane (orient3d == Zero) and the exact coplanar
            // carve fires — A/B seam vertices then intern to identical Vids.
            // The previous per-axis `snap()` of the foot re-scattered it 3–13 µm
            // OFF a tilted plane (per-axis snapping cannot hold a tilt), so the
            // tri-pair classified Segment/near-coplanar and the carve chords of
            // the two operands diverged by mm in-plane ⇒ exact-coordinate
            // boundary cracks on far-from-origin walls. On a weld failure
            // (degenerate basis / out-of-range / inexact recombination) the
            // vertex is left UNTOUCHED — never an inexact foot, which would be
            // off every grid and force the BigRational tier on every predicate
            // that sees it.
            if let Some((d, f)) = best {
                if let Some(q20) = exact_on_plane_weld(*v, f.t) {
                    let original = *v;
                    // #7292: Q20 and the initial axis foot use this drift admission.
                    let admits = |w| f.admits(original, w, d, &band, &host_verts);
                    // Begin with the admitted Q20 target in its selected basis.
                    // A late correction may preserve healthy source axis features;
                    // exact corner targets keep their original identity. Only a
                    // refused lift may try the exact axis foot; all Q20 gates above
                    // remain mandatory. Further independent axis feet use
                    // their own original normal bands, preserving prior axes.
                    let q20_admitted = admits(q20);
                    let mut initial_rescue_foot = None;
                    let target = if q20_admitted {
                        Some(q20)
                    } else {
                        exact_axis_plane_foot(original, f.t).filter(|&foot| admits(foot)).map(|foot| {
                            initial_rescue_foot = Some(foot);
                            let planes = axis_planes.get_or_insert_with(|| faces.iter()
                                .filter_map(|face| AxisPlane::new(face.t, face.band2)).collect());
                            complete_axis_rescue(foot, planes, &host_verts)
                        })
                    };
                    if let Some(w) = target {
                        // Numeric equality hides signed-zero writes performed
                        // by the original loop; corner identity uses raw bits.
                        if crate::kernel::near_band::vertex_bits(&w) != crate::kernel::near_band::vertex_bits(&original) {
                            proposals.push(transversal::Proposal { ti, vi, original, target: Some(w),
                                admitted_q20_face: q20_admitted.then_some((d, f)),
                                refused_face: (!q20_admitted).then_some(f), initial_foot: initial_rescue_foot });
                        }
                    }
                }
            }
        }
    }
    // Defer writes so the incidence map sees every ORIGINAL source triangle.
    // Calls with no proposed movement avoid the extra broadphase entirely.
    if !proposals.is_empty() {
        let incidences = incidence::ExactFaceIncidences::new(cutter, host);
        let source_axes = source_axes::SourceAxes::new(cutter);
        for proposal in &mut proposals {
            let Some(primary) = proposal.target else { continue; };
            let (original, admitted_q20_face) = (proposal.original, proposal.admitted_q20_face);
            // Build the guarded correction before rejecting its uncorrected
            // primary's incidental scatter. An established incidence-foot
            // fallback still takes priority when the primary loses incidence.
            let correction = admitted_q20_face.and_then(|(d, face)| {
                source_axes.candidate(original, primary, face.t, &host_verts)
                    .filter(|&candidate| {
                        face.admits(original, candidate, d, &band, &host_verts)
                            && incidences.admits(original, candidate, host)
                            && source_axes::retains_finite_contacts(primary, candidate, host)
                    })
            });
            let target = if incidences.admits(original, primary, host) {
                Some(correction.unwrap_or(primary))
            } else {
                // An admitted Q20 lift can scatter a tangential coordinate off
                // an existing exact shared face (#7292). Only then try the
                // selected axis plane's exact foot, under the same drift gate
                // and every original overlapping-face incidence. Keep the
                // established refused-Q20 axis-completion path unchanged.
                admitted_q20_face.and_then(|(d, face)| {
                    exact_axis_plane_foot(original, face.t).filter(|&foot| {
                        face.admits(original, foot, d, &band, &host_verts)
                            && incidences.admits(original, foot, host)
                    })
                }).or_else(|| correction.filter(|&candidate| {
                    // This NEW target replaces no previously valid resolution.
                    // Its exact selected-plane identity is already established
                    // by SourceAxes; require a finite host patch on that plane.
                    admitted_q20_face.is_some_and(|(_, face)| {
                        selection::projected_support_on_nondegenerate_plane(candidate, &face.t, &faces)
                            && source_axes::retains_finite_contacts(original, candidate, host)
                    })
                }))
            };
            proposal.target = target;
        }
        // Every certificate sees immutable ORIGINAL source facets. Rejected raw
        // keys retain their exact original bits; no alternate lift is attempted.
        if KEEP_INCIDENCE && proposals.iter().any(|proposal| proposal.target.is_some()) {
            // No finite index or budget charge until an actual movement
            // survives the established admission rules.
            let cutter_edges = if FINITE_INCIDENCE {
                match super::finite::CutterEdges::new(cutter) {
                    Ok(edges) => Some(edges),
                    Err(_) => return welded,
                }
            } else { None };
            for proposal in &mut proposals {
                let Some(target) = proposal.target else { continue; };
                let face = proposal.admitted_q20_face.map(|(_, f)| f).or(proposal.refused_face)
                    .expect("every weld proposal retains its selected host face");
                match guard.retains(proposal.original, target, face.t, cutter_edges.as_ref()) {
                    Ok(true) => {},
                    Ok(false) => proposal.target = None,
                    Err(_) => return welded, // caller rejects the whole Boolean on budget exhaustion
                }
            }
        }
        let rejected = transversal::rejected_keys(cutter, &proposals, &band);
        for proposal in proposals {
            let transversal::Proposal { ti, vi, original, target, .. } = proposal;
            if rejected.contains(&crate::kernel::near_band::vertex_bits(&original)) { continue; }
            if let Some(target) = target {
                cutter[ti][vi] = target;
                welded += usize::from(target != original);
            }
        }
    }
    diag::record(diag::ALL, welded);
    welded
}
