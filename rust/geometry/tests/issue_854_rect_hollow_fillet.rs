// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #854 — `IfcRectangleHollowProfileDef`
//! must honour `InnerFilletRadius` (attr 6) and `OuterFilletRadius`
//! (attr 7), not just the wall thickness.
//!
//! Fixture is the reporter's air-terminal model:
//!   #275= IFCRECTANGLEHOLLOWPROFILEDEF(.AREA.,$,$,
//!         24., 24., 2., 10., 0.);
//!
//! XDim=24, YDim=24, WallThickness=2 → inner half-extent = 10.
//! InnerFilletRadius = 10 == inner_half_x == inner_half_y, so the
//! inner hole MUST be a perfect circle (the four inner quarter arcs
//! meet at the cardinal axes). OuterFilletRadius = 0 keeps the outer
//! corners sharp.
//!
//! Pre-fix `process_rectangle_hollow` ignored both fillet attributes
//! and emitted a 4-corner inner rectangle. Symptom in the viewer:
//! square inner hole where the user authored a round one.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::GeometryRouter;

const FIXTURE: &str = "../../tests/models/issues/854_air_terminal_hollow_fillet.ifc";
const AIR_TERMINAL_ID: u32 = 331;

fn read_fixture() -> Option<String> {
    match std::fs::read_to_string(FIXTURE) {
        Ok(s) => Some(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("issue-854 fixture missing — skipping (run `pnpm fixtures`)");
            None
        }
        Err(e) => panic!("failed to read fixture: {e}"),
    }
}

#[test]
fn issue_854_inner_hole_is_round_when_inner_fillet_equals_half() {
    let Some(content) = read_fixture() else { return };
    let ei = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, ei);
    let entity = decoder
        .decode_by_id(AIR_TERMINAL_ID)
        .expect("air terminal #331");
    let router = GeometryRouter::with_units(&content, &mut decoder);
    let mesh = router
        .process_element(&entity, &mut decoder)
        .expect("air terminal must mesh");

    // The diffuser body is a hollow rectangular prism: square outer
    // shell + cylindrical inner bore. Pre-fix the inner bore was a
    // 4-side rectangular tube (8 vertices around the inner). Post-fix
    // the inner has the fillet's 24 outer vertices per cap (6 segments
    // × 4 corners), which collapse to a circle when the fillet radius
    // equals the inner half-dim.
    //
    // We don't expose the per-loop vertex breakdown post-triangulation,
    // so check the proxy: the total vertex count must be well above the
    // pre-fix 16 (8 outer + 8 inner ×2 caps, plus side walls). A round
    // inner bore tessellated at 6 segments/corner yields 24+ inner cap
    // vertices, pushing the mesh past ~80 verts.
    let n_verts = mesh.positions.len() / 3;
    assert!(
        n_verts > 60,
        "expected rounded inner bore (>= ~80 verts after sharing); got {} \
         (was the InnerFilletRadius silently ignored?)",
        n_verts,
    );

    // And the bore must actually be round on average — sample inner
    // vertices and verify their distance from the profile centre is
    // close to the authored fillet radius (10).
    //
    // "Inner" vertices are those whose XY distance from the profile
    // centroid is between 8 and 12 in the local frame (XYDim = 24,
    // wall = 2 → inner half = 10). The bore axis is along Z (the
    // extruded-area solid's extrude direction in this fixture); we
    // discard Z and check that all such vertices sit on a circle of
    // radius ≈ 10 with ≤ 1 % deviation.
    //
    // The local-to-world transform on this fixture is identity (no
    // rotation, no translation on the air terminal type's Position),
    // so the world XY matches the profile XY.
    // The fixture's IfcUnitAssignment overrides the SI metre with an
    // inch conversion (#31). The geometry pipeline applies the
    // 0.0254 m/in factor before we see the mesh, so the 24×24 inch
    // profile lands as a 0.6096×0.6096 m box and the inner fillet
    // radius = 10 inches = 0.254 m.
    const M_PER_IN: f64 = 0.0254;
    let inner_r_expected = 10.0 * M_PER_IN;

    let (mut xmin, mut xmax, mut ymin, mut ymax) =
        (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for i in 0..n_verts {
        let x = mesh.positions[i * 3] as f64;
        let y = mesh.positions[i * 3 + 1] as f64;
        if x < xmin { xmin = x; }
        if x > xmax { xmax = x; }
        if y < ymin { ymin = y; }
        if y > ymax { ymax = y; }
    }
    let cx = 0.5 * (xmin + xmax);
    let cy = 0.5 * (ymin + ymax);
    // The fixture's solid is an IfcExtrudedAreaSolidTapered with a 0.5
    // scale on the end profile — so the body has TWO inner bores:
    //   * bottom cap @ z=0:   inner radius = 10" = 0.2540 m
    //   * top cap @ z=4":     inner radius =  5" = 0.1270 m  (50 % scale)
    // Only the bottom cap exercises the fillet code path we're testing;
    // the top cap's inner bore inherits via IfcDerivedProfileDef's
    // operator, which is a separate concern. Sample a tight ±2 % window
    // around the start-profile bore so we don't catch the smaller top
    // bore OR the top cap's outer corner at r = 0.2156.
    let mut inner_radii = Vec::new();
    for i in 0..n_verts {
        let x = mesh.positions[i * 3] as f64 - cx;
        let y = mesh.positions[i * 3 + 1] as f64 - cy;
        let r = (x * x + y * y).sqrt();
        if (0.98 * inner_r_expected..1.02 * inner_r_expected).contains(&r) {
            inner_radii.push(r);
        }
    }
    assert!(
        inner_radii.len() >= 24,
        "expected >= 24 inner-bore vertices (rounded inner), got {} — \
         InnerFilletRadius probably ignored. bounds=({:.3},{:.3})..({:.3},{:.3})",
        inner_radii.len(),
        xmin, ymin, xmax, ymax,
    );
    let mean: f64 = inner_radii.iter().sum::<f64>() / inner_radii.len() as f64;
    let max_dev = inner_radii
        .iter()
        .map(|r| (r - mean).abs())
        .fold(0.0_f64, f64::max);
    assert!(
        (mean - inner_r_expected).abs() < 0.005,
        "inner-bore mean radius = {:.4} m, expected ≈ {:.4} m",
        mean, inner_r_expected,
    );
    assert!(
        max_dev / mean < 0.01,
        "inner-bore not circular: max deviation {:.5} / mean {:.4} = {:.2}%",
        max_dev,
        mean,
        100.0 * max_dev / mean,
    );
}
