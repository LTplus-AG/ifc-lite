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

/// The kernel's canonical reconcile grid. Power of two ⇒ the snap is an exact
/// f64 op ⇒ bit-deterministic native==wasm.
use crate::kernel::mesh_bridge::SNAP_GRID;

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
    /// Over the opening cap, or a cell grid whose cells x openings is too large.
    pub defer_too_many_openings: u64,
}

/// Escape hatch: `IFC_LITE_RECT_FAST=0` is the GLOBAL rect-fast kill switch.
/// It forces every opening back through the exact kernel (parity debugging /
/// bisection) by disabling BOTH the legacy world-axis-aligned path gated here
/// AND the parametric placement-frame path ([`param_enabled`] honours it), so
/// setting this single flag is sufficient to route all rectangular openings
/// through CSG. Default ON: the path is a pure optimization that defers on
/// any precondition miss. To disable only the parametric path, set
/// `IFC_LITE_RECT_PARAM=0` instead.
pub fn enabled() -> bool {
    use std::sync::OnceLock;
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var("IFC_LITE_RECT_FAST").as_deref() != Ok("0"))
}

static PARAM_OVERRIDE: std::sync::atomic::AtomicI8 = std::sync::atomic::AtomicI8::new(-1);

/// PARAMETRIC rectangular-opening fast path (placement-frame, ground-truth-exact cut).
/// DEFAULT ON -- opt out with `IFC_LITE_RECT_PARAM=0` (parametric path only),
/// `IFC_LITE_RECT_FAST=0` (the GLOBAL rect-fast kill switch: disables this path AND
/// the legacy [`enabled`] path, preserving the documented single-flag parity/bisection
/// hatch), or `param_set_enabled_override`. Gated separately from [`enabled`] because
/// it is a deliberate behaviour change: it emits the analytic box-minus-boxes solid,
/// which is MORE correct than the exact kernel on engulfing-opening walls.
/// Corpus-validated ON (tests/rect_param_validate.rs A/B over 5 real models): every
/// non-firing element byte-identical ON vs OFF, every firing host watertight and
/// matching the analytic ground truth. wasm has no env, so `std::env::var` errs there
/// and the default is ON on both targets -- native==wasm stays in lockstep; the
/// wasm-side `setRectParamFastPath` override remains the programmatic escape hatch
/// (and, being an explicit per-process call, takes precedence over both env flags).
pub fn param_enabled() -> bool {
    match PARAM_OVERRIDE.load(std::sync::atomic::Ordering::Relaxed) {
        0 => return false,
        1 => return true,
        _ => {}
    }
    use std::sync::OnceLock;
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| {
        param_env_default(enabled(), std::env::var("IFC_LITE_RECT_PARAM").as_deref().ok())
    })
}

/// Env-flag decision core for [`param_enabled`], pure so the semantics are
/// unit-testable without mutating process env: the parametric path is ON unless
/// its own flag opts out (`IFC_LITE_RECT_PARAM=0`) or the global rect-fast kill
/// switch is thrown (`IFC_LITE_RECT_FAST=0`, surfaced here as `rect_fast_on ==
/// false` via [`enabled`]). `IFC_LITE_RECT_PARAM=1` cannot resurrect the path
/// past the kill switch: the kill switch means "exact kernel for everything".
fn param_env_default(rect_fast_on: bool, rect_param: Option<&str>) -> bool {
    rect_fast_on && rect_param != Some("0")
}

/// Test-only: force `param_enabled()` on/off (or `None` for the env default).
pub fn param_set_enabled_override(v: Option<bool>) {
    PARAM_OVERRIDE.store(
        match v {
            None => -1,
            Some(false) => 0,
            Some(true) => 1,
        },
        std::sync::atomic::Ordering::Relaxed,
    );
}

#[path = "rect_fast/param_stats.rs"]
mod param_stats;
pub use param_stats::{param_record_fire, take_param_fires};
pub(crate) use param_stats::publish_param_fire;

// rect_fast engagement counters are now REQUEST-LOCAL: each cut records into its
// router via `GeometryRouter::record_rect_fast` (drained by `take_rect_fast_stats`),
// so concurrent native geometry passes get isolated per-load `rectFast` diagnostics.
// The previous process-global atomic sink (`record_global` / `take_global_stats`)
// was removed because it cross-contaminated concurrent loads.

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

/// Result of the cut: a watertight `Mesh`, or `None` to defer to the exact
/// kernel. `openings` are world AABBs (min,max) of axis-aligned rectangular
/// cutters. Handles WINDOWS, DOORS (flush to an edge), recesses, and overlapping
/// openings uniformly via a 3D CELLULAR decomposition: split the host box by
/// every opening plane on all three axes, mark each cell solid (in the host,
/// outside every opening) or void, and emit each cell face that borders a void
/// cell or the grid boundary. Watertight by construction — adjacent cells share
/// snapped grid vertices bit-identically, so no T-junctions and no cracks.
pub fn subtract_rect_openings(
    host: &Mesh,
    openings: &[([f64; 3], [f64; 3])],
    stats: &mut RectFastStats,
) -> Option<Mesh> {
    if openings.is_empty() {
        stats.defer_no_openings += 1;
        return None;
    }
    // build_cellular is O(cells * openings) and cells grow with the opening count,
    // so a crafted host with thousands of tiny openings is O(N^3) -> unbounded
    // hang. 128 is far above any real wall (1-20 openings); defer the pathological
    // case to the exact kernel (bounded per-element, #1121) rather than hang.
    const MAX_FAST_OPENINGS: usize = 128;
    // cells x openings. Real hosts stay tiny: across the 120-file IFC corpus
    // the largest firing is 1860 (a 20-window wall is ~1e4). A 128-opening
    // staggered curtain host is ~1.7e7 cells (257^3) but ~2e9 cells x openings.
    // Past this cap the exact kernel's per-element bound wins.
    const MAX_FAST_CELL_TESTS: usize = 1 << 25;
    if openings.len() > MAX_FAST_OPENINGS {
        stats.defer_too_many_openings += 1;
        return None;
    }
    let bx = match aligned_box(host) {
        Some(b) => b,
        None => {
            stats.defer_host_not_box += 1;
            return None;
        }
    };

    // Scale-aware near-edge epsilon: two grid lines closer than this would
    // collapse into one f32 at the host's world magnitude, cracking the cut.
    // max(|coord|)·2^-21 keeps >= 4 f32 ULP between distinct lines; floored at the
    // snap grid so origin-scale hosts stay permissive.
    let mag = (0..3)
        .map(|k| bx.min[k].abs().max(bx.max[k].abs()))
        .fold(0.0f64, f64::max);
    let near_eps = (mag * (1.0 / 2_097_152.0)).max(SNAP_GRID);

    // Clamp every opening to the host shell (a cutter extended through the wall
    // pokes past) and keep only those that overlap on all 3 axes. A
    // non-overlapping opening is a no-op (the SILENT NO-OP case) — drop it.
    let smin = [snap(bx.min[0]), snap(bx.min[1]), snap(bx.min[2])];
    let smax = [snap(bx.max[0]), snap(bx.max[1]), snap(bx.max[2])];
    let mut clamped: Vec<[[f64; 3]; 2]> = Vec::with_capacity(openings.len());
    for (omn, omx) in openings {
        let mut cmn = [0.0; 3];
        let mut cmx = [0.0; 3];
        let mut overlaps = true;
        let mut covers_full = true;
        for k in 0..3 {
            cmn[k] = snap(omn[k].max(bx.min[k]));
            cmx[k] = snap(omx[k].min(bx.max[k]));
            if cmx[k] - cmn[k] <= near_eps {
                overlaps = false;
            }
            // Does the clamped opening reach the host edge-to-edge on this axis?
            if cmn[k] > smin[k] + near_eps || cmx[k] < smax[k] - near_eps {
                covers_full = false;
            }
        }
        // An opening that CONTAINS the whole host on all three axes is a
        // degenerate / double-encoded redundant void: the void is already baked
        // into the wall profile and re-added as an opening element (#964). The
        // exact kernel treats it as a no-op (coplanar cutter faces → host left
        // unchanged), so the fast path MUST NOT cut it — doing so erases the
        // entire wall and leaves the window floating in a giant void (#1167).
        // Defer the whole host to the exact path to match its behaviour.
        if covers_full {
            stats.defer_off_face += 1;
            return None;
        }
        if overlaps {
            clamped.push([cmn, cmx]);
        }
    }
    if clamped.is_empty() {
        // Nothing actually cuts — defer the no-op to the exact path (it owns the
        // SILENT NO-OP diagnostic) rather than returning an unchanged clone.
        stats.defer_off_face += 1;
        return None;
    }

    // Per-axis grid lines: host bounds + every clamped opening edge, snapped,
    // sorted, deduplicated; near-coincident-but-distinct lines (<= near_eps) →
    // defer (f32-collapse risk).
    let mut grid: [Vec<f64>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for k in 0..3 {
        let mut edges = vec![snap(bx.min[k]), snap(bx.max[k])];
        for c in &clamped {
            edges.push(c[0][k]);
            edges.push(c[1][k]);
        }
        match dedup_axis(edges, near_eps) {
            Some(g) => grid[k] = g,
            None => {
                stats.defer_near_edge += 1;
                return None;
            }
        }
    }

    // build_cellular tests every cell against every opening, so its work is
    // cells x openings, and 128 openings staggered on all three axes make
    // 257^3 cells: seconds per element in a path that exists to be fast
    // (#7675, PROC-16). The opening cap alone bounds the wrong quantity.
    let work = grid.iter().try_fold(clamped.len(), |acc, g| acc.checked_mul(g.len() - 1));
    if work.is_none_or(|w| w > MAX_FAST_CELL_TESTS) {
        stats.defer_too_many_openings += 1;
        return None;
    }
    let cut = build_cellular(&grid, &clamped);
    stats.fired += 1;
    stats.openings_cut += clamped.len() as u64;
    Some(cut)
}

/// Coplanar-merge an analytic cut, but never trade an exactly closed cut for an
/// open one. Consolidation's size rules (needle, ring noise) drop the rim faces
/// of a thin residual web, such as the ~40 um left between two openings an
/// author kept apart (#7942), and tear the mesh open.
pub(crate) fn consolidate_keeping_closed(cut: Mesh) -> Mesh {
    use crate::exact_topology::strict_closed_mesh;
    if !strict_closed_mesh(&cut) {
        return crate::csg::ClippingProcessor::consolidate_coplanar(cut);
    }
    let merged = crate::csg::ClippingProcessor::consolidate_coplanar(cut.clone());
    if strict_closed_mesh(&merged) {
        merged
    } else {
        cut
    }
}

/// Sort + dedup grid lines on one axis; `None` if two DISTINCT lines are at most
/// `near_eps` apart (an f32-collapse risk → defer). Identical snapped values
/// (e.g. a door edge coinciding with the host edge) collapse to one line.
fn dedup_axis(mut edges: Vec<f64>, near_eps: f64) -> Option<Vec<f64>> {
    // A non-finite coord (NaN/Inf from a corrupt mesh) would panic the sort under
    // `panic=abort` and crash the whole batch — defer to the exact kernel instead.
    if edges.iter().any(|v| !v.is_finite()) {
        return None;
    }
    edges.sort_by(|a, b| a.total_cmp(b));
    let mut out: Vec<f64> = Vec::with_capacity(edges.len());
    for c in edges {
        match out.last() {
            Some(&last) => {
                let d = (c - last).abs();
                if d == 0.0 {
                    // same line — keep one
                } else if d <= near_eps {
                    return None; // distinct but too close → collapse risk
                } else {
                    out.push(c);
                }
            }
            None => out.push(c),
        }
    }
    if out.len() < 2 {
        return None;
    }
    Some(out)
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

/// 3D cellular exposed-face extraction. `grid[axis]` is the sorted snapped grid
/// lines on that axis. A cell is solid iff its centre lies outside every opening
/// (it is always inside the host); emit every face of a solid cell that borders
/// a void cell or the grid boundary, with the outward normal — skipping faces
/// internal to the solid region. Watertight: a shared face between two solid
/// cells is emitted by neither; every boundary face is emitted exactly once on
/// the snapped grid, so reverse edges cancel bit-for-bit.
fn build_cellular(grid: &[Vec<f64>; 3], openings: &[[[f64; 3]; 2]]) -> Mesh {
    let nc = [grid[0].len() - 1, grid[1].len() - 1, grid[2].len() - 1];
    let center = |axis: usize, i: usize| (grid[axis][i] + grid[axis][i + 1]) * 0.5;
    // Each cell's solidity once (cells x openings), not once per neighbour
    // query (7x that); indexed (i * ny + j) * nz + k, the loop order below.
    let mut solid_cells = Vec::with_capacity(nc[0] * nc[1] * nc[2]);
    for i in 0..nc[0] {
        for j in 0..nc[1] {
            for k in 0..nc[2] {
                let p = [center(0, i), center(1, j), center(2, k)];
                solid_cells.push(!openings.iter().any(|o| (0..3).all(|a| p[a] > o[0][a] && p[a] < o[1][a])));
            }
        }
    }
    let solid = |c: [usize; 3]| solid_cells[(c[0] * nc[1] + c[1]) * nc[2] + c[2]];
    let mut b = Builder {
        positions: Vec::new(),
        normals: Vec::new(),
        indices: Vec::new(),
    };

    for i in 0..nc[0] {
        for j in 0..nc[1] {
            for k in 0..nc[2] {
                let cell = [i, j, k];
                if !solid(cell) {
                    continue;
                }
                for axis in 0..3 {
                    let (a1, a2) = match axis {
                        0 => (1usize, 2usize),
                        1 => (0usize, 2usize),
                        _ => (0usize, 1usize),
                    };
                    for &pos in &[false, true] {
                        let exposed = if pos {
                            cell[axis] == nc[axis] - 1 || !solid({
                                let mut n = cell;
                                n[axis] += 1;
                                n
                            })
                        } else {
                            cell[axis] == 0 || !solid({
                                let mut n = cell;
                                n[axis] -= 1;
                                n
                            })
                        };
                        if !exposed {
                            continue;
                        }
                        let coord = grid[axis][cell[axis] + usize::from(pos)];
                        let (lo1, hi1) = (grid[a1][cell[a1]], grid[a1][cell[a1] + 1]);
                        let (lo2, hi2) = (grid[a2][cell[a2]], grid[a2][cell[a2] + 1]);
                        let corner = |x1: f64, x2: f64| {
                            let mut q = [0.0; 3];
                            q[axis] = coord;
                            q[a1] = x1;
                            q[a2] = x2;
                            q
                        };
                        let mut n = [0.0f32; 3];
                        n[axis] = if pos { 1.0 } else { -1.0 };
                        b.quad(
                            [
                                corner(lo1, lo2),
                                corner(hi1, lo2),
                                corner(hi1, hi2),
                                corner(lo1, hi2),
                            ],
                            n,
                        );
                    }
                }
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
#[path = "rect_fast_tests.rs"]
mod tests;
