// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Build ordered plane plans and retain certified cells as seam sources.
use super::{
    buckets::{BucketKey, Buckets},
    conform::{PlanBucket, PlanRegion},
    supported_cells,
};
use crate::{mesh::Mesh, triangulation::project_to_2d_with_basis};
use i_overlay::{core::{fill_rule::FillRule, overlay_rule::OverlayRule}, float::single::SingleFloatOverlay};
use nalgebra::Vector3;
use rustc_hash::FxHashSet;
use std::collections::HashSet;

pub(super) struct Planned {
    pub plans: Vec<PlanBucket>,
    pub supported_bids: FxHashSet<u32>,
    pub retained_cells: Mesh,
}

// Step 2 — three phases over the SAME bucket map.
//
// A: union + weld + simplify each bucket's rings and record which 0.1 mm
//    positions each bucket KEPT.
// B: put back, into every ring, the recorded positions that some OTHER
//    bucket kept and that fall strictly inside one of this ring's edges.
// C: triangulate and emit.
//
// WHY (T-junction hairline cracks, dental_clinic #217): `simplify_2d_collinear`
// chords a boundary that an ABUTTING bucket subdivides — the cut end face is
// split at mid-height, the two corner verticals keep the full-height edge, so
// one long edge faces two short ones. Retaining every shared vertex kills the
// phantom merge the simplify exists for (#098's faceted reveal shares nearly
// all of them), and no local geometric test separates the cases: #217's
// must-keep sagitta (0.93 µm) sits BELOW several of #098's must-drop phantoms.
// Conforming by ADDITION uses the same asymmetry as a source instead of a
// veto, so the phantom removal is untouched: a phantom is near-collinear in
// every bucket, is kept nowhere, and is never re-inserted.
pub(super) fn build(
    buckets: &Buckets,
    merged_bucket_keys: &HashSet<BucketKey>,
    supported: &supported_cells::Supported,
    length_unit_scale: f64,
) -> Planned {
    let mut supported_bids = FxHashSet::default();
    let mut retained_cells = Mesh::new();
    let mut plans: Vec<PlanBucket> = Vec::with_capacity(buckets.len());

    // Phase A.
    for (bid, (bucket_key, tris)) in buckets.iter().enumerate() {
        if tris.is_empty() {
            continue;
        }
        crate::progress::tick();
        let bid = bid as u32;
        // Use the FIRST triangle's normal/anchor for a stable 2D basis;
        // all tris in this bucket share the plane by construction. EXCEPT
        // (#3914): a bucket the merge pass above just folded a straddling
        // neighbour into — `tris[0]`'s own recomputed cross-product
        // normal is one specific member's noise, not the shared plane
        // both original buckets' tags agreed on; use that tag's normal
        // instead. An ordinary, non-merged bucket (the overwhelming
        // majority) is untouched: this is `tris[0].normal` exactly as
        // before the fix.
        let normal = if merged_bucket_keys.contains(bucket_key) {
            tris[0].tag.map(|(n, _)| n).unwrap_or(tris[0].normal)
        } else {
            tris[0].normal
        };
        let origin = tris[0].v[0];
        let abs = (normal.x.abs(), normal.y.abs(), normal.z.abs());
        let reference = if abs.0 <= abs.1 && abs.0 <= abs.2 {
            Vector3::new(1.0, 0.0, 0.0)
        } else if abs.1 <= abs.2 {
            Vector3::new(0.0, 1.0, 0.0)
        } else {
            Vector3::new(0.0, 0.0, 1.0)
        };
        let u_axis = normal.cross(&reference).normalize();
        let v_axis = normal.cross(&u_axis).normalize();
        // CCW-in-2D convention: i_overlay's NonZero fill needs each
        // input triangle wound CCW in (u, v). Our 3D triangles are CCW
        // looking down `normal`; the (u, v) basis above is right-handed
        // with `v = normal × u`, so projection preserves winding.

        let mut plan = PlanBucket {
            bid,
            normal,
            origin,
            u_axis,
            v_axis,
            raw: Vec::new(),
            raw_conformed: None,
            regions: Vec::new(),
        };

        // Project each triangle to 2D and build i_overlay paths.
        if supported.buckets.contains(bucket_key) {
            supported_bids.insert(bid);
            // Retained needles remain as ghost seam sources. The ordinary
            // emitter drops them; one retained copy is appended afterward.
            for t in tris {
                if supported.cells.contains(&supported_cells::cell_key(&t.v)) {
                    supported_cells::append(&mut retained_cells, &t.v, &normal);
                }
                plan.raw.push(t.v);
            }
            plans.push(plan);
            continue;
        }
        if tris.len() == 1 {
            // Single triangle — skip the union round-trip entirely. Its three
            // corners are hard corners by definition, so they are valid
            // insertion sources for the buckets that abut them (recorded
            // lazily, in `build_seam_map`).
            plan.raw.push(tris[0].v);
            plans.push(plan);
            continue;
        }
        let mut subject: Vec<Vec<[f64; 2]>> = Vec::with_capacity(1);
        let mut clip: Vec<Vec<[f64; 2]>> = Vec::with_capacity(tris.len() - 1);
        // The plane's total area, for `ring_is_noise`'s share test.
        let mut plane_area = 0.0_f64;
        for (idx, tri) in tris.iter().enumerate() {
            let pts_2d = project_to_2d_with_basis(&tri.v, &u_axis, &v_axis, &origin);
            // Force CCW for i_overlay's NonZero fill — kernel output
            // fragments can carry inconsistent winding, and mixed-winding
            // subject + clip cancel out instead of unioning.
            let signed_area = (pts_2d[1].x - pts_2d[0].x)
                * (pts_2d[2].y - pts_2d[0].y)
                - (pts_2d[2].x - pts_2d[0].x)
                    * (pts_2d[1].y - pts_2d[0].y);
            plane_area += 0.5 * signed_area.abs();
            let path: Vec<[f64; 2]> = if signed_area >= 0.0 {
                pts_2d.iter().map(|p| [p.x, p.y]).collect()
            } else {
                pts_2d.iter().rev().map(|p| [p.x, p.y]).collect()
            };
            if idx == 0 {
                subject.push(path);
            } else {
                clip.push(path);
            }
        }

        let shapes = subject.overlay(&clip, OverlayRule::Union, FillRule::NonZero);
        if shapes.is_empty() {
            // Union collapsed everything — emit originals to avoid loss.
            for t in tris {
                plan.raw.push(t.v);
            }
            plans.push(plan);
            continue;
        }

        plan.regions = PlanRegion::from_shapes(&shapes, plane_area, length_unit_scale);
        plans.push(plan);
    }
    Planned { plans, supported_bids, retained_cells }
}
