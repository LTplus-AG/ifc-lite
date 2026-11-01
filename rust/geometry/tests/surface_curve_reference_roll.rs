// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcSurfaceCurveSweptAreaSolid` must roll its section by the
//! ReferenceSurface (ISO 10303-42: Axis1 = surface normal, Axis3 = directrix
//! tangent, Axis2 = Axis3 x Axis1). Revit exports slab edges and light
//! fixtures this way: an arbitrary profile swept along a trimmed `IfcCircle`
//! lying on an `IfcSurfaceOfLinearExtrusion`. The rotation-minimising frame
//! rolled those sections 90° (width and height swapped, e.g. in Autodesk's
//! Snowdon Towers sample), issue #8437.
//!
//! Neutral fixture: a 0.2 x 1.0 L-bounded section (profile x in [0, 0.2], y in
//! [-1, 0]) along a 30° arc of radius 10 in the XY plane, reference surface
//! extruded along -Z. The surface normal is dS/du x dS/dv = C'(u) x D, so its
//! sign follows the surface's SweptCurve, not the directrix. Three elements
//! cover the directions; IfcOpenShell 0.8.5 gives the same bounds for all
//! three (the oracle):
//!   - #32, both forward: N points to the arc centre and Axis2 = +Z, so the
//!     section hangs 1.0 below the directrix and is 0.2 deep towards the centre.
//!   - #46, SweptCurve reversed (`SenseAgreement` .F.): N flips outward and
//!     Axis2 to -Z, so the section stands above the directrix, outward.
//!   - #53, directrix reversed (a separate clockwise arc): N stays inward,
//!     Axis3 flips and Axis2 with it, so the section stands above, inward.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::GeometryRouter;

const FIXTURE: &str = "tests/fixtures/surface_curve_reference_roll.ifc";

/// (min z, max z, min radius, max radius) of the mesh of element `id`.
fn extent(id: u32) -> [f32; 4] {
    let content = std::fs::read_to_string(FIXTURE)
        .unwrap_or_else(|e| panic!("failed to read fixture {FIXTURE}: {e}"));
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let element = decoder.decode_by_id(id).unwrap_or_else(|e| panic!("decode #{id}: {e}"));
    assert_eq!(element.ifc_type, IfcType::IfcBuildingElementProxy);
    let mesh = router
        .process_element(&element, &mut decoder)
        .unwrap_or_else(|e| panic!("process #{id}: {e}"));
    assert!(!mesh.indices.is_empty(), "#{id} produced no geometry");

    let mut out = [f32::INFINITY, f32::NEG_INFINITY, f32::INFINITY, 0.0f32];
    for p in mesh.positions.chunks_exact(3) {
        let r = (p[0] * p[0] + p[1] * p[1]).sqrt();
        out = [out[0].min(p[2]), out[1].max(p[2]), out[2].min(r), out[3].max(r)];
    }
    out
}

fn assert_extent(id: u32, expected: [f32; 4]) {
    let actual = extent(id);
    let names = ["min z", "max z", "inner radius", "outer radius"];
    for i in 0..4 {
        assert!(
            (actual[i] - expected[i]).abs() < 1e-3,
            "#{id} {}: {} != {} (all: {actual:?})",
            names[i],
            actual[i],
            expected[i]
        );
    }
}

#[test]
fn section_follows_the_linear_extrusion_reference_surface() {
    // The rotation-minimising frame gave a 0.2-tall section here.
    assert_extent(32, [-1.0, 0.0, 9.8, 10.0]);
}

#[test]
fn reversed_swept_curve_flips_the_reference_normal() {
    assert_extent(46, [0.0, 1.0, 10.0, 10.2]);
}

#[test]
fn reversed_directrix_keeps_the_reference_normal() {
    assert_extent(53, [0.0, 1.0, 9.8, 10.0]);
}
