// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Re-planarise the operands of a wall-local-frame cut (#5635).
//!
//! A plan-rotated wall reaches the void path as f32 world positions. Rotating
//! those into the wall frame (#1167) makes every face axis-aligned only up to
//! the world f32 quantum: at 60 m from the origin one face of an 80 mm layer
//! lands on ~50 distinct depth values spread over ~8 µm. The exact kernel and
//! the coplanar merge then see many near-parallel planes where the authored
//! wall has one, and the cut keeps T-junction seams along them (52 open
//! directed edges on the #5410 reporter's curtain-wall layer, 0 on the
//! axis-aligned twin of the same wall, which never leaves exact world axes).
//!
//! The fix restores the invariant the frame exists for: per frame axis, every
//! coordinate of the host and its cutters within the world quantum of another
//! is moved to one shared value. Coordinates that differ by more than that are
//! untouched, so real features are never merged. It is a RETRY: the caller
//! runs it only when the unsnapped cut came back open, and keeps it only when
//! it is closed and consistently wound, so every already-clean cut stays
//! byte-identical (snapping unconditionally regressed the geometry census,
//! #5905).

use super::OpeningType;
use crate::router::diagnostics::HostOpeningDiagnostic;
use crate::router::GeometryRouter;
use crate::{BoolFailure, Mesh, Point3};

/// Coordinates closer than this many f32 ULPs of the world magnitude are one
/// value. Rotation of a quantised point moves it by up to ~1 ULP per axis;
/// the margin covers the sum over the three world components.
const QUANTUM_ULPS: f64 = 4.0;

/// Upper bound on the snap tolerance (metres). Far from the origin the world
/// quantum grows past real feature sizes (48 mm at 100 km); a snap that large
/// would collapse thin layers, so it stops at 0.1 mm and leaves the rest to
/// the RTC rebase.
const MAX_SNAP_TOLERANCE: f64 = 1e-4;

/// A cluster wider than this many tolerances is not rounding noise but a
/// chain of distinct, closely spaced values (dense tessellation); it is left
/// untouched rather than collapsed onto one plane.
const MAX_CLUSTER_SPAN_TOLERANCES: f64 = 4.0;

/// The f32 quantum of world coordinates of magnitude `world_magnitude`, times
/// [`QUANTUM_ULPS`] and capped at [`MAX_SNAP_TOLERANCE`]: the tolerance
/// [`snap_to_frame_planes`] clusters within.
pub(super) fn frame_snap_tolerance(world_magnitude: f64) -> f64 {
    (QUANTUM_ULPS * f32::EPSILON as f64 * world_magnitude.max(1.0)).min(MAX_SNAP_TOLERANCE)
}

/// Per-axis clusters of nearby coordinate values: sorted `(first, last,
/// representative)` runs whose consecutive gaps are all `<= tol` and whose
/// whole span is at most [`MAX_CLUSTER_SPAN_TOLERANCES`] tolerances.
struct AxisClusters(Vec<(f64, f64, f64)>);

impl AxisClusters {
    fn build(mut values: Vec<f64>, tol: f64) -> Self {
        values.retain(|v| v.is_finite());
        values.sort_by(f64::total_cmp);
        let mut runs = Vec::new();
        let mut start = 0;
        for i in 1..=values.len() {
            if i == values.len() || values[i] - values[i - 1] > tol {
                let span = values[i - 1] - values[start];
                if i > start + 1 && span <= MAX_CLUSTER_SPAN_TOLERANCES * tol {
                    // The median member: a value that really occurs, and the
                    // same one whatever order the operands arrived in. Rounded
                    // to f32 so mesh vertices and f64 opening bounds land on
                    // bit-identical planes.
                    let rep = values[(start + i - 1) / 2] as f32 as f64;
                    runs.push((values[start], values[i - 1], rep));
                }
                start = i;
            }
        }
        Self(runs)
    }

    fn snap(&self, v: f64) -> f64 {
        let i = self.0.partition_point(|&(_, last, _)| last < v);
        match self.0.get(i) {
            Some(&(first, last, rep)) if first <= v && v <= last => rep,
            _ => v,
        }
    }
}

/// Move every coordinate of `host` and of each opening's cutter mesh and
/// bounds, per frame axis, onto the shared representative of its cluster.
/// All operands are expressed in the same wall frame.
pub(super) fn snap_to_frame_planes(host: &mut Mesh, openings: &mut [OpeningType], tol: f64) {
    let mut per_axis: [Vec<f64>; 3] = Default::default();
    let collect_mesh = |m: &Mesh, per_axis: &mut [Vec<f64>; 3]| {
        for c in m.positions.chunks_exact(3) {
            for k in 0..3 {
                per_axis[k].push(c[k] as f64);
            }
        }
    };
    collect_mesh(host, &mut per_axis);
    for op in openings.iter() {
        let (mesh, lo, hi) = parts(op);
        if let Some(m) = mesh {
            collect_mesh(m, &mut per_axis);
        }
        for k in 0..3 {
            per_axis[k].push(lo[k]);
            per_axis[k].push(hi[k]);
        }
    }
    let clusters = per_axis.map(|values| AxisClusters::build(values, tol));

    let snap_mesh = |m: &mut Mesh| {
        for c in m.positions.chunks_exact_mut(3) {
            for k in 0..3 {
                c[k] = clusters[k].snap(c[k] as f64) as f32;
            }
        }
    };
    let snap_point = |p: &mut Point3<f64>| {
        for k in 0..3 {
            p[k] = clusters[k].snap(p[k]);
        }
    };
    snap_mesh(host);
    for op in openings.iter_mut() {
        match op {
            OpeningType::Rectangular(lo, hi, _) => {
                snap_point(lo);
                snap_point(hi);
            }
            OpeningType::NonRectangular(m, lo, hi, _) => {
                snap_mesh(m);
                snap_point(lo);
                snap_point(hi);
            }
            OpeningType::DiagonalRectangular(m, _) => snap_mesh(m),
        }
    }
}

/// Every undirected edge is used exactly once in each direction (closed,
/// consistently wound, manifold) with vertices welded at BOTH 0.1 mm (the #5635
/// measurement) and 1 mm (the geometry census's weld, which also skips
/// collapsed triangles). This is the strict directed-pair rule (#3397) the
/// census gates on, not just a zero net balance, which a 2-forward/2-reverse
/// seam or a duplicated sheet also satisfies. An empty mesh does not pass.
pub(super) fn closed_and_consistently_wound(mesh: &Mesh) -> bool {
    strictly_paired_at(mesh, 1.0e4) && strictly_paired_at(mesh, 1.0e3)
}

/// [`closed_and_consistently_wound`] after the degenerate-triangle hygiene the
/// emitted void-cut mesh gets: `process_element_with_voids` runs
/// `Mesh::clean_degenerate`, which is `drop_thin_triangles` at the kernel's
/// `SNAP_GRID`, so this replays both. A cut can be closed only through µm
/// slivers that hygiene then drops, reopening it (#5739).
pub(super) fn closed_as_emitted(mesh: &Mesh) -> bool {
    let mut probe = mesh.clone();
    probe.clean_degenerate();
    closed_and_consistently_wound(&probe)
}

fn strictly_paired_at(mesh: &Mesh, per_unit: f64) -> bool {
    let key = |i: u32| {
        let b = i as usize * 3;
        [0, 1, 2].map(|k| (mesh.positions[b + k] as f64 * per_unit).round() as i64)
    };
    let mut uses: rustc_hash::FxHashMap<([i64; 3], [i64; 3]), (u32, u32)> =
        rustc_hash::FxHashMap::default();
    for t in mesh.indices.chunks_exact(3) {
        let (ka, kb, kc) = (key(t[0]), key(t[1]), key(t[2]));
        if ka == kb || kb == kc || kc == ka {
            continue;
        }
        for (x, y) in [(ka, kb), (kb, kc), (kc, ka)] {
            let e = uses.entry((x.min(y), x.max(y))).or_insert((0, 0));
            if x < y {
                e.0 += 1;
            } else {
                e.1 += 1;
            }
        }
    }
    !uses.is_empty() && uses.values().all(|&u| u == (1, 1))
}

/// Enclosed volume of a closed mesh about its bounds centre (m³).
pub(super) fn enclosed_volume(mesh: &Mesh) -> f64 {
    let (lo, hi) = mesh.bounds();
    let o = [
        (lo.x as f64 + hi.x as f64) / 2.0,
        (lo.y as f64 + hi.y as f64) / 2.0,
        (lo.z as f64 + hi.z as f64) / 2.0,
    ];
    let p = |i: u32| {
        let b = i as usize * 3;
        [0, 1, 2].map(|k| mesh.positions[b + k] as f64 - o[k])
    };
    mesh.indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                + a[2] * (b[0] * c[1] - b[1] * c[0]))
                / 6.0
        })
        .sum()
}

/// The per-host diagnostics one void cut records on the router. The retry
/// runs the cut twice; only the run whose mesh is KEPT may leave its record,
/// so the caller snapshots around the retry and restores the other one.
pub(super) struct HostDiagSnapshot {
    csg_failures: Option<Vec<BoolFailure>>,
    host_diag: Option<HostOpeningDiagnostic>,
    consumed: bool,
    rect_fast: crate::rect_fast::RectFastStats,
}

impl HostDiagSnapshot {
    pub(super) fn capture(router: &GeometryRouter, host: u32) -> Self {
        Self {
            csg_failures: router.csg_failures.borrow().get(&host).cloned(),
            host_diag: router.host_opening_diagnostics.borrow().get(&host).cloned(),
            consumed: router.voids_consumed_hosts.borrow().contains(&host),
            rect_fast: *router.rect_fast_stats.borrow(),
        }
    }

    pub(super) fn restore(self, router: &GeometryRouter, host: u32) {
        let mut failures = router.csg_failures.borrow_mut();
        match self.csg_failures {
            Some(v) => failures.insert(host, v),
            None => failures.remove(&host),
        };
        let mut diags = router.host_opening_diagnostics.borrow_mut();
        match self.host_diag {
            Some(d) => diags.insert(host, d),
            None => diags.remove(&host),
        };
        let mut consumed = router.voids_consumed_hosts.borrow_mut();
        if self.consumed {
            consumed.insert(host);
        } else {
            consumed.remove(&host);
        }
        *router.rect_fast_stats.borrow_mut() = self.rect_fast;
    }
}

fn parts(op: &OpeningType) -> (Option<&Mesh>, Point3<f64>, Point3<f64>) {
    match op {
        OpeningType::Rectangular(lo, hi, _) => (None, *lo, *hi),
        OpeningType::NonRectangular(m, lo, hi, _) => (Some(m), *lo, *hi),
        OpeningType::DiagonalRectangular(m, _) => {
            let (lo, hi) = m.bounds();
            (
                Some(m),
                Point3::new(lo.x as f64, lo.y as f64, lo.z as f64),
                Point3::new(hi.x as f64, hi.y as f64, hi.z as f64),
            )
        }
    }
}

#[cfg(test)]
#[path = "frame_snap_tests.rs"]
mod tests;
