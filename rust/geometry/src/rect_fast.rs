// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Analytic fast path for axis-aligned rectangular openings cut through an
//! axis-aligned box host (the dominant case: rectangular windows/doors in a
//! straight wall). This sidesteps the exact mesh-arrangement CSG kernel — which
//! is at its single-threaded, memory-bandwidth-bound floor — for openings that
//! need no exact arithmetic at all.
//!
//! WATERTIGHTNESS RECIPE (the make-or-break the prior `subtract_box_fast`
//! attempt got wrong by recomputing rim coords on an incommensurate grid):
//!   - Build the cut on ONE canonical grid whose lines are the host edges plus
//!     every opening edge, each value SNAPPED to the kernel's own power-of-two
//!     `SNAP_GRID = 1/65536` (the grid the host operand already lives on).
//!   - CONFORMING-split every face by the crossing grid lines (no T-junctions):
//!     the front/back faces become a grid of cells with hole cells omitted; the
//!     side faces are split at the hole grid lines so their shared edge with the
//!     annulus matches sub-edge for sub-edge.
//!   - Every vertex reads its position from the SAME snapped grid value, so two
//!     faces meeting at a shared line emit BIT-IDENTICAL f32 → watertight by
//!     construction (value identity, not a numeric hash-match).
//!   - Per-face flat normals; vertices are NEVER welded across creases (#846).
//!
//! GATING: this is a PURE OPTIMIZATION. It returns `None` (→ caller falls back to
//! the exact kernel) the moment any precondition fails — non-box host, non-
//! through opening, opening off the face, or a NEAR-EDGE feature whose grid lines
//! would collapse into each other at the host's f32 magnitude (the robustness
//! gate that replaces a hard dependency on the per-element local frame).

use crate::mesh::Mesh;

/// The kernel's reconcile grid (mesh_bridge::SNAP_GRID). Power of two ⇒ the snap
/// is an exact f64 op ⇒ bit-deterministic native==wasm.
const SNAP_GRID: f64 = 1.0 / 65536.0;

#[inline]
fn snap(c: f64) -> f64 {
    (c / SNAP_GRID).round() * SNAP_GRID
}

/// Telemetry: why the fast path fired or deferred, so the real fire-rate on a
/// void-heavy model is measurable (the prior attempt shipped at fired=0).
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub struct RectFastStats {
    pub fired: u64,
    pub openings_cut: u64,
    pub defer_host_not_box: u64,
    pub defer_not_through: u64,
    pub defer_off_face: u64,
    pub defer_near_edge: u64,
    pub defer_no_openings: u64,
}

/// Escape hatch: `IFC_LITE_RECT_FAST=0` forces every opening back through the
/// exact kernel (parity debugging / bisection). Default ON — the path is a pure
/// optimization that defers on any precondition miss.
pub fn enabled() -> bool {
    use std::sync::OnceLock;
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var("IFC_LITE_RECT_FAST").as_deref() != Ok("0"))
}

mod telemetry {
    use super::RectFastStats;
    use std::sync::atomic::{AtomicU64, Ordering};
    static C: [AtomicU64; 7] = [const { AtomicU64::new(0) }; 7];
    pub fn record(s: &RectFastStats) {
        for (a, v) in C.iter().zip([
            s.fired, s.openings_cut, s.defer_host_not_box, s.defer_not_through,
            s.defer_off_face, s.defer_near_edge, s.defer_no_openings,
        ]) {
            a.fetch_add(v, Ordering::Relaxed);
        }
    }
    pub fn take() -> RectFastStats {
        let g = |i: usize| C[i].swap(0, Ordering::Relaxed);
        RectFastStats {
            fired: g(0), openings_cut: g(1), defer_host_not_box: g(2),
            defer_not_through: g(3), defer_off_face: g(4), defer_near_edge: g(5),
            defer_no_openings: g(6),
        }
    }
}

/// Accumulate per-cut stats into the process-global counters (for fire-rate
/// measurement); `take_global_stats` drains them.
pub fn record_global(stats: &RectFastStats) {
    telemetry::record(stats);
}
/// Read + reset the global fire/defer counters.
pub fn take_global_stats() -> RectFastStats {
    telemetry::take()
}

/// An axis-aligned box AABB extracted from a host mesh, plus a check that every
/// face is axis-aligned (the precondition for the world-coord cut).
struct AlignedBox {
    min: [f64; 3],
    max: [f64; 3],
}

/// Verify `mesh` is an axis-aligned box (every triangle normal ≈ ±X/±Y/±Z, and
/// the surface spans exactly the AABB on all 6 sides) and return its AABB.
/// Conservative: any deviation ⇒ `None` ⇒ defer to the exact kernel.
fn aligned_box(mesh: &Mesh) -> Option<AlignedBox> {
    if mesh.indices.len() < 36 {
        // a box is ≥ 12 triangles; fewer can't be a closed box
        return None;
    }
    let p = |i: u32| -> [f64; 3] {
        let b = i as usize * 3;
        [
            mesh.positions[b] as f64,
            mesh.positions[b + 1] as f64,
            mesh.positions[b + 2] as f64,
        ]
    };
    let (mn_f, mx_f) = mesh.bounds();
    let min = [mn_f.x as f64, mn_f.y as f64, mn_f.z as f64];
    let max = [mx_f.x as f64, mx_f.y as f64, mx_f.z as f64];
    // Degenerate extent on any axis ⇒ not a 3D box.
    for k in 0..3 {
        if max[k] - min[k] <= SNAP_GRID {
            return None;
        }
    }
    // Every triangle must be axis-aligned (normal along one axis) AND lie on the
    // corresponding min or max face plane — i.e. the mesh is exactly the AABB
    // shell, nothing protruding or interior.
    const PLANE_TOL: f64 = 1e-4;
    let mut seen_face = [false; 6]; // -x,+x,-y,+y,-z,+z
    for tri in mesh.indices.chunks_exact(3) {
        let (a, b, c) = (p(tri[0]), p(tri[1]), p(tri[2]));
        let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
        ];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if len == 0.0 {
            continue; // degenerate tri — ignore (hygiene drops it anyway)
        }
        // which axis is the normal along?
        let mut axis = usize::MAX;
        for k in 0..3 {
            if (n[k].abs() / len) > 0.999 {
                axis = k;
            }
        }
        if axis == usize::MAX {
            return None; // a non-axis-aligned face ⇒ not an aligned box
        }
        // all 3 verts must sit on the min or max plane of that axis
        let on_min = a[axis] <= min[axis] + PLANE_TOL
            && b[axis] <= min[axis] + PLANE_TOL
            && c[axis] <= min[axis] + PLANE_TOL;
        let on_max = a[axis] >= max[axis] - PLANE_TOL
            && b[axis] >= max[axis] - PLANE_TOL
            && c[axis] >= max[axis] - PLANE_TOL;
        if on_min {
            seen_face[axis * 2] = true;
        } else if on_max {
            seen_face[axis * 2 + 1] = true;
        } else {
            return None; // an interior / protruding triangle ⇒ not a clean box
        }
    }
    if seen_face.iter().all(|&s| s) {
        Some(AlignedBox { min, max })
    } else {
        None
    }
}

/// One opening projected onto the host: the through-axis `w` it penetrates, and
/// its hole rectangle `[lo,hi]` on the two in-face axes `(u, v)`.
struct Hole {
    u_lo: f64,
    u_hi: f64,
    v_lo: f64,
    v_hi: f64,
}

/// Result of the cut: a watertight `Mesh`, or `None` to defer to the exact
/// kernel. `openings` are world AABBs (min,max) of the rectangular cutters.
pub fn subtract_rect_openings(
    host: &Mesh,
    openings: &[([f64; 3], [f64; 3])],
    stats: &mut RectFastStats,
) -> Option<Mesh> {
    if openings.is_empty() {
        stats.defer_no_openings += 1;
        return None;
    }
    let bx = match aligned_box(host) {
        Some(b) => b,
        None => {
            stats.defer_host_not_box += 1;
            return None;
        }
    };

    // Pick the through-axis `w` = the host's thinnest axis (wall thickness); the
    // in-face axes are the other two. Every opening must penetrate along the SAME
    // axis (a corner window cutting two axes is rare → defer).
    let extents = [bx.max[0] - bx.min[0], bx.max[1] - bx.min[1], bx.max[2] - bx.min[2]];
    let w = (0..3).min_by(|&i, &j| extents[i].partial_cmp(&extents[j]).unwrap()).unwrap();
    let (u, v) = match w {
        0 => (1usize, 2usize),
        1 => (0usize, 2usize),
        _ => (0usize, 1usize),
    };

    // Scale-aware near-edge epsilon: two grid lines closer than this would
    // collapse into one f32 at the host's world magnitude, cracking the cut.
    // max(|coord|) · 2^-21 keeps ≥ 4 f32 ULP between distinct lines; floored at
    // the snap grid so origin-scale hosts stay permissive.
    let mag = bx.min[u].abs().max(bx.max[u].abs())
        .max(bx.min[v].abs().max(bx.max[v].abs()))
        .max(bx.min[w].abs().max(bx.max[w].abs()));
    let near_eps = (mag * (1.0 / 2_097_152.0)).max(SNAP_GRID);

    // Snapped host face extents on the in-face axes + through extent.
    let su = [snap(bx.min[u]), snap(bx.max[u])];
    let sv = [snap(bx.min[v]), snap(bx.max[v])];
    let sw = [snap(bx.min[w]), snap(bx.max[w])];

    // Project + validate every opening into a Hole in (u,v); defer on any miss.
    let mut holes: Vec<Hole> = Vec::with_capacity(openings.len());
    for (omn, omx) in openings {
        // Must penetrate the full thickness along w (a through-cut): the opening
        // span on w must cover the host on w (caps poke past, the standard
        // `extend_opening_along_direction` guarantee).
        if !(omn[w] <= bx.min[w] + near_eps && omx[w] >= bx.max[w] - near_eps) {
            stats.defer_not_through += 1;
            return None;
        }
        // Hole rect on the face = opening span clamped to the host face.
        let u_lo = snap(omn[u].max(bx.min[u]));
        let u_hi = snap(omx[u].min(bx.max[u]));
        let v_lo = snap(omn[v].max(bx.min[v]));
        let v_hi = snap(omx[v].min(bx.max[v]));
        // Must be a proper interior hole: strictly inside the face with a real
        // reveal on every side (≥ near_eps), and non-degenerate.
        if !(u_lo > su[0] + near_eps
            && u_hi < su[1] - near_eps
            && v_lo > sv[0] + near_eps
            && v_hi < sv[1] - near_eps
            && u_hi - u_lo > near_eps
            && v_hi - v_lo > near_eps)
        {
            stats.defer_off_face += 1;
            return None;
        }
        holes.push(Hole { u_lo, u_hi, v_lo, v_hi });
    }

    // Holes must be pairwise non-overlapping on the face (merged openings are
    // disjoint; touching/overlapping → defer to the exact kernel which composes
    // them correctly).
    for i in 0..holes.len() {
        for j in (i + 1)..holes.len() {
            let a = &holes[i];
            let b = &holes[j];
            let disjoint = a.u_hi <= b.u_lo + near_eps
                || b.u_hi <= a.u_lo + near_eps
                || a.v_hi <= b.v_lo + near_eps
                || b.v_hi <= a.v_lo + near_eps;
            if !disjoint {
                stats.defer_off_face += 1;
                return None;
            }
        }
    }

    // Build the conforming grids: every distinct snapped edge on each in-face
    // axis becomes a grid line. Near-coincident lines (< near_eps) would collapse
    // at f32 → defer rather than emit a cracked/degenerate cut.
    let u_lines = match grid_lines(su, holes.iter().flat_map(|h| [h.u_lo, h.u_hi]), near_eps) {
        Some(g) => g,
        None => {
            stats.defer_near_edge += 1;
            return None;
        }
    };
    let v_lines = match grid_lines(sv, holes.iter().flat_map(|h| [h.v_lo, h.v_hi]), near_eps) {
        Some(g) => g,
        None => {
            stats.defer_near_edge += 1;
            return None;
        }
    };

    let cut = build_cut(&bx, u, v, w, &sw, &u_lines, &v_lines, &holes);
    stats.fired += 1;
    stats.openings_cut += holes.len() as u64;
    Some(cut)
}

/// Sorted, deduplicated grid lines on one in-face axis: the two host edges plus
/// every hole edge. Returns `None` if any two distinct lines are closer than
/// `near_eps` (would collapse at f32 → crack/degenerate).
fn grid_lines(
    host: [f64; 2],
    hole_edges: impl Iterator<Item = f64>,
    near_eps: f64,
) -> Option<Vec<f64>> {
    let mut lines: Vec<f64> = vec![host[0], host[1]];
    lines.extend(hole_edges);
    lines.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut out: Vec<f64> = Vec::with_capacity(lines.len());
    for c in lines {
        match out.last() {
            Some(&last) if (c - last).abs() <= near_eps => {
                // coincident within the snap → same line; but if they're
                // distinct-but-too-close (between snap and near_eps) it's a
                // near-edge collapse risk → defer.
                if (c - last).abs() > 0.0 && (c - last).abs() < near_eps {
                    return None;
                }
            }
            _ => out.push(c),
        }
    }
    if out.len() < 2 {
        return None;
    }
    Some(out)
}

/// Map an (u,v,w) coordinate triple (in axis order) back to a world [x,y,z].
#[inline]
fn world(u: usize, v: usize, w: usize, uc: f64, vc: f64, wc: f64) -> [f64; 3] {
    let mut p = [0.0; 3];
    p[u] = uc;
    p[v] = vc;
    p[w] = wc;
    p
}

struct Builder {
    positions: Vec<f32>,
    normals: Vec<f32>,
    indices: Vec<u32>,
}

impl Builder {
    fn vert(&mut self, p: [f64; 3], n: [f32; 3]) -> u32 {
        let idx = (self.positions.len() / 3) as u32;
        self.positions.push(p[0] as f32);
        self.positions.push(p[1] as f32);
        self.positions.push(p[2] as f32);
        self.normals.extend_from_slice(&n);
        idx
    }
    /// A planar quad (4 coplanar world corners in perimeter order) emitted with
    /// the winding that makes its front face point along `n` — robust to the
    /// handedness of the (u,v,w) axis assignment (e.g. a Y-through wall is a
    /// left-handed frame, which would otherwise invert every face).
    fn quad(&mut self, c: [[f64; 3]; 4], n: [f32; 3]) {
        let e1 = [c[1][0] - c[0][0], c[1][1] - c[0][1], c[1][2] - c[0][2]];
        let e2 = [c[2][0] - c[0][0], c[2][1] - c[0][1], c[2][2] - c[0][2]];
        let cr = [
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
        ];
        let dot = cr[0] * n[0] as f64 + cr[1] * n[1] as f64 + cr[2] * n[2] as f64;
        let o = if dot >= 0.0 { [0, 1, 2, 3] } else { [0, 3, 2, 1] };
        let v0 = self.vert(c[o[0]], n);
        let v1 = self.vert(c[o[1]], n);
        let v2 = self.vert(c[o[2]], n);
        let v3 = self.vert(c[o[3]], n);
        self.indices.extend_from_slice(&[v0, v1, v2, v0, v2, v3]);
    }
}

#[allow(clippy::too_many_arguments)]
fn build_cut(
    bx: &AlignedBox,
    u: usize,
    v: usize,
    w: usize,
    sw: &[f64; 2],
    u_lines: &[f64],
    v_lines: &[f64],
    holes: &[Hole],
) -> Mesh {
    let mut b = Builder {
        positions: Vec::new(),
        normals: Vec::new(),
        indices: Vec::new(),
    };

    // outward unit normals along each axis
    let nvec = |axis: usize, pos: bool| -> [f32; 3] {
        let mut n = [0.0f32; 3];
        n[axis] = if pos { 1.0 } else { -1.0 };
        n
    };

    let cell_in_hole = |uc: f64, vc: f64| -> bool {
        holes.iter().any(|h| uc > h.u_lo && uc < h.u_hi && vc > h.v_lo && vc < h.v_hi)
    };

    // --- Front (w = min, outward −w) and Back (w = max, outward +w): conforming
    //     (u×v) grid, omit cells whose centre lies in a hole. ---
    for (wi, front) in [(0usize, true), (1usize, false)] {
        let wc = sw[wi];
        let n = nvec(w, !front); // front face outward = −w
        for i in 0..u_lines.len() - 1 {
            for j in 0..v_lines.len() - 1 {
                let (u0, u1) = (u_lines[i], u_lines[i + 1]);
                let (v0, v1) = (v_lines[j], v_lines[j + 1]);
                if cell_in_hole((u0 + u1) * 0.5, (v0 + v1) * 0.5) {
                    continue;
                }
                let c00 = world(u, v, w, u0, v0, wc);
                let c10 = world(u, v, w, u1, v0, wc);
                let c11 = world(u, v, w, u1, v1, wc);
                let c01 = world(u, v, w, u0, v1, wc);
                if front {
                    b.quad([c00, c01, c11, c10], n); // CCW seen from −w (outward)
                } else {
                    b.quad([c00, c10, c11, c01], n); // CCW seen from +w
                }
            }
        }
    }

    // --- Reveal (jamb) faces: the 4 inner walls of every hole, spanning the
    //     through-depth. CONFORMING-split along the crossing grid lines from
    //     OTHER holes so the jamb's edge on the front/back face matches the
    //     annulus sub-edge for sub-edge (no T-junctions). ---
    // Grid lines strictly inside [lo,hi], plus the endpoints — the breakpoints a
    // jamb edge must be split at to match the conforming annulus.
    let sub = |lines: &[f64], lo: f64, hi: f64| -> Vec<f64> {
        let mut s = vec![lo];
        for &c in lines {
            if c > lo && c < hi {
                s.push(c);
            }
        }
        s.push(hi);
        s
    };
    let (w0, w1) = (sw[0], sw[1]);
    for h in holes {
        // low-u and high-u jambs: split along v.
        let vbreaks = sub(v_lines, h.v_lo, h.v_hi);
        for (uc, pos) in [(h.u_lo, true), (h.u_hi, false)] {
            let n = nvec(u, pos);
            for k in 0..vbreaks.len() - 1 {
                let (va, vb) = (vbreaks[k], vbreaks[k + 1]);
                b.quad(
                    [
                        world(u, v, w, uc, va, w0),
                        world(u, v, w, uc, vb, w0),
                        world(u, v, w, uc, vb, w1),
                        world(u, v, w, uc, va, w1),
                    ],
                    n,
                );
            }
        }
        // sill and head jambs: split along u.
        let ubreaks = sub(u_lines, h.u_lo, h.u_hi);
        for (vc, pos) in [(h.v_lo, true), (h.v_hi, false)] {
            let n = nvec(v, pos);
            for k in 0..ubreaks.len() - 1 {
                let (ua, ub) = (ubreaks[k], ubreaks[k + 1]);
                b.quad(
                    [
                        world(u, v, w, ua, vc, w0),
                        world(u, v, w, ub, vc, w0),
                        world(u, v, w, ub, vc, w1),
                        world(u, v, w, ua, vc, w1),
                    ],
                    n,
                );
            }
        }
    }

    // --- The 4 unchanged side faces (u = min/max, v = min/max), CONFORMING-split
    //     at the crossing grid lines so they match the annulus sub-edge for
    //     sub-edge. Side faces at u=const span v×w; at v=const span u×w. ---
    let su = [snap(bx.min[u]), snap(bx.max[u])];
    let sv = [snap(bx.min[v]), snap(bx.max[v])];
    // u = min (outward −u) and u = max (outward +u): split along v_lines.
    for (uc, pos) in [(su[0], false), (su[1], true)] {
        let n = nvec(u, pos);
        for j in 0..v_lines.len() - 1 {
            let (v0, v1) = (v_lines[j], v_lines[j + 1]);
            let c0 = world(u, v, w, uc, v0, sw[0]);
            let c1 = world(u, v, w, uc, v1, sw[0]);
            let c2 = world(u, v, w, uc, v1, sw[1]);
            let c3 = world(u, v, w, uc, v0, sw[1]);
            if pos {
                b.quad([c0, c1, c2, c3], n);
            } else {
                b.quad([c0, c3, c2, c1], n);
            }
        }
    }
    // v = min (outward −v) and v = max (outward +v): split along u_lines.
    for (vc, pos) in [(sv[0], false), (sv[1], true)] {
        let n = nvec(v, pos);
        for i in 0..u_lines.len() - 1 {
            let (u0, u1) = (u_lines[i], u_lines[i + 1]);
            let c0 = world(u, v, w, u0, vc, sw[0]);
            let c1 = world(u, v, w, u1, vc, sw[0]);
            let c2 = world(u, v, w, u1, vc, sw[1]);
            let c3 = world(u, v, w, u0, vc, sw[1]);
            if pos {
                b.quad([c0, c3, c2, c1], n);
            } else {
                b.quad([c0, c1, c2, c3], n);
            }
        }
    }

    let mut m = Mesh::new();
    m.positions = b.positions;
    m.normals = b.normals;
    m.indices = b.indices;
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Closed axis-aligned box, 12 outward triangles.
    fn box_mesh(min: [f64; 3], max: [f64; 3]) -> Mesh {
        let c = [
            [min[0], min[1], min[2]],
            [max[0], min[1], min[2]],
            [max[0], max[1], min[2]],
            [min[0], max[1], min[2]],
            [min[0], min[1], max[2]],
            [max[0], min[1], max[2]],
            [max[0], max[1], max[2]],
            [min[0], max[1], max[2]],
        ];
        let faces: [([usize; 4], [f32; 3]); 6] = [
            ([0, 3, 2, 1], [0.0, 0.0, -1.0]),
            ([4, 5, 6, 7], [0.0, 0.0, 1.0]),
            ([0, 1, 5, 4], [0.0, -1.0, 0.0]),
            ([2, 3, 7, 6], [0.0, 1.0, 0.0]),
            ([0, 4, 7, 3], [-1.0, 0.0, 0.0]),
            ([1, 2, 6, 5], [1.0, 0.0, 0.0]),
        ];
        let mut m = Mesh::new();
        for (idx, n) in faces {
            let b = (m.positions.len() / 3) as u32;
            for &i in &idx {
                m.positions.extend_from_slice(&[c[i][0] as f32, c[i][1] as f32, c[i][2] as f32]);
                m.normals.extend_from_slice(&n);
            }
            m.indices.extend_from_slice(&[b, b + 1, b + 2, b, b + 2, b + 3]);
        }
        m
    }

    /// DIRECTED exact-f32-bit edge audit (the production crack detector,
    /// mesh_bridge::exact_open_edges): a watertight oriented surface has every
    /// directed edge cancelled by its reverse — catches both cracks AND
    /// inconsistent winding.
    fn open_edges(m: &Mesh) -> usize {
        use std::collections::HashMap;
        let key = |i: u32| {
            let b = i as usize * 3;
            (m.positions[b].to_bits(), m.positions[b + 1].to_bits(), m.positions[b + 2].to_bits())
        };
        let mut edges: HashMap<_, i64> = HashMap::new();
        for t in m.indices.chunks_exact(3) {
            for (a, b) in [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                *edges.entry((key(a), key(b))).or_insert(0) += 1;
                *edges.entry((key(b), key(a))).or_insert(0) -= 1;
            }
        }
        edges.values().filter(|&&c| c != 0).count()
    }

    fn degenerate(m: &Mesh) -> usize {
        let v = |i: u32| {
            let b = i as usize * 3;
            [m.positions[b], m.positions[b + 1], m.positions[b + 2]]
        };
        let mut n = 0;
        for t in m.indices.chunks_exact(3) {
            let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
            let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            let cr = [
                e1[1] * e2[2] - e1[2] * e2[1],
                e1[2] * e2[0] - e1[0] * e2[2],
                e1[0] * e2[1] - e1[1] * e2[0],
            ];
            if cr[0] * cr[0] + cr[1] * cr[1] + cr[2] * cr[2] == 0.0 {
                n += 1;
            }
        }
        n
    }

    /// Signed volume × 6 (divergence), about origin.
    fn vol6(m: &Mesh) -> f64 {
        let v = |i: u32| {
            let b = i as usize * 3;
            [m.positions[b] as f64, m.positions[b + 1] as f64, m.positions[b + 2] as f64]
        };
        let mut s = 0.0;
        for t in m.indices.chunks_exact(3) {
            let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
            let cr = [
                b[1] * c[2] - b[2] * c[1],
                b[2] * c[0] - b[0] * c[2],
                b[0] * c[1] - b[1] * c[0],
            ];
            s += a[0] * cr[0] + a[1] * cr[1] + a[2] * cr[2];
        }
        s
    }

    // 4m × 0.2m × 3m wall (thin along Y). Opening boxes poke through Y.
    fn wall(base: [f64; 3]) -> Mesh {
        box_mesh(base, [base[0] + 4.0, base[1] + 0.2, base[2] + 3.0])
    }
    fn opening(base: [f64; 3], u0: f64, u1: f64, z0: f64, z1: f64) -> ([f64; 3], [f64; 3]) {
        (
            [base[0] + u0, base[1] - 0.1, base[2] + z0],
            [base[0] + u1, base[1] + 0.3, base[2] + z1],
        )
    }

    fn check_watertight(base: [f64; 3], openings: &[([f64; 3], [f64; 3])], label: &str) {
        let host = wall(base);
        let mut st = RectFastStats::default();
        let cut = subtract_rect_openings(&host, openings, &mut st)
            .unwrap_or_else(|| panic!("{label}: expected fast path to fire, deferred: {st:?}"));
        assert_eq!(open_edges(&cut), 0, "{label}: not watertight");
        assert_eq!(degenerate(&cut), 0, "{label}: degenerate triangles");
        // Removed volume ≈ Σ opening∩host volume.
        let removed = (vol6(&host) - vol6(&cut)) / 6.0;
        let mut expect = 0.0;
        let (hmn, hmx) = (base, [base[0] + 4.0, base[1] + 0.2, base[2] + 3.0]);
        for (omn, omx) in openings {
            let mut vv = 1.0;
            for k in 0..3 {
                vv *= (omx[k].min(hmx[k]) - omn[k].max(hmn[k])).max(0.0);
            }
            expect += vv;
        }
        // Volume tolerance scales with f32 ULP at the host's magnitude (a wall
        // 220 km from origin carries ~12 mm of inherent f32 error per coordinate
        // — true of ANY f32 mesh there, exact kernel included; the cut is still
        // watertight). Relative 2% OR absolute scale-aware, whichever is looser.
        let mag = base[0].abs().max(base[2].abs()).max(1.0);
        let vtol = (expect * 0.02).max(mag * 2f64.powi(-23) * 6.0);
        assert!(
            (removed - expect).abs() < vtol,
            "{label}: removed {removed} != expected {expect} (tol {vtol})"
        );
    }

    #[test]
    fn single_opening_watertight_origin() {
        check_watertight([0.0, 0.0, 0.0], &[opening([0.0, 0.0, 0.0], 1.5, 2.5, 0.5, 2.0)], "single-origin");
    }

    #[test]
    fn single_opening_watertight_building_scale() {
        check_watertight(
            [221_534.0, 98_210.0, 47_001.0],
            &[opening([221_534.0, 98_210.0, 47_001.0], 1.5, 2.5, 0.5, 2.0)],
            "single-building",
        );
    }

    #[test]
    fn multi_opening_watertight() {
        let base = [10.0, 5.0, 2.0];
        let ops = [
            opening(base, 0.4, 1.2, 0.5, 2.4),
            opening(base, 1.6, 2.4, 0.5, 2.4),
            opening(base, 2.8, 3.6, 0.5, 1.0),
        ];
        check_watertight(base, &ops, "multi-3");
    }

    #[test]
    fn defers_non_box_host() {
        // a tetrahedron-ish non-box host
        let mut host = Mesh::new();
        host.positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        host.normals = vec![0.0; 12];
        host.indices = vec![0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
        let mut st = RectFastStats::default();
        assert!(subtract_rect_openings(&host, &[opening([0.0, 0.0, 0.0], 1.5, 2.5, 0.5, 2.0)], &mut st).is_none());
        assert_eq!(st.defer_host_not_box, 1);
    }

    #[test]
    fn defers_non_through_opening() {
        // opening that does NOT span the full Y thickness (a recess, not a hole)
        let base = [0.0, 0.0, 0.0];
        let recess = ([1.5, 0.05, 0.5], [2.5, 0.15, 2.0]); // y inside the wall
        let mut st = RectFastStats::default();
        assert!(subtract_rect_openings(&wall(base), &[recess], &mut st).is_none());
        assert_eq!(st.defer_not_through, 1);
    }

    #[test]
    fn defers_off_face_opening() {
        // opening centred off the wall's X extent (touches/exceeds the edge)
        let base = [0.0, 0.0, 0.0];
        let off = opening(base, 3.8, 4.5, 0.5, 2.0); // u_hi clamps to wall edge → no reveal
        let mut st = RectFastStats::default();
        assert!(subtract_rect_openings(&wall(base), &[off], &mut st).is_none());
        assert_eq!(st.defer_off_face, 1);
    }

    #[test]
    fn defers_near_edge_at_building_scale() {
        // 8 µm reveal at ~220 km: below f32 ULP → must defer (the robustness gate)
        let base = [221_534.0, 98_210.0, 47_001.0];
        let tight = opening(base, 8e-6, 4.0 - 8e-6, 8e-6, 3.0 - 8e-6);
        let mut st = RectFastStats::default();
        assert!(
            subtract_rect_openings(&wall(base), &[tight], &mut st).is_none(),
            "near-edge at building scale must defer, not crack"
        );
    }

    #[test]
    fn deterministic_output() {
        let base = [10.0, 5.0, 2.0];
        let ops = [opening(base, 1.5, 2.5, 0.5, 2.0)];
        let mut s1 = RectFastStats::default();
        let mut s2 = RectFastStats::default();
        let a = subtract_rect_openings(&wall(base), &ops, &mut s1).unwrap();
        let b = subtract_rect_openings(&wall(base), &ops, &mut s2).unwrap();
        assert_eq!(a.positions, b.positions);
        assert_eq!(a.indices, b.indices);
    }
}
