// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #846 — IfcBeam #227 in the
//! beam-varying-extrusion-paths fixture uses an IfcRevolvedAreaSolid that
//! references a non-trivial Position offset (0, -100, 0) and a revolution
//! axis at (-1300, 100, 0) with direction (0,-1,0). The old processor
//! (a) ignored the IfcSweptAreaSolid Position transform and (b) misused the
//! 2D profile (x,y) coords as (radius, height) along the axis. The result
//! was a tiny ring near the axis location instead of the expected 45° arc
//! sweep of an IPE200 profile around the axis line.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;

const FIXTURE: &str = "../../tests/models/issues/846_revolved_beam.ifc";

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping issue-846 regression: fixture missing at {FIXTURE} — \
                 run `pnpm fixtures` to fetch it"
            );
            None
        }
        Err(e) => panic!("failed to read fixture {FIXTURE}: {e}"),
    }
}

fn bounds(mesh: &ifc_lite_geometry::Mesh) -> ([f32; 3], [f32; 3]) {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for chunk in mesh.positions.chunks_exact(3) {
        for axis in 0..3 {
            min[axis] = min[axis].min(chunk[axis]);
            max[axis] = max[axis].max(chunk[axis]);
        }
    }
    (min, max)
}

#[test]
fn revolved_beam_sweeps_authored_arc_not_a_degenerate_ring() {
    let Some(content) = read_fixture() else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let beam = decoder
        .decode_by_id(227)
        .expect("decode IfcBeam #227 (Revolution)");
    assert_eq!(beam.ifc_type, IfcType::IfcBeam);

    let mesh = router
        .process_element(&beam, &mut decoder)
        .expect("process revolution beam");

    let tri_count = mesh.indices.len() / 3;
    assert!(
        tri_count > 100,
        "expected non-trivial swept mesh, got {tri_count} triangles",
    );

    let (min, max) = bounds(&mesh);
    let span = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];

    // Authored sweep is a 1300 mm-radius IPE200 (200 mm deep flanges) revolved
    // by 0.79 rad ≈ 45° around an axis offset from the profile origin. The
    // arc length 1300 mm × 0.79 ≈ 1.03 m must appear in the mesh extents,
    // and the profile depth (≈ 0.2 m) must show up on a perpendicular axis.
    // The pre-fix bug produced a tiny ring of order 0.1 m on every axis,
    // located ≈ 1.3 m from the placement origin (the misused axis location).
    assert!(
        span[1] > 0.90,
        "expected long-axis extent ≥0.90 m (arc length ≈1.03 m), got {} \
         (full span {span:?}, bounds {min:?}..{max:?})",
        span[1],
    );
    let cross_axis_max = span[0].max(span[2]);
    assert!(
        cross_axis_max > 0.15,
        "expected perpendicular profile extent ≥0.15 m (IPE200 depth ≈0.2 m), \
         got {cross_axis_max} (full span {span:?})",
    );
}

#[test]
fn extrusion_beam_unchanged_under_revolved_fix() {
    let Some(content) = read_fixture() else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    // Beam #210 is a plain IfcExtrudedAreaSolid — touching the
    // RevolvedAreaSolidProcessor must not affect the extrusion path.
    let beam = decoder
        .decode_by_id(210)
        .expect("decode IfcBeam #210 (Extrusion)");
    let mesh = router
        .process_element(&beam, &mut decoder)
        .expect("process extrusion beam");

    let tri_count = mesh.indices.len() / 3;
    assert!(tri_count > 0, "extrusion beam produced no triangles");

    let (min, max) = bounds(&mesh);
    // The extrusion is a 1 m long IPE200 along world +Z (with local
    // placement rotation). At minimum the mesh must span ≈ 1 m on its
    // long axis.
    let max_span = (max[0] - min[0])
        .max(max[1] - min[1])
        .max(max[2] - min[2]);
    assert!(
        max_span > 0.9,
        "expected extrusion beam to span ≈1 m on its long axis, got {max_span}",
    );
}

#[test]
fn revolved_beam_has_manifold_cap_triangulation() {
    // Issue #846 follow-up: the FIRST fix (PR #848) made the sweep curve
    // land correctly but the end caps were built as a centroid fan — fine
    // for convex profiles, broken for the I-beam's concave outline.
    // Visible symptom: the revolved beam's cross-section rendered as a
    // bowtie/X where adjacent fan triangles crossed each other through
    // the concave web region of the IPE200 profile.
    //
    // Robust catch: an edge that's shared by > 2 triangles is non-manifold,
    // which is exactly what a bowtie-fan produces (crossed fan triangles
    // share edges with their neighbours in degenerate ways). Earcut on the
    // same polygon yields a manifold cap; no edge has more than 2
    // incidences.
    let Some(content) = read_fixture() else { return };
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let beam = decoder
        .decode_by_id(227)
        .expect("decode IfcBeam #227 (Revolution)");
    let mesh = router
        .process_element(&beam, &mut decoder)
        .expect("process revolution beam");

    let mut edge_count: std::collections::HashMap<(u32, u32), u32> =
        std::collections::HashMap::new();
    for tri in mesh.indices.chunks_exact(3) {
        for k in 0..3 {
            let a = tri[k];
            let b = tri[(k + 1) % 3];
            let key = if a < b { (a, b) } else { (b, a) };
            *edge_count.entry(key).or_insert(0) += 1;
        }
    }
    let non_manifold_edges: Vec<_> = edge_count
        .iter()
        .filter(|(_, &count)| count > 2)
        .collect();
    assert!(
        non_manifold_edges.is_empty(),
        "{} edges shared by 3+ triangles — cap triangulation is self-\
         intersecting (the centroid-fan bow-tie that PR #848 follow-up \
         was supposed to fix; see swept.rs::process for IfcRevolvedAreaSolid).\n\
         First few: {:?}",
        non_manifold_edges.len(),
        non_manifold_edges.iter().take(5).collect::<Vec<_>>(),
    );
}

#[test]
fn revolved_beam_is_flat_shaded_so_creases_stay_sharp() {
    // Issue #846 second follow-up: after the cap topology was fixed by
    // earcut, the rendered I-beam profile still looked like a smooth blob.
    // The cause: side quads + caps shared profile-ring vertices, so the
    // viewer's vertex-normal averaging blended the flange-face normal with
    // the perpendicular web-face normal at every crease — every sharp
    // 90° edge in the IPE200 cross-section came out smoothed.
    //
    // Fix: flat-shade the whole revolved solid (per-triangle vertex
    // duplication, each triangle carries its own face normal). Assert
    // both invariants the renderer relies on:
    //   1) positions and normals are parallel arrays (normals populated)
    //   2) every triangle's three vertex normals are identical → no
    //      averaging across creases is possible
    let Some(content) = read_fixture() else { return };
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let beam = decoder
        .decode_by_id(227)
        .expect("decode IfcBeam #227 (Revolution)");
    let mesh = router
        .process_element(&beam, &mut decoder)
        .expect("process revolution beam");

    assert_eq!(
        mesh.normals.len(),
        mesh.positions.len(),
        "revolved-solid mesh must ship per-vertex normals; got \
         {} normal floats for {} position floats — the viewer would \
         fall back to averaged normals and re-smooth every crease",
        mesh.normals.len(),
        mesh.positions.len(),
    );

    let mut mismatched_triangles = 0usize;
    for tri in mesh.indices.chunks_exact(3) {
        let (i0, i1, i2) = (tri[0] as usize, tri[1] as usize, tri[2] as usize);
        let n0 = &mesh.normals[i0 * 3..i0 * 3 + 3];
        let n1 = &mesh.normals[i1 * 3..i1 * 3 + 3];
        let n2 = &mesh.normals[i2 * 3..i2 * 3 + 3];
        let eq = |a: &[f32], b: &[f32]| {
            (a[0] - b[0]).abs() < 1e-5
                && (a[1] - b[1]).abs() < 1e-5
                && (a[2] - b[2]).abs() < 1e-5
        };
        if !(eq(n0, n1) && eq(n1, n2)) {
            mismatched_triangles += 1;
        }
    }
    assert_eq!(
        mismatched_triangles, 0,
        "{} triangles have non-identical vertex normals — the revolved \
         I-beam is being smooth-shaded again, so creases between the \
         flange faces and the web will render as a rounded blob \
         (see swept.rs::process — should call \
         PolygonalFaceSetProcessor::build_flat_shaded_mesh on the \
         finished mesh)",
        mismatched_triangles,
    );
}
