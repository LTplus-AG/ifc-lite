// SPDX-License-Identifier: MPL-2.0
use super::*;

/// Deterministic orthonormal right-handed basis `(u, v)` for a depth axis `d`
/// (`u × v = d`), using the same seed convention as `OpeningFrame::from_depth`.
pub(super) fn basis_from_depth(d: V3) -> Option<(V3, V3)> {
    let seed = if d[2].abs() < 0.9 {
        [0.0, 0.0, 1.0]
    } else {
        [0.0, 1.0, 0.0]
    };
    let u = normalize(cross(seed, d))?;
    let v = normalize(cross(d, u))?;
    Some((u, v))
}

/// Maximum number of depth slabs admitted (a rebated opening has 2-3; more
/// belongs to the exact kernel).
pub(super) const MAX_SLABS: usize = 6;

/// Remove collinear run vertices from a ring (the cross-section stitcher emits
/// one vertex per crossed cutter edge, subdividing straight profile sides).
/// Beyond bloating the face set, they defeat the profile-edge extension: every
/// edge's neighbours look collinear, so the corner re-derivation guard skips
/// it — the #1112 flush-strip roofs never extended.
pub(super) fn simplify_collinear(profile: &mut Vec<V2>, tol: f64) {
    loop {
        let n = profile.len();
        if n <= 3 {
            return;
        }
        let mut removed = false;
        let mut i = 0;
        while profile.len() > 3 && i < profile.len() {
            let m = profile.len();
            let a = profile[(i + m - 1) % m];
            let b = profile[i];
            let c = profile[(i + 1) % m];
            let ab = [b[0] - a[0], b[1] - a[1]];
            let ac = [c[0] - a[0], c[1] - a[1]];
            let lac = (ac[0] * ac[0] + ac[1] * ac[1]).sqrt();
            if lac > 1.0e-12 {
                let perp = (ab[0] * ac[1] - ab[1] * ac[0]).abs() / lac;
                // Only drop a vertex whose removal keeps the ring within `tol`
                // AND that lies BETWEEN its neighbours along the run (a true
                // subdivision point, not a hairpin spike).
                let t = (ab[0] * ac[0] + ab[1] * ac[1]) / (lac * lac);
                if perp <= tol && (0.0..=1.0).contains(&t) {
                    profile.remove(i);
                    removed = true;
                    continue;
                }
            }
            i += 1;
        }
        if !removed {
            return;
        }
    }
}

/// CCW normalization + area of a 2D ring. `None` when degenerate.
pub(super) fn ccw_area(profile: &mut Vec<V2>) -> Option<f64> {
    profile.dedup_by(|a, b| (a[0] - b[0]).abs() < 1.0e-9 && (a[1] - b[1]).abs() < 1.0e-9);
    while profile.len() > 1 {
        let first = profile[0];
        let last = *profile.last().unwrap();
        if (first[0] - last[0]).abs() < 1.0e-9 && (first[1] - last[1]).abs() < 1.0e-9 {
            profile.pop();
        } else {
            break;
        }
    }
    if profile.len() < 3 {
        return None;
    }
    let mut signed2 = 0.0;
    for i in 0..profile.len() {
        let a = profile[i];
        let b = profile[(i + 1) % profile.len()];
        signed2 += a[0] * b[1] - a[1] * b[0];
    }
    if signed2 < 0.0 {
        profile.reverse();
        signed2 = -signed2;
    }
    let area = signed2 * 0.5;
    if area < 1.0e-8 {
        None
    } else {
        Some(area)
    }
}

/// Strictly interior point of a CCW ring: the max-area CDT triangle centroid
/// (a non-convex rebated profile's vertex centroid can lie outside).
pub(super) fn ring_interior(profile: &[V2]) -> Option<V2> {
    let pts: Vec<Point2<f64>> = profile.iter().map(|p| Point2::new(p[0], p[1])).collect();
    let (tp, ti) = crate::cdt::triangulate_constrained(&pts, &[])?;
    let mut best = (0.0, [0.0, 0.0]);
    for t in ti.chunks_exact(3) {
        let (a, b, c) = (tp[t[0]], tp[t[1]], tp[t[2]]);
        let ar = ((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)).abs();
        if ar > best.0 {
            best = (ar, [(a.x + b.x + c.x) / 3.0, (a.y + b.y + c.y) / 3.0]);
        }
    }
    (best.0 > 0.0).then_some(best.1)
}

/// Cross-section ring of the welded cutter at depth `w_mid`: chord segments of
/// every triangle crossing the plane, endpoints computed once per welded EDGE
/// (bit-identical across the two incident triangles) and stitched into one
/// loop by exact bit equality. `None` for anything but a single clean loop.
pub(super) fn cross_section_ring(
    verts: &[V3],
    tris: &[[usize; 3]],
    d: V3,
    u: V3,
    v: V3,
    w_mid: f64,
) -> Option<Vec<V2>> {
    let mut edge_cross: FxHashMap<(usize, usize), V3> = FxHashMap::default();
    let mut crossing = |a: usize, b: usize| -> V3 {
        let key = if a < b { (a, b) } else { (b, a) };
        *edge_cross.entry(key).or_insert_with(|| {
            let (pa, pb) = (verts[key.0], verts[key.1]);
            let (da, db) = (dot(pa, d) - w_mid, dot(pb, d) - w_mid);
            lerp(pa, pb, (da / (da - db)).clamp(0.0, 1.0))
        })
    };
    let mut segs: Vec<(V3, V3)> = Vec::new();
    for t in tris {
        let dist = [
            dot(verts[t[0]], d) - w_mid,
            dot(verts[t[1]], d) - w_mid,
            dot(verts[t[2]], d) - w_mid,
        ];
        let mut pts: Vec<V3> = Vec::new();
        for e in 0..3 {
            let (da, db) = (dist[e], dist[(e + 1) % 3]);
            if (da > 0.0) != (db > 0.0) {
                pts.push(crossing(t[e], t[(e + 1) % 3]));
            }
        }
        if pts.len() == 2 {
            segs.push((pts[0], pts[1]));
        }
    }
    if segs.len() < 3 {
        return None;
    }
    // Stitch by exact endpoint bits (undirected), walking one loop.
    let mut adj: FxHashMap<[u64; 3], Vec<(usize, [u64; 3])>> = FxHashMap::default();
    for (i, (a, b)) in segs.iter().enumerate() {
        adj.entry(bits(*a)).or_default().push((i, bits(*b)));
        adj.entry(bits(*b)).or_default().push((i, bits(*a)));
    }
    if adj.values().any(|v| v.len() != 2) {
        return None; // branch / open curve — not a clean single section
    }
    let start = *adj.keys().min()?;
    let mut ring_keys: Vec<[u64; 3]> = vec![start];
    let mut used = vec![false; segs.len()];
    let mut cur = start;
    loop {
        let nbrs = adj.get(&cur)?;
        let Some(&(si, nxt)) = nbrs.iter().find(|(si, _)| !used[*si]) else {
            break;
        };
        used[si] = true;
        if nxt == start {
            break;
        }
        ring_keys.push(nxt);
        if ring_keys.len() > segs.len() {
            return None;
        }
        cur = nxt;
    }
    if used.iter().any(|&x| !x) {
        return None; // more than one loop (annular / multi-void section)
    }
    let to_v3 = |k: [u64; 3]| -> V3 {
        [
            f64::from_bits(k[0]),
            f64::from_bits(k[1]),
            f64::from_bits(k[2]),
        ]
    };
    Some(
        ring_keys
            .iter()
            .map(|&k| {
                let p = to_v3(k);
                [dot(p, u), dot(p, v)]
            })
            .collect(),
    )
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
