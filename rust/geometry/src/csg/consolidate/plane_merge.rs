// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #3914: stitch a `consolidate_coplanar` plane-bucket split back
//! together using the kernel's own f64 plane, carried forward as
//! [`crate::mesh::PlaneTag`] by `kernel::mesh_bridge::tris_to_mesh` (the
//! kernel boolean's sole `Mesh` producer).
//!
//! Mechanism: `consolidate_coplanar`'s plane-bucketing step normally keys
//! each triangle by a plane RE-DERIVED from its f32-rounded vertices, which
//! can straddle the `POS_QUANT` rounding boundary for a rotated/tilted face
//! and split one physical plane into two adjacent buckets, each
//! re-triangulated independently — a tear the cross-bucket seam-conform pass
//! (`csg/consolidate/conform.rs`, tangential-only) cannot stitch back
//! together. [`tag_for`] validates each triangle's kernel tag (a
//! supporting-plane check); [`merge_rounding_split_buckets`] then folds
//! together exactly the adjacent-bucket-pair case those tags identify as one
//! kernel plane, leaving every other bucket (the overwhelming majority)
//! untouched.
//!
//! This is deliberately NARROWER than re-deriving every bucket's key from
//! the tag: an earlier, broader attempt (measured, not assumed) regressed
//! two real-model hosts in `triangulation_invariance`
//! (`issue_129_mixed_bool2d_residual_preserves_established_topology`,
//! `issue_4627_candidate_failures_preserve_prior_analytic_cuts`) — real
//! models carry legitimately distinct near-coplanar faces (the same kind the
//! #3913 near-coplanar sweep's `SNAP_GRID` controls exist to keep split),
//! and a blanket re-key cannot reliably tell that apart from a genuine
//! rounding split.

use crate::mesh::PlaneTag;
use nalgebra::{Point3, Vector3};
use std::collections::{BTreeMap, HashSet};

/// A triangle inside one of `consolidate_coplanar`'s plane buckets.
pub(super) struct PlaneTri {
    pub v: [Point3<f64>; 3],
    pub normal: Vector3<f64>,
    /// This triangle's kernel-f64 plane (`n`, `d`), when the mesh carries
    /// `plane_tags` AND this specific tag is a supporting plane of this
    /// specific triangle within tolerance (see [`tag_for`]). `None` for an
    /// untagged mesh (weld/merge/transform since — every one of which
    /// clears `plane_tags` — or a synthetic/test mesh) or a tag that fails
    /// that per-triangle check, in which case this triangle behaves exactly
    /// as before the #3914 fix.
    pub tag: Option<(Vector3<f64>, f64)>,
}

/// A tag is trusted for ITS triangle only when it is a supporting plane of
/// that triangle to within a tolerance close to the kernel's own measured
/// f32-cast noise (#3914 thread: legitimate splits measured ~5e-7 between
/// the f32-rederived offset and the kernel's f64 one) — tight enough that a
/// triangle whose cross-product normal is itself unstable (a near-degenerate
/// sliver) fails the check and is treated as untagged, rather than trusting
/// a coincidentally-close tag.
///
/// SCALE-RELATIVE, not a fixed absolute (bot review, #3914): a fixed `1e-6`
/// is the right order of magnitude for the pinned metre-scale fixture
/// (coordinates ~O(1)), but `consolidate` also runs on file-unit operands
/// scaled by `length_unit_scale` — a millimetre building at ordinary
/// coordinates (~O(1e3)-O(1e4)) casts through f32 with proportionally larger
/// absolute noise, so a fixed `1e-6` would reject every tag there and
/// silently fall back to today's behaviour on every such file, never firing
/// the fix. `TAG_REL_EPS` is a few-ULP relative margin on the triangle's own
/// coordinate magnitude (uncapped: this gate only decides "trust this tag
/// for ITS OWN triangle", not the cross-bucket merge discriminator in
/// [`merge_rounding_split_buckets`], where looseness is bounded separately).
pub(super) fn tag_for(
    plane_tags: Option<&[PlaneTag]>,
    triangle_count: usize,
    tri_idx: usize,
    v: &[Point3<f64>; 3],
) -> Option<(Vector3<f64>, f64)> {
    const TAG_REL_EPS: f64 = 8.0 * f32::EPSILON as f64;
    const TAG_TOL_FLOOR: f64 = 1.0e-9;
    let tags = plane_tags?;
    if tags.len() != triangle_count {
        return None;
    }
    let tag = &tags[tri_idx];
    let n = Vector3::new(tag.n[0], tag.n[1], tag.n[2]);
    let scale = v
        .iter()
        .fold(1.0_f64, |m, p| m.max(p.x.abs()).max(p.y.abs()).max(p.z.abs()));
    let tol = (scale * TAG_REL_EPS).max(TAG_TOL_FLOOR);
    let supports = v.iter().all(|p| (n.dot(&p.coords) - tag.d).abs() < tol);
    supports.then_some((n, tag.d))
}

fn bucket_scale(a: &[PlaneTri], b: &[PlaneTri]) -> f64 {
    [a.first(), b.first()]
        .into_iter()
        .flatten()
        .flat_map(|t| t.v)
        .fold(1.0_f64, |m, p| m.max(p.x.abs()).max(p.y.abs()).max(p.z.abs()))
}

fn tag_consensus(tris: &[PlaneTri], tol: f64) -> Option<(Vector3<f64>, f64)> {
    let (n0, d0) = tris.first()?.tag?;
    tris.iter()
        .all(|t| t.tag.is_some_and(|(n, d)| (n - n0).norm() < tol && (d - d0).abs() < tol))
        .then_some((n0, d0))
}

/// Merge PAIRS of `consolidate_coplanar` plane buckets that are exactly the
/// #3914 mechanism — one physical plane split by `POS_QUANT` rounding into
/// two ADJACENT buckets sharing a quantized normal — in place, and return
/// the set of surviving bucket keys that absorbed a neighbour (Phase A uses
/// this to know when `tris[0]`'s own recomputed normal is one specific
/// member's noise rather than the shared plane, and to use the tag's
/// normal instead).
///
/// Adjacency in `qpos` (offset differing by exactly one `POS_QUANT` cell) is
/// the geometric signature of a rounding-boundary straddle, and is only the
/// CANDIDATE-PAIR filter (cheap, and it is what limits this pass to
/// neighbours instead of the whole bucket set). The actual #3914-thread
/// discriminator is numeric, not the same coarse `POS_QUANT`/`NORMAL_QUANT`
/// grid the geometric key already uses (that grid is exactly what let the
/// two triangles land in different buckets in the first place, so
/// re-quantizing the tag the same way cannot reliably tell "one plane,
/// rounding-split" apart from "two distinct planes that happen to be
/// adjacent"): every triangle on both sides must carry a validated tag, and
/// those RAW (un-quantized) tags must agree with each other to a tolerance
/// tight against the #3914 thread's measured true-positive margin (kernel
/// planes agreeing to ~1e-10) and well below the #3913 near-coplanar
/// sweep's deliberately distinct `SNAP_GRID` (1/65536 ≈ 1.5e-5) separation,
/// which must NOT merge (that sweep regressed 0 -> 2/882 under
/// quantized-key agreement before this was tightened to raw values).
///
/// SCALE-RELATIVE WITH A HARD CAP (bot review, #3914): like `tag_for`'s
/// tolerance, a fixed absolute value is the wrong order of magnitude on
/// file-unit operands at large coordinates — but UNLIKE `tag_for`, this
/// tolerance is the actual "same plane or not" discriminator, so it cannot
/// simply grow with scale: `SNAP_GRID` is an ABSOLUTE grid in caller-unit
/// space (applied to raw coordinates regardless of magnitude,
/// `mesh_bridge::snap`), so the safety margin against it does not grow with
/// scale either. Capping at `SNAP_GRID / 128` keeps two full orders of
/// magnitude of margin at every scale: below the cap this scales with the
/// triangles' own coordinate magnitude (covers large file-unit models); at
/// or above it, the tolerance saturates and a bucket pair whose f32-cast
/// noise has grown that large simply stops qualifying for the merge —
/// falling back to today's behaviour (never worse), the same structural
/// limit `POS_QUANT` itself is already subject to at extreme coordinate
/// magnitude.
///
/// ADJACENCY-WINDOW SOUNDNESS BOUND: the candidate scan below only ever
/// compares `qpos`-adjacent buckets. That is sound only while a
/// genuinely-split plane's own f32-rederived offset noise, which GROWS with
/// the triangles' coordinate magnitude, stays under one cell; past it, the
/// plane's two rounding-split fragments can land more than one cell apart
/// and this pass would silently miss them (never wrongly merge —
/// `tag_consensus` still gates on the precise tag values — just fail to
/// find the candidate pair at all). `mesh_bridge::SNAP_GRID`'s own doc
/// records the same crossover under a different name: "past |c| = 128
/// CALLER UNITS the f32 spacing is itself a multiple of the grid" — i.e.
/// exactly where this scheme's one-cell adjacency assumption stops holding.
/// Reusing that documented threshold rather than inventing a new one: above
/// it, skip the merge pass entirely (measured: attempting it anyway at
/// 1000x the pinned fixture's scale, in a 3000-case rotated/overlapping
/// sweep, both left 2 pre-existing large-coordinate tears unfixed AND
/// introduced 2 new ones the un-merged output did not have — this guard
/// restores the pre-#3914 large-coordinate behaviour exactly, the same
/// "never worse" contract as an absent `plane_tags`). A full multi-cell
/// scale-aware search is out of scope for this contained fix; flagging
/// rather than attempting it.
pub(super) fn merge_rounding_split_buckets(
    buckets: &mut BTreeMap<(i64, i64, i64, i64), Vec<PlaneTri>>,
) -> HashSet<(i64, i64, i64, i64)> {
    const TAG_MERGE_REL_EPS: f64 = 8.0 * f32::EPSILON as f64;
    const TAG_MERGE_TOL_FLOOR: f64 = 1.0e-9;
    const MERGE_SAFE_MAGNITUDE: f64 = 128.0;
    let tag_merge_tol_cap = crate::kernel::mesh_bridge::SNAP_GRID / 128.0;

    let mut merged_bucket_keys: HashSet<(i64, i64, i64, i64)> = HashSet::new();
    let candidate_keys: Vec<(i64, i64, i64, i64)> = buckets.keys().copied().collect();
    let mut absorbed: HashSet<(i64, i64, i64, i64)> = HashSet::new();
    for key in candidate_keys {
        if absorbed.contains(&key) {
            continue;
        }
        let (nx, ny, nz, pz) = key;
        for other in [(nx, ny, nz, pz - 1), (nx, ny, nz, pz + 1)] {
            if key >= other || absorbed.contains(&other) {
                continue;
            }
            let Some(a) = buckets.get(&key) else { continue };
            let Some(b) = buckets.get(&other) else { continue };
            let scale = bucket_scale(a, b);
            let tol = (scale * TAG_MERGE_REL_EPS).clamp(TAG_MERGE_TOL_FLOOR, tag_merge_tol_cap);
            let same_kernel_plane = scale < MERGE_SAFE_MAGNITUDE
                && match (tag_consensus(a, tol), tag_consensus(b, tol)) {
                    (Some((na, da)), Some((nb, db))) => {
                        (na - nb).norm() < tol && (da - db).abs() < tol
                    }
                    _ => false,
                };
            if same_kernel_plane {
                // SAFETY: `other` was confirmed present above; remove it and
                // fold its triangles into `key`'s bucket.
                let mut merged = buckets.remove(&other).unwrap();
                buckets.get_mut(&key).unwrap().append(&mut merged);
                absorbed.insert(other);
                merged_bucket_keys.insert(key);
            }
        }
    }
    merged_bucket_keys
}
