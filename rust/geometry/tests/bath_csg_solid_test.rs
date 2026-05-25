// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #780 — the buildingSMART IFC 4.3 bath
//! `csg-solid.ifc` reference (Annex E "Advanced Geometric Shape →
//! bath-csg-solid"). The bath is authored as
//!
//!     IfcSanitaryTerminal
//!       └─ IfcMappedItem
//!            └─ IfcRepresentationMap → IfcShapeRepresentation 'SolidModel'
//!                 └─ IfcCsgSolid
//!                      └─ IfcBooleanResult(.DIFFERENCE.,
//!                              IfcBlock(2000 × 800 × 800),
//!                              IfcExtrudedAreaSolid(
//!                                  IfcRoundedRectangleProfileDef(1800, 600, r=200),
//!                                  depth=700))
//!
//! Pre-fix, none of `IfcCsgSolid`, `IfcBlock` or `IfcRoundedRectangleProfileDef`
//! had geometry processors — the router emitted an empty mesh. This test
//! pins:
//!   - the whole product produces a non-empty world-space mesh,
//!   - the world bbox matches the IFC values converted to metres
//!     (2.000 × 0.800 × 0.800 m, file declares millimetres),
//!   - the cut removed actual volume (final volume < uncut block volume).

use ifc_lite_core::{build_entity_index, EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;

const FIXTURE: &str = "tests/fixtures/bath_csg_solid.ifc";

fn bbox(positions: &[f32]) -> ((f32, f32, f32), (f32, f32, f32)) {
    let mut mn = (f32::INFINITY, f32::INFINITY, f32::INFINITY);
    let mut mx = (f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
    for c in positions.chunks_exact(3) {
        mn.0 = mn.0.min(c[0]);
        mn.1 = mn.1.min(c[1]);
        mn.2 = mn.2.min(c[2]);
        mx.0 = mx.0.max(c[0]);
        mx.1 = mx.1.max(c[1]);
        mx.2 = mx.2.max(c[2]);
    }
    (mn, mx)
}

/// Sum of signed tetrahedron volumes spanned from origin to each triangle.
/// Works for any closed orientable mesh whose triangles are CCW from
/// outside; for an unwelded watertight box this returns the exact volume.
fn signed_volume(positions: &[f32], indices: &[u32]) -> f64 {
    let mut total = 0.0f64;
    for tri in indices.chunks_exact(3) {
        let i0 = tri[0] as usize * 3;
        let i1 = tri[1] as usize * 3;
        let i2 = tri[2] as usize * 3;
        let v0 = (
            positions[i0] as f64,
            positions[i0 + 1] as f64,
            positions[i0 + 2] as f64,
        );
        let v1 = (
            positions[i1] as f64,
            positions[i1 + 1] as f64,
            positions[i1 + 2] as f64,
        );
        let v2 = (
            positions[i2] as f64,
            positions[i2 + 1] as f64,
            positions[i2 + 2] as f64,
        );
        total += (v0.0 * (v1.1 * v2.2 - v1.2 * v2.1)
            + v1.0 * (v2.1 * v0.2 - v2.2 * v0.1)
            + v2.0 * (v0.1 * v1.2 - v0.2 * v1.1))
            / 6.0;
    }
    total.abs()
}

fn find_sanitary_terminal_id(content: &str) -> Option<u32> {
    let mut scanner = ifc_lite_core::EntityScanner::new(content);
    while let Some((id, name, _, _)) = scanner.next_entity() {
        if name == "IFCSANITARYTERMINAL" {
            return Some(id);
        }
    }
    None
}

#[test]
fn bath_csg_solid_produces_non_empty_mesh() {
    let content = std::fs::read_to_string(FIXTURE).expect("bath fixture present");
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let bath_id = find_sanitary_terminal_id(&content).expect("bath product present in fixture");
    let bath = decoder.decode_by_id(bath_id).expect("decode bath product");
    assert_eq!(bath.ifc_type, IfcType::IfcSanitaryTerminal);

    let mesh = router
        .process_element(&bath, &mut decoder)
        .expect("router must dispatch the IfcCsgSolid → IfcBooleanResult → IfcBlock chain");

    assert!(
        !mesh.positions.is_empty(),
        "bath produced an empty mesh — CSG primitive support regressed"
    );
    assert!(
        !mesh.indices.is_empty(),
        "bath produced vertices but no triangles"
    );

    // File declares LENGTHUNIT MILLI METRE; with_units must scale to metres.
    // Block extends from (0,0,0) to (2000,800,800) mm → (2.0, 0.8, 0.8) m.
    let (mn, mx) = bbox(&mesh.positions);
    let tol = 0.005_f32; // 5 mm
    assert!((mn.0 - 0.0).abs() < tol, "min.x = {}", mn.0);
    assert!((mn.1 - 0.0).abs() < tol, "min.y = {}", mn.1);
    assert!((mn.2 - 0.0).abs() < tol, "min.z = {}", mn.2);
    assert!((mx.0 - 2.0).abs() < tol, "max.x = {}", mx.0);
    assert!((mx.1 - 0.8).abs() < tol, "max.y = {}", mx.1);
    assert!((mx.2 - 0.8).abs() < tol, "max.z = {}", mx.2);
}

#[test]
fn bath_csg_solid_subtracted_a_cavity() {
    let content = std::fs::read_to_string(FIXTURE).expect("bath fixture present");
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let bath_id = find_sanitary_terminal_id(&content).expect("bath product present");
    let bath = decoder.decode_by_id(bath_id).expect("decode bath product");

    let mesh = router
        .process_element(&bath, &mut decoder)
        .expect("router dispatch succeeds");

    let block_volume = 2.0 * 0.8 * 0.8; // 1.28 m³
    let v = signed_volume(&mesh.positions, &mesh.indices);
    let tris = mesh.indices.len() / 3;

    // The void is 1.8 × 0.6 × 0.7 m ≈ 0.73 m³ once the rounded corners are
    // accounted for, so a full cut leaves ~0.55 m³. Manifold (native build)
    // lands within 1 % of that. The legacy BSP path (the WASM build's only
    // option until Manifold gets a wasm32 target) cuts less aggressively
    // around the rounded corner walls and lands around 0.75 m³ — still a
    // real cut, just with a coarser cavity. Assert "cavity exists" rather
    // than pinning a volume so both kernels pass without the test becoming
    // a flake; the kernel-specific numbers are confirmed by the
    // [bath_csg_solid_produces_non_empty_mesh] bbox checks and by visual
    // inspection in the viewer.
    assert!(
        tris > 12,
        "expected cut to add geometry; got just {} tris (≤ uncut box)",
        tris
    );
    assert!(
        v < block_volume * 0.8,
        "no detectable cavity — final volume {:.4} m³ vs full block {:.4} m³",
        v,
        block_volume
    );
    assert!(
        v > 0.3 && v < 0.95,
        "post-cut volume {:.4} m³ outside the [0.3, 0.95] band that catches \
         both kernels' real cuts but flags the uncut-host fallback",
        v
    );
}

#[test]
fn bath_csg_solid_has_no_spike_triangles() {
    // Issue #780 follow-up: the BSP-output spike triangles (long thin slivers
    // radiating from sub-divided cutter outline points to the bath outer
    // rim) used to come from input triangles being fed unmerged, so every
    // cutter wall plane sliced the bath's 2-tri faces along their internal
    // diagonal. After the coplanar pre- and post-merge passes in
    // `ClippingProcessor::mesh_to_polygons` / `consolidate_coplanar`, the
    // worst-case triangle aspect ratio on the bath has to stay reasonable
    // — anything > 50:1 is the regression signature.
    let content = std::fs::read_to_string(FIXTURE).expect("bath fixture present");
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let bath_id = find_sanitary_terminal_id(&content).expect("bath product present");
    let bath = decoder.decode_by_id(bath_id).expect("decode bath product");

    let mesh = router
        .process_element(&bath, &mut decoder)
        .expect("router dispatch succeeds");

    let mut max_ratio = 0.0_f32;
    let mut spike_count = 0usize;
    for tri in mesh.indices.chunks_exact(3) {
        let p: Vec<(f32, f32, f32)> = tri
            .iter()
            .map(|&i| {
                let o = i as usize * 3;
                (
                    mesh.positions[o],
                    mesh.positions[o + 1],
                    mesh.positions[o + 2],
                )
            })
            .collect();
        let d = |a: (f32, f32, f32), b: (f32, f32, f32)| {
            ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2) + (a.2 - b.2).powi(2)).sqrt()
        };
        let e1 = d(p[0], p[1]);
        let e2 = d(p[1], p[2]);
        let e3 = d(p[2], p[0]);
        let mn = e1.min(e2).min(e3);
        let mx = e1.max(e2).max(e3);
        if mn > 0.0 {
            let r = mx / mn;
            max_ratio = max_ratio.max(r);
            if r > 50.0 {
                spike_count += 1;
            }
        }
    }
    assert_eq!(
        spike_count, 0,
        "produced {} sliver-spike triangles (aspect > 50:1), max ratio {:.1} — BSP fragmentation regressed",
        spike_count, max_ratio
    );
}

#[test]
fn bath_csg_solid_triangle_budget() {
    // Manifold lands at ~124 tris on this fixture; the BSP path with the
    // post-merge consolidation lands around 50–90. Pin a ceiling well above
    // both so the test is stable across kernel choice, but low enough to
    // catch the un-consolidated 189-triangle BSP regression.
    let content = std::fs::read_to_string(FIXTURE).expect("bath fixture present");
    let entity_index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let bath_id = find_sanitary_terminal_id(&content).expect("bath product present");
    let bath = decoder.decode_by_id(bath_id).expect("decode bath product");
    let mesh = router
        .process_element(&bath, &mut decoder)
        .expect("router dispatch succeeds");

    let tris = mesh.indices.len() / 3;
    assert!(
        tris < 150,
        "bath triangle count grew to {} (>150) — coplanar consolidation likely regressed",
        tris
    );
}
