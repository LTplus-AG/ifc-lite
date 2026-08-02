// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{Mesh, Point2, Point3, Vector3};

/// Close the planar cut left by an unbounded `IfcHalfSpaceSolid` DIFFERENCE.
///
/// `ClippingProcessor::clip_mesh` clips each triangle to the half-plane but
/// emits nothing for the cut cross-section — before #1024 the in-tree BSP
/// kernel's polygon cap closed it; deleting BSP left this path uncapped, so
/// gable roof-trims, mono-pitch eaves and Revit top-trim walls render as open,
/// inverted shells (negative signed volume, dozens of open edges).
///
/// A watertight host clipped by a plane has exactly one open boundary — the
/// section, lying on the cut plane. We weld coincident vertices (the clipper
/// emits bit-identical coordinates for shared cut points, so an exact f32-bit
/// key merges them without a tolerance grid that could fuse distinct corners),
/// chain the on-plane boundary half-edges into loops, classify them into
/// outer rings and holes by even-odd nesting, triangulate each region with the
/// kernel's CDT, and append the result wound to face `-clip_normal` (away from
/// the kept `+clip_normal` material). If the boundary is non-manifold or does
/// not close (a non-watertight host), we bail and leave the mesh unchanged —
/// never worse than the uncapped output.
pub(crate) fn cap_half_space_clip(mesh: &mut Mesh, plane_point: Point3<f64>, clip_normal: Vector3<f64>) {
    use crate::triangulation::{project_to_2d, triangulate_polygon_with_holes_refined};
    use std::collections::{HashMap, HashSet};

    // Escape hatch: revert to the pre-fix (uncapped) plane clip without a
    // rebuild, should the section cap ever misbehave on an unforeseen host.
    if std::env::var_os("IFC_LITE_HALFSPACE_CAP_OFF").is_some() {
        return;
    }
    let tri_n = mesh.indices.len() / 3;
    let vcount = mesh.positions.len() / 3;
    if tri_n == 0 || vcount < 3 {
        return;
    }
    let n = match clip_normal.try_normalize(1e-12) {
        Some(v) => v,
        None => return,
    };

    // Diagonal-relative tolerance for "lies on the cut plane".
    let (mn, mx) = mesh.bounds();
    let diag =
        ((mx.x - mn.x).powi(2) + (mx.y - mn.y).powi(2) + (mx.z - mn.z).powi(2)).sqrt() as f64;
    let on_plane_eps = (diag * 1.0e-5).max(1.0e-6);

    // Weld coincident vertices on a spatial grid tied to the on-plane tolerance,
    // NOT exact f32 bits. Exact-bit welding is too strict for the layer path: the
    // innermost slab is built by TWO successive plane clips (after_prev, then the
    // FLIPPED before_next), and each clip regenerates the section vertices via
    // independent f32 edge interpolation. On a non-convex IfcArbitraryClosedProfileDef
    // the two passes deposit geometrically-coincident cut points that differ by
    // ~1 ULP — both flagged on-plane yet left UNWELDED by an exact-bits key. That
    // 1-ULP gap breaks the boundary chain: a sub-loop dead-ends and is dropped,
    // leaving open edges (a non-watertight slab → "see inside" / no 2D fill).
    // Quantising to weld_eps (= on_plane_eps, orders of magnitude finer than any
    // real wall feature) snaps the ULP-twins into one bucket so the loop closes.
    // Single-plane callers (opening cuts) have no such twins, so genuinely
    // distinct corners stay in distinct buckets.
    let weld_eps = on_plane_eps;
    let quant = |c: f32| -> i64 { (c as f64 / weld_eps).round() as i64 };
    let mut weld: HashMap<(i64, i64, i64), u32> = HashMap::new();
    let mut pos: Vec<Point3<f64>> = Vec::new();
    let mut on_plane: Vec<bool> = Vec::new();
    let mut welded: Vec<u32> = Vec::with_capacity(vcount);
    for i in 0..vcount {
        let key = (
            quant(mesh.positions[i * 3]),
            quant(mesh.positions[i * 3 + 1]),
            quant(mesh.positions[i * 3 + 2]),
        );
        let id = match weld.get(&key) {
            Some(&id) => id,
            None => {
                let p = Point3::new(
                    mesh.positions[i * 3] as f64,
                    mesh.positions[i * 3 + 1] as f64,
                    mesh.positions[i * 3 + 2] as f64,
                );
                let id = pos.len() as u32;
                on_plane.push((p - plane_point).dot(&n).abs() <= on_plane_eps);
                pos.push(p);
                weld.insert(key, id);
                id
            }
        };
        welded.push(id);
    }

    // Directed half-edges; an undirected edge with no twin is on the open
    // boundary. Restrict to edges whose endpoints both lie on the cut plane so
    // a pre-existing open boundary (non-watertight host) is never re-capped.
    let mut present: HashSet<(u32, u32)> = HashSet::new();
    for t in 0..tri_n {
        let v = [
            welded[mesh.indices[t * 3] as usize],
            welded[mesh.indices[t * 3 + 1] as usize],
            welded[mesh.indices[t * 3 + 2] as usize],
        ];
        for (a, b) in [(v[0], v[1]), (v[1], v[2]), (v[2], v[0])] {
            if a != b {
                present.insert((a, b));
            }
        }
    }
    let mut next: HashMap<u32, u32> = HashMap::new();
    for &(a, b) in &present {
        if present.contains(&(b, a)) {
            continue; // interior edge
        }
        if !on_plane[a as usize] || !on_plane[b as usize] {
            continue; // not the cut section
        }
        if next.insert(a, b).is_some() {
            return; // non-manifold cut boundary → bail
        }
    }
    if next.is_empty() {
        return;
    }

    // Chain the boundary half-edges into closed loops.
    let mut starts: Vec<u32> = next.keys().copied().collect();
    starts.sort_unstable();
    let mut visited: HashSet<u32> = HashSet::new();
    let mut loops: Vec<Vec<u32>> = Vec::new();
    for &s in &starts {
        if visited.contains(&s) {
            continue;
        }
        let mut loop_v: Vec<u32> = Vec::new();
        let mut cur = s;
        loop {
            if !visited.insert(cur) {
                break;
            }
            loop_v.push(cur);
            match next.get(&cur) {
                Some(&nx) => cur = nx,
                None => {
                    loop_v.clear();
                    break;
                }
            }
            if cur == s {
                break;
            }
        }
        if loop_v.len() >= 3 {
            loops.push(loop_v);
        }
    }
    if loops.is_empty() {
        return;
    }

    // Project every loop into one shared 2D basis whose +w faces the cap's
    // outward normal (-clip_normal), so a CCW triangulated ring lifts to a
    // triangle whose geometric normal already points outward.
    let cap_outward = -n;
    let mut all3d: Vec<Point3<f64>> = Vec::new();
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for lp in &loops {
        let start = all3d.len();
        for &i in lp {
            all3d.push(pos[i as usize]);
        }
        ranges.push((start, all3d.len()));
    }
    let (all2d, u_axis, v_axis, origin) = project_to_2d(&all3d, &cap_outward);

    let signed_area = |ring: &[Point2<f64>]| -> f64 {
        let mut s = 0.0;
        let m = ring.len();
        for i in 0..m {
            let j = (i + 1) % m;
            s += ring[i].x * ring[j].y - ring[j].x * ring[i].y;
        }
        s * 0.5
    };
    let point_in_ring = |pt: &Point2<f64>, ring: &[Point2<f64>]| -> bool {
        let mut inside = false;
        let m = ring.len();
        let mut j = m - 1;
        for i in 0..m {
            let (pi, pj) = (ring[i], ring[j]);
            if ((pi.y > pt.y) != (pj.y > pt.y))
                && (pt.x < (pj.x - pi.x) * (pt.y - pi.y) / (pj.y - pi.y) + pi.x)
            {
                inside = !inside;
            }
            j = i;
        }
        inside
    };

    let rings: Vec<Vec<Point2<f64>>> = ranges
        .iter()
        .map(|&(a, b)| all2d[a..b].to_vec())
        .collect();

    // Even-odd nesting depth: a ring inside an odd number of others is a hole.
    let depth: Vec<usize> = (0..rings.len())
        .map(|i| {
            let probe = rings[i][0];
            (0..rings.len())
                .filter(|&j| j != i && point_in_ring(&probe, &rings[j]))
                .count()
        })
        .collect();

    let cap_normal = [cap_outward.x as f32, cap_outward.y as f32, cap_outward.z as f32];
    let lift = |p: &Point2<f64>| -> Point3<f64> { origin + u_axis * p.x + v_axis * p.y };

    for (oi, ring) in rings.iter().enumerate() {
        if !depth[oi].is_multiple_of(2) {
            continue; // hole — emitted with its outer ring
        }
        // Outer ring CCW; its immediate holes (depth+1, contained) CW.
        let mut outer = ring.clone();
        if signed_area(&outer) < 0.0 {
            outer.reverse();
        }
        let mut holes: Vec<Vec<Point2<f64>>> = Vec::new();
        for (hi, hring) in rings.iter().enumerate() {
            if hi == oi || depth[hi] != depth[oi] + 1 {
                continue;
            }
            if !point_in_ring(&hring[0], ring) {
                continue;
            }
            let mut h = hring.clone();
            if signed_area(&h) > 0.0 {
                h.reverse();
            }
            holes.push(h);
        }

        let (verts2d, indices) = match triangulate_polygon_with_holes_refined(&outer, &holes) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let verts3d: Vec<Point3<f64>> = verts2d.iter().map(lift).collect();
        let base = (mesh.positions.len() / 3) as u32;
        for p in &verts3d {
            mesh.positions
                .extend_from_slice(&[p.x as f32, p.y as f32, p.z as f32]);
            mesh.normals.extend_from_slice(&cap_normal);
        }
        for tri in indices.chunks_exact(3) {
            let (a, b, c) = (verts3d[tri[0]], verts3d[tri[1]], verts3d[tri[2]]);
            // Wind to face the cap outward normal regardless of CDT convention.
            let geo_n = (b - a).cross(&(c - a));
            let (i1, i2) = if geo_n.dot(&cap_outward) >= 0.0 {
                (tri[1], tri[2])
            } else {
                (tri[2], tri[1])
            };
            mesh.indices
                .extend_from_slice(&[base + tri[0] as u32, base + i1 as u32, base + i2 as u32]);
        }
    }
}
