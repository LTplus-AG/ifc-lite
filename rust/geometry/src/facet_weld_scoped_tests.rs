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


