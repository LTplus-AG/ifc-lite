// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Prism detection: decide that a welded cutter mesh is a stepped
//! extrusion, merge two prisms across a coincident interface, and give an
//! opening that did not yield a prism its identity-frame blocker OBB.

use super::super::geom::opening_frame::cluster_prism_directions;
use super::super::CutterKind;
use super::frame::{PrismFrame, MAX_PROFILE_VERTS};
use super::kit::{cross, dot, normalize, sub, V2, V3};
use super::profile::{
    basis_from_depth, ccw_area, cross_section_ring, ring_interior, simplify_collinear, MAX_SLABS,
};

/// Detect that the (welded) cutter is a stepped extrusion and extract its
/// stack. `verts`/`tris` are the welded cutter in host-local coordinates;
/// `mesh_vol` is the enclosed volume of the (unwelded) cutter. Conservative:
/// any doubt returns `None` → the exact kernel keeps the opening.
pub(super) fn detect_prism(verts: &[V3], tris: &[[usize; 3]], mesh_vol: f64) -> Option<PrismFrame> {
    if tris.len() < 8 || tris.len() > 4096 {
        return None;
    }
    // Facet normals; cluster into candidate depth directions.
    let mut normals: Vec<Option<V3>> = Vec::with_capacity(tris.len());
    for t in tris {
        let (a, b, c) = (verts[t[0]], verts[t[1]], verts[t[2]]);
        normals.push(normalize(cross(sub(b, a), sub(c, a))));
    }
    let clusters = cluster_prism_directions(&normals)?;
    let mut mag = 0.0f64;
    for v in verts {
        for c in v {
            mag = mag.max(c.abs());
        }
    }
    let plane_tol = 1.0e-4_f64.max(mag * 1.0e-6);
    // Try each cluster direction as the depth axis: every facet must be
    // parallel (a cap/step, on one of a few depth planes) or perpendicular
    // (a side) to it.
    'cand: for dc in &clusters {
        let d = *dc;
        let mut wlo = f64::INFINITY;
        let mut whi = f64::NEG_INFINITY;
        for v in verts {
            let w = dot(*v, d);
            wlo = wlo.min(w);
            whi = whi.max(w);
        }
        if whi - wlo < 1.0e-4 {
            continue;
        }
        // Collect the depth planes carried by parallel facets.
        let mut plane_ws: Vec<f64> = vec![wlo, whi];
        for (t, n) in tris.iter().zip(&normals) {
            let Some(n) = n else { continue };
            let a = dot(*n, d).abs();
            if a > 0.9999 {
                let w = dot(verts[t[0]], d);
                // The whole facet must be planar in depth.
                if t
                    .iter()
                    .any(|&i| (dot(verts[i], d) - w).abs() > plane_tol)
                {
                    continue 'cand;
                }
                if !plane_ws.iter().any(|p| (p - w).abs() <= plane_tol) {
                    plane_ws.push(w);
                }
            } else if a > 0.002 {
                // Neither exactly parallel nor exactly perpendicular ⇒ the
                // cross-section varies along the depth ⇒ not a stepped
                // extrusion about this axis. The tight band matters: a ~1°
                // slanted side would make the mid-slab section drift ~0.5 mm
                // across the slab, poisoning the analytic cut at the weld
                // grid.
                continue 'cand;
            }
        }
        plane_ws.sort_by(f64::total_cmp);
        if plane_ws.len() > MAX_SLABS + 1 {
            continue;
        }
        let (u, v) = basis_from_depth(d)?;
        // One cross-section ring per slab, sliced at the slab midpoint.
        let n_slabs = plane_ws.len() - 1;
        let mut raw_rings: Vec<Vec<V2>> = Vec::with_capacity(n_slabs);
        for k in 0..n_slabs {
            let (w_a, w_b) = (plane_ws[k], plane_ws[k + 1]);
            if w_b - w_a < plane_tol * 2.0 {
                continue 'cand; // sliver slab — numerically fragile, defer
            }
            let w_mid = (w_a + w_b) * 0.5;
            let Some(ring) = cross_section_ring(verts, tris, d, u, v, w_mid) else {
                continue 'cand;
            };
            if ring.len() > MAX_PROFILE_VERTS {
                continue 'cand;
            }
            raw_rings.push(ring);
        }
        if raw_rings.is_empty() {
            continue;
        }
        // SNAP profile coordinates across slabs: the per-slab cross-sections
        // carry independent f32 storage jitter, so a jamb side SHARED by two
        // slabs (no rebate step there) comes back as two near-coincident but
        // unequal edges — µm-wide XOR slivers that wreck the cap CDT and the
        // classification. Cluster all u values (and all v values) across the
        // rings within the f32-jitter bound and remap every ring onto the
        // canonical (first-seen) cluster value. Distinct REAL features (≥ mm)
        // stay distinct; only jitter twins collapse.
        let snap_tol = 3.0e-5_f64.max(mag * 6.0e-7);
        for axis in 0..2 {
            let mut vals: Vec<f64> = raw_rings
                .iter()
                .flat_map(|r| r.iter().map(|p| p[axis]))
                .collect();
            vals.sort_by(f64::total_cmp);
            let mut canon: Vec<f64> = Vec::new();
            for x in vals {
                match canon.last() {
                    Some(&last) if (x - last).abs() <= snap_tol => {}
                    _ => canon.push(x),
                }
            }
            for ring in raw_rings.iter_mut() {
                for pnt in ring.iter_mut() {
                    // Nearest canonical value (canon sorted; linear scan is
                    // fine at these sizes, deterministic).
                    let mut best = canon[0];
                    for &cv in &canon {
                        if (pnt[axis] - cv).abs() < (pnt[axis] - best).abs() {
                            best = cv;
                        }
                    }
                    pnt[axis] = best;
                }
            }
        }
        let mut profiles: Vec<Vec<V2>> = Vec::with_capacity(n_slabs);
        let mut slab_area: Vec<f64> = Vec::with_capacity(n_slabs);
        let mut slab_interior: Vec<V2> = Vec::with_capacity(n_slabs);
        let mut vol = 0.0;
        for (k, mut ring) in raw_rings.into_iter().enumerate() {
            let (w_a, w_b) = (plane_ws[k], plane_ws[k + 1]);
            simplify_collinear(&mut ring, 1.0e-6 * (1.0 + mag));
            let Some(area) = ccw_area(&mut ring) else {
                continue 'cand;
            };
            // SLIVER-EDGE gate: a sub-half-millimetre profile edge sits at the
            // 0.1 mm weld/audit grid where its cut features collapse to
            // degenerate triangles and crack the closed-surface audit. Such
            // micro-features belong to the exact kernel.
            let nr = ring.len();
            for ii in 0..nr {
                let pa = ring[ii];
                let pb = ring[(ii + 1) % nr];
                let dx = pb[0] - pa[0];
                let dy = pb[1] - pa[1];
                if (dx * dx + dy * dy).sqrt() < 5.0e-4 {
                    continue 'cand;
                }
            }
            let Some(interior) = ring_interior(&ring) else {
                continue 'cand;
            };
            vol += area * (w_b - w_a);
            profiles.push(ring);
            slab_area.push(area);
            slab_interior.push(interior);
        }
        if profiles.is_empty() {
            continue;
        }
        // Volume reconcile: enclosed mesh volume ≈ Σ area × slab depth
        // (catches a section that missed part of the shape, hollow shells,
        // twisted sides, etc.).
        if !(0.98..1.02).contains(&(mesh_vol.abs() / vol)) {
            continue;
        }
        let mut lo = [f64::INFINITY; 2];
        let mut hi = [f64::NEG_INFINITY; 2];
        for prof in &profiles {
            for p in prof {
                for k in 0..2 {
                    lo[k] = lo[k].min(p[k]);
                    hi[k] = hi[k].max(p[k]);
                }
            }
        }
        return Some(PrismFrame {
            u,
            v,
            d,
            planes: plane_ws,
            profiles,
            slab_area,
            slab_interior,
            bb: (lo, hi),
        });
    }
    None
}


/// Cyclic CCW-ring equality within `tol`.
pub(super) fn rings_equal(a: &[V2], b: &[V2], tol: f64) -> bool {
    let n = a.len();
    if b.len() != n {
        return false;
    }
    'off: for o in 0..n {
        for i in 0..n {
            let pa = a[i];
            let pb = b[(i + o) % n];
            if (pa[0] - pb[0]).abs() > tol || (pa[1] - pb[1]).abs() > tol {
                continue 'off;
            }
        }
        return true;
    }
    false
}

/// Merge two stacks whose union is exactly one stack: identical depth axis
/// (hence identical deterministic basis) and NUMERICALLY-COINCIDENT depth
/// ranges (touching within `weld` plane jitter, NOT the geometric `tol`); the
/// stacks concatenate at the touching plane, and equal adjacent profiles fuse
/// into one slab (`tol` gates only that profile-equality fusion). This is the
/// wall-leaf half-void pattern (FZK / masonry leaf walls): one window void
/// split into abutting halves along the wall thickness — cutting the union in
/// one pass sidesteps their coplanar interface entirely.
pub(super) fn try_merge_prisms(a: &PrismFrame, b: &PrismFrame, tol: f64) -> Option<PrismFrame> {
    // The merged stack concatenates `hi`'s (u, v)-expressed profiles onto `lo`'s
    // planes/profiles verbatim, so the two frames must share the SAME basis:
    // not just a coincident depth axis but coincident in-plane axes too. A
    // frame rotated about `d` (or with u/v swapped) expresses identical
    // geometry in incompatible 2D coordinates — stitching them silently
    // mis-cuts, and the volume self-check (computed in the merged basis) cannot
    // see it. Require all three basis vectors to align within a tight tol.
    const BASIS_TOL: f64 = 1.0 - 1.0e-8;
    if dot(a.d, b.d) < BASIS_TOL || dot(a.u, b.u) < BASIS_TOL || dot(a.v, b.v) < BASIS_TOL {
        return None; // differing basis/frame ⇒ leave to the veto / exact path
    }
    // Concatenate ONLY at a NUMERICALLY-COINCIDENT interface: depth ranges must
    // touch within PLANE JITTER (f32 + snap-grid roundoff), never the geometric
    // `tol`. A real gap back-fills cutter volume and a real overlap reassigns a
    // differing-profile slab — both keep the synthesized prism self-consistent so
    // the self-check misses the over/under-cut. Non-touching / overlapping pairs
    // stay unmerged for the overlap veto / exact path. 8·SNAP_GRID (~122 µm) is
    // the kernel's per-axis-snap scatter: ≫ f32 roundoff, ≪ any authored gap.
    let weld = 8.0 * crate::kernel::mesh_bridge::SNAP_GRID;
    let (lo, hi) = if (a.d1() - b.d0()).abs() <= weld {
        (a, b)
    } else if (b.d1() - a.d0()).abs() <= weld {
        (b, a)
    } else {
        return None;
    };
    if lo.profiles.len() + hi.profiles.len() > MAX_SLABS {
        return None;
    }
    let mut m = lo.clone();
    // Stitch the interface: hi's first plane is re-anchored on lo's last.
    m.planes.extend(hi.planes[1..].iter().copied());
    m.profiles.extend(hi.profiles.iter().cloned());
    m.slab_area.extend(hi.slab_area.iter().copied());
    m.slab_interior.extend(hi.slab_interior.iter().copied());
    // Fuse the two slabs meeting at the interface when their profiles match
    // (the plain leaf-half case collapses back to a single slab).
    let k = lo.profiles.len(); // index of hi's first slab in the merged stack
    if k > 0 && k < m.profiles.len() && rings_equal(&m.profiles[k - 1], &m.profiles[k], tol) {
        m.planes.remove(k);
        m.profiles.remove(k);
        m.slab_area.remove(k);
        m.slab_interior.remove(k);
    }
    m.bb = {
        let mut lo2 = [f64::INFINITY; 2];
        let mut hi2 = [f64::NEG_INFINITY; 2];
        for prof in &m.profiles {
            for p in prof {
                for k in 0..2 {
                    lo2[k] = lo2[k].min(p[k]);
                    hi2[k] = hi2[k].max(p[k]);
                }
            }
        }
        (lo2, hi2)
    };
    Some(m)
}

/// World-axis AABB of an opening that did NOT yield a prism, as an
/// identity-frame OBB in the host's local frame — an overlap "blocker": a
/// candidate prism abutting an exact-kernel opening must not be cut
/// analytically (the residual exact cut would land flush on its caps).
pub(super) fn opening_aabb_obb(op: &CutterKind, origin: [f64; 3]) -> Option<([V3; 3], V3, V3)> {
    let (a, b) = op.cutter().world_bounds();
    let (mn, mx): (V3, V3) = ([a.x, a.y, a.z], [b.x, b.y, b.z]);
    let lo = [mn[0] - origin[0], mn[1] - origin[1], mn[2] - origin[2]];
    let hi = [mx[0] - origin[0], mx[1] - origin[1], mx[2] - origin[2]];
    if (0..3).any(|k| !(hi[k] > lo[k]) || !lo[k].is_finite() || !hi[k].is_finite()) {
        return None;
    }
    Some((
        [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        lo,
        hi,
    ))
}
