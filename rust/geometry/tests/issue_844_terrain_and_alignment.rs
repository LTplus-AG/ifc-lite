// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #844 — IfcGeographicElement (terrain) and
//! IfcAlignment (alignment curves) failed to render.
//!
//! `IfcGeographicElement` carries a normal 'Body','Tessellation'
//! representation with an `IfcTriangulatedFaceSet`, which the existing
//! dispatcher handles. The new ground IS recognised as a renderable
//! `IfcProduct` (`is_subtype_of(IfcElement)`); we just need to make sure
//! the existing pipeline reaches it.
//!
//! `IfcAlignment` carries its directrix in a dedicated `Axis`
//! (`IfcAlignmentCurve`) attribute instead of `Representation`. The new
//! `IfcAlignmentProcessor` samples that curve into a thin triangulated
//! ribbon. This test covers both paths against the reporter's fixture.

use ifc_lite_core::{has_geometry_by_name, EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;

const FIXTURE: &str = "../../tests/models/issues/844_terrain_and_alignment.ifc";

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping issue-844 regression: fixture missing at {FIXTURE} — \
                 run `pnpm fixtures` to fetch it"
            );
            None
        }
        Err(e) => panic!("failed to read fixture {FIXTURE}: {e}"),
    }
}

#[test]
fn geographic_element_terrain_mesh_renders() {
    let Some(content) = read_fixture() else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    // IfcGeographicElement must be recognised as a renderable product.
    assert!(
        has_geometry_by_name("IFCGEOGRAPHICELEMENT"),
        "IFCGEOGRAPHICELEMENT should be classified as a geometry-bearing IfcProduct",
    );

    // #30 = first IfcGeographicElement (Terrain) — Body / Tessellation.
    let terrain = decoder
        .decode_by_id(30)
        .expect("decode IfcGeographicElement #30");
    assert_eq!(terrain.ifc_type, IfcType::IfcGeographicElement);

    let mesh = router
        .process_element(&terrain, &mut decoder)
        .expect("process terrain element");

    assert!(
        mesh.indices.len() / 3 > 10,
        "expected the terrain mesh to tessellate to >10 triangles, got {}",
        mesh.indices.len() / 3,
    );
}

#[test]
fn alignment_curve_renders_as_ribbon() {
    let Some(content) = read_fixture() else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    // IfcAlignment passes the renderable-product classifier.
    assert!(
        has_geometry_by_name("IFCALIGNMENT"),
        "IFCALIGNMENT should be classified as a geometry-bearing IfcProduct",
    );

    // #59 = 'A1' — the longest alignment (8 horizontal + 24 vertical
    // segments), good for exercising the ribbon sampler.
    let alignment = decoder.decode_by_id(59).expect("decode IfcAlignment #59");
    assert_eq!(alignment.ifc_type, IfcType::IfcAlignment);

    let mesh = router
        .process_element(&alignment, &mut decoder)
        .expect("process alignment");

    let tri_count = mesh.indices.len() / 3;
    assert!(
        tri_count > 50,
        "expected the alignment ribbon to span many segments, got {tri_count} triangles",
    );

    // Ribbon must form a contiguous span — at least 2 m on its longest axis.
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for chunk in mesh.positions.chunks_exact(3) {
        for axis in 0..3 {
            min[axis] = min[axis].min(chunk[axis]);
            max[axis] = max[axis].max(chunk[axis]);
        }
    }
    let longest = (max[0] - min[0]).max(max[1] - min[1]).max(max[2] - min[2]);
    assert!(
        longest > 2.0,
        "alignment ribbon collapsed (longest axis span = {longest} m)",
    );
}
