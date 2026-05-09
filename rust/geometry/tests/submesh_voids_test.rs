// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Per-sub-mesh void subtraction tests.
//!
//! Verifies that `process_element_with_submeshes_and_voids` preserves
//! per-item geometry IDs (so callers can look up per-layer `IfcStyledItem`
//! colors) while still cutting openings through every material layer.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::GeometryRouter;
use rustc_hash::FxHashMap;

/// Three-layer wall (3× `IfcExtrudedAreaSolid` in one `IfcShapeRepresentation`)
/// with one `IfcOpeningElement` linked via `IfcRelVoidsElement`.
///
/// The opening cuts through all three layers so every sub-mesh must lose
/// triangles after CSG — a regression guard against the single-mesh
/// void path that collapsed per-layer identity.
fn multi_layer_wall_with_opening_ifc() -> String {
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
#22=IFCCARTESIANPOINT((0.,0.,0.));
#23=IFCDIRECTION((0.,0.,1.));
#24=IFCDIRECTION((1.,0.,0.));
#30=IFCRECTANGLEPROFILEDEF(.AREA.,'Layer1',#31,4.0,0.1);
#31=IFCAXIS2PLACEMENT2D(#32,#33);
#32=IFCCARTESIANPOINT((0.,0.));
#33=IFCDIRECTION((1.,0.));
#40=IFCEXTRUDEDAREASOLID(#30,#41,#42,3.0);
#41=IFCAXIS2PLACEMENT3D(#43,$,$);
#42=IFCDIRECTION((0.,0.,1.));
#43=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCRECTANGLEPROFILEDEF(.AREA.,'Layer2',#51,4.0,0.1);
#51=IFCAXIS2PLACEMENT2D(#52,#53);
#52=IFCCARTESIANPOINT((0.,0.));
#53=IFCDIRECTION((1.,0.));
#60=IFCEXTRUDEDAREASOLID(#50,#61,#62,3.0);
#61=IFCAXIS2PLACEMENT3D(#63,$,$);
#62=IFCDIRECTION((0.,0.,1.));
#63=IFCCARTESIANPOINT((0.,0.1,0.));
#70=IFCRECTANGLEPROFILEDEF(.AREA.,'Layer3',#71,4.0,0.1);
#71=IFCAXIS2PLACEMENT2D(#72,#73);
#72=IFCCARTESIANPOINT((0.,0.));
#73=IFCDIRECTION((1.,0.));
#80=IFCEXTRUDEDAREASOLID(#70,#81,#82,3.0);
#81=IFCAXIS2PLACEMENT3D(#83,$,$);
#82=IFCDIRECTION((0.,0.,1.));
#83=IFCCARTESIANPOINT((0.,0.2,0.));
#90=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#40,#60,#80));
#91=IFCPRODUCTDEFINITIONSHAPE($,$,(#90));
#100=IFCWALL('0001234567890123456789',#2,'TestWall',$,$,#20,#91,'Test',$);
#110=IFCLOCALPLACEMENT(#20,#111);
#111=IFCAXIS2PLACEMENT3D(#112,#113,#114);
#112=IFCCARTESIANPOINT((1.5,0.1,0.5));
#113=IFCDIRECTION((0.,0.,1.));
#114=IFCDIRECTION((1.,0.,0.));
#120=IFCRECTANGLEPROFILEDEF(.AREA.,'OpeningProfile',#121,1.0,0.5);
#121=IFCAXIS2PLACEMENT2D(#122,#123);
#122=IFCCARTESIANPOINT((0.,0.));
#123=IFCDIRECTION((1.,0.));
#130=IFCEXTRUDEDAREASOLID(#120,#131,#132,1.5);
#131=IFCAXIS2PLACEMENT3D(#133,$,$);
#132=IFCDIRECTION((0.,0.,1.));
#133=IFCCARTESIANPOINT((0.,0.,0.));
#140=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#130));
#141=IFCPRODUCTDEFINITIONSHAPE($,$,(#140));
#200=IFCOPENINGELEMENT('0001234567890123456790',#2,'TestOpening',$,$,#110,#141,$,.OPENING.);
#300=IFCRELVOIDSELEMENT('0001234567890123456791',#2,$,$,#100,#200);
ENDSEC;
END-ISO-10303-21;
"#
    .to_string()
}

fn build_void_index(wall_id: u32, opening_id: u32) -> FxHashMap<u32, Vec<u32>> {
    let mut idx = FxHashMap::default();
    idx.insert(wall_id, vec![opening_id]);
    idx
}

#[test]
fn submeshes_with_voids_preserves_one_mesh_per_extrusion_item() {
    let content = multi_layer_wall_with_opening_ifc();
    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let wall = decoder.decode_by_id(100).expect("decode wall");
    let void_index = build_void_index(100, 200);

    let sub_meshes = router
        .process_element_with_submeshes_and_voids(&wall, &mut decoder, &void_index)
        .expect("submesh voids");

    // All three extrusion items must survive — the opening only removes a
    // local block, not an entire layer.
    assert_eq!(
        sub_meshes.sub_meshes.len(),
        3,
        "expected 3 sub-meshes (one per extrusion layer), got {}",
        sub_meshes.sub_meshes.len()
    );

    // Each sub-mesh must carry the original IfcExtrudedAreaSolid express ID
    // so that callers can look up the per-item IfcStyledItem color. This is
    // the entire point of the per-sub-mesh void path: layer colors survive.
    let mut ids: Vec<u32> = sub_meshes.sub_meshes.iter().map(|s| s.geometry_id).collect();
    ids.sort();
    assert_eq!(ids, vec![40, 60, 80], "sub-mesh geometry_ids must match extrusion IDs");

    for sub in &sub_meshes.sub_meshes {
        assert!(
            !sub.mesh.is_empty(),
            "sub-mesh #{} should not be empty after void subtraction",
            sub.geometry_id
        );
    }
}

#[test]
fn submeshes_with_voids_actually_removes_triangles() {
    let content = multi_layer_wall_with_opening_ifc();
    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let wall = decoder.decode_by_id(100).expect("decode wall");
    let void_index = build_void_index(100, 200);

    let uncut = router
        .process_element_with_submeshes(&wall, &mut decoder)
        .expect("submesh uncut");
    let cut = router
        .process_element_with_submeshes_and_voids(&wall, &mut decoder, &void_index)
        .expect("submesh cut");

    // At least one layer must lose triangles to the opening — otherwise CSG
    // never ran, which would indicate the void path silently no-ops.
    let uncut_tris: usize = uncut
        .sub_meshes
        .iter()
        .map(|s| s.mesh.triangle_count())
        .sum();
    let cut_tris: usize = cut
        .sub_meshes
        .iter()
        .map(|s| s.mesh.triangle_count())
        .sum();

    assert!(
        cut_tris != uncut_tris,
        "void subtraction should change triangle count: uncut={} cut={}",
        uncut_tris,
        cut_tris
    );
}

#[test]
fn submeshes_with_voids_returns_empty_without_opening_ids() {
    let content = multi_layer_wall_with_opening_ifc();
    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let wall = decoder.decode_by_id(100).expect("decode wall");
    let void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();

    let sub_meshes = router
        .process_element_with_submeshes_and_voids(&wall, &mut decoder, &void_index)
        .expect("submesh voids");

    // No openings → return empty so the caller can fall back to the
    // void-less sub-mesh path (or merged mesh path) without duplicating work.
    assert!(
        sub_meshes.is_empty(),
        "expected empty collection when no openings apply"
    );
}
