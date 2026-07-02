// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::super::interner::Vid;
use super::super::predicates::{orient2d_any, orient3d};
use super::super::rational::point_of;
use super::super::{DropAxis, ImplicitPoint, Sign};
use super::{Arrangement, BoolOp, Tri};
use num_traits::ToPrimitive;

// --- winding classification + boolean extraction --------------------------

pub(super) fn cross3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
pub(super) fn dot3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
fn e(p: [f64; 3]) -> ImplicitPoint {
    ImplicitPoint::Explicit(p)
}

/// EXACT segment–triangle intersection via `orient3d` (no epsilon): the segment
/// `q1→q2` crosses triangle `t` iff its endpoints straddle `t`'s plane AND the
/// line passes the same side of all three edges. A grazing hit (`orient3d == 0`)
/// is rejected — the fixed generic ray direction makes those vanishingly rare.
fn exact_seg_hits_tri(q1: [f64; 3], q2: [f64; 3], t: &Tri) -> bool {
    let s1 = orient3d(&e(t[0]), &e(t[1]), &e(t[2]), &e(q1));
    let s2 = orient3d(&e(t[0]), &e(t[1]), &e(t[2]), &e(q2));
    if s1 == Sign::Zero || s2 == Sign::Zero || s1 == s2 {
        return false;
    }
    let ea = orient3d(&e(q1), &e(q2), &e(t[0]), &e(t[1]));
    let eb = orient3d(&e(q1), &e(q2), &e(t[1]), &e(t[2]));
    let ec = orient3d(&e(q1), &e(q2), &e(t[2]), &e(t[0]));
    ea != Sign::Zero && ea == eb && eb == ec
}

/// Ray-cast "far" distance: just past the operand's actual extent. Critically NOT
/// a huge constant (1e7) — that blows the orient3d float-filter error bound so
/// EVERY predicate escalates to BigRational (≈5000× slower). Sized to the operand,
/// the float filter resolves the common case and only true grazing escalates.
pub(super) fn operand_extent(tris: &[Tri]) -> f64 {
    let mut hi = 1.0f64;
    for t in tris {
        for v in t {
            for &c in v {
                hi = hi.max(c.abs());
            }
        }
    }
    2.0 * hi + 1.0
}

/// The fixed generic ray direction for parity casts. No two components
/// near-equal and no pairwise ratio near a simple architectural slope (1:1
/// roofs, axis planes). The previous direction had x≈y and dz/dx≈1 — nearly
/// PARALLEL to 45° roof slopes/ridge edges, so a roof-clipped wall's ray grazed
/// the roof and edge-crossings (rejected, not counted) miscounted parity → the
/// sub-ridge gable triangle was wrongly judged inside the cutter and removed
/// (the "missing wall" over-clip). Shared by [`point_inside`] and the
/// per-component AABB ray prefilter so they can never disagree.
fn ray_dir() -> [f64; 3] {
    [0.301_511_3, 0.557_328_1, 0.773_890_1]
}

/// Is point `p` inside the closed mesh `tris`? Exact ray-cast parity to a far
/// point (`far_l` past the extent) along a fixed generic direction; each crossing
/// tested by the exact predicate above.
pub(super) fn point_inside(p: [f64; 3], tris: &[Tri], far_l: f64) -> bool {
    let dir = ray_dir();
    let far = [p[0] + dir[0] * far_l, p[1] + dir[1] * far_l, p[2] + dir[2] * far_l];
    tris.iter().filter(|t| exact_seg_hits_tri(p, far, t)).count() % 2 == 1
}

/// BVH-accelerated [`point_inside`]: the `bvh` (built over `tris`) prunes the ray
/// to the triangles whose AABB it may cross, and the EXACT crossing test runs only
/// on those. The BVH candidate set is a conservative superset of the exact hits,
/// so the crossing-parity — hence the inside/outside verdict — is byte-identical
/// to the linear scan (the pinned boolean determinism manifests are unperturbed).
/// O(N) → O(log N + hits) per query, the win on host operands with many triangles.
fn point_inside_bvh(
    p: [f64; 3],
    tris: &[Tri],
    bvh: &super::super::broadphase::Bvh,
    far_l: f64,
    scratch: &mut Vec<u32>,
) -> bool {
    let dir = ray_dir();
    let far = [p[0] + dir[0] * far_l, p[1] + dir[1] * far_l, p[2] + dir[2] * far_l];
    scratch.clear();
    bvh.ray_candidates(p, far, scratch);
    scratch
        .iter()
        .filter(|&&i| exact_seg_hits_tri(p, far, &tris[i as usize]))
        .count()
        % 2
        == 1
}

pub(super) fn to_f64_pt(arr: &Arrangement, v: Vid) -> [f64; 3] {
    let idx = v as usize;
    if let Some(Some(p)) = arr.f64_cache.borrow().get(idx).copied() {
        return p;
    }
    let pt = arr.interner.get(v);
    // Reuse the interner's already-cached I512 lambda (computed once at intern time)
    // rather than re-deriving it at I1024 in `point_to_f64`; fall to the from-scratch
    // fixed-width path on a cache miss (overflow), then to exact BigRational `point_of`
    // for off-grid points. All three yield the identical f64.
    let p = arr
        .interner
        .lam(v)
        .as_ref()
        .and_then(super::super::fixed::point_to_f64_from_lam)
        .or_else(|| super::super::fixed::point_to_f64(pt))
        .unwrap_or_else(|| {
            let q = point_of(pt);
            [q[0].to_f64().unwrap(), q[1].to_f64().unwrap(), q[2].to_f64().unwrap()]
        });
    if let Some(slot) = arr.f64_cache.borrow_mut().get_mut(idx) {
        *slot = Some(p);
    }
    p
}

pub(super) fn sub_f64(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn centroid(arr: &Arrangement, tri: [Vid; 3]) -> [f64; 3] {
    let c = [to_f64_pt(arr, tri[0]), to_f64_pt(arr, tri[1]), to_f64_pt(arr, tri[2])];
    [
        (c[0][0] + c[1][0] + c[2][0]) / 3.0,
        (c[0][1] + c[1][1] + c[2][1]) / 3.0,
        (c[0][2] + c[1][2] + c[2][2]) / 3.0,
    ]
}

fn tri_normal(arr: &Arrangement, tri: [Vid; 3]) -> [f64; 3] {
    let (a, b, c) = (to_f64_pt(arr, tri[0]), to_f64_pt(arr, tri[1]), to_f64_pt(arr, tri[2]));
    cross3(sub_f64(b, a), sub_f64(c, a))
}

fn drop_axis_of(n: [f64; 3]) -> DropAxis {
    let an = [n[0].abs(), n[1].abs(), n[2].abs()];
    if an[0] >= an[1] && an[0] >= an[2] {
        DropAxis::X
    } else if an[1] >= an[2] {
        DropAxis::Y
    } else {
        DropAxis::Z
    }
}

/// If point `c` lies exactly on a triangle of `others` (coplanar AND inside it),
/// return that triangle's f64 normal — i.e. detect that a sub-triangle whose
/// centroid is `c` sits on a coplanar SHARED face of the other operand.
/// Exact in-plane containment: with `n` the un-normalised face normal of `t`, is
/// `c` strictly inside `t`'s outline projected onto the dropped axis? Shared by the
/// exact and near coplanar-surface tests; false for a degenerate projected `t`.
fn point_in_tri_proj(c: [f64; 3], t: &Tri, n: [f64; 3]) -> bool {
    let axis = drop_axis_of(n);
    let w0 = orient2d_any(&e(t[0]), &e(t[1]), &e(t[2]), axis);
    if w0 == Sign::Zero {
        return false; // degenerate t in projection
    }
    let inside = |u: [f64; 3], v: [f64; 3]| orient2d_any(&e(u), &e(v), &e(c), axis) != w0.flip();
    inside(t[0], t[1]) && inside(t[1], t[2]) && inside(t[2], t[0])
}

/// Per-triangle exact coincident-face test (see [`on_surface_normal`]).
fn on_surface_tri(c: [f64; 3], t: &Tri) -> Option<[f64; 3]> {
    if orient3d(&e(t[0]), &e(t[1]), &e(t[2]), &e(c)) != Sign::Zero {
        return None; // c not on t's plane
    }
    let n = cross3(sub_f64(t[1], t[0]), sub_f64(t[2], t[0]));
    point_in_tri_proj(c, t, n).then_some(n)
}

/// Per-triangle near-coplanar-flush test (see [`near_on_surface_normal`]); `band2`
/// is the squared perpendicular plane-gap tolerance.
fn near_on_surface_tri(c: [f64; 3], t: &Tri, band2: f64) -> Option<[f64; 3]> {
    let n = cross3(sub_f64(t[1], t[0]), sub_f64(t[2], t[0]));
    let nn = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
    if nn <= 0.0 || !nn.is_finite() {
        return None; // degenerate t
    }
    let d = dot3(sub_f64(c, t[0]), n);
    if (d * d) / nn > band2 {
        return None; // c not within the snap band of t's plane
    }
    point_in_tri_proj(c, t, n).then_some(n)
}

/// The near-coplanar perpendicular band (see [`near_on_surface_normal`]) from the
/// operand+`c` coordinate magnitude `extent`.
fn near_band_from_extent(extent: f64) -> f64 {
    (8.0 * SNAP_GRID).max(extent * (1.0 / 4_194_304.0))
}

fn on_surface_normal(c: [f64; 3], others: &[Tri]) -> Option<[f64; 3]> {
    others.iter().find_map(|t| on_surface_tri(c, t))
}

/// Power-of-two grid `mesh_bridge` snaps both operands to (metres); the
/// `near_on_surface_normal` band below is sized to the scatter this snap
/// leaves on a TILTED flush face.
use super::super::mesh_bridge::SNAP_GRID;

/// The NEAR-coplanar analogue of [`on_surface_normal`], used ONLY for a
/// sub-triangle whose parent face had a near-coplanar overlap with the other
/// operand (`coplanar_a/b[i]` set). Returns the covering `other` face's f64 normal
/// when `c` sits within the snap-scatter band of that face's plane AND projects
/// strictly inside it.
///
/// WHY this exists — the flush-cap defect (#1007 host #1112 openings #2150/#2154):
/// real IFC is f32, so an opening cap authored EXACTLY flush with a TILTED roof
/// surface is NOT exactly coplanar after `mesh_bridge`'s per-axis snap — each
/// operand scatters up to `SNAP_GRID·√3` off the shared tilted plane. The exact
/// [`on_surface_normal`] needs `orient3d == 0` (centroid bit-exactly on the other
/// face's plane), so it MISSES the flush cap; the sub-triangle then falls to the
/// fragile `solid_side` probe (regime 2) or the on-boundary centroid ray-cast
/// (regime 3), both undefined at a µm-flush interface ⇒ the inside-footprint host
/// sub-triangle is wrongly KEPT and bridges the opening.
///
/// DETERMINISM: the only inexactness vs. [`on_surface_normal`] is the perpendicular
/// plane-gap admitted (the `band` test); the in-plane containment still uses the
/// EXACT `orient2d_any`. `band` is an absolute power-of-two multiple of `SNAP_GRID`
/// (≈ the 2-operand scatter envelope) widened only for far-from-origin operands
/// (coarser f32 import) — always THREE orders below the smallest real feature edge
/// (~0.2 m), so a genuinely-distinct parallel face (a thin slab's two surfaces)
/// can never be within it. All FMA-free f64 over input coords ⇒ byte-identical
/// native==wasm. GATED on the near-coplanar-parent flag, so a transversal cut
/// (every pinned box−box manifest face) never reaches it.
fn near_on_surface_normal(c: [f64; 3], others: &[Tri]) -> Option<[f64; 3]> {
    let mut extent = 1.0f64;
    for &x in &c {
        extent = extent.max(x.abs());
    }
    for t in others {
        for v in t {
            for &x in v {
                extent = extent.max(x.abs());
            }
        }
    }
    let band2 = near_band_from_extent(extent).powi(2);
    others.iter().find_map(|t| near_on_surface_tri(c, t, band2))
}

/// BVH-accelerated equivalent of `on_surface_normal(c, a).is_some() ||
/// near_on_surface_normal(c, a).is_some()` — does ANY triangle of `a` carry `c` on
/// its face (exactly or within the snap band)? `a_coord_extent` is the max |coord|
/// over `a` (hoisted once per arrangement, since only `c` varies per call). The
/// query radius is the band, so candidates are a conservative superset and the
/// exact per-triangle predicates decide; the result is `any`, so it is independent
/// of candidate order and byte-identical to the linear scan.
fn c_on_or_near_a(
    c: [f64; 3],
    a: &[Tri],
    bvh: &super::super::broadphase::Bvh,
    a_coord_extent: f64,
    scratch: &mut Vec<u32>,
) -> bool {
    let extent = c.iter().fold(a_coord_extent, |m, &x| m.max(x.abs()));
    let band = near_band_from_extent(extent);
    let band2 = band * band;
    scratch.clear();
    bvh.point_candidates(c, band, scratch);
    scratch.iter().any(|&i| {
        let t = &a[i as usize];
        on_surface_tri(c, t).is_some() || near_on_surface_tri(c, t, band2).is_some()
    })
}

/// Is the OTHER operand's solid present just off `c` along `±dir`?
///
/// `c` is a sub-triangle centroid that may lie EXACTLY on a shared interface plane
/// where the on-plane ray-cast is undefined. We probe an infinitesimal step to
/// EACH side along the (unit-ish) face normal `dir` and ray-cast each probe point
/// — the probe points are strictly off the plane, so the parity test is
/// well-defined. Returns `(in_plus, in_minus)` = solid present on the `+dir` /
/// `−dir` side.
///
/// DETERMINISM: every operation here is FMA-free f64 over input coordinates, and
/// the ray-cast uses the all-`Explicit` `geometry_predicates::orient3d` path (no
/// implicit points, no BigRational escalation, const float error bounds) — so the
/// keep/drop verdict is byte-identical native==wasm, exactly like the existing
/// on-plane centroid classification.
fn solid_side(c: [f64; 3], dir: [f64; 3], other: &[Tri], far_l: f64) -> (bool, bool) {
    // Unit-normalise `dir` so the step magnitude is plane-independent, then step a
    // small fraction of the operand extent off the plane — far enough that the
    // float predicate resolves the probe vs. the plane, near enough that no other
    // feature is crossed.
    let len = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
    if len == 0.0 {
        return (false, false);
    }
    // far_l = 2*extent + 1; a step of far_l * 2^-20 ≈ extent * 2^-19 is ~µm at
    // building scale — well inside a face yet resolvable by orient3d.
    let step = far_l * (1.0 / 1_048_576.0);
    let u = [dir[0] / len * step, dir[1] / len * step, dir[2] / len * step];
    let p_plus = [c[0] + u[0], c[1] + u[1], c[2] + u[2]];
    let p_minus = [c[0] - u[0], c[1] - u[1], c[2] - u[2]];
    (point_inside(p_plus, other, far_l), point_inside(p_minus, other, far_l))
}

/// The B operand as PAIRWISE-DISJOINT closed components (disjoint-cutter
/// batching). The binary boolean is the 1-component special case. Classification
/// against the union of disjoint closed solids decomposes per component —
/// "inside the union" ⇔ "inside exactly one component" — which (a) caps the ray
/// parity scan at the component the ray can actually reach (the per-component
/// AABB prefilter removes the O(|subA|·Σ|B_k|) blowup of a soup-wide cast), and
/// (b) structurally eliminates cross-component graze-parity fragility (a graze
/// on a FAR component can no longer flip the verdict for a near one).
pub(super) struct BComponents<'a> {
    comps: &'a [&'a [Tri]],
    /// Per-component AABB, inflated by `pad` (conservative for both the ray
    /// prefilter and the coincident-face band test).
    aabbs: Vec<([f64; 3], [f64; 3])>,
    /// Per-component ray-cast far length (`operand_extent`), exactly as the
    /// binary path computes it for its single operand.
    exts: Vec<f64>,
}

impl<'a> BComponents<'a> {
    pub(super) fn new(comps: &'a [&'a [Tri]]) -> Self {
        let exts: Vec<f64> = comps.iter().map(|c| operand_extent(c)).collect();
        // Inflation: ≥ 2× the near-coplanar band envelope (`8·SNAP_GRID`,
        // widened far from origin), so a centroid within the coincident-face
        // band of a component face is always inside that component's inflated
        // AABB; also dwarfs any f64 rounding in the slab test. Deterministic
        // FMA-free f64.
        let max_ext = exts.iter().cloned().fold(1.0f64, f64::max);
        let pad = 4.0 * (8.0 * SNAP_GRID).max(max_ext * (1.0 / 4_194_304.0));
        let aabbs = comps
            .iter()
            .map(|c| {
                let mut lo = [f64::MAX; 3];
                let mut hi = [f64::MIN; 3];
                for t in c.iter() {
                    for v in t {
                        for k in 0..3 {
                            lo[k] = lo[k].min(v[k]);
                            hi[k] = hi[k].max(v[k]);
                        }
                    }
                }
                for k in 0..3 {
                    lo[k] -= pad;
                    hi[k] += pad;
                }
                (lo, hi)
            })
            .collect();
        Self { comps, aabbs, exts }
    }

    /// Conservative "could the parity segment from `p` hit component `k`?" —
    /// a slab test of `[p, p + dir·ext_k]` against the inflated AABB. Sound:
    /// the component's triangles lie inside the (un-inflated) AABB, so a
    /// segment that misses the inflated AABB has parity 0 there.
    fn ray_may_hit(&self, k: usize, p: [f64; 3]) -> bool {
        let dir = ray_dir();
        let far_l = self.exts[k];
        let q = [p[0] + dir[0] * far_l, p[1] + dir[1] * far_l, p[2] + dir[2] * far_l];
        let (lo, hi) = (&self.aabbs[k].0, &self.aabbs[k].1);
        let (mut t0, mut t1) = (0.0f64, 1.0f64);
        for i in 0..3 {
            let d = q[i] - p[i];
            if d == 0.0 {
                if p[i] < lo[i] || p[i] > hi[i] {
                    return false;
                }
                continue;
            }
            let (a, b) = ((lo[i] - p[i]) / d, (hi[i] - p[i]) / d);
            let (a, b) = if a <= b { (a, b) } else { (b, a) };
            t0 = t0.max(a);
            t1 = t1.min(b);
            if t0 > t1 {
                return false;
            }
        }
        true
    }

    #[inline]
    fn point_in_aabb(&self, k: usize, p: [f64; 3]) -> bool {
        let (lo, hi) = (&self.aabbs[k].0, &self.aabbs[k].1);
        (0..3).all(|i| p[i] >= lo[i] && p[i] <= hi[i])
    }

    /// Is `p` inside the union of the components? (Pairwise-disjoint closed
    /// solids ⇒ inside exactly one ⇒ a per-component exact ray parity, each
    /// prefiltered by its AABB.)
    fn inside(&self, p: [f64; 3]) -> bool {
        self.comps
            .iter()
            .enumerate()
            .any(|(k, comp)| self.ray_may_hit(k, p) && point_inside(p, comp, self.exts[k]))
    }

    /// Regime-1 coincident-face probe across the components: the EXACT
    /// [`on_surface_normal`] on every AABB-near component first, then the
    /// snap-band [`near_on_surface_normal`] analogue (same priority order as
    /// the binary path). Disjointness makes at most one component eligible.
    fn surface_normal(&self, c: [f64; 3]) -> Option<[f64; 3]> {
        for (k, comp) in self.comps.iter().enumerate() {
            if self.point_in_aabb(k, c) {
                if let Some(n) = on_surface_normal(c, comp) {
                    return Some(n);
                }
            }
        }
        for (k, comp) in self.comps.iter().enumerate() {
            if self.point_in_aabb(k, c) {
                if let Some(n) = near_on_surface_normal(c, comp) {
                    return Some(n);
                }
            }
        }
        None
    }

    /// Multi-component [`solid_side`]: probe an infinitesimal step to each side
    /// of the face along `dir` and test the union-inside on each probe. The
    /// step is sized to the LARGEST component extent (== the binary behavior
    /// for one component).
    fn solid_side(&self, c: [f64; 3], dir: [f64; 3]) -> (bool, bool) {
        let len = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
        if len == 0.0 {
            return (false, false);
        }
        let max_ext = self.exts.iter().cloned().fold(1.0f64, f64::max);
        let step = max_ext * (1.0 / 1_048_576.0);
        let u = [dir[0] / len * step, dir[1] / len * step, dir[2] / len * step];
        let p_plus = [c[0] + u[0], c[1] + u[1], c[2] + u[2]];
        let p_minus = [c[0] - u[0], c[1] - u[1], c[2] - u[2]];
        (self.inside(p_plus), self.inside(p_minus))
    }
}

/// Regime-2 classifier (see [`boolean_vids`]): a sub-triangle whose centroid `c`
/// lies on the OTHER solid's boundary surface — without a COINCIDENT face there
/// (regime 1 already handled that), so the on-plane centroid ray-cast is undefined.
///
/// Applies ONLY when the other solid's boundary actually passes through `c` —
/// detected by [`solid_side`] reporting DIFFERENT inside/outside verdicts on the
/// two sides of the face (`op_plus != op_minus`). That is exactly the degenerate
/// case the plain ray-cast can't resolve (the #960 seam end-region: the other
/// solid abuts via a NON-coplanar face, so its solid is present on one side of
/// this coplanar sub-triangle but it has no coincident face there). When the two
/// sides AGREE, `c` is strictly inside or outside the other solid → the plain
/// ray-cast is reliable → return `None` so the caller uses it (preserving every
/// existing in/out classification, incl. the pinned box−box manifests).
///
/// `c` is on the boundary, so the other solid occupies exactly one side. With the
/// outward normal `n` (own-solid on `−n`):
/// * Union — keep iff the other solid is NOT outside (`!op_plus`): an interface
///   with the other solid on the `+n` side is interior to `A∪B` → drop.
/// * Intersection — keep iff the other solid is on the inner side: `op_minus`.
/// * Difference — keep iff the other solid is NOT on the inner side: `!op_minus`.
fn on_interface_keep(
    arr: &Arrangement,
    tri: [Vid; 3],
    c: [f64; 3],
    other: &[Tri],
    ext_other: f64,
    op: BoolOp,
    _a_side: bool,
) -> Option<bool> {
    let n = tri_normal(arr, tri);
    let (op_plus, op_minus) = solid_side(c, n, other, ext_other);
    if op_plus == op_minus {
        // `c` is strictly inside/outside the other solid — NOT on its boundary;
        // the plain centroid ray-cast is well-defined, so defer to it. This is the
        // common case for every non-coplanar sub-triangle (incl. the pinned
        // box−box cut faces), so regime 2 perturbs nothing there.
        return None;
    }
    Some(match op {
        BoolOp::Union => !op_plus,
        BoolOp::Intersection => op_minus,
        BoolOp::Difference => !op_minus,
    })
}

/// The boolean result as ORIENTED Vid triangles.
///
/// A sub-triangle's centroid is classified against the OTHER operand in one of
/// three regimes:
/// 1. **On a coincident SHARED face** (`on_surface_normal` finds a covering,
///    coplanar triangle of the other operand): classify by NORMAL AGREEMENT —
///    keep the A-copy for a co-oriented face on a union/intersection, or an
///    opposite face on a difference; drop the B-copy (dedup). This is the
///    original exact handling and is unchanged.
/// 2. **On a shared INTERFACE plane WITHOUT a coincident face** (the segmented-
///    roof seam end-regions, #960 — the other solid abuts via a NON-coplanar
///    face, so regime 1 misses it and the on-plane ray-cast is undefined):
///    classify by the other solid's presence on the `−n` (inner) side, probed an
///    infinitesimal step off the plane ([`solid_side`]). This is the fix: such a
///    sub-triangle is an interior interface for union (drop) but was previously
///    mis-routed to the undefined ray-cast and wrongly kept.
/// 3. **Strictly off any shared plane**: the exact centroid ray-cast, as before.
///
/// For union/intersection, a co-oriented DUPLICATE face (same patch, same winding
/// — e.g. unioning identical/overlapping coplanar solids) survives regime 1's
/// keep test on BOTH operands; because the arrangement conforms over one interner
/// it is the SAME oriented Vid triangle on both, so the B-copy is dropped when its
/// rotation-canonical key already appears among the kept A-copies. (A back-to-back
/// interface shares the unordered vertex set but has OPPOSITE winding, so it never
/// collides; both its copies are dissolved by regime 2.)
pub(super) fn boolean_vids(arr: &Arrangement, a: &[Tri], b: &[Tri], op: BoolOp) -> Vec<[Vid; 3]> {
    boolean_vids_components(arr, a, &BComponents::new(&[b]), op)
}

/// [`boolean_vids`] with the B operand as pairwise-disjoint closed components
/// (see [`BComponents`]). For a single component this is verdict-identical to
/// the historical binary classifier — the AABB gates are pure prefilters — so
/// the pinned boolean manifest is unperturbed.
pub(super) fn boolean_vids_components(
    arr: &Arrangement,
    a: &[Tri],
    bc: &BComponents,
    op: BoolOp,
) -> Vec<[Vid; 3]> {
    use std::collections::HashSet;
    let ext_a = operand_extent(a);
    // One BVH over operand A, reused for every B-face inside/outside ray-cast AND
    // coincident/near-surface probe below (the dominant O(|tris_b|·|a|) scans on
    // boolean-heavy meshes). `a_coord_extent` (hoisted) feeds the near-surface band.
    let bvh_a = super::super::broadphase::Bvh::build(a);
    let a_coord_extent = a
        .iter()
        .flat_map(|t| t.iter())
        .flat_map(|v| v.iter())
        .fold(1.0f64, |m, &x| m.max(x.abs()));
    let mut scratch: Vec<u32> = Vec::new();
    let dedup = matches!(op, BoolOp::Union | BoolOp::Intersection);
    let mut a_kept: HashSet<[Vid; 3]> = HashSet::new();
    let mut out = Vec::new();
    for (i, &tri) in arr.tris_a.iter().enumerate() {
        let c = centroid(arr, tri);
        let cop_parent = arr.coplanar_a.get(i).copied().unwrap_or(false);
        let keep;
        // regime 1: coincident shared face → classify by normal agreement. Tried
        // EXACT first, then the snap-band-flush analogue (`near_on_surface_normal`)
        // which catches a face left a few µm off a TILTED shared plane by per-axis
        // import snapping (the #1007 flush roof-opening cap). The near test is
        // ungated (like the exact one) because a coincident-shared-face DROP/keep is
        // unconditionally correct, and its centroid-inside + µm-perp requirements
        // never match a transversal cut face (every pinned box−box manifest face).
        if let Some(n_other) = bc.surface_normal(c) {
            let co_oriented = dot3(tri_normal(arr, tri), n_other) > 0.0;
            keep = match op {
                BoolOp::Union | BoolOp::Intersection => co_oriented,
                BoolOp::Difference => !co_oriented,
            };
        } else if let Some(k) = cop_parent
            .then(|| {
                // regime 2 (only on coplanar-overlap parents): shared interface
                // plane, no coincident face → solid-side probe (see
                // `on_interface_keep` for the keep table rationale).
                let n = tri_normal(arr, tri);
                let (op_plus, op_minus) = bc.solid_side(c, n);
                if op_plus == op_minus {
                    return None; // strictly in/out — the plain ray-cast decides
                }
                Some(match op {
                    BoolOp::Union => !op_plus,
                    BoolOp::Intersection => op_minus,
                    BoolOp::Difference => !op_minus,
                })
            })
            .flatten()
        {
            keep = k;
        } else {
            // regime 3: strictly off-plane → centroid ray-cast (original)
            let inside_b = bc.inside(c);
            keep = match op {
                BoolOp::Intersection => inside_b,
                _ => !inside_b,
            };
        }
        if keep {
            if dedup {
                a_kept.insert(rotate_min_first(tri));
            }
            out.push(tri);
        }
    }
    for (i, &tri) in arr.tris_b.iter().enumerate() {
        // dedup a true co-oriented duplicate of a kept A face (keep the A-copy)
        if dedup && a_kept.contains(&rotate_min_first(tri)) {
            continue;
        }
        let c = centroid(arr, tri);
        let cop_parent = arr.coplanar_b.get(i).copied().unwrap_or(false);
        // A coincident-shared B face is dropped (the A-copy is the kept one). Tried
        // EXACT first, then the snap-band-flush analogue — ungated, because a B cap
        // fully CONTAINED in a larger host face has NO coplanar constraint of its
        // own (the host imposes none on it) so `coplanar_b` is unset for it, yet it
        // is still a coincident shared face that must drop (the #1007 flush roof cap
        // — without the near drop here it survives and bridges the opening).
        if c_on_or_near_a(c, a, &bvh_a, a_coord_extent, &mut scratch) {
            continue; // coplanar-shared B-copy: dropped (the A-copy is the kept one)
        }
        if cop_parent {
            if let Some(keep) = on_interface_keep(arr, tri, c, a, ext_a, op, false) {
                // regime 2 for B (coplanar-overlap parent only).
                if keep {
                    let flip = matches!(op, BoolOp::Difference);
                    out.push(if flip { [tri[0], tri[2], tri[1]] } else { tri });
                }
                continue;
            }
        }
        let inside_a = point_inside_bvh(c, a, &bvh_a, ext_a, &mut scratch);
        let (keep, flip) = match op {
            BoolOp::Difference => (inside_a, true),
            BoolOp::Union => (!inside_a, false),
            BoolOp::Intersection => (inside_a, false),
        };
        if keep {
            out.push(if flip { [tri[0], tri[2], tri[1]] } else { tri });
        }
    }
    out
}

#[inline]
pub(super) fn rotate_min_first(t: [Vid; 3]) -> [Vid; 3] {
    let i = (0..3).min_by_key(|&k| t[k]).unwrap();
    [t[i], t[(i + 1) % 3], t[(i + 2) % 3]]
}
