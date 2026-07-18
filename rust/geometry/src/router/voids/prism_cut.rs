// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Analytic prism subtraction on the host MESH.
//!
//! The dominant expensive void cut on CSG-heavy models (ISSUE_098 / ISSUE_129)
//! is a PERPENDICULAR prism opening — a window / door / sleeve — on a host the
//! other fast paths cannot serve: faceted-BREP walls, clipped extrusions,
//! multi-item bodies. The exact mesh-arrangement kernel is at its
//! single-threaded floor (~15 ms per cut), yet the cutter is just a polygonal
//! profile swept through the wall (masonry openings are REBATED — stepped
//! multi-vertex profiles, not plain boxes). This path subtracts such a cutter
//! analytically from ANY host mesh:
//!
//! 1. DETECT that the cutter mesh is a genuine prism: a closed 2-manifold with
//!    one depth axis `d` such that every facet is either parallel (the two end
//!    caps, each on one extremal plane) or perpendicular (the sides) to `d`;
//!    the profile polygon is stitched from the cap facet's boundary loop and
//!    the enclosed volume must reconcile with `area × depth`. Any deviation
//!    (curved-cap void, open shell, annular profile, self-intersecting
//!    garbage) is left to the exact kernel.
//! 2. EXTEND each cap past the host surface when (and only when) the swept
//!    slab is provably empty of host material — a flush cap becomes a clean
//!    transversal crossing (the #1112 lesson) while a genuine blind recess
//!    keeps its authored bottom.
//! 3. DECOMPOSE only the host triangles that actually reach the prism: each
//!    such triangle T gets the exact `T ∩ ∂prism` seam segments (cap-plane
//!    chords clipped to the profile in 2D; side-strip chords clipped to the
//!    strip rectangle) as constraints of a per-triangle conforming CDT, whose
//!    sub-triangles are classified inside/outside the prism by centroid.
//!    Shared edges subdivide identically across neighbours (every edge×plane
//!    crossing is computed once through a canonical-order cache and admitted
//!    by a point-deterministic face-membership gate), so the kept surface
//!    stays T-junction-free. Triangles away from the prism pass through
//!    UNTOUCHED — original coordinates and normals.
//! 4. CAP the reveal: each prism face (2 profile caps + one rectangle per
//!    profile edge) is triangulated by a CDT of the face polygon constrained
//!    by the seams from step 3, each sub-triangle kept iff its centroid lies
//!    inside the (pre-cut) host solid by ray parity. Cap boundaries reuse the
//!    exact seam coordinates, so caps weld to the kept host fragments.
//!
//! SELF-CHECKS (all hard gates — any failure defers to the exact kernel with
//! the FULL opening set unchanged):
//! * per-opening volume identity `vol(outside) + vol(inside) == vol(host)` in
//!   f64 (the caps cancel; the fragments partition the host surface), plus
//!   `0 < vol(inside) <= vol(prism)` so the caps provably close the removed
//!   solid;
//! * the host must arrive as a consistently-wound closed solid and the final
//!   emitted mesh must pass the same DIRECTED quantized closed-surface audit
//!   (which also catches doubled coincident faces and flipped caps).
//!
//! The whole computation runs in f64 (host f32 promoted once, stored f32 once
//! at the end), with no FMA-sensitive matrix products and deterministic
//! iteration order, so native == wasm stays byte-identical (#1297). Vertices
//! are never welded (#846); per-element `origin` is preserved exactly.
//!
//! Gate: `IFC_LITE_PRISM_CUT=0` forces every host back through the exact
//! kernel (A/B measurement). Default ON; wasm has no env, so the default holds
//! on both targets.

use std::sync::OnceLock;

use super::geom::opening_mesh_thinnest_axis_dir;
use super::{cutter_is_closed_manifold, GeometryRouter, OpeningType, VoidContext};
use crate::cdt::triangulate_pslg;
use crate::mesh::Mesh;
use nalgebra::Point2;
use rustc_hash::FxHashMap;

/// `IFC_LITE_PRISM_CUT=0` disables the analytic prism-subtraction path (exact
/// kernel for every host). Default ON; read once.
pub(super) fn enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var("IFC_LITE_PRISM_CUT").as_deref() != Ok("0"))
}

// ─────────────────────────── diagnostic counters ────────────────────────────
// Per the geometry-crate convention, telemetry is compiled in ONLY under an
// observability feature (`observability` / `csg_capture` / `debug_geometry`).
// The default build carries no process-global atomics on the hot path — no
// per-opening atomic traffic, and no shared mutable state for concurrent unit
// tests to race on. `take_prism_stats` / `take_prism_defers` stay public in
// both configurations (return zeros when the feature is off) so the crate's
// exported surface is stable; unit tests assert path coverage through
// `try_prism_cut`'s RETURN VALUE, not these counters.

#[cfg(any(feature = "observability", feature = "csg_capture", feature = "debug_geometry"))]
mod diag {
    use std::sync::atomic::{AtomicU64, Ordering};

    static FIRES: AtomicU64 = AtomicU64::new(0);
    static OPENINGS_ANALYTIC: AtomicU64 = AtomicU64::new(0);
    static OPENINGS_RESIDUAL: AtomicU64 = AtomicU64::new(0);

    /// Defer-reason counters (diagnostic only): indices into [`DEFER_NAMES`].
    const DEFER_NAMES: [&str; 10] = [
        "host_not_closed",
        "host_promote_fail",
        "op_not_prism",
        "op_tiny",
        "op_no_overlap",
        "op_engulf",
        "op_veto_overlap",
        "cut_cdt_fail",
        "cut_vol_fail",
        "out_not_closed",
    ];
    static DEFERS: [AtomicU64; 10] = [
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
        AtomicU64::new(0),
    ];

    #[inline]
    pub(super) fn defer(i: usize) {
        DEFERS[i].fetch_add(1, Ordering::Relaxed);
    }

    /// Record one analytic-cut host: (fires, openings cut, openings residual).
    #[inline]
    pub(super) fn record_cut(committed_ops: usize, residual: usize) {
        FIRES.fetch_add(1, Ordering::Relaxed);
        OPENINGS_ANALYTIC.fetch_add(committed_ops as u64, Ordering::Relaxed);
        OPENINGS_RESIDUAL.fetch_add(residual as u64, Ordering::Relaxed);
    }

    /// Read + reset the per-reason defer counters as (name, count) pairs.
    pub fn take_prism_defers() -> Vec<(&'static str, u64)> {
        DEFER_NAMES
            .iter()
            .enumerate()
            .map(|(i, n)| (*n, DEFERS[i].swap(0, Ordering::Relaxed)))
            .collect()
    }

    /// Read + reset the prism-path telemetry: (hosts cut via the prism path,
    /// openings subtracted analytically, openings routed to the exact residual
    /// on prism-cut hosts). Process-global; the perf harness reports the
    /// fast-path hit-rate from it. Relaxed atomics — a stale read under
    /// concurrency only mis-reports a diagnostic count, never geometry.
    pub fn take_prism_stats() -> (u64, u64, u64) {
        (
            FIRES.swap(0, Ordering::Relaxed),
            OPENINGS_ANALYTIC.swap(0, Ordering::Relaxed),
            OPENINGS_RESIDUAL.swap(0, Ordering::Relaxed),
        )
    }
}

#[cfg(not(any(feature = "observability", feature = "csg_capture", feature = "debug_geometry")))]
mod diag {
    #[inline]
    pub(super) fn defer(_i: usize) {}
    #[inline]
    pub(super) fn record_cut(_committed_ops: usize, _residual: usize) {}
    /// Telemetry disabled in the default build; the perf harness must enable an
    /// observability feature to read real counts.
    pub fn take_prism_defers() -> Vec<(&'static str, u64)> {
        Vec::new()
    }
    pub fn take_prism_stats() -> (u64, u64, u64) {
        (0, 0, 0)
    }
}

use diag::{defer, record_cut};
pub use diag::{take_prism_defers, take_prism_stats};

// ─────────────────────────── small f64 vector kit ───────────────────────────
// Explicit component arithmetic (no nalgebra matrix products) so no FMA can
// sneak in and break native==wasm byte identity.

type V3 = [f64; 3];
type V2 = [f64; 2];

#[inline]
fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
#[inline]
fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
#[inline]
fn scale(a: V3, s: f64) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
#[inline]
fn cross(a: V3, b: V3) -> V3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
#[inline]
fn norm(a: V3) -> f64 {
    dot(a, a).sqrt()
}
#[inline]
fn normalize(a: V3) -> Option<V3> {
    let n = norm(a);
    if !n.is_finite() || n < 1.0e-12 {
        None
    } else {
        Some(scale(a, 1.0 / n))
    }
}
#[inline]
fn lerp(a: V3, b: V3, t: f64) -> V3 {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}
#[inline]
fn bits(p: V3) -> [u64; 3] {
    [p[0].to_bits(), p[1].to_bits(), p[2].to_bits()]
}

/// Even-odd point-in-polygon (half-open crossing rule — deterministic on
/// boundary-adjacent points, and identical for every caller testing the same
/// point, which is what the neighbour-consistency argument needs).
fn pip(pt: V2, poly: &[V2]) -> bool {
    let (x, y) = (pt[0], pt[1]);
    let n = poly.len();
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (poly[i][0], poly[i][1]);
        let (xj, yj) = (poly[j][0], poly[j][1]);
        if (yi > y) != (yj > y) {
            let xc = xi + (y - yi) / (yj - yi) * (xj - xi);
            if x < xc {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

/// Parameter `t ∈ [0, 1]` on segment `p→q` where it crosses segment `a→b`
/// (proper or endpoint-touching crossing), or `None` when parallel / disjoint.
fn seg_cross_param(p: V2, q: V2, a: V2, b: V2) -> Option<f64> {
    let r = [q[0] - p[0], q[1] - p[1]];
    let s = [b[0] - a[0], b[1] - a[1]];
    let denom = r[0] * s[1] - r[1] * s[0];
    if denom.abs() < 1.0e-18 {
        return None;
    }
    let ap = [a[0] - p[0], a[1] - p[1]];
    let t = (ap[0] * s[1] - ap[1] * s[0]) / denom;
    let u = (ap[0] * r[1] - ap[1] * r[0]) / denom;
    const E: f64 = 1.0e-12;
    if (-E..=1.0 + E).contains(&t) && (-E..=1.0 + E).contains(&u) {
        Some(t.clamp(0.0, 1.0))
    } else {
        None
    }
}

/// DIRECTED quantized closed-surface audit (0.1 mm grid): every directed edge
/// must be cancelled by its reverse. Strictly stronger than the undirected
/// 2-manifold check — it catches inconsistent winding and doubled coincident
/// surfaces (two triangles sharing an edge in the SAME direction), not just
/// cracks. Triangles that collapse to a degenerate key on the grid are skipped
/// (their edges net to zero).
fn directed_closed(mesh: &Mesh) -> bool {
    let key = |i: u32| -> (i64, i64, i64) {
        let b = i as usize * 3;
        let q = |v: f32| (v as f64 / 1.0e-4).round() as i64;
        (
            q(mesh.positions[b]),
            q(mesh.positions[b + 1]),
            q(mesh.positions[b + 2]),
        )
    };
    let mut edges: FxHashMap<((i64, i64, i64), (i64, i64, i64)), i64> = FxHashMap::default();
    for tri in mesh.indices.chunks_exact(3) {
        let (ka, kb, kc) = (key(tri[0]), key(tri[1]), key(tri[2]));
        if ka == kb || kb == kc || kc == ka {
            continue;
        }
        for (x, y) in [(ka, kb), (kb, kc), (kc, ka)] {
            *edges.entry((x, y)).or_insert(0) += 1;
            *edges.entry((y, x)).or_insert(0) -= 1;
        }
    }
    !edges.is_empty() && edges.values().all(|&c| c == 0)
}

/// Closed-surface audit with a HAIRLINE tolerance: the surface passes when
/// every unpaired directed edge (0.1 mm grid) is collinearly COVERED by
/// unpaired edges of the opposite net sign — the signature of two adjacent
/// faces subdividing a shared boundary line differently (a T-junction chain,
/// invisible sub-grid gap), NOT of a missing surface. A genuine hole leaves a
/// boundary loop whose edges have nothing opposite along them and fails. The
/// exact kernel's own output is routinely NOT even undirected-watertight on
/// these hosts, so this gate is still far stricter than the status quo.
fn closed_or_hairline(mesh: &Mesh) -> bool {
    type K = (i64, i64, i64);
    let key = |i: u32| -> K {
        let b = i as usize * 3;
        let q = |v: f32| (v as f64 / 1.0e-4).round() as i64;
        (
            q(mesh.positions[b]),
            q(mesh.positions[b + 1]),
            q(mesh.positions[b + 2]),
        )
    };
    let mut edges: FxHashMap<(K, K), i64> = FxHashMap::default();
    for tri in mesh.indices.chunks_exact(3) {
        let (ka, kb, kc) = (key(tri[0]), key(tri[1]), key(tri[2]));
        if ka == kb || kb == kc || kc == ka {
            continue;
        }
        for (x, y) in [(ka, kb), (kb, kc), (kc, ka)] {
            *edges.entry((x, y)).or_insert(0) += 1;
            *edges.entry((y, x)).or_insert(0) -= 1;
        }
    }
    if edges.is_empty() {
        return false;
    }
    // Canonicalize to undirected segments with a net sign.
    let mut bad: Vec<(K, K, i64)> = Vec::new();
    for (&(a, b), &c) in edges.iter() {
        if c > 0 {
            bad.push((a, b, c));
        }
    }
    if bad.is_empty() {
        return true;
    }
    if bad.len() > 64 {
        return false; // way past hairline territory
    }
    let p = |k: K| [k.0 as f64, k.1 as f64, k.2 as f64]; // grid units (0.1 mm)

    // Rigorous hairline test. A hairline (T-junction) boundary is one where the
    // uncancelled directed edges, viewed as a 1-D SIGNED measure along each
    // supporting line, net to ZERO everywhere: every stretch covered by an edge
    // running one way is covered the SAME number of times by edges running the
    // other way (two adjacent faces subdividing a shared line differently). A
    // genuine hole — or a boundary edge only PARTIALLY covered, or covered the
    // wrong number of times — leaves a stretch with nonzero net coverage and
    // fails. This is strictly stronger than the old midpoint-proximity test,
    // which a LONG unmatched edge could spoof merely by having a SHORT reverse
    // edge sit near its midpoint (the short edge "covered" a single point, never
    // the whole interval, and multiplicity was ignored entirely).
    const COLLINEAR_TOL: f64 = 2.0; // grid units (~0.2 mm) perpendicular slack
    const T_EPS: f64 = 1.0e-6; // grid units: ignore sub-interval slivers

    struct Seg {
        a: V3,
        b: V3,
        m: i64,
    }
    let segs: Vec<Seg> = bad
        .iter()
        .map(|&(a, b, c)| Seg {
            a: p(a),
            b: p(b),
            m: c,
        })
        .collect();

    // Perpendicular distance from point `x` to the infinite line `(o, dir)`
    // (`dir` unit). Perp distance is convex along a segment, so if BOTH
    // endpoints of a segment are within tol of a line, the whole segment is —
    // that is our collinearity-coincidence test (no separate parallel check
    // needed, and it correctly rejects a segment that merely crosses the line).
    let perp = |x: V3, o: V3, dir: V3| -> f64 {
        let w = sub(x, o);
        let along = dot(w, dir);
        norm(sub(w, scale(dir, along)))
    };

    struct Line {
        o: V3,
        dir: V3,
        members: Vec<usize>,
    }
    // Seed lines from the LONGEST segments first: a long edge fixes a stable
    // direction, so its collinear short neighbours join it rather than each
    // spawning a slightly-rotated line of its own (greedy fragmentation would
    // split a genuinely-covered boundary across groups and report phantom gaps).
    let mut order: Vec<usize> = (0..segs.len()).collect();
    order.sort_by(|&i, &j| {
        let li = dot(sub(segs[i].b, segs[i].a), sub(segs[i].b, segs[i].a));
        let lj = dot(sub(segs[j].b, segs[j].a), sub(segs[j].b, segs[j].a));
        lj.partial_cmp(&li).unwrap()
    });
    let mut lines: Vec<Line> = Vec::new();
    'seg: for si in order {
        let s = &segs[si];
        let Some(sdir) = normalize(sub(s.b, s.a)) else {
            // Degenerate (zero-length) bad edge: cannot seal anything → defer.
            return false;
        };
        for line in lines.iter_mut() {
            if perp(s.a, line.o, line.dir) <= COLLINEAR_TOL
                && perp(s.b, line.o, line.dir) <= COLLINEAR_TOL
            {
                line.members.push(si);
                continue 'seg;
            }
        }
        lines.push(Line {
            o: s.a,
            dir: sdir,
            members: vec![si],
        });
    }

    // Sweep each line's signed multiplicity coverage. At every point along the
    // line the signed count of covering edges (this line's `+dir` edges minus
    // its `-dir` edges, weighted by multiplicity) must net to ZERO — the exact
    // T-junction signature. We track the longest CONTIGUOUS mis-covered run and
    // reject once it exceeds `GAP_TOL`: a hole, a partially-covered long edge,
    // or a multiply-covered stretch leaves a macroscopic run, whereas the ≤0.2mm
    // sub-grid jitter of a genuine hairline stays inside the same quantization
    // slack the collinearity grouping already allows. (This deliberately still
    // admits the hosts whose exact-kernel meshing is itself not undirected-
    // watertight — the documented reason the hairline gate exists — while the
    // old midpoint test's spoof, a long edge grazed only near its midpoint by a
    // short reverse edge, leaves a run of nearly the whole edge and is rejected.)
    const GAP_TOL: f64 = COLLINEAR_TOL; // 2 grid units (~0.2 mm)
    for line in &lines {
        let mut ints: Vec<(f64, f64, i64)> = Vec::with_capacity(line.members.len());
        let mut breaks: Vec<f64> = Vec::with_capacity(line.members.len() * 2);
        for &si in &line.members {
            let s = &segs[si];
            let ta = dot(sub(s.a, line.o), line.dir);
            let tb = dot(sub(s.b, line.o), line.dir);
            let sign = if tb >= ta { 1 } else { -1 };
            ints.push((ta.min(tb), ta.max(tb), sign * s.m));
            breaks.push(ta);
            breaks.push(tb);
        }
        breaks.sort_by(|x, y| x.partial_cmp(y).unwrap());
        let mut run = 0.0_f64;
        for w in breaks.windows(2) {
            let (lo, hi) = (w[0], w[1]);
            let len = hi - lo;
            if len <= T_EPS {
                continue;
            }
            let mid = 0.5 * (lo + hi);
            let mut sum = 0i64;
            for &(ilo, ihi, sm) in &ints {
                if ilo - T_EPS <= mid && mid <= ihi + T_EPS {
                    sum += sm;
                }
            }
            if sum != 0 {
                run += len;
                if run > GAP_TOL {
                    return false;
                }
            } else {
                run = 0.0;
            }
        }
    }
    true
}

/// One host triangle in f64 (positions + per-vertex normals), host-local frame.
#[derive(Clone)]
struct PTri {
    p: [V3; 3],
    n: [V3; 3],
}

impl PTri {
    /// Signed volume contribution about the origin (divergence theorem, ×6).
    #[inline]
    fn vol6(&self) -> f64 {
        dot(self.p[0], cross(self.p[1], self.p[2]))
    }
    #[inline]
    fn aabb(&self) -> (V3, V3) {
        let mut lo = self.p[0];
        let mut hi = self.p[0];
        for v in &self.p[1..] {
            for k in 0..3 {
                lo[k] = lo[k].min(v[k]);
                hi[k] = hi[k].max(v[k]);
            }
        }
        (lo, hi)
    }
}

fn tri_volume6(tris: &[PTri]) -> f64 {
    tris.iter().map(PTri::vol6).sum()
}

/// Promote a `Mesh` to the f64 triangle list, folding nothing (the mesh is
/// taken in its own frame — `origin` semantics are preserved by the caller).
fn ptris_from_mesh(mesh: &Mesh) -> Option<Vec<PTri>> {
    // Reject structurally malformed meshes outright: `chunks_exact(3)` below
    // silently drops any trailing partial triple, so a positions/indices length
    // that is not a multiple of 3 would rebuild the solid missing its tail data
    // while every emitted index still passed its bounds check.
    if !mesh.positions.len().is_multiple_of(3) || !mesh.indices.len().is_multiple_of(3) {
        return None;
    }
    let vc = mesh.positions.len() / 3;
    let have_normals = mesh.normals.len() == mesh.positions.len();
    let mut out = Vec::with_capacity(mesh.indices.len() / 3);
    for t in mesh.indices.chunks_exact(3) {
        if t.iter().any(|&i| i as usize >= vc) {
            return None;
        }
        let read = |i: u32| -> V3 {
            let b = i as usize * 3;
            [
                mesh.positions[b] as f64,
                mesh.positions[b + 1] as f64,
                mesh.positions[b + 2] as f64,
            ]
        };
        let p = [read(t[0]), read(t[1]), read(t[2])];
        if p.iter().any(|v| v.iter().any(|c| !c.is_finite())) {
            return None;
        }
        let n = if have_normals {
            let rn = |i: u32| -> V3 {
                let b = i as usize * 3;
                [
                    mesh.normals[b] as f64,
                    mesh.normals[b + 1] as f64,
                    mesh.normals[b + 2] as f64,
                ]
            };
            [rn(t[0]), rn(t[1]), rn(t[2])]
        } else {
            let fnrm =
                normalize(cross(sub(p[1], p[0]), sub(p[2], p[0]))).unwrap_or([0.0, 0.0, 1.0]);
            [fnrm, fnrm, fnrm]
        };
        out.push(PTri { p, n });
    }
    Some(out)
}

/// Store the f64 triangle list back to an f32 `Mesh` in the host's frame.
/// Per-triangle vertices (no sharing, no welding — #846); normals normalized
/// with the triangle's geometric normal as fallback.
fn mesh_from_ptris(tris: &[PTri], template: &Mesh) -> Mesh {
    let mut positions = Vec::with_capacity(tris.len() * 9);
    let mut normals = Vec::with_capacity(tris.len() * 9);
    let mut indices = Vec::with_capacity(tris.len() * 3);
    for (i, t) in tris.iter().enumerate() {
        let face = normalize(cross(sub(t.p[1], t.p[0]), sub(t.p[2], t.p[0])))
            .unwrap_or([0.0, 0.0, 1.0]);
        for v in 0..3 {
            positions.push(t.p[v][0] as f32);
            positions.push(t.p[v][1] as f32);
            positions.push(t.p[v][2] as f32);
            let n = normalize(t.n[v]).unwrap_or(face);
            normals.push(n[0] as f32);
            normals.push(n[1] as f32);
            normals.push(n[2] as f32);
        }
        let base = (i * 3) as u32;
        indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
    Mesh {
        positions,
        normals,
        indices,
        rtc_applied: template.rtc_applied,
        origin: template.origin,
        instance_meta: None,
        local_bounds: None,
        local_to_world: None,
    }
}

// ─────────────────────────────── prism cutter ───────────────────────────────

/// Maximum profile vertex count admitted to the analytic path (face ids must
/// fit `u8`, and a pathological many-gon belongs to the exact kernel anyway).
const MAX_PROFILE_VERTS: usize = 120;

/// A stepped-extrusion cutter: a stack of K depth slabs along axis `d`, slab
/// `k` spanning `planes[k]..planes[k+1]` with constant CCW cross-section
/// `profiles[k]`. K = 1 is a plain prism; K > 1 is the REBATED masonry opening
/// (the ISSUE_098 window voids: outer box + inner box sharing a step plane).
/// `(u, v, d)` is orthonormal right-handed (`u × v = d`).
#[derive(Clone)]
struct PrismFrame {
    u: V3,
    v: V3,
    d: V3,
    /// K+1 sorted depth planes.
    planes: Vec<f64>,
    /// K CCW simple polygons (no holes), one per slab.
    profiles: Vec<Vec<V2>>,
    /// Per-slab |area|.
    slab_area: Vec<f64>,
    /// Per-slab strictly interior point (max-area CDT triangle centroid —
    /// robust for non-convex rebated profiles).
    slab_interior: Vec<V2>,
    /// Overall profile bounding box (lo, hi) in `(u, v)`.
    bb: (V2, V2),
}

impl PrismFrame {
    #[inline]
    fn d0(&self) -> f64 {
        self.planes[0]
    }
    #[inline]
    fn d1(&self) -> f64 {
        *self.planes.last().unwrap()
    }
    #[inline]
    fn volume(&self) -> f64 {
        (0..self.profiles.len())
            .map(|k| self.slab_area[k] * (self.planes[k + 1] - self.planes[k]))
            .sum()
    }
    /// Canonical lift `(u, v, depth) → 3D`. FIXED summation order so every
    /// face computing the same point produces identical bits.
    #[inline]
    fn lift(&self, uu: f64, vv: f64, w: f64) -> V3 {
        add(add(scale(self.u, uu), scale(self.v, vv)), scale(self.d, w))
    }
    #[inline]
    fn to2(&self, p: V3) -> V2 {
        [dot(p, self.u), dot(p, self.v)]
    }
    /// Strict interior test (open solid).
    #[inline]
    fn contains(&self, p: V3) -> bool {
        let w = dot(p, self.d);
        if w <= self.d0() || w >= self.d1() {
            return false;
        }
        let q = self.to2(p);
        for k in 0..self.profiles.len() {
            if w < self.planes[k + 1] {
                return pip(q, &self.profiles[k]);
            }
        }
        false
    }
    /// Largest coordinate magnitude over the swept profile corners (epsilon
    /// scaling).
    fn corner_mag(&self) -> f64 {
        let mut mag = 0.0f64;
        for prof in &self.profiles {
            for &[uu, vv] in prof {
                for w in [self.d0(), self.d1()] {
                    for c in self.lift(uu, vv, w) {
                        mag = mag.max(c.abs());
                    }
                }
            }
        }
        mag
    }
    /// Conservative OBB of the solid (profile bbox × depth) as (axes, lo, hi)
    /// intervals for the SAT overlap veto.
    fn obb(&self) -> ([V3; 3], V3, V3) {
        (
            [self.u, self.v, self.d],
            [self.bb.0[0], self.bb.0[1], self.d0()],
            [self.bb.1[0], self.bb.1[1], self.d1()],
        )
    }
}

/// One face of the stepped solid.
#[derive(Clone, Copy)]
enum Face {
    /// The depth plane `planes[j]`; its exposed region is the XOR of the
    /// adjacent slab profiles (`∅` beyond the ends).
    Cap { j: usize },
    /// Side strip of slab `k`, profile edge `i`, over
    /// `planes[k]..planes[k+1]`.
    Strip { k: usize, i: usize },
}

/// Enumerate the faces of a stack deterministically.
fn stack_faces(pf: &PrismFrame) -> Vec<Face> {
    let mut out = Vec::new();
    for j in 0..pf.planes.len() {
        out.push(Face::Cap { j });
    }
    for k in 0..pf.profiles.len() {
        for i in 0..pf.profiles[k].len() {
            out.push(Face::Strip { k, i });
        }
    }
    out
}

/// Whether a 2D point lies in cap `j`'s exposed region: inside exactly one of
/// the two adjacent slab profiles (XOR; the region a stepped shoulder or an
/// end cap exposes). Point-deterministic — every caller agrees.
fn cap_xor(pf: &PrismFrame, j: usize, q: V2) -> bool {
    let in_prev = j > 0 && pip(q, &pf.profiles[j - 1]);
    let in_next = j < pf.profiles.len() && pip(q, &pf.profiles[j]);
    in_prev != in_next
}

/// Oriented-box overlap via the separating-axis theorem (15 axes), with a
/// positive `margin` treating near-contact as overlap. Boxes given as
/// (orthonormal axes, per-axis projection interval).
fn obb_overlaps(a: &([V3; 3], V3, V3), b: &([V3; 3], V3, V3), margin: f64) -> bool {
    let centre = |x: &([V3; 3], V3, V3)| -> V3 {
        let mid = [
            (x.1[0] + x.2[0]) * 0.5,
            (x.1[1] + x.2[1]) * 0.5,
            (x.1[2] + x.2[2]) * 0.5,
        ];
        add(
            add(scale(x.0[0], mid[0]), scale(x.0[1], mid[1])),
            scale(x.0[2], mid[2]),
        )
    };
    let half = |x: &([V3; 3], V3, V3), k: usize| (x.2[k] - x.1[k]) * 0.5;
    let dvec = sub(centre(b), centre(a));
    let mut axes: Vec<V3> = Vec::with_capacity(15);
    for k in 0..3 {
        axes.push(a.0[k]);
        axes.push(b.0[k]);
    }
    for i in 0..3 {
        for j in 0..3 {
            let c = cross(a.0[i], b.0[j]);
            if norm(c) > 1.0e-9 {
                axes.push(c);
            }
        }
    }
    for l in axes {
        let Some(l) = normalize(l) else { continue };
        let ra: f64 = (0..3).map(|k| half(a, k) * dot(a.0[k], l).abs()).sum();
        let rb: f64 = (0..3).map(|k| half(b, k) * dot(b.0[k], l).abs()).sum();
        if dot(dvec, l).abs() > ra + rb + margin {
            return false;
        }
    }
    true
}

/// Deterministic orthonormal right-handed basis `(u, v)` for a depth axis `d`
/// (`u × v = d`), using the same seed convention as `OpeningFrame::from_depth`.
fn basis_from_depth(d: V3) -> Option<(V3, V3)> {
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
const MAX_SLABS: usize = 6;

/// Remove collinear run vertices from a ring (the cross-section stitcher emits
/// one vertex per crossed cutter edge, subdividing straight profile sides).
/// Beyond bloating the face set, they defeat the profile-edge extension: every
/// edge's neighbours look collinear, so the corner re-derivation guard skips
/// it — the #1112 flush-strip roofs never extended.
fn simplify_collinear(profile: &mut Vec<V2>, tol: f64) {
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
fn ccw_area(profile: &mut Vec<V2>) -> Option<f64> {
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
fn ring_interior(profile: &[V2]) -> Option<V2> {
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
fn cross_section_ring(
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

/// Detect that the (welded) cutter is a stepped extrusion and extract its
/// stack. `verts`/`tris` are the welded cutter in host-local coordinates;
/// `mesh_vol` is the enclosed volume of the (unwelded) cutter. Conservative:
/// any doubt returns `None` → the exact kernel keeps the opening.
fn detect_prism(verts: &[V3], tris: &[[usize; 3]], mesh_vol: f64) -> Option<PrismFrame> {
    if tris.len() < 8 || tris.len() > 4096 {
        return None;
    }
    // Facet normals; cluster into candidate depth directions.
    let mut normals: Vec<Option<V3>> = Vec::with_capacity(tris.len());
    for t in tris {
        let (a, b, c) = (verts[t[0]], verts[t[1]], verts[t[2]]);
        normals.push(normalize(cross(sub(b, a), sub(c, a))));
    }
    let mut clusters: Vec<V3> = Vec::new();
    for n in normals.iter().flatten() {
        if !clusters.iter().any(|c| dot(*n, *c).abs() > 0.999) {
            if clusters.len() > 64 {
                return None; // way past any stepped extrusion — bail early
            }
            clusters.push(*n);
        }
    }
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

/// Build the analytic prism for one classified opening, expressed in the
/// host's local frame (`origin` subtracted in f64). `None` ⇒ the opening is
/// not a clean prism and stays with the exact kernel.
fn prepare_prism(op: &OpeningType, origin: [f64; 3]) -> Option<PrismFrame> {
    match op {
        OpeningType::Rectangular(mn, mx, dir) => {
            let lo = [mn.x - origin[0], mn.y - origin[1], mn.z - origin[2]];
            let hi = [mx.x - origin[0], mx.y - origin[1], mx.z - origin[2]];
            if (0..3).any(|k| hi[k] - lo[k] < 1.0e-4 || !lo[k].is_finite() || !hi[k].is_finite())
            {
                return None;
            }
            // Depth axis: the authored (axis-aligned) extrusion dir, else the
            // thinnest extent (the classic wall-thickness cutter).
            let k = match dir {
                Some(d) => {
                    let a = [d.x.abs(), d.y.abs(), d.z.abs()];
                    let mut k = 0;
                    for i in 1..3 {
                        if a[i] > a[k] {
                            k = i;
                        }
                    }
                    k
                }
                None => {
                    let ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
                    let mut k = 0;
                    for i in 1..3 {
                        if ext[i] < ext[k] {
                            k = i;
                        }
                    }
                    k
                }
            };
            let mut d = [0.0; 3];
            d[k] = 1.0;
            let (u, v) = basis_from_depth(d)?;
            // Rectangle profile from the AABB corners projected to (u, v).
            let mut plo = [f64::INFINITY; 2];
            let mut phi = [f64::NEG_INFINITY; 2];
            for ci in 0..8 {
                let c = [
                    if ci & 1 == 0 { lo[0] } else { hi[0] },
                    if ci & 2 == 0 { lo[1] } else { hi[1] },
                    if ci & 4 == 0 { lo[2] } else { hi[2] },
                ];
                let uu = dot(c, u);
                let vv = dot(c, v);
                plo[0] = plo[0].min(uu);
                plo[1] = plo[1].min(vv);
                phi[0] = phi[0].max(uu);
                phi[1] = phi[1].max(vv);
            }
            let profile = vec![
                [plo[0], plo[1]],
                [phi[0], plo[1]],
                [phi[0], phi[1]],
                [plo[0], phi[1]],
            ];
            let area = (phi[0] - plo[0]) * (phi[1] - plo[1]);
            Some(PrismFrame {
                u,
                v,
                d,
                planes: vec![lo[k], hi[k]],
                profiles: vec![profile],
                slab_area: vec![area],
                slab_interior: vec![[(plo[0] + phi[0]) * 0.5, (plo[1] + phi[1]) * 0.5]],
                bb: (plo, phi),
            })
        }
        OpeningType::DiagonalRectangular(m, _) | OpeningType::NonRectangular(m, _, _, _) => {
            // A genuine prism must weld to a closed 2-manifold; the
            // self-intersecting "fin" cutters (#1007) and open shells fail
            // here and keep their exact-kernel (+ malformed-recut) treatment.
            // An opening authored as glued extrusions carries a back-to-back
            // cap membrane mid-cutter that breaks manifoldness — deseam it
            // first (the same repair every exact void path funnels through).
            let deseamed;
            let m = if cutter_is_closed_manifold(m) {
                m
            } else {
                let dir = match op {
                    OpeningType::DiagonalRectangular(_, frame) => frame.depth,
                    OpeningType::NonRectangular(_, _, _, Some(d)) => *d,
                    _ => opening_mesh_thinnest_axis_dir(m),
                };
                deseamed = GeometryRouter::remove_internal_membrane(m, dir);
                if !cutter_is_closed_manifold(&deseamed) {
                    return None;
                }
                &deseamed
            };
            // Host-local f64 verts (cutter origin folded, host origin removed).
            let o = m.origin;
            let vc = m.positions.len() / 3;
            let mut raw: Vec<V3> = Vec::with_capacity(vc);
            for c in m.positions.chunks_exact(3) {
                let p = [
                    c[0] as f64 + o[0] - origin[0],
                    c[1] as f64 + o[1] - origin[1],
                    c[2] as f64 + o[2] - origin[2],
                ];
                if p.iter().any(|x| !x.is_finite()) {
                    return None;
                }
                raw.push(p);
            }
            // Enclosed volume from the raw (per-face-vertex) soup.
            let mut vol6 = 0.0;
            for t in m.indices.chunks_exact(3) {
                if t.iter().any(|&i| i as usize >= vc) {
                    return None;
                }
                let (a, b, c) = (
                    raw[t[0] as usize],
                    raw[t[1] as usize],
                    raw[t[2] as usize],
                );
                vol6 += dot(a, cross(b, c));
            }
            // Weld by position for exact edge stitching of the cap boundary.
            let mut wverts: Vec<V3> = Vec::new();
            let mut wmap: FxHashMap<(i64, i64, i64), usize> = FxHashMap::default();
            let q = |x: f64| (x / 1.0e-6).round() as i64;
            let mut idx_of = vec![0usize; raw.len()];
            for (i, p) in raw.iter().enumerate() {
                let key = (q(p[0]), q(p[1]), q(p[2]));
                let id = *wmap.entry(key).or_insert_with(|| {
                    wverts.push(*p);
                    wverts.len() - 1
                });
                idx_of[i] = id;
            }
            let mut wtris: Vec<[usize; 3]> = Vec::with_capacity(m.indices.len() / 3);
            for t in m.indices.chunks_exact(3) {
                let a = idx_of[t[0] as usize];
                let b = idx_of[t[1] as usize];
                let c = idx_of[t[2] as usize];
                if a != b && b != c && c != a {
                    wtris.push([a, b, c]);
                }
            }
            detect_prism(&wverts, &wtris, vol6 / 6.0)
        }
    }
}

/// Cyclic CCW-ring equality within `tol`.
fn rings_equal(a: &[V2], b: &[V2], tol: f64) -> bool {
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
fn try_merge_prisms(a: &PrismFrame, b: &PrismFrame, tol: f64) -> Option<PrismFrame> {
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
fn opening_aabb_obb(op: &OpeningType, origin: [f64; 3]) -> Option<([V3; 3], V3, V3)> {
    let (mn, mx): (V3, V3) = match op {
        OpeningType::Rectangular(mn, mx, _) | OpeningType::NonRectangular(_, mn, mx, _) => {
            ([mn.x, mn.y, mn.z], [mx.x, mx.y, mx.z])
        }
        OpeningType::DiagonalRectangular(m, _) => {
            let (a, b) = m.bounds();
            let o = m.origin;
            (
                [a.x as f64 + o[0], a.y as f64 + o[1], a.z as f64 + o[2]],
                [b.x as f64 + o[0], b.y as f64 + o[1], b.z as f64 + o[2]],
            )
        }
    };
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

// ─────────────────────────── ray parity (point in solid) ─────────────────────

/// Fixed skewed ray direction (same constants as `geom::point_inside_mesh`) —
/// avoids exact grazes on the axis-dominated faces of IFC geometry.
const RAY_DIR: V3 = [0.573_257_1, 0.665_412_3, 0.477_889_5];

/// Möller–Trumbore crossing parity of `point` against the triangle list (with
/// precomputed AABBs). Odd ⇒ inside the solid.
fn point_inside(tris: &[PTri], aabbs: &[(V3, V3)], point: V3) -> bool {
    let mut crossings = 0usize;
    for (t, (_lo, hi)) in tris.iter().zip(aabbs) {
        // Cheap reject: every component of `RAY_DIR` is positive, so a hit
        // point has all coordinates strictly greater than the origin's — a
        // triangle entirely below the origin on ANY axis cannot be crossed.
        if hi[0] < point[0] || hi[1] < point[1] || hi[2] < point[2] {
            continue;
        }
        let e1 = sub(t.p[1], t.p[0]);
        let e2 = sub(t.p[2], t.p[0]);
        let pvec = cross(RAY_DIR, e2);
        let det = dot(e1, pvec);
        if det.abs() < 1.0e-12 {
            continue;
        }
        let inv = 1.0 / det;
        let tvec = sub(point, t.p[0]);
        let u = dot(tvec, pvec) * inv;
        if !(-1.0e-9..=1.0 + 1.0e-9).contains(&u) {
            continue;
        }
        let qvec = cross(tvec, e1);
        let v = dot(RAY_DIR, qvec) * inv;
        if v < -1.0e-9 || u + v > 1.0 + 1.0e-9 {
            continue;
        }
        let dist = dot(e2, qvec) * inv;
        if dist > 1.0e-9 {
            crossings += 1;
        }
    }
    crossings % 2 == 1
}

// ────────────────────────────── cap extension ───────────────────────────────

/// Push each prism CAP outward past the host surface when the swept slab is
/// PROVABLY empty of host material: no host triangle intersects (profile
/// footprint × slab) AND a probe point inside the slab lies outside the host
/// solid. A flush window cap then becomes a clean transversal crossing, while
/// a genuine blind-recess bottom (host material beyond the cap) keeps its
/// authored plane.
fn extend_prism_caps(pf: &mut PrismFrame, tris: &[PTri], aabbs: &[(V3, V3)]) {
    let span = pf.d1() - pf.d0();
    let delta = (span * 0.1).clamp(0.005, 0.5);
    let mag = pf.corner_mag();
    // Flush-exclusion band: a host FACE lying (near-)flush ON the cap plane —
    // the flush window/sleeve case, or a cutter authored a hair SHORT of the
    // surface (the #1112 roof skylights) — is not material BEYOND the plane
    // and must not block the extension; only geometry clearly past the band
    // does. Matches the exact kernel's flush-cap detection band
    // (`extend_opening_mesh_through_host`: `open_span.max(1.0) * 1e-3`), so
    // the analytic path pushes through exactly where the exact path would.
    let band = (span.max(1.0) * 1.0e-3).max(mag * 4.0e-7);
    let pad = 1.0e-6 * (1.0 + mag);
    for hi_side in [false, true] {
        let (slab_lo, slab_hi) = if hi_side {
            (pf.d1() + band, pf.d1() + delta)
        } else {
            (pf.d0() - delta, pf.d0() - band)
        };
        if slab_hi <= slab_lo {
            continue;
        }
        let (k, interior) = if hi_side {
            (pf.profiles.len() - 1, pf.slab_interior[pf.profiles.len() - 1])
        } else {
            (0, pf.slab_interior[0])
        };
        let profile = &pf.profiles[k];
        let occupied = tris
            .iter()
            .any(|t| tri_touches_slab_footprint(t, pf, profile, slab_lo, slab_hi, pad));
        if occupied {
            continue;
        }
        let probe = pf.lift(interior[0], interior[1], (slab_lo + slab_hi) * 0.5);
        if point_inside(tris, aabbs, probe) {
            continue;
        }
        let last = pf.planes.len() - 1;
        if hi_side {
            pf.planes[last] += delta;
        } else {
            pf.planes[0] -= delta;
        }
    }
}

/// Push a profile EDGE outward past the host surface when the swept band
/// beyond it is provably empty of host material — the side-face analog of the
/// cap extension. The canonical case: a DOOR whose bottom profile edge is
/// flush with the wall's bottom face; without extension that strip is
/// coplanar with host skin (parity garbage), with it the threshold band falls
/// cleanly inside the cutter. Corners are re-derived by intersecting the
/// translated edge line with the (unchanged) neighbour edge lines.
/// Point-in-or-on-polygon: inside by ray parity OR within `eps` of any edge.
/// The boundary tolerance matters for the extension containment check: a
/// re-derived corner is COLLINEAR with the authored corner it replaces (both
/// lie on the shared neighbour-edge line), so the authored corner sits exactly
/// on `cand`'s boundary — a strict interior test would wrongly reject it.
fn point_in_or_on(p: V2, poly: &[V2], eps: f64) -> bool {
    let n = poly.len();
    let eps2 = eps * eps;
    for i in 0..n {
        let a = poly[i];
        let b = poly[(i + 1) % n];
        let ab = [b[0] - a[0], b[1] - a[1]];
        let ap = [p[0] - a[0], p[1] - a[1]];
        let len2 = ab[0] * ab[0] + ab[1] * ab[1];
        if len2 < 1.0e-20 {
            if ap[0] * ap[0] + ap[1] * ap[1] < eps2 {
                return true;
            }
            continue;
        }
        let t = ((ap[0] * ab[0] + ap[1] * ab[1]) / len2).clamp(0.0, 1.0);
        let proj = [a[0] + ab[0] * t, a[1] + ab[1] * t];
        let dx = p[0] - proj[0];
        let dy = p[1] - proj[1];
        if dx * dx + dy * dy < eps2 {
            return true;
        }
    }
    pip(p, poly)
}

/// Whether `outer` contains every vertex of `inner` (boundary-inclusive).
fn ring_contains_ring(outer: &[V2], inner: &[V2], eps: f64) -> bool {
    inner.iter().all(|&p| point_in_or_on(p, outer, eps))
}

/// Whether a 2D ring is a SIMPLE polygon: no pair of non-adjacent edges
/// crosses. Adjacent edges (sharing a vertex) are exempt. Used to reject a
/// profile-edge extension that folded a non-convex ring back on itself.
fn ring_is_simple(ring: &[V2]) -> bool {
    let n = ring.len();
    if n < 3 {
        return false;
    }
    for i in 0..n {
        let (a, b) = (ring[i], ring[(i + 1) % n]);
        for j in (i + 1)..n {
            // Skip edges adjacent to edge i (they legitimately share a vertex).
            if j == (i + 1) % n || (j + 1) % n == i {
                continue;
            }
            let (c, d) = (ring[j], ring[(j + 1) % n]);
            if seg_cross_param(a, b, c, d).is_some() {
                return false;
            }
        }
    }
    true
}

fn extend_profile_edges(pf: &mut PrismFrame, tris: &[PTri], aabbs: &[(V3, V3)]) {
    let mag = pf.corner_mag();
    let band = 2.0e-4_f64.max(mag * 4.0e-7);
    for k in 0..pf.profiles.len() {
        let (w_a, w_b) = (pf.planes[k], pf.planes[k + 1]);
        // Authored ring for this slab: every extension must keep containing it
        // (a moved edge on a non-convex ring can otherwise shrink the profile).
        let authored = pf.profiles[k].clone();
        let mut i = 0usize;
        while i < pf.profiles[k].len() {
            let prof = pf.profiles[k].clone();
            let n = prof.len();
            let a = prof[i];
            let b = prof[(i + 1) % n];
            let e = [b[0] - a[0], b[1] - a[1]];
            let len = (e[0] * e[0] + e[1] * e[1]).sqrt();
            if len < 1.0e-6 {
                i += 1;
                continue;
            }
            let ed = [e[0] / len, e[1] / len];
            let n2 = [ed[1], -ed[0]]; // outward for a CCW ring
            let delta = (len * 0.1).clamp(0.01, 0.5);
            // Neighbour edge lines must be genuinely transversal to move the
            // corners; skip near-collinear neighbours.
            let ap = prof[(i + n - 1) % n];
            let bn = prof[(i + 2) % n];
            let d_prev = [a[0] - ap[0], a[1] - ap[1]];
            let d_next = [bn[0] - b[0], bn[1] - b[1]];
            let cr_prev = ed[0] * d_prev[1] - ed[1] * d_prev[0];
            let cr_next = ed[0] * d_next[1] - ed[1] * d_next[0];
            let lp = (d_prev[0] * d_prev[0] + d_prev[1] * d_prev[1]).sqrt();
            let ln = (d_next[0] * d_next[0] + d_next[1] * d_next[1]).sqrt();
            if lp < 1.0e-9 || ln < 1.0e-9 || cr_prev.abs() / lp < 0.1 || cr_next.abs() / ln < 0.1
            {
                i += 1;
                continue;
            }
            // Emptiness of the swept band (band..delta beyond the edge, this
            // slab's depth interval), then an outside-host probe.
            let quad = [
                [a[0] + n2[0] * band, a[1] + n2[1] * band],
                [b[0] + n2[0] * band, b[1] + n2[1] * band],
                [b[0] + n2[0] * delta, b[1] + n2[1] * delta],
                [a[0] + n2[0] * delta, a[1] + n2[1] * delta],
            ];
            let pad = 1.0e-6 * (1.0 + mag);
            let occupied = tris
                .iter()
                .any(|t| tri_touches_slab_footprint(t, pf, &quad, w_a, w_b, pad));
            if occupied {
                i += 1;
                continue;
            }
            let mid_off = (band + delta) * 0.5;
            let probe2 = [
                (a[0] + b[0]) * 0.5 + n2[0] * mid_off,
                (a[1] + b[1]) * 0.5 + n2[1] * mid_off,
            ];
            let probe = pf.lift(probe2[0], probe2[1], (w_a + w_b) * 0.5);
            if point_inside(tris, aabbs, probe) {
                i += 1;
                continue;
            }
            // Translate the edge line by delta and re-derive its two corners
            // as intersections with the neighbour edge lines.
            let line_pt = [a[0] + n2[0] * delta, a[1] + n2[1] * delta];
            let isect = |p0: V2, dir0: V2| -> Option<V2> {
                // line_pt + t·ed  ==  p0 + s·dir0
                let den = ed[0] * dir0[1] - ed[1] * dir0[0];
                if den.abs() < 1.0e-12 {
                    return None;
                }
                let dx = [p0[0] - line_pt[0], p0[1] - line_pt[1]];
                let t = (dx[0] * dir0[1] - dx[1] * dir0[0]) / den;
                Some([line_pt[0] + ed[0] * t, line_pt[1] + ed[1] * t])
            };
            let (Some(na), Some(nb)) = (
                isect(ap, [d_prev[0] / lp, d_prev[1] / lp]),
                isect(b, [d_next[0] / ln, d_next[1] / ln]),
            ) else {
                i += 1;
                continue;
            };
            // Commit the extension only if the resulting ring stays SIMPLE and
            // still contains the authored profile. `ccw_area` accepts a
            // self-intersecting ring (positive signed area), so the downstream
            // volume self-check cannot catch an over/under-cut from a folded
            // non-convex ring — validate here and keep the un-extended edge
            // otherwise.
            let mut cand = pf.profiles[k].clone();
            cand[i] = na;
            cand[(i + 1) % n] = nb;
            // Boundary-tolerant containment: the authored corners are collinear
            // with (and on the boundary of) `cand`, so a strict interior test
            // is unusable — `contain_eps` (≫ the collinearity float error, ≪
            // any real shrink) accepts a genuine outward growth and rejects a
            // reflex corner that pulled the profile inward.
            let contain_eps = 1.0e-6 * (1.0 + mag);
            if ring_is_simple(&cand) && ring_contains_ring(&cand, &authored, contain_eps) {
                pf.profiles[k] = cand;
            }
            i += 1;
        }
        // Refresh the slab area (the interior point stays valid — the profile
        // only grew).
        let mut ring = pf.profiles[k].clone();
        if let Some(area) = ccw_area(&mut ring) {
            pf.profiles[k] = ring;
            pf.slab_area[k] = area;
        }
    }
    // Refresh the overall bbox.
    let mut lo = [f64::INFINITY; 2];
    let mut hi = [f64::NEG_INFINITY; 2];
    for prof in &pf.profiles {
        for p in prof {
            for k in 0..2 {
                lo[k] = lo[k].min(p[k]);
                hi[k] = hi[k].max(p[k]);
            }
        }
    }
    pf.bb = (lo, hi);
}

/// Whether triangle `t` has a non-degenerate piece inside the region
/// `{depth ∈ [slab_lo, slab_hi]} ∩ {(u,v) within the (pad-inflated) profile}`.
/// Conservative in the safe direction: any doubt reports "occupied" (⇒ no cap
/// extension ⇒ at worst a later self-check fallback, never an over-cut).
fn tri_touches_slab_footprint(
    t: &PTri,
    pf: &PrismFrame,
    profile: &[V2],
    slab_lo: f64,
    slab_hi: f64,
    pad: f64,
) -> bool {
    // Clip the triangle to the depth slab (two parallel planes) — convex S-H.
    let mut poly: Vec<V3> = t.p.to_vec();
    for hi_side in [false, true] {
        if poly.len() < 3 {
            return false;
        }
        let mut next: Vec<V3> = Vec::with_capacity(poly.len() + 1);
        let dist = |p: V3| -> f64 {
            let w = dot(p, pf.d);
            if hi_side {
                w - slab_hi
            } else {
                slab_lo - w
            }
        };
        for i in 0..poly.len() {
            let j = (i + 1) % poly.len();
            let (da, db) = (dist(poly[i]), dist(poly[j]));
            if da <= 0.0 {
                next.push(poly[i]);
            }
            if (da <= 0.0) != (db <= 0.0) {
                next.push(lerp(poly[i], poly[j], da / (da - db)));
            }
        }
        poly = next;
    }
    if poly.len() < 3 {
        return false;
    }
    // 2D overlap of the clipped (convex) polygon with the profile: vertex of
    // one inside the other, or any edge pair crossing.
    let poly2: Vec<V2> = poly.iter().map(|p| pf.to2(*p)).collect();
    // bbox prefilter with pad — against the SUPPLIED `profile` footprint, NOT
    // `pf.bb`. The profile-edge extension passes an outward band that can lie
    // entirely OUTSIDE the prism's overall bbox; prefiltering on pf.bb would
    // wrongly report "empty" and let the extension sweep through nearby host
    // material.
    let mut lo = [f64::INFINITY; 2];
    let mut hi = [f64::NEG_INFINITY; 2];
    for p in &poly2 {
        for k in 0..2 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    let mut footprint_lo = [f64::INFINITY; 2];
    let mut footprint_hi = [f64::NEG_INFINITY; 2];
    for p in profile {
        for k in 0..2 {
            footprint_lo[k] = footprint_lo[k].min(p[k]);
            footprint_hi[k] = footprint_hi[k].max(p[k]);
        }
    }
    if hi[0] < footprint_lo[0] - pad
        || lo[0] > footprint_hi[0] + pad
        || hi[1] < footprint_lo[1] - pad
        || lo[1] > footprint_hi[1] + pad
    {
        return false;
    }
    if poly2.iter().any(|p| pip(*p, profile)) {
        return true;
    }
    if profile.iter().any(|p| pip(*p, &poly2)) {
        return true;
    }
    let np = poly2.len();
    let nq = profile.len();
    for i in 0..np {
        let (a, b) = (poly2[i], poly2[(i + 1) % np]);
        for j in 0..nq {
            let (c, d2) = (profile[j], profile[(j + 1) % nq]);
            if seg_cross_param(a, b, c, d2).is_some() {
                return true;
            }
        }
    }
    false
}

// ─────────────────────────────── the prism cut ──────────────────────────────

/// Canonical-order edge×face-plane crossing cache. Both triangles sharing an
/// edge compute the crossing from the SAME endpoint order, so the point is
/// bit-identical on both sides — the T-junction-freedom cornerstone.
type CrossCache = FxHashMap<([u64; 3], [u64; 3], u16), V3>;

/// A seam sub-segment on a prism face: exact 3D endpoints plus their
/// face-local 2D coordinates.
struct Seam {
    a3: V3,
    b3: V3,
    a2: V2,
    b2: V2,
}

struct PrismCutOutcome {
    tris: Vec<PTri>,
    /// Volume removed (host ∩ cutter), from the closed inside assembly.
    removed: f64,
}

/// Plane of a face: (unit normal, offset) with the plane `{x : n·x = c}`.
fn face_plane(pf: &PrismFrame, face: Face) -> Option<(V3, f64)> {
    match face {
        Face::Cap { j } => Some((pf.d, pf.planes[j])),
        Face::Strip { k, i } => {
            let prof = &pf.profiles[k];
            let n = prof.len();
            let a = prof[i];
            let b = prof[(i + 1) % n];
            let e = [b[0] - a[0], b[1] - a[1]];
            let len = (e[0] * e[0] + e[1] * e[1]).sqrt();
            if len < 1.0e-9 {
                return None;
            }
            // Outward 2D normal of a CCW ring edge.
            let n2 = [e[1] / len, -e[0] / len];
            let n3 = add(scale(pf.u, n2[0]), scale(pf.v, n2[1]));
            let c = n2[0] * a[0] + n2[1] * a[1];
            Some((n3, c))
        }
    }
}

/// Intersection of segment (a, b) with face plane `f` (`{x: m·x = c}`),
/// computed in canonical endpoint order and cached. Endpoint-clamped crossings
/// return the endpoint EXACTLY (bit-equal), so they intern to the same pooled
/// vertex instead of a 1-ulp duplicate.
fn cached_crossing(cache: &mut CrossCache, f: u16, m: V3, c: f64, a: V3, b: V3) -> V3 {
    let (ka, kb) = (bits(a), bits(b));
    let (first, second, key) = if ka <= kb {
        (a, b, (ka, kb, f))
    } else {
        (b, a, (kb, ka, f))
    };
    if let Some(p) = cache.get(&key) {
        return *p;
    }
    let da = dot(first, m) - c;
    let db = dot(second, m) - c;
    let denom = da - db;
    let t = if denom.abs() < 1.0e-300 {
        0.5
    } else {
        (da / denom).clamp(0.0, 1.0)
    };
    let p = if t <= 0.0 {
        first
    } else if t >= 1.0 {
        second
    } else {
        lerp(first, second, t)
    };
    cache.insert(key, p);
    p
}

/// Face-local 2D coordinates of a 3D point.
fn face_coords(pf: &PrismFrame, face: Face, p: V3) -> V2 {
    match face {
        Face::Cap { .. } => pf.to2(p),
        Face::Strip { k, i } => {
            let prof = &pf.profiles[k];
            let n = prof.len();
            let a = prof[i];
            let b = prof[(i + 1) % n];
            let e = [b[0] - a[0], b[1] - a[1]];
            let len = (e[0] * e[0] + e[1] * e[1]).sqrt();
            let ed = [e[0] / len, e[1] / len];
            let q = pf.to2(p);
            [
                (q[0] - a[0]) * ed[0] + (q[1] - a[1]) * ed[1],
                dot(p, pf.d),
            ]
        }
    }
}

/// Subtract the stepped solid `pf` from the host triangle list. `Err(defer
/// index)` ⇒ a gate or self-check failed ⇒ the caller must leave the host
/// untouched and route this opening to the exact kernel.
fn cut_prism(tris: &[PTri], pf: &PrismFrame) -> Result<PrismCutOutcome, usize> {
    let faces = stack_faces(pf);
    if faces.len() > u16::MAX as usize {
        return Err(7);
    }
    let mut planes: Vec<(V3, f64)> = Vec::with_capacity(faces.len());
    for &face in &faces {
        planes.push(face_plane(pf, face).ok_or(7usize)?);
    }

    let aabbs: Vec<(V3, V3)> = tris.iter().map(PTri::aabb).collect();
    let mut cache: CrossCache = CrossCache::default();

    let mut out: Vec<PTri> = Vec::with_capacity(tris.len() + 16);
    let mut inside: Vec<PTri> = Vec::new();
    let mut seams: Vec<Vec<Seam>> = (0..faces.len()).map(|_| Vec::new()).collect();
    let mut any_cut = false;

    for t in tris {
        // Quick reject: depth interval and 2D bbox versus the overall bbox.
        let w0 = dot(t.p[0], pf.d);
        let w1 = dot(t.p[1], pf.d);
        let w2 = dot(t.p[2], pf.d);
        if w0.max(w1).max(w2) < pf.d0() || w0.min(w1).min(w2) > pf.d1() {
            out.push(t.clone());
            continue;
        }
        {
            let q0 = pf.to2(t.p[0]);
            let q1 = pf.to2(t.p[1]);
            let q2 = pf.to2(t.p[2]);
            let lo = [q0[0].min(q1[0]).min(q2[0]), q0[1].min(q1[1]).min(q2[1])];
            let hi = [q0[0].max(q1[0]).max(q2[0]), q0[1].max(q1[1]).max(q2[1])];
            if hi[0] < pf.bb.0[0]
                || lo[0] > pf.bb.1[0]
                || hi[1] < pf.bb.0[1]
                || lo[1] > pf.bb.1[1]
            {
                out.push(t.clone());
                continue;
            }
        }

        // Gather T ∩ ∂solid seam sub-segments + T-edge subdivision points.
        let mut segs: Vec<(usize, V3, V3)> = Vec::new(); // (face idx, a3, b3)
        let mut edge_pts: [Vec<V3>; 3] = Default::default();
        for (fi, (&face, &(m, c))) in faces.iter().zip(&planes).enumerate() {
            // Chord of T with this face plane (strict >0 side test — symmetric
            // and vertex-exact, so neighbours agree bit-for-bit).
            let dist = [
                dot(t.p[0], m) - c,
                dot(t.p[1], m) - c,
                dot(t.p[2], m) - c,
            ];
            let mut chord: Vec<(V3, usize)> = Vec::new(); // (point, tri edge)
            for e in 0..3 {
                let (da, db) = (dist[e], dist[(e + 1) % 3]);
                if (da > 0.0) != (db > 0.0) {
                    let p = cached_crossing(
                        &mut cache,
                        fi as u16,
                        m,
                        c,
                        t.p[e],
                        t.p[(e + 1) % 3],
                    );
                    chord.push((p, e));
                }
            }
            if chord.len() != 2 {
                continue;
            }
            let (q0, e0) = chord[0];
            let (q1, e1) = chord[1];
            // Face-local membership gate + clipping of the chord to the face's
            // exposed region.
            match face {
                Face::Cap { j } => {
                    let a2 = pf.to2(q0);
                    let b2 = pf.to2(q1);
                    // T-edge subdivision membership (point-deterministic —
                    // both neighbours agree).
                    if cap_xor(pf, j, a2) {
                        edge_pts[e0].push(q0);
                    }
                    if cap_xor(pf, j, b2) {
                        edge_pts[e1].push(q1);
                    }
                    // Subdivide the 2D chord at crossings with BOTH adjacent
                    // profiles' edges; keep sub-segments inside the XOR region.
                    let mut ts: Vec<f64> = vec![0.0, 1.0];
                    for prof in [
                        (j > 0).then(|| &pf.profiles[j - 1]),
                        (j < pf.profiles.len()).then(|| &pf.profiles[j]),
                    ]
                    .into_iter()
                    .flatten()
                    {
                        let npr = prof.len();
                        for i in 0..npr {
                            let (pa, pb) = (prof[i], prof[(i + 1) % npr]);
                            if let Some(tt) = seg_cross_param(a2, b2, pa, pb) {
                                ts.push(tt);
                            }
                        }
                    }
                    ts.sort_by(f64::total_cmp);
                    ts.dedup_by(|x, y| (*x - *y).abs() < 1.0e-12);
                    for wnd in ts.windows(2) {
                        let (ta, tb) = (wnd[0], wnd[1]);
                        if tb - ta < 1.0e-12 {
                            continue;
                        }
                        let mid = [
                            a2[0] + (b2[0] - a2[0]) * (ta + tb) * 0.5,
                            a2[1] + (b2[1] - a2[1]) * (ta + tb) * 0.5,
                        ];
                        if cap_xor(pf, j, mid) {
                            let sa = if ta == 0.0 { q0 } else { lerp(q0, q1, ta) };
                            let sb = if tb == 1.0 { q1 } else { lerp(q0, q1, tb) };
                            segs.push((fi, sa, sb));
                        }
                    }
                }
                Face::Strip { k, i } => {
                    let prof = &pf.profiles[k];
                    let npr = prof.len();
                    let a = prof[i];
                    let b = prof[(i + 1) % npr];
                    let e2 = [b[0] - a[0], b[1] - a[1]];
                    let len = (e2[0] * e2[0] + e2[1] * e2[1]).sqrt();
                    let ed = [e2[0] / len, e2[1] / len];
                    let (w_a, w_b) = (pf.planes[k], pf.planes[k + 1]);
                    let sparam = |p: V3| -> f64 {
                        let q = pf.to2(p);
                        (q[0] - a[0]) * ed[0] + (q[1] - a[1]) * ed[1]
                    };
                    let wparam = |p: V3| dot(p, pf.d);
                    let (s0, s1) = (sparam(q0), sparam(q1));
                    let (wc0, wc1) = (wparam(q0), wparam(q1));
                    // Membership gate for T-edge subdivision.
                    let in_strip =
                        |s: f64, w: f64| (0.0..=len).contains(&s) && (w_a..=w_b).contains(&w);
                    if in_strip(s0, wc0) {
                        edge_pts[e0].push(q0);
                    }
                    if in_strip(s1, wc1) {
                        edge_pts[e1].push(q1);
                    }
                    // τ interval on the chord where both params are in range.
                    let mut t_lo = 0.0f64;
                    let mut t_hi = 1.0f64;
                    for (p0, p1, lo, hi) in [(s0, s1, 0.0, len), (wc0, wc1, w_a, w_b)] {
                        let dp = p1 - p0;
                        if dp.abs() < 1.0e-15 {
                            if p0 < lo || p0 > hi {
                                t_lo = 1.0;
                                t_hi = 0.0;
                            }
                        } else {
                            let (mut ta, mut tb) = ((lo - p0) / dp, (hi - p0) / dp);
                            if ta > tb {
                                std::mem::swap(&mut ta, &mut tb);
                            }
                            t_lo = t_lo.max(ta);
                            t_hi = t_hi.min(tb);
                        }
                    }
                    if t_hi - t_lo > 1.0e-12 {
                        let sa = if t_lo == 0.0 { q0 } else { lerp(q0, q1, t_lo) };
                        let sb = if t_hi == 1.0 { q1 } else { lerp(q0, q1, t_hi) };
                        segs.push((fi, sa, sb));
                    }
                }
            }
        }

        if segs.is_empty() && edge_pts.iter().all(|v| v.is_empty()) {
            // No boundary reaches this triangle: it is wholly inside or wholly
            // outside the (open) solid.
            let centroid = scale(add(add(t.p[0], t.p[1]), t.p[2]), 1.0 / 3.0);
            if pf.contains(centroid) {
                inside.push(t.clone());
                any_cut = true;
            } else {
                out.push(t.clone());
            }
            continue;
        }

        // Conforming decomposition of T by the seam constraints.
        if !decompose_tri(t, pf, &faces, &segs, &edge_pts, &mut out, &mut inside, &mut seams) {
            return Err(7);
        }
        any_cut = true;
    }

    if !any_cut {
        return Err(4); // nothing to remove — a silent no-op belongs to the exact path
    }

    // Canonical per-cap-plane breakpoints: the vertices of both adjacent
    // profiles plus every proper crossing between their ring edges. Injected
    // into the cap AND every strip bordering that plane, so the faces sharing
    // a cutter-edge line subdivide it IDENTICALLY (T-junction freedom across
    // faces — the cap knows about profile corners the strip alone does not).
    let plane_pts: Vec<Vec<V2>> = (0..pf.planes.len())
        .map(|j| cap_plane_breakpoints(pf, j))
        .collect();

    // Caps: one CDT per face, constrained by that face's seams, classified by
    // ray parity against the PRE-CUT host.
    let mut caps: Vec<PTri> = Vec::new();
    for (fi, &face) in faces.iter().enumerate() {
        if !build_face_cap(pf, face, &seams[fi], &plane_pts, tris, &aabbs, &mut caps) {
            return Err(7);
        }
    }

    // Volume self-checks (f64, exact identities up to roundoff):
    //   vol_out + vol_in == vol_host   (caps cancel, fragments partition)
    //   0 < vol_in <= vol(cutter)      (the caps close the removed solid)
    let mut host_mag = pf.corner_mag();
    for (lo, hi) in &aabbs {
        for k in 0..3 {
            host_mag = host_mag.max(lo[k].abs()).max(hi[k].abs());
        }
    }
    let vol_host = tri_volume6(tris) / 6.0;
    let caps_vol = tri_volume6(&caps) / 6.0; // caps oriented for the RESULT
    let vol_out = tri_volume6(&out) / 6.0 + caps_vol;
    let vol_in = tri_volume6(&inside) / 6.0 - caps_vol;
    let scale3 = (1.0 + host_mag).powi(3);
    let tol = 1.0e-12 * scale3 + 1.0e-9;
    if (vol_out + vol_in - vol_host).abs() > tol.max(1.0e-6 * vol_host.abs()) {
        return Err(8);
    }
    if vol_in < 1.0e-9 {
        return Err(8); // removed nothing measurable — leave to the exact path
    }
    if vol_in > pf.volume() * (1.0 + 1.0e-6) + tol {
        return Err(8);
    }

    let mut tris_out = out;
    tris_out.append(&mut caps);
    Ok(PrismCutOutcome {
        tris: tris_out,
        removed: vol_in,
    })
}

/// 2D point pool with tolerance merging: canonical 3D/normal = first-seen.
/// Merging kills the 1e-12 doublets a cutter-edge junction produces when two
/// faces' clips compute the same geometric point through different arithmetic.
struct PointPool {
    pts2: Vec<Point2<f64>>,
    pts3: Vec<V3>,
    nrm: Vec<V3>,
    buckets: FxHashMap<(i64, i64), Vec<usize>>,
    eps: f64,
}

impl PointPool {
    fn new(eps: f64) -> Self {
        Self {
            pts2: Vec::new(),
            pts3: Vec::new(),
            nrm: Vec::new(),
            buckets: FxHashMap::default(),
            eps: eps.max(1.0e-15),
        }
    }
    fn intern(&mut self, q: V2, p3: V3, n: V3) -> usize {
        let cell = |x: f64| (x / (self.eps * 4.0)).floor() as i64;
        let (cx, cy) = (cell(q[0]), cell(q[1]));
        for dx in -1..=1 {
            for dy in -1..=1 {
                if let Some(ids) = self.buckets.get(&(cx + dx, cy + dy)) {
                    for &i in ids {
                        let d0 = self.pts2[i].x - q[0];
                        let d1 = self.pts2[i].y - q[1];
                        if d0.abs() <= self.eps && d1.abs() <= self.eps {
                            return i;
                        }
                    }
                }
            }
        }
        let idx = self.pts2.len();
        self.pts2.push(Point2::new(q[0], q[1]));
        self.pts3.push(p3);
        self.nrm.push(n);
        self.buckets.entry((cx, cy)).or_default().push(idx);
        idx
    }
}

/// Decompose one host triangle by the cutter-boundary seams via a conforming
/// per-triangle CDT; classify each sub-triangle by its centroid; record the
/// seams (with face-local 2D coords) for the cap builder. Returns false when
/// the CDT cannot be built (→ exact kernel for the whole opening).
#[allow(clippy::too_many_arguments)]
fn decompose_tri(
    t: &PTri,
    pf: &PrismFrame,
    faces: &[Face],
    segs: &[(usize, V3, V3)],
    edge_pts: &[Vec<V3>; 3],
    out: &mut Vec<PTri>,
    inside: &mut Vec<PTri>,
    seams: &mut [Vec<Seam>],
) -> bool {
    // 2D basis in the triangle's plane (CCW = triangle winding).
    let Some(u) = normalize(sub(t.p[1], t.p[0])) else {
        out.push(t.clone());
        return true;
    };
    let Some(w) = normalize(cross(sub(t.p[1], t.p[0]), sub(t.p[2], t.p[0]))) else {
        out.push(t.clone());
        return true;
    };
    let v = cross(w, u);
    let to2 = |x: V3| -> V2 {
        let d = sub(x, t.p[0]);
        [dot(d, u), dot(d, v)]
    };

    let mut mag = 0.0f64;
    for p in &t.p {
        for c in p {
            mag = mag.max(c.abs());
        }
    }
    let mut pool = PointPool::new(1.0e-9 * (1.0 + mag));

    let tri_idx = [
        pool.intern(to2(t.p[0]), t.p[0], t.n[0]),
        pool.intern(to2(t.p[1]), t.p[1], t.n[1]),
        pool.intern(to2(t.p[2]), t.p[2], t.n[2]),
    ];

    let mut segments: Vec<(usize, usize)> = Vec::new();
    // T-edge chains subdivided at the admitted crossing points.
    for e in 0..3 {
        let a3 = t.p[e];
        let b3 = t.p[(e + 1) % 3];
        let dir = sub(b3, a3);
        let len2 = dot(dir, dir);
        if len2 <= 0.0 {
            continue;
        }
        let mut on_edge: Vec<(f64, usize)> = Vec::new();
        for p in &edge_pts[e] {
            // Normal interpolated along the edge.
            let tt = (dot(sub(*p, a3), dir) / len2).clamp(0.0, 1.0);
            let nn = lerp(t.n[e], t.n[(e + 1) % 3], tt);
            let idx = pool.intern(to2(*p), *p, nn);
            on_edge.push((tt, idx));
        }
        on_edge.sort_by(|x, y| x.0.total_cmp(&y.0));
        let mut prev = tri_idx[e];
        for &(_, idx) in &on_edge {
            if idx != prev {
                segments.push((prev, idx));
                prev = idx;
            }
        }
        let last = tri_idx[(e + 1) % 3];
        if last != prev {
            segments.push((prev, last));
        }
    }
    // Seam constraints (+ record for the cap builder). Interior seam points
    // carry the triangle's geometric normal (flat-facet hosts: exact).
    let face_n = normalize(cross(sub(t.p[1], t.p[0]), sub(t.p[2], t.p[0]))).unwrap_or(w);
    for &(fi, a3, b3) in segs {
        let ia = pool.intern(to2(a3), a3, face_n);
        let ib = pool.intern(to2(b3), b3, face_n);
        if ia == ib {
            continue;
        }
        segments.push((ia, ib));
        seams[fi].push(Seam {
            a3,
            b3,
            a2: face_coords(pf, faces[fi], a3),
            b2: face_coords(pf, faces[fi], b3),
        });
    }
    segments.sort();
    segments.dedup();
    let t0 = t.p[0];
    // `resolve_crossings` interns any new seam×seam / T-junction points with a
    // placeholder [0,0,1] normal. These points land on the RETAINED host
    // surface (`out`), so a Z-up placeholder on a non-horizontal face shades
    // wrong. Overwrite every point it created with the host triangle's own
    // face normal.
    let existing_points = pool.nrm.len();
    resolve_crossings(
        &mut pool,
        |q| add(t0, add(scale(u, q[0]), scale(v, q[1]))),
        &mut segments,
    );
    for n in pool.nrm.iter_mut().skip(existing_points) {
        *n = face_n;
    }

    let Some((pts2, idx2)) = triangulate_pslg(&pool.pts2, &segments) else {
        return false;
    };
    if pts2.len() != pool.pts2.len() {
        return false; // CDT must not invent points — mapping back requires identity
    }

    for tri in idx2.chunks_exact(3) {
        let (a, b, c) = (tri[0], tri[1], tri[2]);
        let p = [pool.pts3[a], pool.pts3[b], pool.pts3[c]];
        let centroid = scale(add(add(p[0], p[1]), p[2]), 1.0 / 3.0);
        let piece = PTri {
            p,
            n: [pool.nrm[a], pool.nrm[b], pool.nrm[c]],
        };
        if pf.contains(centroid) {
            inside.push(piece);
        } else {
            out.push(piece);
        }
    }
    true
}

/// Canonical 2D breakpoints of cap plane `j`: all vertices of the adjacent
/// slab profiles plus every proper pairwise crossing between the two rings.
fn cap_plane_breakpoints(pf: &PrismFrame, j: usize) -> Vec<V2> {
    let mut profs: Vec<&[V2]> = Vec::new();
    if j > 0 {
        profs.push(&pf.profiles[j - 1]);
    }
    if j < pf.profiles.len() {
        profs.push(&pf.profiles[j]);
    }
    let mut out: Vec<V2> = Vec::new();
    for prof in &profs {
        out.extend_from_slice(prof);
    }
    if profs.len() == 2 {
        let (a, b) = (profs[0], profs[1]);
        let (na, nb) = (a.len(), b.len());
        for i in 0..na {
            let (p, q) = (a[i], a[(i + 1) % na]);
            for k in 0..nb {
                let (c, d) = (b[k], b[(k + 1) % nb]);
                if let Some(t) = seg_cross_param(p, q, c, d) {
                    if (1.0e-9..=1.0 - 1.0e-9).contains(&t) {
                        out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
                    }
                }
            }
        }
    }
    out
}

/// Build the cap (reveal face) for one cutter face: CDT of the face domain
/// constrained by the reveal seams (and, for a stepped cap, the adjacent
/// profiles' rings), each sub-triangle kept iff its centroid lies in the
/// face's exposed region AND inside the (pre-cut) host solid by ray parity.
/// Emitted oriented for the RESULT (normal pointing INTO the removed void).
/// Returns false on CDT failure.
fn build_face_cap(
    pf: &PrismFrame,
    face: Face,
    seams: &[Seam],
    plane_pts: &[Vec<V2>],
    host: &[PTri],
    aabbs: &[(V3, V3)],
    caps: &mut Vec<PTri>,
) -> bool {
    match face {
        Face::Strip { k, i } => {
            let prof = &pf.profiles[k];
            let npr = prof.len();
            let a = prof[i];
            let b = prof[(i + 1) % npr];
            let e2 = [b[0] - a[0], b[1] - a[1]];
            let len = (e2[0] * e2[0] + e2[1] * e2[1]).sqrt();
            if len < 1.0e-9 {
                return true;
            }
            let ed = [e2[0] / len, e2[1] / len];
            let (w_a, w_b) = (pf.planes[k], pf.planes[k + 1]);
            let lift_s =
                |s: f64, wd: f64| -> V3 { pf.lift(a[0] + ed[0] * s, a[1] + ed[1] * s, wd) };
            let ring2: Vec<V2> = vec![[0.0, w_a], [len, w_a], [len, w_b], [0.0, w_b]];
            let ring3: Vec<V3> = vec![
                lift_s(0.0, w_a),
                lift_s(len, w_a),
                lift_s(len, w_b),
                lift_s(0.0, w_b),
            ];
            // Outward 2D normal of the CCW ring edge; the result-cap normal is
            // its opposite (into the void). CCW-in-(s, w) lifts to the OUTWARD
            // strip normal ⇒ always flip.
            let n2 = [e2[1] / len, -e2[0] / len];
            let outward = add(scale(pf.u, n2[0]), scale(pf.v, n2[1]));
            let desired = scale(outward, -1.0);
            // Inject the canonical breakpoints of BOTH bounding cap planes
            // that lie on this strip's edge line, so the strip subdivides its
            // shared boundary exactly like the neighbouring caps do.
            let mut inject: Vec<(V2, V3)> = Vec::new();
            let on_line_tol = 1.0e-6 * (1.0 + pf.corner_mag());
            for (jj, wj) in [(k, w_a), (k + 1, w_b)] {
                for q in &plane_pts[jj] {
                    let ap = [q[0] - a[0], q[1] - a[1]];
                    let ss = ap[0] * ed[0] + ap[1] * ed[1];
                    if !(0.0..=len).contains(&ss) {
                        continue;
                    }
                    let perp = (ap[0] * ed[1] - ap[1] * ed[0]).abs();
                    if perp <= on_line_tol {
                        inject.push(([ss, wj], lift_s(ss, wj)));
                    }
                }
            }
            if seams.is_empty() && inject.is_empty() {
                // Entirely inside the host (whole-face reveal) or entirely
                // outside — one parity probe decides.
                let mid = |kk: usize| (ring3[0][kk] + ring3[2][kk]) * 0.5;
                if !point_inside(host, aabbs, [mid(0), mid(1), mid(2)]) {
                    return true;
                }
                emit_cap(caps, ring3[0], ring3[1], ring3[2], desired, true);
                emit_cap(caps, ring3[0], ring3[2], ring3[3], desired, true);
                return true;
            }
            if seams.is_empty() {
                // Injected points but no seams: same parity probe decides
                // whole-face vs nothing, but the emission must still be the
                // subdivided CDT so the shared boundary matches the caps.
                let mid = |kk: usize| (ring3[0][kk] + ring3[2][kk]) * 0.5;
                if !point_inside(host, aabbs, [mid(0), mid(1), mid(2)]) {
                    return true;
                }
            }
            cap_cdt(
                pf,
                &ring2,
                &ring3,
                &[],
                seams,
                &inject,
                desired,
                true,
                |q| pip(q, &ring2),
                host,
                aabbs,
                caps,
            )
        }
        Face::Cap { j } => {
            let wdepth = pf.planes[j];
            // Domain ring: the union bbox of the adjacent profiles, slightly
            // inflated so profile rings are strictly interior constraints.
            let mut lo = [f64::INFINITY; 2];
            let mut hi = [f64::NEG_INFINITY; 2];
            let mut aux: Vec<&[V2]> = Vec::new();
            if j > 0 {
                aux.push(&pf.profiles[j - 1]);
            }
            if j < pf.profiles.len() {
                aux.push(&pf.profiles[j]);
            }
            for prof in &aux {
                for p in prof.iter() {
                    for k in 0..2 {
                        lo[k] = lo[k].min(p[k]);
                        hi[k] = hi[k].max(p[k]);
                    }
                }
            }
            let m = 1.0e-3 * (1.0 + (hi[0] - lo[0]).abs().max((hi[1] - lo[1]).abs()));
            let (lo, hi) = ([lo[0] - m, lo[1] - m], [hi[0] + m, hi[1] + m]);
            let ring2: Vec<V2> = vec![
                [lo[0], lo[1]],
                [hi[0], lo[1]],
                [hi[0], hi[1]],
                [lo[0], hi[1]],
            ];
            let ring3: Vec<V3> = ring2
                .iter()
                .map(|&[uu, vv]| pf.lift(uu, vv, wdepth))
                .collect();
            // Orientation per sub-region: where only the LOWER slab exists the
            // removed void is below ⇒ normal −d; where only the UPPER slab
            // exists ⇒ +d. Resolved per emitted triangle inside `cap_cdt` via
            // the classifier below; the `desired`/flip passed in cover the
            // "+d" branch and the emitter flips for the −d case.
            let in_lower = |q: V2| j > 0 && pip(q, &pf.profiles[j - 1]);
            let in_upper = |q: V2| j < pf.profiles.len() && pip(q, &pf.profiles[j]);
            // Fast skip for the OUTERMOST caps with no seams (the common
            // extended-cap case): probe the adjacent slab interior.
            if seams.is_empty() && (j == 0 || j == pf.profiles.len()) {
                let k = if j == 0 { 0 } else { pf.profiles.len() - 1 };
                let interior = pf.slab_interior[k];
                let probe = pf.lift(interior[0], interior[1], wdepth);
                if !point_inside(host, aabbs, probe) {
                    return true;
                }
            }
            let inject: Vec<(V2, V3)> = plane_pts[j]
                .iter()
                .map(|&q| (q, pf.lift(q[0], q[1], wdepth)))
                .collect();
            cap_cdt_xor(
                pf,
                &ring2,
                &ring3,
                &aux,
                seams,
                &inject,
                wdepth,
                in_lower,
                in_upper,
                host,
                aabbs,
                caps,
            )
        }
    }
}

/// Emit one cap triangle with the RESULT orientation: `flip` swaps the winding
/// so the geometric normal matches `desired`.
fn emit_cap(caps: &mut Vec<PTri>, a: V3, b: V3, c: V3, desired: V3, flip: bool) {
    let (b, c) = if flip { (c, b) } else { (b, c) };
    caps.push(PTri {
        p: [a, b, c],
        n: [desired, desired, desired],
    });
}

/// Shared cap CDT for a SINGLE-region face (side strips): domain ring +
/// seams, keep = `region(centroid)` && host parity.
#[allow(clippy::too_many_arguments)]
fn cap_cdt(
    pf: &PrismFrame,
    ring2: &[V2],
    ring3: &[V3],
    aux: &[&[V2]],
    seams: &[Seam],
    inject: &[(V2, V3)],
    desired: V3,
    flip: bool,
    region: impl Fn(V2) -> bool,
    host: &[PTri],
    aabbs: &[(V3, V3)],
    caps: &mut Vec<PTri>,
) -> bool {
    cap_cdt_impl(pf, ring2, ring3, aux, seams, inject, host, aabbs, caps, |q| {
        region(q).then_some((desired, flip))
    })
}

/// Cap CDT for a stepped cap plane: keep = XOR of the adjacent profiles, with
/// per-region orientation (−d where only the lower slab exists, +d where only
/// the upper does).
#[allow(clippy::too_many_arguments)]
fn cap_cdt_xor(
    pf: &PrismFrame,
    ring2: &[V2],
    ring3: &[V3],
    aux: &[&[V2]],
    seams: &[Seam],
    inject: &[(V2, V3)],
    _wdepth: f64,
    in_lower: impl Fn(V2) -> bool,
    in_upper: impl Fn(V2) -> bool,
    host: &[PTri],
    aabbs: &[(V3, V3)],
    caps: &mut Vec<PTri>,
) -> bool {
    let d = pf.d;
    cap_cdt_impl(pf, ring2, ring3, aux, seams, inject, host, aabbs, caps, move |q| {
        let lo = in_lower(q);
        let up = in_upper(q);
        if lo == up {
            return None; // outside the exposed XOR region
        }
        if lo {
            // Cutter below the plane ⇒ solid above ⇒ normal −d. CCW-in-(u,v)
            // lifts to +d ⇒ flip.
            Some((scale(d, -1.0), true))
        } else {
            Some((d, false))
        }
    })
}


/// Make a segment soup CDT-admissible: split every pair of properly-crossing
/// constraints at their intersection (interned through `lift3`), and split
/// every constraint at any pooled point lying strictly in its interior.
/// Needed because adjacent slab profiles of a rebated opening genuinely CROSS
/// (a sill / lintel detail poking past the other slab's outline), and seam
/// endpoints can land in the interior of a ring edge.
fn resolve_crossings(
    pool: &mut PointPool,
    lift3: impl Fn(V2) -> V3,
    segs: &mut Vec<(usize, usize)>,
) {
    let orig = segs.clone();
    let mut splits: Vec<Vec<(f64, usize)>> = vec![Vec::new(); orig.len()];
    // Pairwise proper crossings on the ORIGINAL segments (sub-segment
    // crossings are a subset, so one pass suffices).
    for i in 0..orig.len() {
        for j in (i + 1)..orig.len() {
            let (a, b) = orig[i];
            let (c, d) = orig[j];
            if a == c || a == d || b == c || b == d {
                continue;
            }
            let pa = [pool.pts2[a].x, pool.pts2[a].y];
            let pb = [pool.pts2[b].x, pool.pts2[b].y];
            let pc = [pool.pts2[c].x, pool.pts2[c].y];
            let pd = [pool.pts2[d].x, pool.pts2[d].y];
            let r = [pb[0] - pa[0], pb[1] - pa[1]];
            let sv = [pd[0] - pc[0], pd[1] - pc[1]];
            let den = r[0] * sv[1] - r[1] * sv[0];
            if den.abs() < 1.0e-18 {
                continue;
            }
            let ap = [pc[0] - pa[0], pc[1] - pa[1]];
            let t = (ap[0] * sv[1] - ap[1] * sv[0]) / den;
            let u = (ap[0] * r[1] - ap[1] * r[0]) / den;
            const E: f64 = 1.0e-9;
            if !(E..=1.0 - E).contains(&t) || !(E..=1.0 - E).contains(&u) {
                continue;
            }
            let q = [pa[0] + r[0] * t, pa[1] + r[1] * t];
            let idx = pool.intern(q, lift3(q), [0.0, 0.0, 1.0]);
            splits[i].push((t, idx));
            splits[j].push((u, idx));
        }
    }
    // Pooled points strictly interior to a segment (T-junctions).
    let n_pts = pool.pts2.len();
    for k in 0..n_pts {
        let p = [pool.pts2[k].x, pool.pts2[k].y];
        for (i, &(a, b)) in orig.iter().enumerate() {
            if a == k || b == k {
                continue;
            }
            let pa = [pool.pts2[a].x, pool.pts2[a].y];
            let pb = [pool.pts2[b].x, pool.pts2[b].y];
            let e = [pb[0] - pa[0], pb[1] - pa[1]];
            let len2 = e[0] * e[0] + e[1] * e[1];
            if len2 < 1.0e-18 {
                continue;
            }
            let t = ((p[0] - pa[0]) * e[0] + (p[1] - pa[1]) * e[1]) / len2;
            if !(1.0e-9..=1.0 - 1.0e-9).contains(&t) {
                continue;
            }
            let perp = ((p[0] - pa[0]) * e[1] - (p[1] - pa[1]) * e[0]).abs() / len2.sqrt();
            if perp <= pool.eps * 4.0 {
                splits[i].push((t, k));
            }
        }
    }
    let mut out: Vec<(usize, usize)> = Vec::with_capacity(orig.len() + 8);
    for (i, &(a, b)) in orig.iter().enumerate() {
        if splits[i].is_empty() {
            out.push((a, b));
            continue;
        }
        let mut sp = std::mem::take(&mut splits[i]);
        sp.sort_by(|x, y| x.0.total_cmp(&y.0));
        let mut prev = a;
        for &(_, idx) in &sp {
            if idx != prev {
                out.push((prev, idx));
                prev = idx;
            }
        }
        if prev != b {
            out.push((prev, b));
        }
    }
    out.sort();
    out.dedup();
    *segs = out;
}

/// The cap CDT core: pool the ring, aux-profile rings and seams; chain every
/// straight constraint through the pooled points lying on it; run the
/// conforming CDT; classify each sub-triangle by `classify(centroid)` (which
/// returns the emit orientation) && host parity.
#[allow(clippy::too_many_arguments)]
fn cap_cdt_impl(
    pf: &PrismFrame,
    ring2: &[V2],
    ring3: &[V3],
    aux: &[&[V2]],
    seams: &[Seam],
    inject: &[(V2, V3)],
    host: &[PTri],
    aabbs: &[(V3, V3)],
    caps: &mut Vec<PTri>,
    classify: impl Fn(V2) -> Option<(V3, bool)>,
) -> bool {
    let snap_eps = 1.0e-9 * (1.0 + pf.corner_mag());
    let mut pool = PointPool::new(snap_eps);
    let placeholder_n = [0.0, 0.0, 1.0];
    let ring_idx: Vec<usize> = ring2
        .iter()
        .zip(ring3)
        .map(|(&q, &p3)| pool.intern(q, p3, placeholder_n))
        .collect();
    // Aux profile rings (cap planes only): 2D verts lifted on the face plane.
    // Their 3D lift shares the plane depth of ring3[0] along d.
    let wdepth = dot(ring3[0], pf.d);
    let mut aux_idx: Vec<Vec<usize>> = Vec::new();
    for prof in aux {
        aux_idx.push(
            prof.iter()
                .map(|&[uu, vv]| pool.intern([uu, vv], pf.lift(uu, vv, wdepth), placeholder_n))
                .collect(),
        );
    }
    // Canonical shared-boundary breakpoints (pooled so the chains below pick
    // them up — the cross-face T-junction freedom).
    for &(q, p3) in inject {
        pool.intern(q, p3, placeholder_n);
    }
    let mut seam_segs: Vec<(usize, usize)> = Vec::new();
    for s in seams {
        let ia = pool.intern(s.a2, s.a3, placeholder_n);
        let ib = pool.intern(s.b2, s.b3, placeholder_n);
        if ia != ib {
            seam_segs.push((ia, ib));
        }
    }
    // Chain every straight constraint (ring edges + aux profile edges) through
    // the pooled points lying on it, so seam endpoints subdivide them and the
    // CDT stays conforming.
    let n_pool = pool.pts2.len();
    let mut seg_list: Vec<(usize, usize)> = seam_segs;
    let chain = |ia: usize, ib: usize, seg_list: &mut Vec<(usize, usize)>| {
        let a = [pool.pts2[ia].x, pool.pts2[ia].y];
        let b = [pool.pts2[ib].x, pool.pts2[ib].y];
        let eb = [b[0] - a[0], b[1] - a[1]];
        let len2 = eb[0] * eb[0] + eb[1] * eb[1];
        if len2 < 1.0e-18 {
            return;
        }
        let edge_tol = snap_eps * 4.0;
        let mut on_edge: Vec<(f64, usize)> = Vec::new();
        for i in 0..n_pool {
            if i == ia || i == ib {
                continue;
            }
            let p = [pool.pts2[i].x, pool.pts2[i].y];
            let ap = [p[0] - a[0], p[1] - a[1]];
            let tt = (ap[0] * eb[0] + ap[1] * eb[1]) / len2;
            if !(0.0..=1.0).contains(&tt) {
                continue;
            }
            let perp = (ap[0] * eb[1] - ap[1] * eb[0]).abs() / len2.sqrt();
            if perp <= edge_tol {
                on_edge.push((tt, i));
            }
        }
        on_edge.sort_by(|x, y| x.0.total_cmp(&y.0));
        let mut prev = ia;
        for &(_, i) in &on_edge {
            if i != prev {
                seg_list.push((prev, i));
                prev = i;
            }
        }
        if prev != ib {
            seg_list.push((prev, ib));
        }
    };
    let nr = ring_idx.len();
    for e in 0..nr {
        chain(ring_idx[e], ring_idx[(e + 1) % nr], &mut seg_list);
    }
    for ridx in &aux_idx {
        let n = ridx.len();
        for e in 0..n {
            chain(ridx[e], ridx[(e + 1) % n], &mut seg_list);
        }
    }
    seg_list.sort();
    seg_list.dedup();
    resolve_crossings(&mut pool, |q| pf.lift(q[0], q[1], wdepth), &mut seg_list);

    let Some((pts2, idx2)) = triangulate_pslg(&pool.pts2, &seg_list) else {
        return false;
    };
    if pts2.len() != pool.pts2.len() {
        return false;
    }
    for tri in idx2.chunks_exact(3) {
        let (a, b, c) = (tri[0], tri[1], tri[2]);
        let cu = (pts2[a].x + pts2[b].x + pts2[c].x) / 3.0;
        let cv = (pts2[a].y + pts2[b].y + pts2[c].y) / 3.0;
        let Some((desired, flip)) = classify([cu, cv]) else {
            continue;
        };
        // Lift the centroid to 3D for the host-parity test.
        let c3 = scale(
            add(add(pool.pts3[a], pool.pts3[b]), pool.pts3[c]),
            1.0 / 3.0,
        );
        if point_inside(host, aabbs, c3) {
            let (pa, pb, pc) = (pool.pts3[a], pool.pts3[b], pool.pts3[c]);
            emit_cap(caps, pa, pb, pc, desired, flip);
        }
    }
    true
}

// ─────────────────────────────── the driver ─────────────────────────────────

impl GeometryRouter {
    /// Try the analytic prism subtraction on `mesh`.
    ///
    /// Iterates the merged openings in order; each opening whose cutter is a
    /// clean prism AND whose cut passes every self-check is subtracted
    /// analytically; every other opening lands in the returned residual
    /// context (cut by the exact kernel on the analytic result — the caller
    /// recurses through [`GeometryRouter::apply_void_context`], mirroring the
    /// 2D path's residual composition). `None` ⇒ no opening was cut and the
    /// caller must run the FULL original context through the exact kernel.
    pub(super) fn try_prism_cut(
        &self,
        mesh: &Mesh,
        ctx: &VoidContext,
    ) -> Option<(Mesh, Option<VoidContext>)> {
        if ctx.merged_openings.is_empty() || mesh.is_empty() || mesh.indices.len() < 12 {
            return None;
        }
        // Promote to the f64 triangle list FIRST: `ptris_from_mesh` bounds-checks
        // every index, whereas the closure audits index `mesh.positions` straight
        // from `mesh.indices`. Auditing first would PANIC (abort under
        // panic=abort) on a malformed host index instead of recording
        // `host_promote_fail` and deferring. Post-promotion all indices are valid.
        let origin = mesh.origin;
        let Some(mut tris) = ptris_from_mesh(mesh) else {
            defer(1);
            return None;
        };
        // The volume identity, the parity classification, and the closed
        // self-check are only meaningful on a host that arrives as a
        // consistently-wound closed solid (hairline subdivision mismatches
        // tolerated — tessellated hosts routinely carry them).
        if !directed_closed(mesh) && !closed_or_hairline(mesh) {
            defer(0);
            return None;
        }
        let min_vol = Self::min_opening_volume(self.tessellation_quality);

        // ── Candidate prisms ────────────────────────────────────────────────
        // Extract a prism per opening, then MERGE prisms whose union is one
        // prism (the wall-leaf half-void pattern: two abutting halves of one
        // window — cutting the union in one pass sidesteps their coplanar
        // interface). Openings without a prism become AABB "blockers".
        struct Cand {
            pf: PrismFrame,
            ops: Vec<usize>, // indices into ctx.merged_openings
        }
        let mut cands: Vec<Cand> = Vec::new();
        let mut blockers: Vec<([V3; 3], V3, V3)> = Vec::new();
        let mut residual_idx: Vec<usize> = Vec::new();
        for (i, op) in ctx.merged_openings.iter().enumerate() {
            match prepare_prism(op, origin) {
                Some(pf) => cands.push(Cand { pf, ops: vec![i] }),
                None => {
                    defer(2);
                    residual_idx.push(i);
                    if let Some(blk) = opening_aabb_obb(op, origin) {
                        blockers.push(blk);
                    }
                }
            }
        }
        // Profile-equality fusion must weld on NUMERICAL coincidence, not a 2 mm
        // geometric slack: at 2 mm two genuinely distinct leaf profiles could be
        // declared equal and fused, silently collapsing a real slab boundary. Use
        // the same 8·SNAP_GRID weld the depth-concatenation gate already uses.
        const PROFILE_FUSE_TOL: f64 = 8.0 * crate::kernel::mesh_bridge::SNAP_GRID;
        loop {
            let mut merged_pair: Option<(usize, usize, PrismFrame)> = None;
            'search: for i in 0..cands.len() {
                for j in (i + 1)..cands.len() {
                    if let Some(m) = try_merge_prisms(&cands[i].pf, &cands[j].pf, PROFILE_FUSE_TOL) {
                        merged_pair = Some((i, j, m));
                        break 'search;
                    }
                }
            }
            let Some((i, j, m)) = merged_pair else { break };
            let mut absorbed = cands.remove(j);
            cands[i].pf = m;
            cands[i].ops.append(&mut absorbed.ops);
        }
        // Overlap vetoes, decided BEFORE any cut so an abutting-but-unmergeable
        // pair is never half-cut (cutting one against the other's flush caps —
        // here or in the residual exact pass — is the coplanar minefield the
        // exact kernel owns). 1 mm margin, matching the batch pad.
        let mut vetoed = vec![false; cands.len()];
        for i in 0..cands.len() {
            let obb_i = cands[i].pf.obb();
            for (j, cj) in cands.iter().enumerate().skip(i + 1) {
                if obb_overlaps(&obb_i, &cj.pf.obb(), 1.0e-3) {
                    vetoed[i] = true;
                    vetoed[j] = true;
                }
            }
            if blockers.iter().any(|b| obb_overlaps(&obb_i, b, 1.0e-3)) {
                vetoed[i] = true;
            }
        }

        // ── Sequential analytic cuts ────────────────────────────────────────
        let mut committed_ops = 0usize;
        for (cand, veto) in cands.iter().zip(&vetoed) {
            let mut ok = false;
            if *veto {
                defer(6);
            } else if cand.pf.volume() < min_vol {
                // Tiny cutters keep the exact path's (identical) skip
                // semantics.
                defer(3);
            } else {
                let mut pf = cand.pf.clone();
                // Host projection intervals on the prism axes: no-overlap ⇒
                // silent no-op (the exact path owns that diagnostic); engulf ⇒
                // the exact path owns the redundant-void machinery (#964,
                // #635).
                let axes = [pf.u, pf.v, pf.d];
                let mut hlo = [f64::INFINITY; 3];
                let mut hhi = [f64::NEG_INFINITY; 3];
                for t in &tris {
                    for p in &t.p {
                        for k in 0..3 {
                            let s = dot(*p, axes[k]);
                            hlo[k] = hlo[k].min(s);
                            hhi[k] = hhi[k].max(s);
                        }
                    }
                }
                let plo = [pf.bb.0[0], pf.bb.0[1], pf.d0()];
                let phi = [pf.bb.1[0], pf.bb.1[1], pf.d1()];
                let overlap = (0..3).all(|k| phi[k] > hlo[k] && plo[k] < hhi[k]);
                if !overlap {
                    defer(4);
                } else {
                    let aabbs: Vec<(V3, V3)> = tris.iter().map(PTri::aabb).collect();
                    extend_prism_caps(&mut pf, &tris, &aabbs);
                    extend_profile_edges(&mut pf, &tris, &aabbs);
                    let plo = [pf.bb.0[0], pf.bb.0[1], pf.d0()];
                    let phi = [pf.bb.1[0], pf.bb.1[1], pf.d1()];
                    let engulfs = (0..3).all(|k| {
                        let slack =
                            (hhi[k] - hlo[k]).abs().max(1.0e-9) * super::ENGULF_TOLERANCE;
                        plo[k] <= hlo[k] + slack && phi[k] >= hhi[k] - slack
                    });
                    if engulfs {
                        defer(5);
                    } else {
                        match cut_prism(&tris, &pf) {
                            Ok(outcome) => {
                                debug_assert!(outcome.removed > 0.0);
                                tris = outcome.tris;
                                committed_ops += cand.ops.len();
                                ok = true;
                            }
                            Err(reason) => defer(reason),
                        }
                    }
                }
            }
            if !ok {
                residual_idx.extend(cand.ops.iter().copied());
            }
        }
        if committed_ops == 0 {
            return None;
        }

        let mut out = mesh_from_ptris(&tris, mesh);
        // COPLANAR CONSOLIDATION: the conforming per-triangle CDT deliberately
        // over-fragments faces (every decomposed host triangle keeps its own
        // sub-triangulation, and caps carry their constraint scaffolding). Run
        // the SAME coplanar merge the exact kernel and the rect/param fast
        // paths apply (i_overlay union per plane bucket + CDT re-triangulation,
        // watertight-preserving), collapsing each planar face back to a few
        // large triangles — 2-3x fewer output triangles on the advanced_model
        // walls, matching the exact kernel's tessellation density.
        out = crate::csg::ClippingProcessor::consolidate_coplanar(out);
        // WATERTIGHT SLIVER REFINEMENT (#1007): the per-triangle CDT can emit a
        // high-aspect corner sliver at an opening rim (a far-corner triangle
        // fanned to two rim vertices) — the visible roof-slope chamfer the
        // exact path also produces and repairs. Run the SAME lockstep-bisection
        // pass the exact kernel output gets (targets aspect <= 8:1, watertight
        // by construction), so the analytic cut meets the same rim-quality bar.
        // The pass fixes one edge per internal round (64 max); the analytic
        // cut can carry more rim fans than that, so drive it to a (bounded)
        // fixpoint — each iteration is a no-op clone once no sliver remains.
        // SELF-CHECKED application, and ONLY when this cut is FINAL (no
        // residual): with a residual, the exact kernel still cuts this mesh and
        // runs its own sliver refinement on ITS output — refining first would
        // hand the arrangement midpoint-split geometry it re-fragments (#1167).
        // On a hairline-tolerated output the lockstep split can also see just
        // one side of an overlapping chain pair and amplify the sub-grid
        // mismatch, and the split slivers can fall below the clean-degenerate
        // grid — so accept the refined mesh only when it is STRICTLY closed
        // and a cleaned probe stays at least hairline-closed.
        if residual_idx.is_empty() && directed_closed(&out) {
            let mut refined = out.clone();
            for _ in 0..6 {
                let next = crate::facet_weld::refine_high_aspect_slivers(&refined);
                if next.indices.len() == refined.indices.len() {
                    break;
                }
                refined = next;
            }
            let mut probe = refined.clone();
            probe.clean_degenerate();
            if directed_closed(&refined) && (directed_closed(&probe) || closed_or_hairline(&probe))
            {
                out = refined;
            }
        }
        // Never emit a cut that is not a consistently-wound closed surface. The
        // analytic CONSTRUCTION itself must be closed (the DIRECTED audit also
        // catches doubled coincident faces and flipped caps the undirected
        // 2-manifold check cannot see); if it is not, the prism decomposition was
        // wrong and the WHOLE host (full opening set) goes back to the exact
        // kernel.
        if !directed_closed(&out) && !closed_or_hairline(&out) {
            defer(9);
            return None;
        }
        // Apply the standard `clean_degenerate` hygiene (every void path, the
        // exact kernel included, drops sub-grid slivers), then RE-AUDIT: the
        // EMITTED mesh must be the audited one (#1806 review), because cleaning
        // can drop a thin-but-counted triangle that was load-bearing for closure
        // and crack the surface. When hygiene opens such a crack, keep the
        // already-closed pre-clean construction rather than emitting the cracked
        // mesh — its un-cleaned slivers are the same hairlines every other path
        // (the exact kernel included, #1167) already carries, so this stays
        // correct without paying the exact-kernel tax for a host the analytic
        // path cut cleanly.
        let mut cleaned = out.clone();
        cleaned.clean_degenerate();
        if directed_closed(&cleaned) || closed_or_hairline(&cleaned) {
            out = cleaned;
        }

        // Residual openings in their original classification order.
        residual_idx.sort_unstable();
        let residual: Vec<OpeningType> = residual_idx
            .iter()
            .map(|&i| ctx.merged_openings[i].clone())
            .collect();

        record_cut(committed_ops, residual.len());

        let residual_ctx = if residual.is_empty() {
            None
        } else {
            Some(VoidContext {
                openings: residual.clone(),
                merged_openings: residual,
                param: None,
                bool2d: None,
            })
        };
        Some((out, residual_ctx))
    }
}

#[cfg(test)]
#[path = "prism_cut_tests.rs"]
mod tests;
