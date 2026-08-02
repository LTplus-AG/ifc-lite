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

/// A triangle whose corners carry NaN on ONE axis leaves that axis at its
/// sentinel while the other two hold real bounds — the three axes really can
/// diverge, because `extend_bounds` uses `f64::min`/`f64::max`, which drop NaN.
///
/// Testing only axis 0 shipped whichever of these two the NaN happened to miss:
/// NaN on x looked like "no geometry", NaN on y returned a box whose y span was
/// `inf .. -inf` labelled as a measurement. Neither is a box, so both are
/// `None`.
#[test]
fn world_aabb_is_none_when_any_single_axis_never_accumulated() {
    // Corners differ in y and z, so the triangle is NOT degenerate after
    // quantization (NaN quantizes to 0) and DOES reach the fingerprint.
    let nan_on = |axis: usize| {
        let mut pos: Vec<f32> = vec![0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 1.0];
        for v in 0..3 {
            pos[v * 3 + axis] = f32::NAN;
        }
        let mut h = GeometryHasher::new(TOL, [0.0; 3]);
        h.add_mesh(&pos, &[0, 1, 2]);
        h
    };

    for axis in 0..3 {
        let h = nan_on(axis);
        assert!(
            !h.is_empty(),
            "axis {axis}: the triangle must still hash — otherwise this test is not \
             exercising the divergence it claims to"
        );
        assert_eq!(
            h.world_aabb(),
            None,
            "axis {axis}: an axis that never accumulated must suppress the whole box, \
             not be reported as an inverted/infinite span"
        );
    }
}

/// The two emit gates are independent, and `produce_element_meshes` relies on
/// exactly this: a fingerprint can exist with no box, so it must not collapse
/// the pair to `(None, None)` and throw the fingerprint away.
#[test]
fn a_hash_without_a_box_is_reachable() {
    let mut h = GeometryHasher::new(TOL, [0.0; 3]);
    h.add_mesh(
        &[f32::NAN, 0.0, 0.0, f32::NAN, 1.0, 0.0, f32::NAN, 0.0, 1.0],
        &[0, 1, 2],
    );
    assert!(!h.is_empty(), "the NaN-x triangle still carries a fingerprint");
    assert_eq!(h.world_aabb(), None, "...and no box");
    // The converse must stay unreachable: a box implies an accumulated corner,
    // which implies a triangle, which is what `is_empty()` already gates on.
    let empty = GeometryHasher::new(TOL, [0.0; 3]);
    assert!(empty.is_empty() && empty.world_aabb().is_none());
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

// ---------------------------------------------------------------------------
// Volume and its gate (#1891). See `GeometryHasher::volume` for the reasoning;
// these pin that the gate actually gates, and that the number it lets through
// is the right one.
// ---------------------------------------------------------------------------

/// A watertight, outward-wound unit cube at `origin`, flat-shaded (three
/// distinct vertices per triangle) exactly like the meshes the producer feeds
/// in. This is the only volume the whole pipeline has an unarguable answer for.
fn watertight_unit_cube(origin: [f32; 3]) -> (Vec<f32>, Vec<u32>) {
    let [ox, oy, oz] = origin;
    let c = [
        [0.0f32, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0], [1.0, 0.0, 1.0], [1.0, 1.0, 1.0], [0.0, 1.0, 1.0],
    ];
    let faces: [[usize; 3]; 12] = [
        [0, 2, 1], [0, 3, 2],
        [4, 5, 6], [4, 6, 7],
        [0, 1, 5], [0, 5, 4],
        [2, 3, 7], [2, 7, 6],
        [1, 2, 6], [1, 6, 5],
        [0, 4, 7], [0, 7, 3],
    ];
    let mut positions = Vec::new();
    let mut indices = Vec::new();
    for f in &faces {
        for &vi in f {
            positions.extend_from_slice(&[ox + c[vi][0], oy + c[vi][1], oz + c[vi][2]]);
        }
        let base = indices.len() as u32;
        indices.extend_from_slice(&[base, base + 1, base + 2]);
    }
    (positions, indices)
}

fn closed_solid_verdict() -> OrientVerdict {
    OrientVerdict {
        flipped: false,
        all_closed: true,
        all_orientable: true,
        components: 1,
    }
}

/// The anchor: a unit cube must be EXACTLY 1.0 m³, not 0.999. The divergence
/// sum over an axis-aligned unit cube is exact in `f64`, so any tolerance here
/// would be hiding an arithmetic mistake rather than absorbing float noise.
#[test]
fn a_unit_cube_is_exactly_one_cubic_metre() {
    let (positions, indices) = watertight_unit_cube([0.0, 0.0, 0.0]);
    let mut h = GeometryHasher::new(DEFAULT_GEOM_HASH_TOLERANCE, [0.0; 3]);
    h.add_oriented_mesh(&positions, &indices, [0.0; 3], closed_solid_verdict());
    assert_eq!(h.volume(), Some(1.0));
    assert!(h.closure().is_trustworthy_solid());
    assert_eq!(h.closure().bits(), 0b1111);
}

/// A 2×3×4 box is 24 m³. Catches a factor lost in the ×6 / ÷6 round trip that a
/// unit cube (where 1 is a fixed point of most such errors) would not.
#[test]
fn a_non_unit_box_gets_its_true_volume() {
    let (mut positions, indices) = watertight_unit_cube([0.0, 0.0, 0.0]);
    for v in positions.chunks_exact_mut(3) {
        v[0] *= 2.0;
        v[1] *= 3.0;
        v[2] *= 4.0;
    }
    let mut h = GeometryHasher::new(DEFAULT_GEOM_HASH_TOLERANCE, [0.0; 3]);
    h.add_oriented_mesh(&positions, &indices, [0.0; 3], closed_solid_verdict());
    assert_eq!(h.volume(), Some(24.0));
}

/// The reference point must not leak into the answer. A cube in real project
/// coordinates — hundreds of km east, thousands of km north — must still read
/// exactly 1.0. Referenced to the WORLD ORIGIN instead of a point on the
/// surface, the divergence sum would multiply three ~1e6 coordinates and cancel
/// a 6.0 answer out of ~1e14, losing it in the rounding.
///
/// The offsets are deliberately NOT round numbers: at 4e5 with a dyadic
/// fraction every product stays exactly representable in `f64`, so a
/// suspiciously tidy georeference would pass this test even with the
/// accumulator referenced to the origin.
#[test]
fn volume_is_translation_invariant_even_far_from_the_origin() {
    let (positions, indices) = watertight_unit_cube([0.0, 0.0, 0.0]);
    let mut near = GeometryHasher::new(DEFAULT_GEOM_HASH_TOLERANCE, [0.0; 3]);
    near.add_oriented_mesh(&positions, &indices, [0.0; 3], closed_solid_verdict());

    let mut far = GeometryHasher::new(
        DEFAULT_GEOM_HASH_TOLERANCE,
        [412_345.678_9, -5_310_987.321_4, 91.234_5],
    );
    far.add_oriented_mesh(&positions, &indices, [0.0; 3], closed_solid_verdict());

    assert_eq!(near.volume(), Some(1.0));
    assert_eq!(far.volume(), Some(1.0), "the RTC/world offset must not reach the volume");
}

/// Winding must not reach the MAGNITUDE. `orient_mesh_outward` normally leaves
/// a closed component outward-wound, but its own flip decision is taken about
/// the mesh's local-frame origin and can come out wrong on a far-offset frame;
/// an inward-wound closed cube is still a 1 m³ cube, not a −1 m³ one.
#[test]
fn an_inward_wound_closed_cube_still_reports_a_positive_volume() {
    let (positions, mut indices) = watertight_unit_cube([0.0, 0.0, 0.0]);
    for t in indices.chunks_exact_mut(3) {
        t.swap(1, 2);
    }
    let mut h = GeometryHasher::new(DEFAULT_GEOM_HASH_TOLERANCE, [0.0; 3]);
    h.add_oriented_mesh(&positions, &indices, [0.0; 3], closed_solid_verdict());
    assert_eq!(h.volume(), Some(1.0));
}

/// The gate: anything short of a single closed orientable component yields
/// NOTHING. Not zero, not the raw sum — `None`, which the FFI writes as NaN.
#[test]
fn every_non_solid_verdict_refuses_a_volume() {
    let (positions, indices) = watertight_unit_cube([0.0, 0.0, 0.0]);
    let cases = [
        ("open", OrientVerdict { all_closed: false, ..closed_solid_verdict() }),
        ("non-orientable", OrientVerdict { all_orientable: false, ..closed_solid_verdict() }),
        ("two components", OrientVerdict { components: 2, ..closed_solid_verdict() }),
        ("unanalysable", OrientVerdict::INDETERMINATE),
    ];
    for (label, verdict) in cases {
        let mut h = GeometryHasher::new(DEFAULT_GEOM_HASH_TOLERANCE, [0.0; 3]);
        h.add_oriented_mesh(&positions, &indices, [0.0; 3], verdict);
        assert_eq!(
            h.volume(),
            None,
            "{label}: the geometry is a perfectly ordinary cube, so only the verdict can refuse it"
        );
        assert_ne!(h.closure().bits(), 0b1111, "{label}: the flags must record the refusal");
    }
}

/// A caller that supplies no verdict at all gets no volume. The default must be
/// refusal, or a producer that forgets to thread the verdict through silently
/// starts publishing unvalidated numbers.
#[test]
fn a_segment_added_without_a_verdict_disarms_the_volume() {
    let (positions, indices) = watertight_unit_cube([0.0, 0.0, 0.0]);
    let mut h = GeometryHasher::new(DEFAULT_GEOM_HASH_TOLERANCE, [0.0; 3]);
    h.add_mesh_with_origin(&positions, &indices, [0.0; 3]);
    assert_eq!(h.volume(), None);
}

/// THE MULTI-SEGMENT DECISION, pinned. Two cubes fed as two segments — each one
/// individually a flawless closed solid — must NOT sum to 2.0. IFC item lists
/// are an implicit union and their items overlap far more often than not (66% of
/// the corpus's multi-segment elements), so a sum is a guess dressed as a
/// measurement.
#[test]
fn two_closed_segments_refuse_to_sum() {
    let (a_pos, a_idx) = watertight_unit_cube([0.0, 0.0, 0.0]);
    let (b_pos, b_idx) = watertight_unit_cube([10.0, 0.0, 0.0]);
    let mut h = GeometryHasher::new(DEFAULT_GEOM_HASH_TOLERANCE, [0.0; 3]);
    h.add_oriented_mesh(&a_pos, &a_idx, [0.0; 3], closed_solid_verdict());
    h.add_oriented_mesh(&b_pos, &b_idx, [0.0; 3], closed_solid_verdict());
    assert_eq!(h.closure().segments, 2);
    assert_eq!(
        h.volume(),
        None,
        "even DISJOINT closed segments refuse: nothing here can prove they are disjoint"
    );
    assert_eq!(h.closure().bits(), 0b0111, "only the exactly-one-segment bit may be clear");
}

/// A call that contributes no triangle is not a segment. Otherwise an empty
/// instance placeholder (#1623) would silently push a real single-solid element
/// over the one-segment gate and delete its volume.
#[test]
fn an_empty_segment_does_not_count_against_the_gate() {
    let (positions, indices) = watertight_unit_cube([0.0, 0.0, 0.0]);
    let mut h = GeometryHasher::new(DEFAULT_GEOM_HASH_TOLERANCE, [0.0; 3]);
    h.add_oriented_mesh(&[], &[], [0.0; 3], OrientVerdict::INDETERMINATE);
    h.add_oriented_mesh(&positions, &indices, [0.0; 3], closed_solid_verdict());
    assert_eq!(h.closure().segments, 1);
    assert_eq!(h.volume(), Some(1.0));
}

/// The volume rides the ORIGINAL corner order, which means it must be
/// accumulated before the hasher sorts each triangle's quantized corners (that
/// sort is what makes the fingerprint winding-invariant, and it destroys
/// winding). A cube whose local frame is folded through `origin` exercises the
/// same path the wasm local-frame producer takes.
#[test]
fn volume_survives_the_local_frame_fold() {
    let (positions, indices) = watertight_unit_cube([0.0, 0.0, 0.0]);
    let mut h = GeometryHasher::new(DEFAULT_GEOM_HASH_TOLERANCE, [7.3, -3.7, 11.9]);
    h.add_oriented_mesh(&positions, &indices, [100.1, 200.3, 300.7], closed_solid_verdict());
    assert_eq!(h.volume(), Some(1.0));
}

/// The closure flags are the diagnosis a consumer reads when there is no
/// volume, so each bit must move independently.
#[test]
fn closure_flags_pack_one_bit_per_clause() {
    let base = GeometryClosure {
        all_closed: true,
        all_orientable: true,
        all_single_component: true,
        segments: 1,
    };
    assert_eq!(base.bits(), 0b1111);
    assert_eq!(GeometryClosure { all_closed: false, ..base }.bits(), 0b1110);
    assert_eq!(GeometryClosure { all_orientable: false, ..base }.bits(), 0b1101);
    assert_eq!(GeometryClosure { all_single_component: false, ..base }.bits(), 0b1011);
    assert_eq!(GeometryClosure { segments: 2, ..base }.bits(), 0b0111);
}
