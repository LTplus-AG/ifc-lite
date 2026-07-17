// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Post-cut hygiene for void subtraction (#1788): real-change detection and
//! the stray-shard sweep against the original (pre-cut) host.

use super::geom::{mesh_is_closed_exact, mesh_point, mesh_signed_volume, point_inside_mesh};
use crate::{Mesh, Point3};

/// Whether a boolean produced a REAL change against the pre-cut host: the
/// triangle count moved, or the enclosed volume moved beyond noise.
///
/// Triangle count alone misreads two opposite cases (#1788):
///  * an end/miter cut can replace a 12-tri box host with another 12-tri box —
///    same count, 8.5% volume moved (ISSUE_129 `IGC_MUR` wedge); count-only
///    detection threw the perfect cut away and the #635 AABB fallback then
///    carved the cutter's axis-aligned world box instead;
///  * a kernel short-circuit returns the host byte-identical — count AND
///    volume are equal, which this test still (correctly) reads as unchanged.
///
/// Volumes are compared by MAGNITUDE: the kernel's `orient_outward`
/// normalization can hand back a no-op subtraction of an inward-wound host
/// with its winding flipped, and comparing raw signed values would read that
/// as a ~2x volume change — accepting an UNCUT mesh and skipping the #635
/// fallback (codex P1 on #1802).
///
/// The volume tolerance is deliberately COARSE (0.1% relative): a rejected /
/// short-circuited subtract may return the host re-snapped rather than
/// byte-identical, and reading that noise as "changed" would silently skip
/// the #635 fallback machinery. A same-count REAL cut moves volume by orders
/// of magnitude more (8.5% on the ISSUE_129 wedge); a real cut smaller than
/// 0.1% of the host that ALSO keeps the triangle count identical stays on
/// the (pre-existing) fallback path, no worse than before.
pub(super) fn cut_changed_mesh(result: &Mesh, tris_before: usize, vol_before: f64) -> bool {
    if result.triangle_count() != tris_before {
        return true;
    }
    let vol_after = mesh_signed_volume(result).abs();
    let vol_before = vol_before.abs();
    (vol_after - vol_before).abs() > vol_before.max(1.0e-9) * 1.0e-3
}

/// Cap on `result_triangles x host_triangles` for the shard sweep. Every swept
/// face costs up to five parity/distance queries, each a linear scan of the
/// reference host, so the sweep is O(result·host); this cap bounds it to
/// ~10M ray-triangle tests (a few ms) so a high-tessellation closed host can
/// never stall the geometry stream on an already-expensive cut (codex P1 on
/// #1802). Over budget the sweep is skipped — the pre-#1788 behaviour — which
/// degrades to "shard stays", never to a wrong drop. The observed shard class
/// lives on simple extrusion hosts (12..~200 reference triangles), far below
/// the cap. Deterministic: a pure function of the two triangle counts.
const SWEEP_COST_BUDGET: usize = 2_000_000;

/// `true` iff `p` is farther than `tol` from EVERY triangle of `mesh`
/// (point-to-triangle distance, plain f64). Early-outs on the first triangle
/// within `tol`.
fn point_mesh_distance_exceeds(mesh: &Mesh, p: &Point3<f64>, tol: f64) -> bool {
    let tol2 = tol * tol;
    for tri in mesh.indices.chunks_exact(3) {
        let (Some(a), Some(b), Some(c)) = (
            mesh_point(mesh, tri[0]),
            mesh_point(mesh, tri[1]),
            mesh_point(mesh, tri[2]),
        ) else {
            continue;
        };
        // Closest point on triangle (Ericson, Real-Time Collision Detection).
        let ab = b - a;
        let ac = c - a;
        let ap = p - a;
        let d1 = ab.dot(&ap);
        let d2 = ac.dot(&ap);
        let q = if d1 <= 0.0 && d2 <= 0.0 {
            a
        } else {
            let bp = p - b;
            let d3 = ab.dot(&bp);
            let d4 = ac.dot(&bp);
            if d3 >= 0.0 && d4 <= d3 {
                b
            } else {
                let vc = d1 * d4 - d3 * d2;
                if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
                    a + ab * (d1 / (d1 - d3))
                } else {
                    let cp = p - c;
                    let d5 = ab.dot(&cp);
                    let d6 = ac.dot(&cp);
                    if d6 >= 0.0 && d5 <= d6 {
                        c
                    } else {
                        let vb = d5 * d2 - d1 * d6;
                        if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
                            a + ac * (d2 / (d2 - d6))
                        } else {
                            let va = d3 * d6 - d5 * d4;
                            if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
                                b + (c - b) * ((d4 - d3) / ((d4 - d3) + (d5 - d6)))
                            } else {
                                let denom = 1.0 / (va + vb + vc);
                                a + ab * (vb * denom) + ac * (vc * denom)
                            }
                        }
                    }
                }
            }
        };
        if (p - q).norm_squared() <= tol2 {
            return false;
        }
    }
    true
}

/// `true` when `mesh` decomposes into 2+ vertex-connected components whose
/// AABBs overlap. `process_element` builds hosts by CONCATENATING
/// representation items, so a multi-solid element can be several closed
/// shells occupying shared space; odd/even parity across overlapping shells
/// classifies overlap-interior points as OUTSIDE, which would let the sweep
/// delete legitimate faces (codex P2 on #1802). Disjoint-AABB shells keep
/// parity sound (a point is interior to at most one shell) and stay eligible.
/// Components by bit-exact vertex position (the mesh is pre-welded).
fn overlapping_components(mesh: &Mesh) -> bool {
    use std::collections::HashMap;
    let nverts = mesh.positions.len() / 3;
    let mut parent: Vec<u32> = (0..nverts as u32).collect();
    fn find(parent: &mut [u32], mut x: u32) -> u32 {
        while parent[x as usize] != x {
            parent[x as usize] = parent[parent[x as usize] as usize];
            x = parent[x as usize];
        }
        x
    }
    // Merge bit-identical positions (welded mesh; belt-and-braces), then
    // merge each triangle's vertices.
    let mut by_pos: HashMap<(u32, u32, u32), u32> = HashMap::new();
    for i in 0..nverts {
        let b = i * 3;
        let key = (
            mesh.positions[b].to_bits(),
            mesh.positions[b + 1].to_bits(),
            mesh.positions[b + 2].to_bits(),
        );
        match by_pos.get(&key) {
            Some(&j) => {
                let (a, b2) = (find(&mut parent, i as u32), find(&mut parent, j));
                parent[a as usize] = b2;
            }
            None => {
                by_pos.insert(key, i as u32);
            }
        }
    }
    for tri in mesh.indices.chunks_exact(3) {
        let a = find(&mut parent, tri[0]);
        let b = find(&mut parent, tri[1]);
        parent[a as usize] = b;
        let b = find(&mut parent, tri[1]);
        let c = find(&mut parent, tri[2]);
        parent[b as usize] = c;
    }
    // Per-component AABB over triangle vertices.
    let mut boxes: HashMap<u32, ([f32; 3], [f32; 3])> = HashMap::new();
    for tri in mesh.indices.chunks_exact(3) {
        let root = find(&mut parent, tri[0]);
        let entry = boxes
            .entry(root)
            .or_insert(([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]));
        for &vi in tri {
            let b = vi as usize * 3;
            for k in 0..3 {
                entry.0[k] = entry.0[k].min(mesh.positions[b + k]);
                entry.1[k] = entry.1[k].max(mesh.positions[b + k]);
            }
        }
    }
    if boxes.len() < 2 {
        return false;
    }
    let list: Vec<&([f32; 3], [f32; 3])> = boxes.values().collect();
    for i in 0..list.len() {
        for j in (i + 1)..list.len() {
            let (amn, amx) = list[i];
            let (bmn, bmx) = list[j];
            if (0..3).all(|k| amn[k] <= bmx[k] && bmn[k] <= amx[k]) {
                return true;
            }
        }
    }
    false
}

/// Drop cut-result faces that have NO original-host material on either side.
///
/// A subtract can only remove material, so every legitimate face of the cut
/// result — host skin or cutter reveal — bounds kept material that lies inside
/// the ORIGINAL (pre-cut) host solid. A face whose both sides sit outside that
/// solid is provably an artifact: the sequential exact subtract on an
/// already-cut host can misclassify and keep a stray extended-cutter cap
/// fragment ~1 m off the wall plane (the ISSUE_098 Poroton family, #1788 —
/// invisible to the volume gates, but it inflates the hull/AABB and renders as
/// a floating shard). Probes `centroid ± ε·normal` (ε = 50 µm) with the same
/// parity ray as [`point_inside_mesh`]; a real face's kept side is inside by
/// ~a wall thickness, orders beyond ε.
///
/// GATES (all bail out to the un-swept result, the pre-#1788 behaviour):
///  * the (1 µm-welded) reference host must be bit-exact CLOSED — a closed
///    reference makes the parity test sound, so every both-sides-outside face
///    is provably an artifact and there is no drop cap; an open reference
///    would risk eating legitimate faces. The SAME welded mesh is then used
///    for every parity/distance query, so sub-µm seams in the raw original
///    can't pass the gate and still misclassify (CodeRabbit on #1802);
///  * no overlapping vertex-connected components (see
///    [`overlapping_components`]) — parity across overlapping closed shells
///    reads overlap-interior points as outside;
///  * `result x host` triangle product within [`SWEEP_COST_BUDGET`];
///  * every result index in bounds (a malformed triangle would panic in the
///    compaction slice below).
///
/// DETERMINISM: plain FMA-free f64, fixed probe direction and iteration order
/// ⇒ byte-identical native==wasm.
pub(super) fn drop_faces_outside_host(result: Mesh, original_host: &Mesh) -> Mesh {
    if result.indices.is_empty() || original_host.indices.is_empty() {
        return result;
    }
    let tri_count = result.indices.len() / 3;
    let vert_count = result.positions.len() / 3;
    if result.indices.iter().any(|&i| i as usize >= vert_count) {
        return result;
    }
    if tri_count.saturating_mul(original_host.indices.len() / 3) > SWEEP_COST_BUDGET {
        return result;
    }
    let reference_host = original_host.welded_by_position(1.0e-6);
    if !mesh_is_closed_exact(&reference_host) || overlapping_components(&reference_host) {
        return result;
    }
    let reference_host = &reference_host;
    const EPS: f64 = 5.0e-5;
    let mut keep: Vec<bool> = Vec::with_capacity(tri_count);
    let mut dropped = 0usize;
    for tri in result.indices.chunks_exact(3) {
        let (Some(a), Some(b), Some(c)) = (
            mesh_point(&result, tri[0]),
            mesh_point(&result, tri[1]),
            mesh_point(&result, tri[2]),
        ) else {
            keep.push(true);
            continue;
        };
        let centroid = Point3::new(
            (a.x + b.x + c.x) / 3.0,
            (a.y + b.y + c.y) / 3.0,
            (a.z + b.z + c.z) / 3.0,
        );
        let n = (b - a).cross(&(c - a));
        let len = n.norm();
        if len <= 0.0 {
            keep.push(true); // degenerate; other hygiene passes own these
            continue;
        }
        let off = n * (EPS / len);
        // A face is an artifact when (a) BOTH sides of its centroid are
        // outside the host, or (b) any of its vertices sits STRICTLY outside
        // the host with real clearance — a needle that PIERCES the host keeps
        // its centroid inside while a far vertex hangs ~1 m out, so (a) alone
        // misses it. The 1 mm clearance keeps host-surface vertices (distance
        // ~0) and corner-grazing parity noise safe.
        const VERTEX_CLEARANCE: f64 = 1.0e-3;
        let centroid_out = !point_inside_mesh(reference_host, centroid + off)
            && !point_inside_mesh(reference_host, centroid - off);
        let vertex_out = [a, b, c].iter().any(|&v| {
            !point_inside_mesh(reference_host, v)
                && point_mesh_distance_exceeds(reference_host, &v, VERTEX_CLEARANCE)
        });
        let kept = !(centroid_out || vertex_out);
        if !kept {
            dropped += 1;
        }
        keep.push(kept);
    }
    if dropped == 0 || dropped == tri_count {
        return result;
    }
    // Rebuild with COMPACTED vertex arrays: bounds/hull consumers read the
    // position array directly, so an orphaned shard vertex would keep
    // inflating them even with its faces gone.
    let mut remap: Vec<u32> = vec![u32::MAX; vert_count];
    let mut out = result.clone();
    out.positions.clear();
    out.normals.clear();
    out.indices.clear();
    let has_normals = result.normals.len() == result.positions.len();
    for (i, tri) in result.indices.chunks_exact(3).enumerate() {
        if !keep[i] {
            continue;
        }
        for &vi in tri {
            let v = vi as usize;
            if remap[v] == u32::MAX {
                remap[v] = (out.positions.len() / 3) as u32;
                out.positions
                    .extend_from_slice(&result.positions[v * 3..v * 3 + 3]);
                if has_normals {
                    out.normals
                        .extend_from_slice(&result.normals[v * 3..v * 3 + 3]);
                }
            }
            out.indices.push(remap[v]);
        }
    }
    out
}
