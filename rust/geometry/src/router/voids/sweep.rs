// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Post-cut hygiene for void subtraction (#1788): real-change detection and
//! the stray-shard sweep against the original (pre-cut) host.

use super::geom::{mesh_is_closed_exact, mesh_point, mesh_signed_volume, point_inside_mesh};
use crate::{Mesh, Point3};

/// Whether a boolean produced a REAL change against the pre-cut host: the
/// triangle count moved, or the enclosed (signed) volume moved beyond noise.
///
/// Triangle count alone misreads two opposite cases (#1788):
///  * an end/miter cut can replace a 12-tri box host with another 12-tri box —
///    same count, 8.5% volume moved (ISSUE_129 `IGC_MUR` wedge); count-only
///    detection threw the perfect cut away and the #635 AABB fallback then
///    carved the cutter's axis-aligned world box instead;
///  * a kernel short-circuit returns the host byte-identical — count AND
///    volume are equal, which this test still (correctly) reads as unchanged.
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
    let vol_after = mesh_signed_volume(result);
    (vol_after - vol_before).abs() > vol_before.abs().max(1.0e-9) * 1.0e-3
}

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
/// GATE: the sweep runs only when the (1 µm-welded) original host is
/// bit-exact CLOSED — a closed reference makes the parity test sound, so every
/// both-sides-outside face is provably an artifact and there is no drop cap.
/// A non-closed reference (open imported brep) makes parity unreliable, so
/// the sweep is skipped entirely rather than risk eating legitimate faces.
/// DETERMINISM: plain FMA-free f64, fixed probe direction and iteration order
/// ⇒ byte-identical native==wasm.
pub(super) fn drop_faces_outside_host(result: Mesh, original_host: &Mesh) -> Mesh {
    if result.indices.is_empty() || original_host.indices.is_empty() {
        return result;
    }
    if !mesh_is_closed_exact(&original_host.welded_by_position(1.0e-6)) {
        return result;
    }
    const EPS: f64 = 5.0e-5;
    let tri_count = result.indices.len() / 3;
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
        let centroid_out = !point_inside_mesh(original_host, centroid + off)
            && !point_inside_mesh(original_host, centroid - off);
        let vertex_out = [a, b, c].iter().any(|&v| {
            !point_inside_mesh(original_host, v)
                && point_mesh_distance_exceeds(original_host, &v, VERTEX_CLEARANCE)
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
    let vert_count = result.positions.len() / 3;
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
