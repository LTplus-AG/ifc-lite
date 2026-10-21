// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::super::broadphase::Aabb;
use super::super::interner::Vid;
use super::super::predicates::orient2d_any;
use super::super::rational::point_of;
use super::super::{DropAxis, ImplicitPoint, Sign};
use super::coincident::coincident_planes;
use super::ray_parity::{exact_seg_hits_tri, operand_extent, point_inside, ray_dir, sound_far};
use super::{Arrangement, BoolOp, Tri};
use num_traits::ToPrimitive;
#[path = "closed_source.rs"]
mod closed_source;
use closed_source::strict_closed;
#[path = "finite_patch.rs"]
mod finite_patch;
use finite_patch::AdjacentFaces;

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
    // Same far-endpoint soundness guarantee as `point_inside`, taken from the
    // BVH's root AABB (the unpadded bound over every triangle) rather than an
    // O(N) rescan.
    let Some(bb) = bvh.root_aabb() else {
        return false; // empty tree, no crossings to count
    };
    let far = sound_far(p, ray_dir(), far_l, bb);
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

#[cfg(test)]
fn centroid(arr: &Arrangement, tri: [Vid; 3]) -> [f64; 3] {
    centroid_of_points(tri.map(|v| to_f64_pt(arr, v)))
}

fn centroid_of_points(c: [[f64; 3]; 3]) -> [f64; 3] {
    [
        (c[0][0] + c[1][0] + c[2][0]) / 3.0,
        (c[0][1] + c[1][1] + c[2][1]) / 3.0,
        (c[0][2] + c[1][2] + c[2][2]) / 3.0,
    ]
}

fn tri_normal([a, b, c]: [[f64; 3]; 3]) -> [f64; 3] {
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

#[path = "classify_surface.rs"]
mod surface;
use surface::{surface_normal_near_a, near_on_surface_normal, BoundaryCentroid, on_surface_normal};
use super::super::near_band::{NearBand, near_band_from_extent};

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
///
/// `other_aabb` is `other`'s box (see [`point_inside`]), hoisted once by the
/// caller rather than rescanned for each of the two probes below.
fn solid_side(c: [f64; 3], dir: [f64; 3], other: &[Tri], far_l: f64, other_aabb: Aabb) -> (bool, bool) {
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
    (
        point_inside(p_plus, other, far_l, other_aabb),
        point_inside(p_minus, other, far_l, other_aabb),
    )
}

/// Opposite near faces can bound a real overlapping sliver. If the exact
/// arranged centroid is off the other boundary, DIFFERENCE uses solid occupancy
/// symmetrically; the shared-normal table applies to actual boundary points.
/// Co-oriented near faces retain their flush-cap policy (#1007, #7292).
fn opposed_difference_uses_volume(
    op: BoolOp, own: [f64; 3], other: [f64; 3], only_opposed: bool, on_boundary: impl FnOnce() -> bool,
) -> bool {
    matches!(op, BoolOp::Difference) && dot3(own, other) < 0.0 && only_opposed && !on_boundary()
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
    closed: std::cell::OnceCell<bool>,
    adjacency: Vec<std::cell::OnceCell<AdjacentFaces>>,
}

impl<'a> BComponents<'a> {
    pub(super) fn new(comps: &'a [&'a [Tri]]) -> Self {
        let exts: Vec<f64> = comps.iter().map(|c| operand_extent(c)).collect();
        // Inflation: ≥ 2× the near-coplanar band envelope (`8·SNAP_GRID`,
        // widened far from origin), so a centroid within the coincident-face
        // band of a component face is always inside that component's inflated
        // AABB; also dwarfs any f64 rounding in the slab test. Deterministic
        // FMA-free f64.
        // Deliberately still the SCALAR `near_band_from_extent`: this inflates
        // an axis-aligned box in ALL axes, so there is no plane normal to
        // project onto, and it is only a prefilter. `operand_extent` is
        // `2·hi + 1` and the factor here a further 4x, against a projected band
        // of at most `sqrt(3)·hi·2⁻²²` — a comfortable superset.
        let max_ext = exts.iter().cloned().fold(1.0f64, f64::max);
        let pad = 4.0 * near_band_from_extent(max_ext);
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
        Self { comps, aabbs, exts, closed: std::cell::OnceCell::new(), adjacency: (0..comps.len()).map(|_| std::cell::OnceCell::new()).collect() }
    }

    /// Conservative "could the parity segment from `p` hit component `k`?" —
    /// a slab test of `[p, p + dir·ext_k]` against the inflated AABB. Sound:
    /// the component's triangles lie inside the (un-inflated) AABB, so a
    /// segment that misses the inflated AABB has parity 0 there.
    ///
    /// NOTE this tests the UNEXTENDED endpoint, while the parity cast it gates
    /// may be lengthened by [`sound_far`]. That is still sound, but only via
    /// [`sound_far`]'s early return, so the dependency is stated here rather
    /// than left to be re-derived: a rejection here means the short segment
    /// missed the INFLATED box, hence the default endpoint is outside the
    /// UN-inflated box, hence `sound_far` returns it unchanged and the segment
    /// actually cast is the one this tested. Extending against a padded box
    /// instead of the unpadded one would break this and silently under-count.
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
    ///
    /// Passes the already-inflated `self.aabbs[k]` rather than rescanning `comp`.
    /// It contains `comp`'s triangles, so the verdict is unchanged — not merely
    /// faster: escalation counts and the boolean manifest are unaffected.
    fn inside(&self, p: [f64; 3]) -> bool {
        self.comps.iter().enumerate().any(|(k, comp)| {
            self.ray_may_hit(k, p) && point_inside(p, comp, self.exts[k], self.aabbs[k])
        })
    }

    /// Regime-1 coincident-face probe across the components: the EXACT
    /// [`on_surface_normal`] on every AABB-near component first, then the
    /// snap-band [`near_on_surface_normal`] analogue (same priority order as
    /// the binary path). Disjointness makes at most one component eligible.
    fn surface_normal(&self, c: [f64; 3], n_own: [f64; 3], own: &Tri, own_exact: [&ImplicitPoint; 3], bands: &[NearBand]) -> Option<[f64; 3]> {
        for (k, comp) in self.comps.iter().enumerate() {
            if self.point_in_aabb(k, c) {
                if let Some(n) = on_surface_normal(c, n_own, comp) {
                    return Some(n);
                }
            }
        }
        for (k, comp) in self.comps.iter().enumerate() {
            if self.point_in_surface_aabb(k, c, &bands[k]) {
                if let Some(n) = near_on_surface_normal(c, n_own, own, own_exact, comp, &bands[k], &self.adjacency[k]) {
                    return Some(n);
                }
            }
        }
        None
    }

    fn all_closed(&self) -> bool {
        *self.closed.get_or_init(|| self.comps.iter().all(|c| strict_closed(c)))
    }

    fn only_opposed(&self, c: [f64; 3], n_own: [f64; 3], own: &Tri, own_exact: [&ImplicitPoint; 3], bands: &[NearBand]) -> bool {
        self.comps.iter().enumerate().all(|(k, comp)| !self.point_in_surface_aabb(k, c, &bands[k])
            || !surface::has_nonopposed_surface(c, n_own, own, own_exact, comp, &bands[k], &self.adjacency[k]))
    }

    /// Surface lookup alone needs the paired context's finite-projection pad.
    /// Leave existing parity/ray boxes and their callers untouched.
    fn point_in_surface_aabb(&self, k: usize, p: [f64; 3], band: &NearBand) -> bool {
        let pad = 2.0 * band.radius();
        let (lo, hi) = &self.aabbs[k];
        (0..3).all(|i| p[i] >= (lo[i] - pad).next_down()
            && p[i] <= (hi[i] + pad).next_up())
    }

    fn on_boundary(&self, arr: &Arrangement, tri: [Vid; 3]) -> bool {
        let Some(centroid) = BoundaryCentroid::new(arr, tri) else { return false };
        for comp in self.comps {
            if super::super::budget::tripped() { return false; }
            if centroid.on_surface(comp) { return true; }
        }
        false
    }

    /// Regime 2 on a coplanar parent: a shared interface without a coincident
    /// face uses the same side-occupancy table as `on_interface_keep`.
    fn interface_keep(&self, arr: &Arrangement, tri: [Vid; 3], c: [f64; 3],
        n_own: [f64; 3], op: BoolOp) -> Option<bool> {
        if !self.on_boundary(arr, tri) { return None; }
        let (op_plus, op_minus) = self.solid_side(c, n_own);
        if op_plus == op_minus {
            return None; // strictly in/out — the plain ray-cast decides
        }
        Some(match op {
            BoolOp::Union => !op_plus,
            BoolOp::Intersection => op_minus,
            BoolOp::Difference => !op_minus,
        })
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
/// verified at the exact centroid of the original interner points before
/// [`solid_side`] tests the two sides of the face (`op_plus != op_minus`).
/// That is exactly the degenerate
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
    centroid_normal: ([f64; 3], [f64; 3]),
    other: &[Tri],
    ext_other: f64,
    other_aabb: Aabb,
    op: BoolOp,
) -> Option<bool> {
    if !BoundaryCentroid::new(arr, tri).is_some_and(|c| c.on_surface(other)) {
        return None;
    }
    let (c, n) = centroid_normal;
    let (op_plus, op_minus) = solid_side(c, n, other, ext_other, other_aabb);
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
    boolean_vids_components(arr, a, &BComponents::new(&[b]), op).0
}

/// [`boolean_vids`] with the B operand as pairwise-disjoint closed components
/// (see [`BComponents`]). For a single component this is verdict-identical to
/// the historical binary classifier — the AABB gates are pure prefilters — so
/// the pinned boolean manifest is unperturbed.
///
/// Returns `(tris, changed)`. `changed == false` means no A sub-triangle was
/// dropped and no B sub-triangle kept: the result is operand A re-tessellated
/// along the arrangement, bounding the same solid.
pub(super) fn boolean_vids_components(
    arr: &Arrangement,
    a: &[Tri],
    bc: &BComponents,
    op: BoolOp,
) -> (Vec<[Vid; 3]>, bool) {
    use std::collections::HashSet;
    let ext_a = operand_extent(a);
    let a_closed = std::cell::OnceCell::new();
    let a_adjacency = std::cell::OnceCell::new();
    // One BVH over operand A, reused for every B-face inside/outside ray-cast AND
    // coincident/near-surface probe below (the dominant O(|tris_b|·|a|) scans on
    // boolean-heavy meshes). `a_band` (hoisted) feeds the near-surface band.
    let bvh_a = super::super::broadphase::Bvh::build(a);
    // Reuse the box the BVH build already computed, rather than rescanning `a` per
    // coplanar-parent B triangle. `unwrap_or` matters only for an empty `a`, where
    // the box is never read.
    let a_aabb = bvh_a.root_aabb().unwrap_or(([0.0; 3], [0.0; 3]));
    let mut scratch: Vec<u32> = Vec::new();
    let dedup = matches!(op, BoolOp::Union | BoolOp::Intersection);
    let mut a_kept: HashSet<[Vid; 3]> = HashSet::new();
    let mut out = Vec::new();
    for (i, &tri) in arr.tris_a.iter().enumerate() {
        if super::super::budget::tripped() { return (Vec::new(), true); }
        let own_pts = tri.map(|v| to_f64_pt(arr, v));
        let c = centroid_of_points(own_pts);
        let n_own = tri_normal(own_pts);
        let cop_parent = arr.coplanar_a.get(i).copied().unwrap_or(false);
        let keep;
        // regime 1: coincident shared face → classify by normal agreement. Tried
        // EXACT first, then the snap-band-flush analogue (`near_on_surface_normal`)
        // which catches a face left a few µm off a TILTED shared plane by per-axis
        // import snapping (the #1007 flush roof-opening cap). The near test is
        // ungated on the parent flag (like the exact one) because a coincident-
        // shared-face DROP/keep is unconditionally correct.
        //
        // Both tests LOCATE the candidate face from the CENTROID; whether the
        // sub-triangle actually LIES ON it is `coincident_planes` (#4439): its own
        // plane must be near-parallel to the face. Without that, a sub-triangle
        // that merely hugs the intersection LINE of two transversal faces — a
        // needle inside a thin notch (#4439), or one that retriangulation left
        // degenerate onto the line (#3353's `sweep_261`) — sat within the band of
        // the other operand's plane and was decided by the sign of a dot product
        // that a perpendicular or near-collinear pair does not pin down,
        // overriding a ray-cast that already had it right. The per-triangle
        // regime table and the measured parent-level fix shapes (all rejected
        // for regressing 20+ golden census hosts) are in
        // `issue_3353_vid_census_tests.rs`.
        let own_exact = tri.map(|v| arr.interner.get(v));
        if let Some(n_other) = bc.surface_normal(c, n_own, &own_pts, own_exact, &arr.bands) {
            let co_oriented = dot3(n_own, n_other) > 0.0;
            let use_volume = opposed_difference_uses_volume(op, n_own, n_other,
                matches!(op, BoolOp::Difference) && dot3(n_own, n_other) < 0.0 && bc.only_opposed(c, n_own, &own_pts, own_exact, &arr.bands)
                    && *a_closed.get_or_init(|| strict_closed(a)) && bc.all_closed(),
                || bc.on_boundary(arr, tri));
            if super::super::budget::tripped() { return (Vec::new(), true); }
            keep = if use_volume { !bc.inside(c) } else { match op {
                BoolOp::Union | BoolOp::Intersection => co_oriented,
                BoolOp::Difference => !co_oriented,
            }};
        } else if let Some(k) = cop_parent
            .then(|| bc.interface_keep(arr, tri, c, n_own, op)).flatten()
        {
            keep = k;
        } else {
            // regime 3: strictly off-plane → centroid ray-cast (original)
            if super::super::budget::tripped() { return (Vec::new(), true); }
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
    let a_kept_count = out.len();
    for (i, &tri) in arr.tris_b.iter().enumerate() {
        if super::super::budget::tripped() { return (Vec::new(), true); }
        // dedup a true co-oriented duplicate of a kept A face (keep the A-copy)
        if dedup && a_kept.contains(&rotate_min_first(tri)) {
            continue;
        }
        let own_pts = tri.map(|v| to_f64_pt(arr, v));
        let c = centroid_of_points(own_pts);
        let n_own = tri_normal(own_pts);
        let cop_parent = arr.coplanar_b.get(i).copied().unwrap_or(false);
        // A coincident-shared B face is dropped (the A-copy is the kept one). Tried
        // EXACT first, then the snap-band-flush analogue — ungated, because a B cap
        // fully CONTAINED in a larger host face has NO coplanar constraint of its
        // own (the host imposes none on it) so `coplanar_b` is unset for it, yet it
        // is still a coincident shared face that must drop (the #1007 flush roof cap
        // — without the near drop here it survives and bridges the opening).
        let own_exact = tri.map(|v| arr.interner.get(v));
        let use_volume = if let Some((n_other, only_opposed)) = surface_normal_near_a(
            c, n_own, &own_pts, own_exact, a, &bvh_a, &arr.bands[arr.component_b[i]], &mut scratch, &a_adjacency,
        ) {
            let use_volume = opposed_difference_uses_volume(op, n_own, n_other,
                only_opposed && matches!(op, BoolOp::Difference) && dot3(n_own, n_other) < 0.0
                    && *a_closed.get_or_init(|| strict_closed(a)) && bc.all_closed(), ||
                BoundaryCentroid::new(arr, tri).is_some_and(|centroid| centroid.on_surface(a)));
            if super::super::budget::tripped() { return (Vec::new(), true); }
            if !use_volume {
                continue; // actual shared B-copy: the A-copy owns this boundary
            }
            true
        } else { false };
        if cop_parent && !use_volume {
            if let Some(keep) = on_interface_keep(arr, tri, (c, n_own), a, ext_a, a_aabb, op) {
                // regime 2 for B (coplanar-overlap parent only).
                if keep {
                    let flip = matches!(op, BoolOp::Difference);
                    out.push(if flip { [tri[0], tri[2], tri[1]] } else { tri });
                }
                continue;
            }
        }
        if super::super::budget::tripped() { return (Vec::new(), true); }
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
    let changed = a_kept_count != arr.tris_a.len() || out.len() != a_kept_count;
    (out, changed)
}

#[inline]
pub(super) fn rotate_min_first(t: [Vid; 3]) -> [Vid; 3] {
    let i = (0..3).min_by_key(|&k| t[k]).unwrap();
    [t[i], t[(i + 1) % 3], t[(i + 2) % 3]]
}

#[cfg(test)]
#[path = "classify_tests.rs"]
mod classify_tests;

#[cfg(test)]
#[path = "issue_3353_vid_census_tests.rs"]
mod issue_3353_vid_census_tests;
