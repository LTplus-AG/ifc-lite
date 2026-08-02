// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for [`super`] — split out of `geom_hash.rs` so the module stays under
//! the house 400-line rule (test files are ratchet-exempt).

use super::*;

/// A unit cube (8 verts, 12 triangles) centred near `origin` in world
/// coordinates. Returns positions already in world space.
fn cube(origin: [f32; 3]) -> (Vec<f32>, Vec<u32>) {
    let [ox, oy, oz] = origin;
    let mut positions = Vec::with_capacity(8 * 3);
    for &x in &[0.0_f32, 1.0] {
        for &y in &[0.0_f32, 1.0] {
            for &z in &[0.0_f32, 1.0] {
                positions.extend_from_slice(&[ox + x, oy + y, oz + z]);
            }
        }
    }
    // 12 triangles over the 8 corners (not a watertight ordering — only
    // needs to be a deterministic, non-degenerate triangle soup).
    let indices = vec![
        0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6,
        4, 1, 5, 7, 1, 7, 3,
    ];
    (positions, indices)
}

const TOL: f64 = 1.0e-3;

#[test]
fn rtc_invariance_same_world_geometry() {
    // Same wall at world position (1_000_000, 0, 0), expressed two ways:
    //   file A: local = world,            rtc = [0,0,0]
    //   file B: local = world - 999_000,  rtc = [999_000,0,0]
    // f32 can't hold 1e6 + sub-metre detail, so build the geometry at a
    // realistic magnitude where the two encodings reconstruct the same
    // world coords within f32 precision.
    let world_origin = [1234.5_f32, -67.25, 8.5];
    let (pos_a, idx) = cube(world_origin);
    let a = hash_mesh_world(&pos_a, &idx, [0.0, 0.0, 0.0], TOL);

    let shift = [999_000.0_f64, -2_000.0, 5_000.0];
    let pos_b: Vec<f32> = pos_a
        .chunks_exact(3)
        .flat_map(|c| {
            [
                (c[0] as f64 - shift[0]) as f32,
                (c[1] as f64 - shift[1]) as f32,
                (c[2] as f64 - shift[2]) as f32,
            ]
        })
        .collect();
    let b = hash_mesh_world(&pos_b, &idx, shift, TOL);

    assert_eq!(a, b, "RTC offset must not change the geometry hash");
}

#[test]
fn translation_is_detected() {
    let (pos, idx) = cube([0.0, 0.0, 0.0]);
    let moved: Vec<f32> = pos.chunks_exact(3).flat_map(|c| [c[0] + 1.0, c[1], c[2]]).collect();
    assert_ne!(
        hash_mesh_world(&pos, &idx, [0.0; 3], TOL),
        hash_mesh_world(&moved, &idx, [0.0; 3], TOL),
        "a 1 m move must change the hash"
    );
}

#[test]
fn degenerate_triangles_do_not_affect_hash() {
    let (pos, idx) = cube([0.0, 0.0, 0.0]);
    let base = hash_mesh_world(&pos, &idx, [0.0; 3], TOL);

    // Append zero-area triangles (repeated/coincident corners) — the kind
    // of triangulation noise that must not move the fingerprint.
    let mut noisy = idx.clone();
    noisy.extend_from_slice(&[0, 0, 1]);
    noisy.extend_from_slice(&[2, 2, 2]);
    let with_noise = hash_mesh_world(&pos, &noisy, [0.0; 3], TOL);

    assert_eq!(base, with_noise, "zero-area triangles must not change the hash");
}

#[test]
fn sub_tolerance_jitter_is_ignored() {
    // `round(v/tol)` puts cell *centres* at integer multiples of `tol` and
    // cell *boundaries* at the half-grid `(k+0.5)*tol`. Place verts at
    // centres (here `10*tol` apart, well clear of boundaries) so a jitter
    // below half a cell stays inside the same quantization cell.
    let cell = TOL * 10.0;
    let base: Vec<f32> = (0..24).map(|i| (i as f32) * (cell as f32)).collect();
    let idx: Vec<u32> = (0..(base.len() as u32 / 3) - 2)
        .flat_map(|i| [i, i + 1, i + 2])
        .collect();

    let jitter = (TOL as f32) * 0.1;
    let perturbed: Vec<f32> = base.iter().map(|v| v + jitter).collect();

    assert_eq!(
        hash_mesh_world(&base, &idx, [0.0; 3], TOL),
        hash_mesh_world(&perturbed, &idx, [0.0; 3], TOL),
        "jitter below the quantization grid must not change the hash"
    );
}

#[test]
fn triangle_and_vertex_order_invariant() {
    let (pos, idx) = cube([3.0, 3.0, 3.0]);
    let canonical = hash_mesh_world(&pos, &idx, [0.0; 3], TOL);

    // Reverse triangle order and rotate each triangle's corners.
    let mut shuffled = Vec::with_capacity(idx.len());
    for tri in idx.chunks_exact(3).rev() {
        shuffled.extend_from_slice(&[tri[1], tri[2], tri[0]]);
    }
    assert_eq!(
        canonical,
        hash_mesh_world(&pos, &shuffled, [0.0; 3], TOL),
        "reordering triangles / rotating corners must not change the hash"
    );
}

#[test]
fn winding_invariant() {
    let (pos, idx) = cube([0.0, 0.0, 0.0]);
    let canonical = hash_mesh_world(&pos, &idx, [0.0; 3], TOL);
    let flipped: Vec<u32> =
        idx.chunks_exact(3).flat_map(|t| [t[0], t[2], t[1]]).collect();
    assert_eq!(
        canonical,
        hash_mesh_world(&pos, &flipped, [0.0; 3], TOL),
        "reversing winding must not change the hash"
    );
}

#[test]
fn segment_split_matches_single_segment() {
    // Hashing an entity as one 12-triangle mesh must equal hashing it as
    // two 6-triangle segments (entities arrive split across submeshes).
    let (pos, idx) = cube([10.0, 0.0, -4.0]);
    let single = hash_mesh_world(&pos, &idx, [0.0; 3], TOL);

    let (first, second) = idx.split_at(idx.len() / 2);
    let mut hasher = GeometryHasher::new(TOL, [0.0; 3]);
    hasher.add_mesh(&pos, first);
    hasher.add_mesh(&pos, second);
    assert_eq!(single, hasher.finish(), "split segments must match a single mesh");
}

#[test]
fn distinct_shapes_differ() {
    let (cube_pos, cube_idx) = cube([0.0, 0.0, 0.0]);
    let (big_pos, big_idx) = cube([0.0, 0.0, 0.0]);
    let scaled: Vec<f32> = big_pos.iter().map(|v| v * 2.0).collect();
    assert_ne!(
        hash_mesh_world(&cube_pos, &cube_idx, [0.0; 3], TOL),
        hash_mesh_world(&scaled, &big_idx, [0.0; 3], TOL),
        "a 2x-scaled cube must hash differently"
    );
}

/// Documents the tolerance trade-off empirically: a move of exactly one
/// grid cell is always detected; the same geometry under pure
/// reconstruction noise stays stable. This is the harness to extend with
/// real revision pairs when tuning `DEFAULT_GEOM_HASH_TOLERANCE`.
#[test]
fn tolerance_sweep_sensitivity() {
    let (pos, idx) = cube([100.0, 50.0, 25.0]);
    for &tol in &[1.0e-4_f64, 1.0e-3, 1.0e-2, 1.0e-1] {
        let baseline = hash_mesh_world(&pos, &idx, [0.0; 3], tol);

        // A move of one full grid cell must always register as changed.
        let one_cell = tol as f32;
        let moved: Vec<f32> =
            pos.chunks_exact(3).flat_map(|c| [c[0] + one_cell, c[1], c[2]]).collect();
        assert_ne!(
            baseline,
            hash_mesh_world(&moved, &idx, [0.0; 3], tol),
            "tol={tol}: a one-cell move must be detected"
        );

        // A move of one thousandth of a cell must be absorbed. The cube
        // sits at integer coords; for every tolerance here those land on
        // cell centres (integer multiples of `tol`), so a tiny nudge stays
        // in-cell.
        let tiny = (tol as f32) * 1.0e-3;
        let nudged: Vec<f32> = pos.iter().map(|v| v + tiny).collect();
        assert_eq!(
            baseline,
            hash_mesh_world(&nudged, &idx, [0.0; 3], tol),
            "tol={tol}: sub-grid jitter must be absorbed"
        );
    }
}

// --- world AABB (#1891 follow-on) ---------------------------------------

/// The box must be the exact `f64` world extent, NOT the quantization grid.
#[test]
fn world_aabb_is_the_exact_unquantized_extent() {
    let (pos, idx) = cube([2.5, -7.0, 0.25]);
    let mut h = GeometryHasher::new(TOL, [0.0; 3]);
    h.add_mesh(&pos, &idx);
    let aabb = h.world_aabb().expect("cube produced corners");
    assert_eq!(aabb, [2.5, -7.0, 0.25, 3.5, -6.0, 1.25]);
}

/// RTC is folded back exactly as it is for the hash, so two files that picked
/// different offsets report the SAME world box.
#[test]
fn world_aabb_is_rtc_invariant() {
    let world_origin = [1234.5_f32, -67.25, 8.5];
    let (pos_a, idx) = cube(world_origin);
    let mut a = GeometryHasher::new(TOL, [0.0; 3]);
    a.add_mesh(&pos_a, &idx);

    let shift = [999_000.0_f64, -2_000.0, 5_000.0];
    let pos_b: Vec<f32> = pos_a
        .chunks_exact(3)
        .flat_map(|c| {
            [
                (c[0] as f64 - shift[0]) as f32,
                (c[1] as f64 - shift[1]) as f32,
                (c[2] as f64 - shift[2]) as f32,
            ]
        })
        .collect();
    let mut b = GeometryHasher::new(TOL, shift);
    b.add_mesh(&pos_b, &idx);

    assert_eq!(
        a.world_aabb(),
        b.world_aabb(),
        "the file's RTC choice must not move the reported world box"
    );
}

/// `origin` (the per-mesh local frame) is folded back, and boxes union across
/// the segments of one entity.
#[test]
fn world_aabb_folds_origin_and_unions_segments() {
    let (pos, idx) = cube([0.0, 0.0, 0.0]);
    let mut h = GeometryHasher::new(TOL, [0.0; 3]);
    h.add_mesh_with_origin(&pos, &idx, [10.0, 0.0, 0.0]);
    h.add_mesh_with_origin(&pos, &idx, [-4.0, 2.0, 0.0]);
    assert_eq!(
        h.world_aabb().expect("two segments"),
        [-4.0, 0.0, 0.0, 11.0, 3.0, 1.0]
    );
}

/// A triangle the HASH rejects as post-quantization degenerate still carries
/// real extent, so its corners must reach the box. Otherwise an element whose
/// outermost face happens to be a sliver reports a box that is too small.
#[test]
fn world_aabb_includes_hash_skipped_degenerate_triangles() {
    let (mut pos, mut idx) = cube([0.0, 0.0, 0.0]);
    let base = (pos.len() / 3) as u32;
    // A zero-area triangle (two coincident corners) reaching out to x = 40.
    pos.extend_from_slice(&[40.0, 0.0, 0.0, 40.0, 0.0, 0.0, 40.0, 1.0, 0.0]);
    idx.extend_from_slice(&[base, base + 1, base + 2]);

    let mut h = GeometryHasher::new(TOL, [0.0; 3]);
    h.add_mesh(&pos, &idx);
    assert_eq!(
        h.world_aabb().expect("cube + sliver"),
        [0.0, 0.0, 0.0, 40.0, 1.0, 1.0],
        "a degenerate triangle contributes extent even though it carries no hash"
    );
    // ...and it still must not move the fingerprint.
    assert_eq!(
        h.finish(),
        hash_mesh_world(&pos, &{ idx[..idx.len() - 3].to_vec() }, [0.0; 3], TOL),
        "the degenerate triangle must stay out of the hash"
    );
}

/// Out-of-range indices are skipped defensively by the hash; the box must skip
/// them too rather than read past the buffer.
#[test]
fn world_aabb_skips_out_of_range_triangles() {
    let (pos, idx) = cube([0.0, 0.0, 0.0]);
    let mut noisy = idx.clone();
    noisy.extend_from_slice(&[0, 1, 9999]);
    let mut h = GeometryHasher::new(TOL, [0.0; 3]);
    h.add_mesh(&pos, &noisy);
    assert_eq!(h.world_aabb().expect("cube"), [0.0, 0.0, 0.0, 1.0, 1.0, 1.0]);
}

/// Nothing accumulated ⇒ no box (never a degenerate INFINITY..-INFINITY one).
#[test]
fn world_aabb_is_none_without_geometry() {
    let h = GeometryHasher::new(TOL, [0.0; 3]);
    assert_eq!(h.world_aabb(), None);
    let mut empty = GeometryHasher::new(TOL, [0.0; 3]);
    empty.add_mesh(&[], &[]);
    assert_eq!(empty.world_aabb(), None);
}

/// The AABB work must not perturb a single existing fingerprint. These are the
/// hash values produced by `geom_hash.rs` BEFORE this change; they are pinned
/// literals, not recomputed, so a future refactor of the corner reconstruction
/// cannot silently re-key every stored diff.
#[test]
fn hash_values_are_byte_identical_to_the_pre_aabb_implementation() {
    let (pos, idx) = cube([0.0, 0.0, 0.0]);
    assert_eq!(
        hash_mesh_world(&pos, &idx, [0.0; 3], TOL),
        9_804_297_170_738_711_971
    );

    let (pos, idx) = cube([1234.5, -67.25, 8.5]);
    assert_eq!(
        hash_mesh_world(&pos, &idx, [999_000.0, -2_000.0, 5_000.0], TOL),
        16_570_244_528_967_140_961
    );

    let mut h = GeometryHasher::new(1.0e-2, [3.0, -1.0, 0.5]);
    let (pos, idx) = cube([10.0, 0.0, -4.0]);
    h.add_mesh_with_origin(&pos, &idx, [0.125, 0.25, -0.5]);
    assert_eq!(h.finish(), 7_301_177_935_129_768_504);
}
