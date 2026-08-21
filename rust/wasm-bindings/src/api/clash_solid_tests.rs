// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `clash_solid.rs`.
//!
//! Split out per the repo convention for modules whose bulk is test code
//! (see `rust/core/src/georef.rs` / `georef_tests.rs`), which also keeps
//! `clash_solid.rs` inside its module-size ratchet budget.

use super::*;

/// A deeply-overlapping pair of axis-aligned unit boxes, well-formed, so
/// `mesh_from`'s validation is confirmed not to reject legitimate input.
fn box_positions_indices(lo: [f32; 3], hi: [f32; 3]) -> (Vec<f32>, Vec<u32>) {
    let corners: [[f32; 3]; 8] = [
        [lo[0], lo[1], lo[2]],
        [hi[0], lo[1], lo[2]],
        [hi[0], hi[1], lo[2]],
        [lo[0], hi[1], lo[2]],
        [lo[0], lo[1], hi[2]],
        [hi[0], lo[1], hi[2]],
        [hi[0], hi[1], hi[2]],
        [lo[0], hi[1], hi[2]],
    ];
    let positions: Vec<f32> = corners.iter().flat_map(|c| c.iter().copied()).collect();
    #[rustfmt::skip]
    let indices: Vec<u32> = vec![
        0, 1, 2, 0, 2, 3, // -z
        4, 6, 5, 4, 7, 6, // +z
        0, 5, 1, 0, 4, 5, // -y
        3, 2, 6, 3, 6, 7, // +y
        0, 3, 7, 0, 7, 4, // -x
        1, 5, 6, 1, 6, 2, // +x
    ];
    (positions, indices)
}

#[test]
fn well_formed_deep_overlap_still_returns_a_solid() {
    let (pos_a, idx_a) = box_positions_indices([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
    let (pos_b, idx_b) = box_positions_indices([0.5, 0.5, 0.5], [1.5, 1.5, 1.5]);

    let result = clash_intersection_solid(&pos_a, &idx_a, &pos_b, &idx_b);

    assert!(result.is_solid(), "well-formed deep overlap must not be rejected as malformed");
    assert_eq!(result.degenerate_reason(), "");
    assert!(result.volume_m3() > 0.0);
}

#[test]
fn a_positions_buffer_not_a_multiple_of_three_is_reported_malformed_not_computed() {
    let (pos_a, idx_a) = box_positions_indices([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
    let (mut pos_b, idx_b) = box_positions_indices([0.5, 0.5, 0.5], [1.5, 1.5, 1.5]);
    // Truncate one trailing float — no longer a flat [x, y, z, …] triple.
    pos_b.pop();

    let result = clash_intersection_solid(&pos_a, &idx_a, &pos_b, &idx_b);

    assert!(!result.is_solid());
    assert_eq!(result.degenerate_reason(), "malformed-operand");
    assert_eq!(result.volume_m3(), 0.0);
    assert!(result.positions().is_empty());
    assert!(result.indices().is_empty());
}

#[test]
fn an_index_past_its_own_operands_vertex_count_is_reported_malformed_not_silently_dropped() {
    let (pos_a, idx_a) = box_positions_indices([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
    let (pos_b, mut idx_b) = box_positions_indices([0.5, 0.5, 0.5], [1.5, 1.5, 1.5]);
    // `pos_b` has 8 vertices (indices 0..=7); this references vertex 99,
    // which `ifc_lite_geometry`'s own mesh reader would silently drop
    // rather than reject — the whole point of this test is that the
    // wasm binding catches it BEFORE that happens.
    let last = idx_b.len() - 1;
    idx_b[last] = 99;

    let result = clash_intersection_solid(&pos_a, &idx_a, &pos_b, &idx_b);

    assert!(!result.is_solid());
    assert_eq!(result.degenerate_reason(), "malformed-operand");
    assert_eq!(result.volume_m3(), 0.0);
}

/// Boundary case for the same guard: `pos_b` has exactly 8 vertices, so
/// its valid index range is `0..=7` and `vertex_count == 8` is the first
/// value one past the end. The far-out-of-range probes above (99, 1000)
/// cannot tell `i >= vertex_count` apart from the weaker `i > vertex_count`
/// — both reject 99 and 1000 identically — so they leave the off-by-one
/// at the boundary itself unpinned. Confirmed by mutation: flipping
/// `mesh_from`'s guard from `>=` to `>` in
/// `rust/wasm-bindings/src/api/clash_solid.rs` left every existing test
/// in this module green.
#[test]
fn an_index_exactly_at_its_own_operands_vertex_count_is_reported_malformed() {
    let (pos_a, idx_a) = box_positions_indices([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
    let (pos_b, mut idx_b) = box_positions_indices([0.5, 0.5, 0.5], [1.5, 1.5, 1.5]);
    let vertex_count = (pos_b.len() / 3) as u32;
    let last = idx_b.len() - 1;
    idx_b[last] = vertex_count; // one past the last valid index (7), not merely "large"

    let result = clash_intersection_solid(&pos_a, &idx_a, &pos_b, &idx_b);

    assert!(!result.is_solid());
    assert_eq!(result.degenerate_reason(), "malformed-operand");
    assert_eq!(result.volume_m3(), 0.0);
}

#[test]
fn an_out_of_range_index_on_operand_a_is_also_caught() {
    let (pos_a, mut idx_a) = box_positions_indices([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
    let (pos_b, idx_b) = box_positions_indices([0.5, 0.5, 0.5], [1.5, 1.5, 1.5]);
    idx_a[0] = 1000;

    let result = clash_intersection_solid(&pos_a, &idx_a, &pos_b, &idx_b);

    assert!(!result.is_solid());
    assert_eq!(result.degenerate_reason(), "malformed-operand");
}

/// PR #2573 review finding: a NaN coordinate placed on a face of operand A
/// that the true overlap never touches passes `mesh_from` untouched today
/// (only length-multiple-of-3 and index-in-range are checked) and produces
/// a normal-looking `isSolid=true, volume≈0.125` — identical to the clean
/// case. That is not "the corruption had no effect"; it is silent
/// corruption that happens not to change this particular answer. Corner 0
/// (`[0,0,0]`, on A's lo-lo-lo faces) is chosen because the overlap region
/// `[0.5,1]^3` never reaches those faces.
#[test]
fn nan_corner_off_the_overlap_face_must_be_rejected_not_silently_absorbed() {
    let (mut pos_a, idx_a) = box_positions_indices([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
    let (pos_b, idx_b) = box_positions_indices([0.5, 0.5, 0.5], [1.5, 1.5, 1.5]);
    pos_a[0] = f32::NAN; // corner 0's x coordinate

    let result = clash_intersection_solid(&pos_a, &idx_a, &pos_b, &idx_b);

    assert!(
        !result.is_solid(),
        "NaN operand must never be reported as a trustworthy solid; got isSolid=true, volume={}",
        result.volume_m3()
    );
    assert_eq!(result.degenerate_reason(), "malformed-operand");
}

/// Same review finding, second probe: a NaN coordinate placed on a face of
/// operand A that DOES bound the true overlap. Before validation this
/// silently misclassifies a genuinely overlapping pair as
/// `"no-overlap"` — a wrong answer, not a rejection. Corner 6
/// (`[1,1,1]`, on A's hi-hi-hi faces) bounds the overlap region
/// `[0.5,1]^3`.
#[test]
fn nan_corner_on_the_overlap_face_must_be_rejected_not_misreported_as_no_overlap() {
    let (mut pos_a, idx_a) = box_positions_indices([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
    let (pos_b, idx_b) = box_positions_indices([0.5, 0.5, 0.5], [1.5, 1.5, 1.5]);
    pos_a[6 * 3] = f32::NAN; // corner 6's x coordinate

    let result = clash_intersection_solid(&pos_a, &idx_a, &pos_b, &idx_b);

    assert!(!result.is_solid());
    assert_eq!(
        result.degenerate_reason(),
        "malformed-operand",
        "a genuinely overlapping pair corrupted by NaN must not be reported as no-overlap"
    );
}

/// An infinite coordinate is the same failure mode as NaN and must be
/// caught the same way.
#[test]
fn infinite_corner_must_be_rejected_as_malformed_operand() {
    let (mut pos_a, idx_a) = box_positions_indices([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
    let (pos_b, idx_b) = box_positions_indices([0.5, 0.5, 0.5], [1.5, 1.5, 1.5]);
    pos_a[0] = f32::INFINITY;

    let result = clash_intersection_solid(&pos_a, &idx_a, &pos_b, &idx_b);

    assert!(!result.is_solid());
    assert_eq!(result.degenerate_reason(), "malformed-operand");
}
