// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Deseaming a cutter mesh authored as two (or more) extrusions glued
//! cap-to-cap. Split out of `synthesis.rs` to keep that module under its
//! line budget: #4119's triangle-vs-vertex-count classification fix added
//! comments that pushed `synthesis.rs` over its 955-line allowlist budget.
//! `remove_internal_membrane` was already self-contained (`Mesh`/`Vector3`
//! only, no other state from `synthesis.rs`), so it moves verbatim rather
//! than being rewritten.

use super::super::{GeometryRouter, NORMALIZE_EPSILON};
use crate::{Mesh, Vector3};

impl GeometryRouter {
    /// Remove the INTERNAL MEMBRANE left when an opening is authored as two (or
    /// more) extrusions glued cap-to-cap — the AC20 round windows store two
    /// `IfcExtrudedAreaSolid` with the SAME circle profile and the SAME start
    /// point extruding in OPPOSITE directions, so the combined cutter mesh
    /// carries a back-to-back pair of cap disks where the two solids meet (e.g. 28
    /// tris on a shared plane mid-wall). The exact CSG subtract treats that double
    /// cap as a real boundary and leaves a solid plug at the seam — the window
    /// never cuts through.
    ///
    /// We delete the WHOLE interior cap plane (every cap-facing triangle in an
    /// interior bucket that carries faces pointing both along and against the
    /// axis), not just vertex-coincident pairs: the two disks are often
    /// triangulated DIFFERENTLY, so pair-matching leaves a central plug (a square
    /// patch inside the round hole). Removing the full membrane welds the two
    /// solids into one continuous tube whose only caps are the true outer ends, so
    /// the subtract carves a clean through-hole. A no-op for ordinary single-solid
    /// openings (no interior back-to-back cap plane exists).
    ///
    /// `pub(in super::super)` (= `voids`), not `pub(super)`: called from
    /// `prism_cut.rs`, a sibling of `synthesis` under `voids`, not just from
    /// within `synthesis` itself.
    pub(in super::super) fn remove_internal_membrane(
        opening_mesh: &Mesh,
        axis_dir: Vector3<f64>,
    ) -> Mesh {
        let tri_count = opening_mesh.indices.len() / 3;
        if tri_count < 4 {
            return opening_mesh.clone();
        }
        let p = |i: usize| -> [f64; 3] {
            [
                opening_mesh.positions[i * 3] as f64,
                opening_mesh.positions[i * 3 + 1] as f64,
                opening_mesh.positions[i * 3 + 2] as f64,
            ]
        };
        // Penetration axis: the cutter's cylinder/extrusion axis, along which the
        // two glued solids stack and their shared seam caps lie. Prefer the
        // supplied depth direction; fall back to the cutter's longest bbox axis.
        let mut d = axis_dir;
        if d.norm() < NORMALIZE_EPSILON {
            let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
            for c in opening_mesh.positions.chunks_exact(3) {
                for a in 0..3 {
                    lo[a] = lo[a].min(c[a] as f64);
                    hi[a] = hi[a].max(c[a] as f64);
                }
            }
            let ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
            // Use a total order: non-finite file coords (e.g. `1.E999` → +inf,
            // whose `inf - inf` extent is NaN) would make `partial_cmp` return
            // `None` and panic the `.unwrap()`. `f64::total_cmp` (the idiom used
            // for the sorts in voids/mod.rs) is NaN-safe and deterministic.
            let la = (0..3).max_by(|&i, &j| ext[i].total_cmp(&ext[j])).unwrap();
            d = Vector3::new(
                if la == 0 { 1.0 } else { 0.0 },
                if la == 1 { 1.0 } else { 0.0 },
                if la == 2 { 1.0 } else { 0.0 },
            );
        }
        d /= d.norm();

        // Cutter span along the axis — its extreme ends are the TRUE outer caps,
        // which must be kept.
        let (mut smin, mut smax) = (f64::INFINITY, f64::NEG_INFINITY);
        for c in opening_mesh.positions.chunks_exact(3) {
            let s = c[0] as f64 * d.x + c[1] as f64 * d.y + c[2] as f64 * d.z;
            smin = smin.min(s);
            smax = smax.max(s);
        }
        let span = (smax - smin).abs();
        if span < NORMALIZE_EPSILON {
            return opening_mesh.clone();
        }
        // Bucket cap triangles by their plane offset along the axis (0.5 mm grid,
        // so a flat cap's triangles cluster into one bucket). A bucket touching
        // either extreme is an outer cap and is never removed.
        let cell = (span * 0.005).max(5.0e-4);
        let bucket = |s: f64| (s / cell).round() as i64;
        let (min_b, max_b) = (bucket(smin), bucket(smax));

        // Lateral basis (u, v) ⊥ axis, for the spatial-overlap test below.
        let helper = if d.x.abs() < 0.9 {
            Vector3::new(1.0, 0.0, 0.0)
        } else {
            Vector3::new(0.0, 1.0, 0.0)
        };
        let u = d.cross(&helper).normalize();
        let v = d.cross(&u);

        // Per interior cap-plane bucket, track the LATERAL (⊥ axis) bounding box of
        // the +axis-facing and −axis-facing cap faces SEPARATELY. Two solids glued
        // cap-to-cap leave an outward cap of one and an inward cap of the other on
        // the same plane — but, crucially, with the SAME lateral footprint (the
        // shared disk). Tracking direction alone is not enough: two laterally
        // SEPARATE caps (e.g. side-by-side cutters abutting at one offset) would
        // also carry both directions in the bucket, and welding them would punch
        // through solid material between the holes. So a bucket is a membrane only
        // where the two footprints actually OVERLAP, and only that overlap region
        // is removed — a lone cap or a disjoint neighbour sharing the offset is
        // kept. A genuine two-hole opening is therefore not merged into one.
        let bbox_union = |bb: &mut Option<[f64; 4]>, lu: f64, lv: f64| match bb {
            None => *bb = Some([lu, lu, lv, lv]),
            Some(b) => {
                b[0] = b[0].min(lu);
                b[1] = b[1].max(lu);
                b[2] = b[2].min(lv);
                b[3] = b[3].max(lv);
            }
        };
        let mut buckets: std::collections::HashMap<i64, [Option<[f64; 4]>; 2]> =
            std::collections::HashMap::new();
        // Per cap triangle: (bucket, lateral_u, lateral_v); non-caps use i64::MIN.
        let mut cap_tris: Vec<(i64, f64, f64)> = Vec::with_capacity(tri_count);
        for t in 0..tri_count {
            let (i0, i1, i2) = (
                opening_mesh.indices[t * 3] as usize,
                opening_mesh.indices[t * 3 + 1] as usize,
                opening_mesh.indices[t * 3 + 2] as usize,
            );
            let (a, b, c) = (p(i0), p(i1), p(i2));
            let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let n = [
                e1[1] * e2[2] - e1[2] * e2[1],
                e1[2] * e2[0] - e1[0] * e2[2],
                e1[0] * e2[1] - e1[1] * e2[0],
            ];
            let nl = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            if nl < 1e-12 {
                cap_tris.push((i64::MIN, 0.0, 0.0));
                continue;
            }
            let align = (n[0] * d.x + n[1] * d.y + n[2] * d.z) / nl;
            if align.abs() <= 0.9 {
                cap_tris.push((i64::MIN, 0.0, 0.0)); // not a cap (tube wall)
                continue;
            }
            let cx = (a[0] + b[0] + c[0]) / 3.0;
            let cy = (a[1] + b[1] + c[1]) / 3.0;
            let cz = (a[2] + b[2] + c[2]) / 3.0;
            let cs = cx * d.x + cy * d.y + cz * d.z;
            let lu = cx * u.x + cy * u.y + cz * u.z;
            let lv = cx * v.x + cy * v.y + cz * v.z;
            let bk = bucket(cs);
            cap_tris.push((bk, lu, lv));
            if bk != min_b && bk != max_b {
                let e = buckets.entry(bk).or_insert([None, None]);
                bbox_union(&mut e[(align > 0.0) as usize], lu, lv);
            }
        }
        // A bucket is a glued membrane where its +face and −face footprints overlap
        // laterally; the membrane region is that lateral intersection.
        let mut membrane_region: std::collections::HashMap<i64, [f64; 4]> =
            std::collections::HashMap::new();
        for (&bk, dirs) in &buckets {
            if let (Some(neg), Some(pos)) = (dirs[0], dirs[1]) {
                let iu0 = neg[0].max(pos[0]);
                let iu1 = neg[1].min(pos[1]);
                let iv0 = neg[2].max(pos[2]);
                let iv1 = neg[3].min(pos[3]);
                // Require a non-degenerate overlap so caps merely touching at an
                // edge/corner (a real internal partition, not a coincident disk)
                // are not welded.
                if iu1 - iu0 > 1.0e-3 && iv1 - iv0 > 1.0e-3 {
                    membrane_region.insert(bk, [iu0, iu1, iv0, iv1]);
                }
            }
        }
        if membrane_region.is_empty() {
            return opening_mesh.clone();
        }
        let pad = 1.0e-4;
        let mut out = opening_mesh.clone();
        out.indices.clear();
        for t in 0..tri_count {
            let (bk, lu, lv) = cap_tris[t];
            if let Some(r) = membrane_region.get(&bk) {
                if lu >= r[0] - pad && lu <= r[1] + pad && lv >= r[2] - pad && lv <= r[3] + pad
                {
                    continue; // inside the overlapping membrane footprint
                }
            }
            out.indices.push(opening_mesh.indices[t * 3]);
            out.indices.push(opening_mesh.indices[t * 3 + 1]);
            out.indices.push(opening_mesh.indices[t * 3 + 2]);
        }
        out
    }
}
