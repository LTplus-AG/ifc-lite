// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression: high-vertex `IfcOpeningElement` voids must still be cut under the
//! per-element LOCAL FRAME (#1297).
//!
//! In wasm the host mesh is stored relative to its per-element AABB-centre origin
//! (`world = origin + position`, default ON). The void cut runs host AND cutters
//! in that shared frame: `apply_void_context` relativises WORLD-coordinate cutters
//! by the host origin. The >100-vertex opening path in `classify_openings`,
//! however, sourced its cutter from `process_element`, which — under the local
//! frame — returns the opening in the OPENING'S OWN local frame (positions
//! relative to the opening's centre). That origin was never folded back in, so the
//! cutter (and its #635 fallback AABB) landed a whole building placement away from
//! the host, the AABB-overlap guard skipped it, the CSG was a silent no-op, and
//! the host rendered SOLID (no holes, `total_csg_failures = 0`).
//!
//! Native was unaffected (local frame OFF → cutters already world-framed), so the
//! bug only ever showed in the browser. This file runs in its OWN test binary so
//! it can force the local frame on (the flag is read once and cached per process).

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner, IfcType};
use ifc_lite_geometry::{GeometryRouter, Mesh};
use rustc_hash::FxHashMap;

/// A 40 m × 40 m × 2 m steel-style plate placed 200 m / 300 m from the origin
/// (so its per-element local origin is large in X and Y), with a single round
/// hole through its thickness. A radius-16 circle tessellates to the 32-segment
/// cap maximum, so the meshed opening clears the 100-vertex threshold and takes
/// the `classify_openings` high-vertex path — the one #1297 broke. The hole
/// extrusion (z = -1 .. 3) fully penetrates the plate (z = 0 .. 2).
fn plate_with_round_hole_far_from_origin_ifc() -> &'static str {
    r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1234567890123456789012',#2,'Test',$,$,$,$,(#10),#7);
#2=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#3=IFCPERSONANDORGANIZATION(#5,#6,$);
#4=IFCAPPLICATION(#6,'1.0','Test','Test');
#5=IFCPERSON($,'Test',$,$,$,$,$,$);
#6=IFCORGANIZATION($,'Test',$,$,$);
#7=IFCUNITASSIGNMENT((#8,#9));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#9=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,#23,#24);
#22=IFCCARTESIANPOINT((200.,300.,0.));
#23=IFCDIRECTION((0.,0.,1.));
#24=IFCDIRECTION((1.,0.,0.));
#30=IFCRECTANGLEPROFILEDEF(.AREA.,'Plate',#31,40.0,40.0);
#31=IFCAXIS2PLACEMENT2D(#32,#33);
#32=IFCCARTESIANPOINT((0.,0.));
#33=IFCDIRECTION((1.,0.));
#40=IFCEXTRUDEDAREASOLID(#30,#41,#42,2.0);
#41=IFCAXIS2PLACEMENT3D(#43,$,$);
#42=IFCDIRECTION((0.,0.,1.));
#43=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#40));
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#100=IFCPLATE('0001234567890123456789',#2,'TestPlate',$,$,#20,#51,'Tag',$);
#60=IFCLOCALPLACEMENT(#20,#61);
#61=IFCAXIS2PLACEMENT3D(#62,#63,#64);
#62=IFCCARTESIANPOINT((0.,0.,-1.));
#63=IFCDIRECTION((0.,0.,1.));
#64=IFCDIRECTION((1.,0.,0.));
#70=IFCCIRCLEPROFILEDEF(.AREA.,'Hole',#71,16.0);
#71=IFCAXIS2PLACEMENT2D(#72,#73);
#72=IFCCARTESIANPOINT((0.,0.));
#73=IFCDIRECTION((1.,0.));
#80=IFCEXTRUDEDAREASOLID(#70,#81,#82,4.0);
#81=IFCAXIS2PLACEMENT3D(#83,$,$);
#82=IFCDIRECTION((0.,0.,1.));
#83=IFCCARTESIANPOINT((0.,0.,0.));
#90=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#80));
#91=IFCPRODUCTDEFINITIONSHAPE($,$,(#90));
#110=IFCOPENINGELEMENT('0001234567890123456790',#2,'Hole',$,$,#60,#91,$,.OPENING.);
#120=IFCRELVOIDSELEMENT('0001234567890123456791',#2,$,$,#100,#110);
ENDSEC;
END-ISO-10303-21;
"#
}

/// Signed mesh volume (divergence theorem). Folds the per-element `origin` back in
/// so the figure is comparable whether or not the local frame is active.
fn mesh_volume(mesh: &Mesh) -> f64 {
    let o = mesh.origin;
    mesh.indices
        .chunks_exact(3)
        .map(|t| {
            let v = |i: u32| {
                let b = i as usize * 3;
                [
                    mesh.positions[b] as f64 + o[0],
                    mesh.positions[b + 1] as f64 + o[1],
                    mesh.positions[b + 2] as f64 + o[2],
                ]
            };
            let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
            a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0])
        })
        .sum::<f64>()
        / 6.0
}

fn build_void_index(content: &str) -> FxHashMap<u32, Vec<u32>> {
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut decoder = EntityDecoder::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name != "IFCRELVOIDSELEMENT" {
            continue;
        }
        if let Ok(entity) = decoder.decode_at_with_id(id, start, end) {
            if let (Some(host_id), Some(opening_id)) = (entity.get_ref(4), entity.get_ref(5)) {
                void_index.entry(host_id).or_default().push(opening_id);
            }
        }
    }
    void_index
}

#[test]
fn high_vertex_opening_is_cut_under_per_element_local_frame() {
    // Force the local frame on BEFORE any geometry call reads & caches the flag.
    // Safe: this file is its own test binary, so nothing else reads it first.
    std::env::set_var("IFC_LITE_LOCAL_FRAME", "1");

    let content = plate_with_round_hole_far_from_origin_ifc();
    let entity_index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, entity_index);
    let router = GeometryRouter::with_units(content, &mut decoder);
    let void_index = build_void_index(content);

    assert_eq!(
        void_index.get(&100).map(Vec::as_slice),
        Some([110u32].as_slice()),
        "the void index must associate opening #110 with plate #100"
    );

    let plate = decoder.decode_by_id(100).expect("decode plate #100");
    assert_eq!(plate.ifc_type, IfcType::IfcPlate);

    let mesh = router
        .process_element_with_voids(&plate, &mut decoder, &void_index)
        .expect("plate-with-void path ok");

    // The mesh must be in a per-element local frame (proves the bug's precondition
    // is actually exercised; a world-framed host never triggered #1297).
    assert_ne!(
        mesh.origin, [0.0, 0.0, 0.0],
        "the host plate must be stored in its per-element local frame"
    );

    // Uncut plate = 40 × 40 × 2 = 3200 m3; the hole removes pi r^2 * 2 = ~1608 m3
    // (r = 16, thickness 2). #1297: the cut was silently dropped, leaving the full
    // 3200 m3 solid plate. A real cut lands well under the uncut volume.
    let uncut = 40.0 * 40.0 * 2.0;
    let vol = mesh_volume(&mesh);
    assert!(
        vol < uncut - 1000.0,
        "the round hole was not cut (solid plate) — #1297 regression: \
         cut volume = {vol} m3, uncut plate = {uncut} m3"
    );

    // A solid box plate is 12 triangles; a cut plate carries the annular caps +
    // cylinder wall, an order of magnitude more. Pins the cut against a silent
    // no-op that still returns the (uncut) host mesh.
    let tris = mesh.indices.len() / 3;
    assert!(
        tris > 30,
        "expected a cut plate (annulus + bore wall), got {tris} triangles \
         (an uncut box plate is 12) — the void cut was dropped"
    );
}
