// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Inline void-subtraction matrix (split out of the former
//! `voids_matrix_test.rs`; shared fixtures live in `voids_common`).
//!
//! [`inline_void_matrix`] drives inline-IFC configs through
//! `process_element_with_voids`, with shared structural invariants plus
//! per-case checks (direct CSG subtraction, mesh merge/bounds, the
//! issue #547 trapezoid over-cut regression, and the CSG-budget
//! regression for many tessellated-box openings). Preserves every input
//! configuration and assertion from the former `csg_void_test.rs`.

mod voids_common;

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{csg::ClippingProcessor, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;
use voids_common::fixtures::{
    long_wall_with_many_tessellated_openings, slab_with_opening_ifc,
    wall_with_trapezoid_opening_ifc,
};

/// Context handed to each case's extra check.
struct InlineCtx<'a> {
    content: &'a str,
    voided: &'a Mesh,
}

struct InlineCase {
    name: &'static str,
    /// Returns (IFC content, host express ID, opening express IDs).
    build: fn() -> (String, u32, Vec<u32>),
    /// Case-specific invariant beyond the shared structural checks.
    check: fn(&InlineCtx),
}

/// Shared structural invariants every voided result must satisfy.
fn assert_structural_invariants(name: &str, uncut: &Mesh, voided: &Mesh) {
    assert!(!uncut.is_empty(), "[{name}] host mesh should not be empty");
    assert!(
        !voided.is_empty(),
        "[{name}] voided mesh should not be empty"
    );
    assert!(
        !voided.positions.is_empty(),
        "[{name}] voided positions should not be empty"
    );
    assert!(
        !voided.normals.is_empty(),
        "[{name}] voided normals should not be empty"
    );
    assert_eq!(
        voided.normals.len(),
        voided.positions.len(),
        "[{name}] normals and positions should have matching lengths"
    );
    assert!(
        voided.positions.iter().all(|v| v.is_finite()),
        "[{name}] all positions should be finite"
    );
    assert!(
        voided.normals.iter().all(|v| v.is_finite()),
        "[{name}] all normals should be finite"
    );

    // The cut only removes material — bounds must stay within the host's.
    let (host_min, host_max) = uncut.bounds();
    let (cut_min, cut_max) = voided.bounds();
    assert!(
        cut_min.x >= host_min.x - 0.01 && cut_max.x <= host_max.x + 0.01,
        "[{name}] voided X bounds should be within host bounds"
    );
    assert!(
        cut_min.y >= host_min.y - 0.01 && cut_max.y <= host_max.y + 0.01,
        "[{name}] voided Y bounds should be within host bounds"
    );
}

/// Former `test_csg_void_subtraction_basic` + `test_mesh_merge` +
/// `test_mesh_bounds`: direct `ClippingProcessor::subtract_mesh` on the
/// slab/opening pair, mesh merge triangle accounting, and slab bounds.
fn check_slab_direct_subtract_merge_bounds(ctx: &InlineCtx) {
    let mut decoder = EntityDecoder::new(ctx.content);
    let router = GeometryRouter::with_units(ctx.content, &mut decoder);

    let slab = decoder.decode_by_id(100).expect("Failed to decode slab");
    let slab_mesh = router
        .process_element(&slab, &mut decoder)
        .expect("Failed to process slab");
    let opening = decoder.decode_by_id(200).expect("Failed to decode opening");
    let opening_mesh = router
        .process_element(&opening, &mut decoder)
        .expect("Failed to process opening");

    assert!(!slab_mesh.is_empty(), "Slab mesh should not be empty");
    assert!(!opening_mesh.is_empty(), "Opening mesh should not be empty");

    // --- Slab bounds: approximately 4m × 3m × 0.3m ---
    let (min, max) = slab_mesh.bounds();
    let width = max.x - min.x;
    let depth = max.y - min.y;
    let height = max.z - min.z;
    assert!(
        (width - 4.0).abs() < 0.1,
        "Slab width should be ~4m, got {width:.2}"
    );
    assert!(
        (depth - 3.0).abs() < 0.1,
        "Slab depth should be ~3m, got {depth:.2}"
    );
    assert!(
        (height - 0.3).abs() < 0.1,
        "Slab height should be ~0.3m, got {height:.2}"
    );

    // --- Direct CSG subtraction ---
    let clipper = ClippingProcessor::new();
    let result_mesh = clipper
        .subtract_mesh(&slab_mesh, &opening_mesh)
        .unwrap_or_else(|e| panic!("CSG subtraction failed: {e}"));

    assert!(!result_mesh.is_empty(), "CSG result should not be empty");
    assert!(
        !result_mesh.positions.is_empty(),
        "Result mesh positions should not be empty"
    );
    assert!(
        !result_mesh.normals.is_empty(),
        "Result mesh normals should not be empty"
    );
    assert_eq!(
        result_mesh.normals.len(),
        result_mesh.positions.len(),
        "Normals and positions should have matching lengths"
    );
    assert!(
        result_mesh.positions.iter().all(|v| v.is_finite()),
        "All positions should be finite"
    );
    assert!(
        result_mesh.normals.iter().all(|v| v.is_finite()),
        "All normals should be finite"
    );
    let (slab_min, slab_max) = slab_mesh.bounds();
    let (result_min, result_max) = result_mesh.bounds();
    assert!(
        result_min.x >= slab_min.x - 0.01 && result_max.x <= slab_max.x + 0.01,
        "Result X bounds should be within slab bounds"
    );
    assert!(
        result_min.y >= slab_min.y - 0.01 && result_max.y <= slab_max.y + 0.01,
        "Result Y bounds should be within slab bounds"
    );

    // --- Mesh merge triangle accounting ---
    let mut combined = Mesh::new();
    combined.merge(&slab_mesh);
    combined.merge(&opening_mesh);
    assert_eq!(
        combined.triangle_count(),
        slab_mesh.triangle_count() + opening_mesh.triangle_count(),
        "Combined mesh should have sum of triangles"
    );
}

/// Regression check for issue #547: a low-tessellation non-rectangular
/// opening (trapezoid extrusion) used to be classified as rectangular
/// purely because its vertex count fell below the 100-vertex threshold.
/// The AABB cut removed the trapezoid's entire bounding rectangle from
/// the wall, so the voided wall was missing material outside the actual
/// trapezoid — visible as oversized voids around windows/doors.
///
/// The opening's trapezoid (after placement) spans world
///   x ∈ [-0.5, 0.5] at z = 2.0 (wide top)
///   x ∈ [-0.3, 0.3] at z = 0.0 (narrow bottom)
/// so at z ≈ 0.3 the actual opening only reaches |x| ≲ 0.33 but the
/// AABB cut would have cleared material all the way to |x| = 0.5.
fn check_trapezoid_not_overcut(ctx: &InlineCtx) {
    // The trapezoid's narrow edge (z ≈ 0) only reaches x ∈ [-0.3, 0.3].
    // A true trapezoid cut introduces boundary vertices at (±0.3, ±0.15, 0).
    // An AABB cut would instead carve the bounding box [-0.5, 0.5] × [0, 2]
    // and put its narrow-end boundary vertices at x ≈ ±0.5. Finding vertices
    // at (±0.3, ±0.15, 0) proves the cut respected the trapezoid shape.
    let mut narrow_edge_vertices = 0usize;
    for chunk in ctx.voided.positions.chunks_exact(3) {
        let x = chunk[0];
        let y = chunk[1];
        let z = chunk[2];
        let on_face = y.abs() > 0.14 && z.abs() < 0.01;
        if on_face && (x.abs() - 0.3).abs() < 0.01 {
            narrow_edge_vertices += 1;
        }
    }
    assert!(
        narrow_edge_vertices > 0,
        "trapezoid cut must introduce boundary vertices at (±0.3, ±0.15, 0) — \
         the narrow end of the opening. The opening was cut as its AABB \
         (bounding rectangle) instead of its trapezoid shape."
    );
}

/// With many tessellated-box openings on one wall, every opening must
/// be cut. If `mesh_fills_axis_aligned_box` rejected tessellated boxes,
/// all of them would route to CSG and the `MAX_CSG_OPERATIONS = 10`
/// cap inside `apply_void_context` would silently skip the 11th+
/// openings — leaving uncut wall at their positions.
fn check_all_tessellated_openings_cut(ctx: &InlineCtx) {
    const N: usize = 15;
    let voided = ctx.voided;

    // Each opening is at x = -45 + 5·i, y-range [-0.5, 0.1], z-range [0, 2],
    // so the wall front face (y = -0.15) should have NO triangle whose
    // centroid falls inside any opening's AABB footprint. Skipped CSG
    // cuts would leave the original wall face intact, so at least one
    // triangle centroid would land inside the skipped opening.
    let centroid = |chunk: &[u32]| {
        let p = |i: u32| {
            let idx = i as usize * 3;
            (
                voided.positions[idx],
                voided.positions[idx + 1],
                voided.positions[idx + 2],
            )
        };
        let (a, b, c) = (p(chunk[0]), p(chunk[1]), p(chunk[2]));
        (
            (a.0 + b.0 + c.0) / 3.0,
            (a.1 + b.1 + c.1) / 3.0,
            (a.2 + b.2 + c.2) / 3.0,
        )
    };

    for i in 0..N {
        let cx = -45.0 + (i as f64) * 5.0;
        let mut covering_triangles = 0usize;
        for tri in voided.indices.chunks_exact(3) {
            let (cxt, cyt, czt) = centroid(tri);
            // Shrink opening bounds slightly to avoid boundary
            // triangles that are legitimately on the hole's edge.
            let margin = 0.05_f32;
            let x_in =
                (cxt as f64) > cx - 0.5 + margin as f64 && (cxt as f64) < cx + 0.5 - margin as f64;
            let z_in = czt > 0.0 + margin && czt < 2.0 - margin;
            let on_front = (cyt + 0.15).abs() < 0.02;
            if on_front && x_in && z_in {
                covering_triangles += 1;
            }
        }
        assert_eq!(
            covering_triangles, 0,
            "opening #{i} (x centre {cx:.1}) has {covering_triangles} wall-front \
             triangles inside its footprint — the cut was skipped (likely due to \
             CSG budget exhaustion from misrouting tessellated boxes to CSG)."
        );
    }
}

#[test]
fn inline_void_matrix() {
    let cases = [
        InlineCase {
            name: "slab_with_rect_opening__direct_subtract_merge_bounds",
            build: || (slab_with_opening_ifc(), 100, vec![200]),
            check: check_slab_direct_subtract_merge_bounds,
        },
        InlineCase {
            name: "wall_with_trapezoid_opening__issue_547_no_aabb_overcut",
            build: || (wall_with_trapezoid_opening_ifc(), 100, vec![200]),
            check: check_trapezoid_not_overcut,
        },
        InlineCase {
            name: "long_wall_15_tessellated_openings__no_csg_budget_skip",
            build: || {
                const N: usize = 15;
                let opening_ids = (0..N).map(|i| 1000 + i as u32 * 20 + 17).collect();
                (
                    long_wall_with_many_tessellated_openings(N),
                    100,
                    opening_ids,
                )
            },
            check: check_all_tessellated_openings_cut,
        },
    ];

    for case in &cases {
        let (content, host_id, opening_ids) = (case.build)();
        let mut decoder = EntityDecoder::new(&content);
        let router = GeometryRouter::with_units(&content, &mut decoder);

        let host = decoder
            .decode_by_id(host_id)
            .unwrap_or_else(|e| panic!("[{}] decode host: {e:?}", case.name));
        let uncut = router
            .process_element(&host, &mut decoder)
            .unwrap_or_else(|e| panic!("[{}] process host: {e:?}", case.name));

        let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
        void_index.insert(host_id, opening_ids);
        let voided = router
            .process_element_with_voids(&host, &mut decoder, &void_index)
            .unwrap_or_else(|e| panic!("[{}] process host with voids: {e:?}", case.name));

        assert_structural_invariants(case.name, &uncut, &voided);
        (case.check)(&InlineCtx {
            content: &content,
            voided: &voided,
        });
    }
}
