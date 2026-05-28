// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #842 — IfcRationalBSplineSurfaceWithKnots and
//! the surrounding IfcSphere markers were not being parsed.
//!
//! Fixture (`tests/models/issues/842_rational_bspline_surface.ifc`) declares
//! one IfcBuildingElementProxy whose ProductDefinitionShape carries a single
//! 'Surface3D' representation containing two 5×5 rational B-spline surfaces
//! plus nine IfcSphere markers (radius 0.05) at known anchor points.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;

const FIXTURE: &str = "../../tests/models/issues/842_rational_bspline_surface.ifc";

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping issue-842 regression: fixture missing at {FIXTURE} — \
                 run `pnpm fixtures` to fetch it"
            );
            None
        }
        Err(e) => panic!("failed to read fixture {FIXTURE}: {e}"),
    }
}

#[test]
fn bspline_surface_and_sphere_markers_produce_geometry() {
    let Some(content) = read_fixture() else {
        return;
    };

    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::new();

    let proxy = decoder
        .decode_by_id(22)
        .expect("decode IfcBuildingElementProxy #22");
    assert_eq!(proxy.ifc_type, IfcType::IfcBuildingElementProxy);

    let mesh = router
        .process_element(&proxy, &mut decoder)
        .expect("process IfcBuildingElementProxy");

    let vert_count = mesh.positions.len() / 3;
    let tri_count = mesh.indices.len() / 3;

    // Two 5×5 B-spline surfaces tessellated at adaptive resolution + nine
    // IfcSphere markers (24×16 each) should easily exceed these thresholds.
    // Lower bound deliberately loose to survive future tessellation tuning.
    assert!(
        vert_count >= 1_500,
        "expected ≥1500 vertices, got {vert_count}",
    );
    assert!(
        tri_count >= 1_500,
        "expected ≥1500 triangles, got {tri_count}",
    );

    // Sanity: bounds should span both surface patches (0..9 in local X) shifted
    // by the proxy's placement (+1 in X). The sphere markers anchor at known
    // points within that footprint, so combined extent is roughly [1, 10].
    let mut min_x = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    for chunk in mesh.positions.chunks_exact(3) {
        min_x = min_x.min(chunk[0]);
        max_x = max_x.max(chunk[0]);
    }
    assert!(
        min_x < 1.5 && max_x > 9.0,
        "expected combined surface span across world X≈[1,10], got [{min_x}, {max_x}]",
    );
}
