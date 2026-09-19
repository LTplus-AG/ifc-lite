// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #3353: booleans still tear on overlapping/rotated operands after
//! the #3341 parity fix.
//!
//! #3341 fixed one specific defect in `point_inside`'s parity ray-cast. A
//! separate, unrelated family of tears survives it: a 60000-pair random
//! sweep across Difference/Union/Intersection found 96 pairs (concentrated
//! in overlapping and rotated configurations) where the boolean output is
//! still non-manifold, and 37 of 38 drilled-into cases showed the
//! classification verdict was UNCHANGED by the #3341 fix — the tear was
//! already there, upstream or independent of it.
//!
//! ## Superseded root cause (issue #3914)
//!
//! The title/root-cause framing above (`classify.rs`'s two coincident-face
//! detectors, `c_on_or_near_a` vs `BComponents::surface_normal`, disagreeing)
//! was the ORIGINAL hypothesis when this test was pinned. Issue #3914 traced
//! this specific fixture down and found the two detectors agree completely
//! on it (measured, not assumed) — the mechanism is unrelated, and lives one
//! stage later, entirely inside `consolidate_coplanar`.
//!
//! The real mechanism: `rust/geometry/src/csg/consolidate.rs`'s
//! `consolidate_coplanar` buckets the kernel's watertight output by a plane
//! key it RE-DERIVES from each triangle's f32-rounded vertices. On this
//! fixture's rotated tilted face, two operand-B parent triangles (whose true
//! kernel planes agree to 1e-10) land in the same physical plane but their
//! re-derived offsets straddle the bucket's `POS_QUANT = 1e6` rounding
//! boundary, splitting one plane into two adjacent buckets. Each bucket is
//! re-triangulated independently, and the cross-bucket seam-conform pass in
//! `csg/consolidate/conform.rs` is tangential-only — it reconciles
//! disagreement WITHIN a shared plane and cannot represent the resulting
//! normal-direction offset BETWEEN the two buckets, so the seam tears.
//!
//! The fix (issue #3914): `kernel::mesh_bridge::tris_to_mesh`, the kernel
//! boolean's sole `Mesh` producer, now tags every output triangle with its
//! f64 supporting plane (`Mesh::plane_tags`) computed BEFORE the f32 cast.
//! `consolidate_coplanar` buckets by that kernel-precise plane when the tags
//! validate (present, one per triangle, each a supporting plane of its own
//! triangle), so the two parent triangles land in the SAME bucket instead of
//! straddling the rounding boundary — no clustering, no new tolerance, no
//! kernel change. A mesh without tags (anything that went through a
//! weld/merge/transform since, or a synthetic/test mesh) is byte-identical to
//! before.
//!
//! This test is left un-ignored specifically because it is now pinning a
//! FIXED invariant, verified against the full `triangulation_invariance`
//! census and the #3913 sweep (see the issue thread and this PR's evidence).
//!
//! ## Not fixed by the #3353 near-coplanar weld, and why
//!
//! `issue_3353_near_coplanar_rotated_overlap.rs` fixed a DIFFERENT half of
//! #3353: two operand faces landing a few `SNAP_GRID` steps apart because
//! `mesh_bridge` snaps per axis, which `union_with_conformity` now reconciles
//! by welding the operands onto shared planes before the arrangement. That
//! closed a 9464-union sweep of the rotated corner-overlap family.
//!
//! This case was untouched by it before the #3914 fix above — measured, not
//! assumed: it failed identically with the weld in place. Its operands are
//! not a near-coplanar pair, so the weld has nothing to move; the mechanism
//! is the `consolidate_coplanar` plane-bucket split described above, unrelated
//! to the pre-arrangement snap. Do not read the near-coplanar fix as having
//! addressed this, and do not re-open the near-coplanar work when attacking
//! a similar-looking failure.
//!
//! The case below was found by a local seeded sweep of rotated/overlapping
//! box pairs through `ClippingProcessor::union_mesh` (seed 6 of a
//! splitmix64-seeded run), independent of and smaller than the original
//! 60000-pair sweep in the issue, but reproducing the same symptom: a
//! closed-in, non-watertight-out Union.

use ifc_lite_geometry::{ClippingProcessor, Mesh, Point3, Vector3};
use std::collections::HashMap;

/// Outward-wound axis-aligned box.
fn boxed(min: [f64; 3], size: [f64; 3]) -> Mesh {
    let mx = [min[0] + size[0], min[1] + size[1], min[2] + size[2]];
    let c = |i: usize| -> [f64; 2] { [min[i], mx[i]] };
    let corners: Vec<Point3<f64>> = [
        (0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0),
        (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1),
    ]
    .iter()
    .map(|&(i, j, k)| Point3::new(c(0)[i], c(1)[j], c(2)[k]))
    .collect();
    let faces: [[usize; 4]; 6] = [
        [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
        [2, 3, 7, 6], [0, 4, 7, 3], [1, 2, 6, 5],
    ];
    let mut m = Mesh::with_capacity(24, 36);
    for f in &faces {
        let e1 = corners[f[1]] - corners[f[0]];
        let e2 = corners[f[2]] - corners[f[0]];
        let n = e1.cross(&e2).try_normalize(1e-12).unwrap_or(Vector3::z());
        let b = m.vertex_count() as u32;
        for &i in f {
            m.add_vertex(corners[i], n);
        }
        m.add_triangle(b, b + 1, b + 2);
        m.add_triangle(b, b + 2, b + 3);
    }
    m
}

/// The same box, rigidly rotated about Z by `theta` radians.
fn rotated_boxed(min: [f64; 3], size: [f64; 3], theta: f64) -> Mesh {
    let mut m = boxed(min, size);
    let (s, c) = theta.sin_cos();
    for p in m.positions.chunks_exact_mut(3) {
        let (x, y) = (p[0] as f64, p[1] as f64);
        p[0] = (c * x - s * y) as f32;
        p[1] = (s * x + c * y) as f32;
    }
    m
}

/// Directed-edge manifold check after welding by position: every undirected
/// edge must be used exactly once forward and once reverse. A signed-only
/// tally would let a non-manifold edge (e.g. 2 forward + 1 reverse) hide
/// behind a duplicated one that cancels; counting both directions rejects it.
fn open_edges(m: &Mesh) -> Result<usize, String> {
    if m.is_empty() {
        return Err("boolean output was empty".to_string());
    }
    let welded = m.welded_by_position(1e-6);
    let mut edges: HashMap<(u32, u32), (u32, u32)> = HashMap::new();
    for tri in welded.indices.chunks_exact(3) {
        for k in 0..3 {
            let (a, b) = (tri[k], tri[(k + 1) % 3]);
            if a == b {
                return Err(format!("degenerate edge: triangle repeats welded vertex {a}"));
            }
            let e = edges.entry((a.min(b), a.max(b))).or_insert((0, 0));
            if a < b {
                e.0 += 1;
            } else {
                e.1 += 1;
            }
        }
    }
    Ok(edges.values().filter(|&&(f, r)| f != 1 || r != 1).count())
}

/// Pins #3353/#3914: two closed, overlapping, rotated boxes in; a manifold
/// shell out. Was `#[ignore]`d as a known open defect until #3914 traced and
/// fixed the actual mechanism — a `consolidate_coplanar` plane-bucket split,
/// not the `classify.rs` detector disagreement originally suspected (see the
/// module doc's "Superseded root cause" section). The #3353 near-coplanar
/// weld does NOT reach it; see the module doc.
#[test]
fn a_rotated_overlapping_union_stays_manifold() {
    let clipper = ClippingProcessor::new();

    let a_min = [-1.064427873716452, -1.5758991032070164, -2.335934512221897];
    let a_size = [1.7582981472721038, 3.7437572581011054, 2.5580013636220693];
    let b_min = [-0.468184233137136, -1.8002926870781526, -1.0101295786317475];
    let b_size = [1.9952974802528327, 3.404965797097641, 3.2964264954246745];
    let theta = 1.3158416849982029;

    let a = boxed(a_min, a_size);
    let b = rotated_boxed(b_min, b_size, theta);

    let out = clipper.union_mesh(&a, &b).expect("union must not error");

    match open_edges(&out) {
        Ok(0) => {}
        Ok(bad) => panic!(
            "union of two closed operands came back non-manifold: \
             {bad} unmatched directed edges (see issue #3353)"
        ),
        Err(why) => panic!("union of two closed operands came back invalid: {why}"),
    }
}

/// Regression pin for the #3914 fix's large-coordinate safety guard
/// (`plane_merge::merge_rounding_split_buckets`'s `MERGE_SAFE_MAGNITUDE`).
///
/// Found by a local seeded sweep of rotated/overlapping box pairs at 1000x
/// the pinned fixture's coordinate magnitude (~O(1e3), a millimetre-scale
/// building's raw coordinates) — independent of, and a different mechanism
/// from, the metre-scale pin above. Measured, not assumed: an EARLIER
/// version of the #3914 fix that scaled its merge tolerance with coordinate
/// magnitude but did not bound the `qpos`-adjacency candidate window left 2
/// pre-existing large-coordinate tears in a 3000-case sweep unfixed AND
/// introduced 2 NEW ones — including this one — that the un-merged output
/// did not have. The reason: the candidate window only ever compares
/// buckets one `POS_QUANT` cell apart, which stops being a sound net past
/// the coordinate magnitude where f32-rederived plane noise itself exceeds
/// one cell (documented independently on `mesh_bridge::SNAP_GRID`: "past
/// |c| = 128 CALLER UNITS the f32 spacing is itself a multiple of the
/// grid"); a false-negative merge attempt at that scale can still perturb
/// the bucket the candidate scan happened to touch. The fix's merge pass
/// now skips entirely above that magnitude, restoring the pre-#3914 output
/// exactly (never worse) rather than attempting a merge the one-cell window
/// cannot make sound.
#[test]
fn a_large_coordinate_overlapping_union_is_not_newly_torn_by_the_merge_pass() {
    let clipper = ClippingProcessor::new();
    let a_min = [-1228.9475065504578, -1417.1822059816695, -2306.0253514211972];
    let a_size = [1213.2463132281496, 3009.857479989996, 2270.47703987189];
    let b_min = [-133.30604159842997, -1269.0140481667731, -1265.70224188568];
    let b_size = [2049.810034945035, 3685.739373643453, 3494.266378783676];
    let theta = 1.4195649704200568;

    let a = boxed(a_min, a_size);
    let b = rotated_boxed(b_min, b_size, theta);
    let out = clipper.union_mesh(&a, &b).expect("union must not error");

    match open_edges(&out) {
        Ok(0) => {}
        Ok(bad) => panic!(
            "the merge-safety guard regressed: union came back non-manifold \
             at large coordinate magnitude ({bad} unmatched directed edges), \
             which the un-merged (pre-#3914) output did not"
        ),
        Err(why) => panic!("union of two closed operands came back invalid: {why}"),
    }
}
