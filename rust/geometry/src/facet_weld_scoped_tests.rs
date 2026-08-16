/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Properties of the REGION-SCOPED sliver refinement used by the prism void
//! fast path (`refine_high_aspect_slivers_within`).
//!
//! The scoped path differs from the unscoped one in ways that are easy to get
//! silently wrong and that fixture tests would not localise: it splits MANY
//! edges per round instead of one, it skips triangles outside the cut region,
//! and it has two independent guards against a degenerate needle that
//! bisection cannot improve. Each test below pins one of those behaviours as a
//! stated invariant rather than an output snapshot.

use super::*;

/// Directed-edge closure, canonicalised BY POSITION — every directed edge
/// appears exactly once and its reverse exists exactly once. This is the same
/// watertightness notion the void path audits with `directed_closed`, and it is
/// what the batched (many-edges-per-round) split has to preserve.
///
/// Position-canonical, NOT index-canonical: this refinement rebuilds its output
/// with per-triangle (unshared) vertices — the repo keeps meshes unwelded so
/// flat shading survives (#846) — so pairing raw index ids would report every
/// edge as unpaired for both the scoped and the unscoped pass alike.
fn directed_closed_mesh(mesh: &Mesh) -> bool {
    let key = |i: u32| -> (i64, i64, i64) {
        let i = i as usize;
        let q = |c: f32| (c as f64 / 1.0e-6).round() as i64;
        (
            q(mesh.positions[i * 3]),
            q(mesh.positions[i * 3 + 1]),
            q(mesh.positions[i * 3 + 2]),
        )
    };
    type K = (i64, i64, i64);
    let mut seen: std::collections::BTreeMap<(K, K), i32> = std::collections::BTreeMap::new();
    for t in mesh.indices.chunks_exact(3) {
        for k in 0..3 {
            let a = key(t[k]);
            let b = key(t[(k + 1) % 3]);
            if a == b {
                continue; // zero-length edge of a degenerate tri — not a seam
            }
            *seen.entry((a, b)).or_insert(0) += 1;
        }
    }
    seen.iter()
        .all(|(&(a, b), &n)| n == 1 && seen.get(&(b, a)).copied().unwrap_or(0) == 1)
}

fn signed_volume(mesh: &Mesh) -> f64 {
    let p = |i: u32| -> [f64; 3] {
        let i = i as usize;
        [
            mesh.positions[i * 3] as f64,
            mesh.positions[i * 3 + 1] as f64,
            mesh.positions[i * 3 + 2] as f64,
        ]
    };
    let mut v = 0.0;
    for t in mesh.indices.chunks_exact(3) {
        let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
        v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0]))
            / 6.0;
    }
    v
}

/// A closed 1×1 bar subdivided into `strips` segments of `seg_len` metres each.
/// With `seg_len` >> 1 every side triangle is a long thin sliver (aspect ≈
/// `seg_len`), which is the shape this refinement exists to bisect. Aspect is
/// the longest/shortest EDGE ratio, so `seg_len = 100` gives ≈100 — well over
/// the `SLIVER_ASPECT` threshold of 8.
fn slivered_box(strips: usize, seg_len: f32) -> Mesh {
    let len = seg_len * strips as f32;
    let mut positions: Vec<f32> = Vec::new();
    let mut indices: Vec<u32> = Vec::new();
    // Two rows of vertices along x at y=0 and y=1, at z=0 and z=1.
    let push = |positions: &mut Vec<f32>, x: f32, y: f32, z: f32| -> u32 {
        positions.extend_from_slice(&[x, y, z]);
        (positions.len() / 3 - 1) as u32
    };
    let mut grid = vec![[0u32; 4]; strips + 1];
    for i in 0..=strips {
        let x = len * (i as f32) / (strips as f32);
        grid[i] = [
            push(&mut positions, x, 0.0, 0.0),
            push(&mut positions, x, 1.0, 0.0),
            push(&mut positions, x, 1.0, 1.0),
            push(&mut positions, x, 0.0, 1.0),
        ];
    }
    // Side quads between consecutive stations (4 faces around). The
    // cross-section loop is CCW seen from +x, so [a_k, a_k2, b_k2] / [a_k,
    // b_k2, b_k] gives an OUTWARD normal (verified: the z=0 face comes out -z).
    for i in 0..strips {
        let a = grid[i];
        let b = grid[i + 1];
        for k in 0..4 {
            let k2 = (k + 1) % 4;
            indices.extend_from_slice(&[a[k], a[k2], b[k2]]);
            indices.extend_from_slice(&[a[k], b[k2], b[k]]);
        }
    }
    // End caps (winding outward at each end).
    let s = grid[0];
    indices.extend_from_slice(&[s[0], s[2], s[1], s[0], s[3], s[2]]);
    let e = grid[strips];
    indices.extend_from_slice(&[e[0], e[1], e[2], e[0], e[2], e[3]]);
    Mesh {
        positions,
        indices,
        ..Default::default()
    }
}

fn whole_mesh_box(mesh: &Mesh) -> ([f64; 3], [f64; 3]) {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for p in mesh.positions.chunks_exact(3) {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k] as f64);
            hi[k] = hi[k].max(p[k] as f64);
        }
    }
    (lo, hi)
}

#[test]
fn scoped_batched_refinement_stays_closed_and_volume_exact() {
    let mesh = slivered_box(200, 100.0);
    assert!(directed_closed_mesh(&mesh), "fixture must start closed");
    let v0 = signed_volume(&mesh);
    let region = vec![whole_mesh_box(&mesh)];
    let out = refine_high_aspect_slivers_within(&mesh, &region);
    assert!(
        out.indices.len() > mesh.indices.len(),
        "the fixture is all high-aspect — refinement must fire"
    );
    // Batching splits many edges per round; both triangles incident to a split
    // edge must take the SAME snapped midpoint or the mesh unzips here.
    assert!(
        directed_closed_mesh(&out),
        "batched scoped refinement broke directed-edge closure"
    );
    // Midpoints sit ON the original straight edge ⇒ volume is preserved.
    let v1 = signed_volume(&out);
    assert!(
        (v1 - v0).abs() < 1e-6 * v0.abs().max(1.0),
        "volume drifted: {v0} -> {v1}"
    );
}

/// The point of scoping: geometry away from the cut is not refined. Compared
/// against the SAME batched algorithm run over the whole mesh — comparing to
/// the unscoped entry point would be meaningless, since that one splits a
/// single edge per round and is bounded by MAX_BISECT_ROUNDS regardless.
#[test]
fn scoped_refinement_does_less_work_than_whole_mesh_region() {
    let mesh = slivered_box(60, 100.0);
    let (lo, hi) = whole_mesh_box(&mesh);
    // A region covering only the first tenth of the bar's length.
    let narrow = vec![(lo, [lo[0] + 0.1 * (hi[0] - lo[0]), hi[1], hi[2]])];
    let whole = vec![(lo, hi)];
    let scoped = refine_high_aspect_slivers_within(&mesh, &narrow);
    let full = refine_high_aspect_slivers_within(&mesh, &whole);
    assert!(
        scoped.indices.len() < full.indices.len(),
        "narrow region must refine strictly less than the whole-mesh region \
         (narrow {}, whole {})",
        scoped.indices.len(),
        full.indices.len()
    );
    assert!(
        scoped.indices.len() > mesh.indices.len(),
        "…but it must still refine the in-region slivers"
    );
    assert!(directed_closed_mesh(&scoped));
}

#[test]
fn empty_region_is_a_no_op() {
    let mesh = slivered_box(20, 100.0);
    let out = refine_high_aspect_slivers_within(&mesh, &[]);
    assert_eq!(out.indices, mesh.indices, "no boxes ⇒ nothing to refine");
    assert_eq!(out.positions, mesh.positions);
}

#[test]
fn scoped_refinement_is_deterministic() {
    let mesh = slivered_box(120, 100.0);
    let region = vec![whole_mesh_box(&mesh)];
    let a = refine_high_aspect_slivers_within(&mesh, &region);
    let b = refine_high_aspect_slivers_within(&mesh, &region);
    assert_eq!(a.indices, b.indices, "index stream must be reproducible");
    assert_eq!(a.positions, b.positions, "positions must be reproducible");
}

/// A zero-length edge gives `aspect` = INFINITY; bisecting it never lowers the
/// aspect, so an unguarded batched fixpoint re-qualifies it every round and
/// doubles its fragments. The finite-aspect guard must make it a non-candidate,
/// and the run must terminate with a closed mesh (this hung ISSUE_129 during
/// development).
#[test]
fn degenerate_needle_terminates_without_exploding() {
    let mut mesh = slivered_box(40, 100.0);
    // Collapse one vertex onto another to manufacture a zero-length edge.
    let n = mesh.positions.len() / 3;
    assert!(n > 8);
    for k in 0..3 {
        mesh.positions[3 * 4 + k] = mesh.positions[k];
    }
    let region = vec![whole_mesh_box(&mesh)];
    let before = mesh.indices.len();
    let out = refine_high_aspect_slivers_within(&mesh, &region);
    // Bounded by the scoped split budget (2048 splits ⇒ ≤2 new tris each), not
    // by an exponential cascade.
    assert!(
        out.indices.len() <= before + 2 * 2048 * 3,
        "scoped split budget did not bind: {} -> {}",
        before,
        out.indices.len()
    );
}

#[cfg(test)]
mod offset_anchor_tests {
    use super::*;

    fn mesh_from_tris(tris: &[[[f64; 3]; 3]]) -> Mesh {
        let mut m = Mesh::new();
        for t in tris {
            let base = (m.positions.len() / 3) as u32;
            for p in t {
                m.positions
                    .extend_from_slice(&[p[0] as f32, p[1] as f32, p[2] as f32]);
                m.normals.extend_from_slice(&[0.0, 0.0, 1.0]);
            }
            m.indices.extend_from_slice(&[base, base + 1, base + 2]);
        }
        m
    }

    fn vert(m: &Mesh, i: usize) -> [f64; 3] {
        [
            m.positions[i * 3] as f64,
            m.positions[i * 3 + 1] as f64,
            m.positions[i * 3 + 2] as f64,
        ]
    }

    /// Round `p` through the SAME f32 storage a real `Mesh` applies, so a raw
    /// gap computed from it reflects genuine per-vertex re-quantization
    /// rather than the exact f64 the test wrote down.
    fn vert_f32(p: [f64; 3]) -> [f64; 3] {
        [p[0] as f32 as f64, p[1] as f32 as f64, p[2] as f32 as f64]
    }

    /// Distinct 1 µm-offset planes within one quantised-normal group — this is
    /// exactly what `consolidate_coplanar` buckets on.
    fn distinct_offset_buckets(m: &Mesh) -> usize {
        use std::collections::BTreeSet;
        let mut set: BTreeSet<i64> = BTreeSet::new();
        for c in m.indices.chunks_exact(3) {
            let a = vert(m, c[0] as usize);
            let b = vert(m, c[1] as usize);
            let d = vert(m, c[2] as usize);
            if let Some((n, _)) = super::tri_normal(a, b, d) {
                let s = if n[0] + n[1] + n[2] < 0.0 { -1.0 } else { 1.0 };
                let off = (n[0] * a[0] + n[1] * a[1] + n[2] * a[2]) * s;
                set.insert((off * 1.0e6).round() as i64);
            }
        }
        set.len()
    }

    /// Same as [`distinct_offset_buckets`] but anchored at the mesh's vertex
    /// centroid, not the raw vertex — `distinct_offset_buckets` itself
    /// inherits the amplification bug at site-scale coordinates (`f32` ULP at
    /// ~8.7 km is ~1 mm, a hundred times coarser than the 1 µm bucket grid,
    /// so an already-coplanar mesh reads back as multiple raw-frame buckets
    /// from storage quantization alone). This is the fair check for whether
    /// the weld's OWN clustering worked.
    fn distinct_offset_buckets_anchored(m: &Mesh) -> usize {
        use std::collections::BTreeSet;
        let vertex_count = m.positions.len() / 3;
        if vertex_count == 0 {
            return 0;
        }
        // Centroid, not a single facet's own corner (which would trivially
        // zero the offset for any facet containing it).
        let mut anchor = [0.0f64, 0.0, 0.0];
        for i in 0..vertex_count {
            let p = vert(m, i);
            anchor[0] += p[0];
            anchor[1] += p[1];
            anchor[2] += p[2];
        }
        let inv = 1.0 / vertex_count as f64;
        anchor = [anchor[0] * inv, anchor[1] * inv, anchor[2] * inv];
        let mut set: BTreeSet<i64> = BTreeSet::new();
        for c in m.indices.chunks_exact(3) {
            let sub = |p: [f64; 3]| [p[0] - anchor[0], p[1] - anchor[1], p[2] - anchor[2]];
            let a = sub(vert(m, c[0] as usize));
            let b = sub(vert(m, c[1] as usize));
            let d = sub(vert(m, c[2] as usize));
            if let Some((n, _)) = super::tri_normal(a, b, d) {
                let s = if n[0] + n[1] + n[2] < 0.0 { -1.0 } else { 1.0 };
                let off = (n[0] * a[0] + n[1] * a[1] + n[2] * a[2]) * s;
                set.insert((off * 1.0e6).round() as i64);
            }
        }
        set.len()
    }

    /// Two coplanar facets whose plane offset jitters by ~15 µm (the #1112
    /// signature) MUST weld to ONE offset bucket; two facets 0.4 m apart MUST
    /// NOT merge.
    #[test]
    fn welds_offset_jitter_not_distinct_plane() {
        // A flat z=0 slab split into 2 triangles, the second lifted 15 µm in z
        // (a pure offset jitter — same normal).
        let j = 15.0e-6;
        let jitter = mesh_from_tris(&[
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            [[1.0, 0.0, j], [1.0, 1.0, j], [0.0, 1.0, j]],
        ]);
        assert_eq!(
            distinct_offset_buckets(&jitter),
            2,
            "pre-weld the two facets must sit on distinct 1µm offset buckets"
        );
        let welded = weld_near_coplanar_facets(&jitter);
        assert_eq!(
            distinct_offset_buckets(&welded),
            1,
            "15µm offset jitter must weld to ONE offset bucket"
        );

        // Same normal but 0.4 m apart — a genuinely distinct parallel plane.
        let distinct = mesh_from_tris(&[
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            [[1.0, 0.0, 0.4], [1.0, 1.0, 0.4], [0.0, 1.0, 0.4]],
        ]);
        let welded_d = weld_near_coplanar_facets(&distinct);
        assert_eq!(
            distinct_offset_buckets(&welded_d),
            2,
            "0.4m-apart planes must NOT merge"
        );
    }

    /// Two facets ~0.09° apart by NORMAL weld; ~0.5° apart do NOT — the angular
    /// over-weld guard (distinct normal buckets keep real pitch apart).
    #[test]
    fn welds_small_angle_not_real_feature() {
        let small = (0.09_f64).to_radians().tan();
        let big = (0.5_f64).to_radians().tan();

        // Shared edge along X at y=0; second facet tilted by the jitter angle.
        let jitter = mesh_from_tris(&[
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.5, 1.0, small]],
        ]);
        let welded = weld_near_coplanar_facets(&jitter);
        // After weld both facets share the fitted plane (offset bucket count 1).
        assert_eq!(
            distinct_offset_buckets(&welded),
            1,
            "0.09° + same-bucket-normal jitter must weld coplanar"
        );

        let feature = mesh_from_tris(&[
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.5, 1.0, big]],
        ]);
        let before = distinct_offset_buckets(&feature);
        let welded_f = weld_near_coplanar_facets(&feature);
        let after = distinct_offset_buckets(&welded_f);
        assert_eq!(
            before, after,
            "a real 0.5° feature must NOT weld (distinct normal bucket)"
        );
    }

    #[test]
    fn flat_pair_is_noop_topology() {
        let flat = mesh_from_tris(&[
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            [[1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]],
        ]);
        let welded = weld_near_coplanar_facets(&flat);
        assert_eq!(welded.indices, flat.indices, "topology must be preserved");
        assert_eq!(welded.positions.len(), flat.positions.len());
    }

    #[test]
    fn weld_is_deterministic() {
        let j = 15.0e-6;
        let m = mesh_from_tris(&[
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
            [[1.0, 0.0, j], [1.0, 1.0, j], [0.0, 1.0, j]],
            [[2.0, 0.0, j], [3.0, 0.0, 0.0], [2.0, 1.0, j]],
        ]);
        let a = weld_near_coplanar_facets(&m);
        let b = weld_near_coplanar_facets(&m);
        assert_eq!(a.positions, b.positions);
        assert_eq!(a.indices, b.indices);
    }

    /// Ordinary site coordinates (~150 m, well under
    /// `LARGE_COORD_THRESHOLD_METERS`) must weld exactly as well as the
    /// near-origin case. Same structure as `welds_offset_jitter_not_distinct_plane`,
    /// just translated. 150 m, not thousands: beyond ~840 m `f32`'s ULP
    /// exceeds `POSITION_DEDUP_GRID`, a separate pre-existing dedup
    /// limitation this change doesn't touch (see
    /// `anchored_formula_removes_offset_amplification`); below that, this
    /// isolates the one thing that IS fixed here.
    ///
    /// The two facets are deliberately NOT axis-aligned (review: PR #2611) —
    /// two horizontal triangles differing only by a Z jitter both compute the
    /// EXACT same `(0,0,1)` normal, so the raw `n·v` offset gap is just the Z
    /// jitter itself, independent of `t`, and would pass even on the
    /// pre-anchor code with no amplification exercised at all. Tilting the
    /// shared edge gives each facet a genuinely distinct per-vertex-jittered
    /// normal (both go through `mesh_from_tris`'s f32 storage, the same
    /// re-quantization the real pipeline applies), so `raw_gap` is actually
    /// amplified by `t`'s magnitude — asserted below BEFORE the anchored
    /// weld is asked to recover it, so this is a real RED/GREEN contrast, not
    /// just a post-weld snapshot.
    #[test]
    fn welds_offset_jitter_at_large_site_coordinates() {
        let t = [120.123_f64, 150.456, 100.789];
        let add = |p: [f64; 3]| [p[0] + t[0], p[1] + t[1], p[2] + t[2]];
        // Smallest per-vertex divergence that survives f32 storage at this
        // magnitude (same technique as `anchored_formula_removes_offset_amplification`).
        let ulp = {
            let f = t[2] as f32;
            (f32::from_bits(f.to_bits() + 1) - f) as f64
        };
        let a = add([0.0, 0.0, 0.0]);
        let b = add([10.0, 3.0, 0.5]); // non-axis-aligned shared edge
        let c1 = add([2.0, 10.0, 1.0]);
        let c2 = add([2.0, 10.0, 1.0 + ulp]); // one f32 ULP off c1, not shared-edge
        let jittered = mesh_from_tris(&[[a, b, c1], [a, b, c2]]);

        // RED: the raw (pre-anchor) offset gap, using each facet's own
        // (genuinely different, f32-requantized) normal — must actually be
        // amplified past MAX_OFFSET_JITTER at this magnitude, or this fixture
        // isn't exercising the bug at all.
        let raw_gap = {
            let (a32, b32, c1_32, c2_32) = (vert_f32(a), vert_f32(b), vert_f32(c1), vert_f32(c2));
            let n1 = super::tri_normal(a32, b32, c1_32).unwrap().0;
            let n2 = super::tri_normal(a32, b32, c2_32).unwrap().0;
            let off1 = n1[0] * c1_32[0] + n1[1] * c1_32[1] + n1[2] * c1_32[2];
            let off2 = n2[0] * c2_32[0] + n2[1] * c2_32[1] + n2[2] * c2_32[2];
            (off1 - off2).abs()
        };
        eprintln!("large-site weld: t={t:?} ulp={ulp:e} raw_gap={raw_gap:e}");
        assert!(
            raw_gap > MAX_OFFSET_JITTER,
            "fixture must exercise real amplification (raw_gap={raw_gap:e} \
             must exceed MAX_OFFSET_JITTER={MAX_OFFSET_JITTER:e}) or this is \
             not a meaningful RED case"
        );

        // Anchored check — see `distinct_offset_buckets_anchored` doc.
        let pre_buckets = distinct_offset_buckets_anchored(&jittered);
        let welded = weld_near_coplanar_facets(&jittered);
        let post_buckets = distinct_offset_buckets_anchored(&welded);

        eprintln!(
            "large-site weld: pre_buckets={pre_buckets} post_buckets={post_buckets}"
        );
        assert_eq!(
            post_buckets, 1,
            "two facets of one authored plane at a real site offset must weld \
             to ONE offset bucket, same as the near-origin \
             `welds_offset_jitter_not_distinct_plane` case — got {post_buckets} \
             (pre-weld: {pre_buckets})"
        );
    }

    /// The invariant this fix restores: the anchor must be a function of the
    /// vertex SET, not of vertex numbering. Builds the same 3 facets (a weld
    /// cluster + one unrelated far facet) in two vertex orders — far facet
    /// first vs. last, so a different physical vertex would have been
    /// `canon_pos[0]` under the old first-vertex anchor — and asserts every
    /// vertex's welded position is bit-identical between the two orderings
    /// once matched back to the same physical vertex.
    ///
    /// This encodes the invariant behind the census's #6588 finding (a host
    /// newly dependent on the triangulator's diagonal choice) rather than
    /// hand-reproducing its exact divergence: that divergence is a
    /// corpus-scale, floating-point-boundary coincidence (the real
    /// duplex.ifc #6426 fixture does not diverge at this synthetic scale
    /// either) that resisted small hand-built reconstruction. The
    /// bit-identity assertion below is correct-by-construction regardless:
    /// two orderings of the same mesh must weld to the same result, full stop.
    #[test]
    fn anchor_is_stable_under_vertex_reordering() {
        // Just under MAX_OFFSET_JITTER (5e-5), so the pair is near the bucket
        // boundary. Note this jitter is NOT sized to an f32 ULP at this
        // magnitude, so it does not by itself prove a perturbation flips the
        // bucket; the assertion this test actually makes is order-invariance,
        // which holds regardless (see the doc comment above).
        let j = 4.9e-5;
        let t = [5000.123_f64, 3000.456, 7000.789];
        let add = |p: [f64; 3]| [p[0] + t[0], p[1] + t[1], p[2] + t[2]];
        let facet1 = [add([0.0, 0.0, 0.0]), add([10.0, 0.0, 0.0]), add([0.0, 10.0, 0.0])];
        let facet2 = [add([10.0, 0.0, j]), add([10.0, 10.0, j]), add([0.0, 10.0, j])];
        // Unrelated facet, 1 km from the cluster, distinct normal bucket.
        let d0 = add([1000.0, 0.0, 0.0]);
        let d1 = add([1000.0, 0.0, 1.0]);
        let d2 = add([1001.0, 1.0, 0.5]);
        let far_facet = [d0, d1, d2];

        let vertex0_far = mesh_from_tris(&[far_facet, facet1, facet2]);
        let vertex0_cluster = mesh_from_tris(&[facet1, facet2, far_facet]);

        let welded_far_first = weld_near_coplanar_facets(&vertex0_far);
        let welded_cluster_first = weld_near_coplanar_facets(&vertex0_cluster);

        // `vertex0_far`'s raw vertex order is `vertex0_cluster`'s rotated by
        // the far facet's 3 vertices (moved from last to first): raw index i
        // in `vertex0_cluster` is the SAME physical vertex as raw index
        // `(i + 3) % 9` in `vertex0_far`. Compare every vertex's welded
        // position bit-for-bit through that correspondence.
        for i in 0..9 {
            let far_i = (i + 3) % 9;
            let cluster_pos = &welded_cluster_first.positions[i * 3..i * 3 + 3];
            let far_pos = &welded_far_first.positions[far_i * 3..far_i * 3 + 3];
            assert_eq!(
                cluster_pos, far_pos,
                "vertex {i} (cluster-first raw id) / {far_i} (far-first raw \
                 id) is the SAME physical vertex — its welded position must \
                 be bit-identical regardless of which vertex was numbered \
                 first. cluster-first={cluster_pos:?} far-first={far_pos:?}"
            );
        }
    }

    /// Isolates the offset-formula fix from the full `weld_near_coplanar_facets`
    /// pipeline (so `POSITION_DEDUP_GRID`'s separate limitation, see above,
    /// can't interfere), using the smallest jitter that survives `f32`
    /// storage at ~5000-7000 m (a true 15 µm #1112-scale jitter is
    /// unrepresentable there).
    ///
    /// Asserts the ANCHORED gap clears `MAX_OFFSET_JITTER` when the anchor is
    /// on the shared edge (the common case, since `weld_near_coplanar_facets`
    /// anchors at the mesh's bbox-min corner, typically part of or near the
    /// cluster being welded), against a RAW gap orders of magnitude over
    /// tolerance. Also PRINTS (doesn't assert) the gap for an anchor
    /// progressively farther from the cluster: the residual scales with
    /// anchor-to-cluster distance (mesh-scale) rather than world-origin
    /// distance (site-scale) — a large improvement, not a complete
    /// elimination for a sprawling host.
    #[test]
    fn anchored_formula_removes_offset_amplification() {
        let t = [5000.123_f64, 3000.456, 7000.789];
        // Smallest vertex divergence that survives f32 storage at this magnitude.
        let ulp_at_t2 = {
            let f = t[2] as f32;
            (f32::from_bits(f.to_bits() + 1) - f) as f64
        };
        eprintln!("f32 ULP near {}: {ulp_at_t2:e}", t[2]);

        for edge in [1.0_f64, 10.0_f64] {
            let add = |p: [f64; 3]| [p[0] + t[0], p[1] + t[1], p[2] + t[2]];
            // Facet1 flat, not axis-aligned (avoids a spurious zero dot
            // product from an orthogonal edge/normal). Facet2 shares the
            // (A,B) edge; its unique corner is lifted by one f32 ULP.
            let a = add([0.0, 0.0, 0.0]);
            let b = add([edge, 0.3 * edge, 0.05 * edge]);
            let c1 = add([0.2 * edge, edge, 0.1 * edge]);
            let c2 = add([0.2 * edge, edge, 0.1 * edge + ulp_at_t2]);

            // Evaluate at the vertex that moved (c1/c2) — a shared-edge
            // vertex would vanish by construction regardless of the gap.
            let raw_gap = {
                let n1 = super::tri_normal(a, b, c1).unwrap().0;
                let n2 = super::tri_normal(b, c2, a).unwrap().0;
                let off1 = n1[0] * c1[0] + n1[1] * c1[1] + n1[2] * c1[2];
                let off2 = n2[0] * c2[0] + n2[1] * c2[1] + n2[2] * c2[2];
                (off1 - off2).abs()
            };
            let anchored_gap = {
                let anchor = a;
                let s = |p: [f64; 3]| [p[0] - anchor[0], p[1] - anchor[1], p[2] - anchor[2]];
                let (a2, b2, c1a) = (s(a), s(b), s(c1));
                let (b2b, c2a, a2a) = (s(b), s(c2), s(a));
                let n1 = super::tri_normal(a2, b2, c1a).unwrap().0;
                let n2 = super::tri_normal(b2b, c2a, a2a).unwrap().0;
                let off1 = n1[0] * c1a[0] + n1[1] * c1a[1] + n1[2] * c1a[2];
                let off2 = n2[0] * c2a[0] + n2[1] * c2a[1] + n2[2] * c2a[2];
                (off1 - off2).abs()
            };
            eprintln!(
                "edge={edge}m: raw_gap={raw_gap:e} anchored_gap={anchored_gap:e} \
                 MAX_OFFSET_JITTER={MAX_OFFSET_JITTER:e}"
            );
            assert!(
                raw_gap > MAX_OFFSET_JITTER,
                "RAW formula must be shown failing (amplified) for this to \
                 be a meaningful RED case; edge={edge}m raw_gap={raw_gap:e}"
            );
            assert!(
                anchored_gap < MAX_OFFSET_JITTER,
                "ANCHORED formula must bring the gap back under tolerance \
                 when the anchor is on the shared edge; edge={edge}m \
                 anchored_gap={anchored_gap:e}"
            );

            // WORST CASE: the global anchor (bbox-min corner) belongs to a
            // DIFFERENT part of a large host, `far_m` away from this
            // cluster's shared edge — plausible for a big
            // multi-slope roof. Offset is a PLANE property (constant across
            // all 3 of a triangle's own vertices), so the gap is
            // `δn · (shared_edge_point − anchor)`; an anchor ON the shared
            // edge cancels EXACTLY (see the `anchored_gap≈0` result above) —
            // an anchor `far_m` away does not.
            for far_m in [1.0_f64, 10.0_f64, 50.0_f64] {
                let anchor = [a[0] - far_m, a[1], a[2]];
                let s = |p: [f64; 3]| [p[0] - anchor[0], p[1] - anchor[1], p[2] - anchor[2]];
                let (a2, b2, c1a) = (s(a), s(b), s(c1));
                let (b2b, c2a, a2a) = (s(b), s(c2), s(a));
                let n1 = super::tri_normal(a2, b2, c1a).unwrap().0;
                let n2 = super::tri_normal(b2b, c2a, a2a).unwrap().0;
                let off1 = n1[0] * c1a[0] + n1[1] * c1a[1] + n1[2] * c1a[2];
                let off2 = n2[0] * c2a[0] + n2[1] * c2a[1] + n2[2] * c2a[2];
                let gap_far = (off1 - off2).abs();
                eprintln!(
                    "  edge={edge}m anchor {far_m}m from cluster: gap={gap_far:e} \
                     ({} MAX_OFFSET_JITTER)",
                    if gap_far < MAX_OFFSET_JITTER { "<" } else { ">=" }
                );
            }
        }
    }
}
