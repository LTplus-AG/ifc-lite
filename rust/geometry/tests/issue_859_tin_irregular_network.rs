// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #859 follow-up — the reporter's
//! `UT_Tin_in_MGA_56.ifc` (terrain mesh authored as
//! `IfcTriangulatedIrregularNetwork`, IFC4x3 TIN entity) rendered as
//! an empty viewport because the geometry router rejected the
//! representation with `"Unsupported representation type:
//! IfcTriangulatedIrregularNetwork"`.
//!
//! TIN is a subtype of `IfcTriangulatedFaceSet` that adds an optional
//! `ClosedOrOpen` list at the tail. The inherited Coordinates / Closed /
//! CoordIndex layout is identical, so routing TIN through the existing
//! `TriangulatedFaceSetProcessor` is correct. The fix registers TIN in
//! `supported_types()` and threads it through the matching arms in
//! `router/processing.rs` (RTC detection) and `router/layers.rs`
//! (no-position geometry).
//!
//! Pairs with PR #866 (issue #860, recognising `IfcSolidStratum` as a
//! geometry-bearing leaf) which is what allowed the entity to reach the
//! geometry pipeline in the first place — before #866 it was silently
//! dropped at `has_geometry_by_name`. This test guards the next step:
//! TIN must actually produce a mesh.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::GeometryRouter;

/// Build a minimal IFC4x3 file with a single IfcSolidStratum whose body
/// is an IfcTriangulatedIrregularNetwork — a 2×2 grid of vertices
/// triangulated into two triangles (the simplest possible TIN). Pre-fix
/// this errored at the router; post-fix it returns a 4-vertex, 2-triangle
/// mesh.
fn minimal_tin_ifc() -> String {
    r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('0123456789012345678901',#2,'TINProject',$,$,$,$,(#10),#7);
#2=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#3=IFCPERSONANDORGANIZATION(#5,#6,$);
#4=IFCAPPLICATION(#6,'1.0','Test','Test');
#5=IFCPERSON($,'Test',$,$,$,$,$,$);
#6=IFCORGANIZATION($,'Test',$,$,$);
#7=IFCUNITASSIGNMENT((#8));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#12,$,$);
#30=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(10.,0.,0.),(10.,10.,1.),(0.,10.,0.)));
#31=IFCTRIANGULATEDIRREGULARNETWORK(#30,$,$,((1,2,3),(1,3,4)),$,$);
#32=IFCSHAPEREPRESENTATION(#13,'Body','Tessellation',(#31));
#33=IFCPRODUCTDEFINITIONSHAPE($,$,(#32));
#40=IFCGEOGRAPHICELEMENT('1aB2cD3eF4gH5iJ6kL7mNo','Terrain',$,$,$,#20,#33,$,$);
ENDSEC;
END-ISO-10303-21;
"#
    .to_string()
}

#[test]
fn tin_renders_as_triangle_mesh() {
    let content = minimal_tin_ifc();
    let entity_index = ifc_lite_core::build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, entity_index);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let element = decoder
        .decode_by_id(40)
        .expect("decode the IfcGeographicElement (#40) carrying the TIN");

    let mesh = router
        .process_element(&element, &mut decoder)
        .expect(
            "process IfcTriangulatedIrregularNetwork — pre-fix this errored \
             'Unsupported representation type: IfcTriangulatedIrregularNetwork' \
             because the router never registered TIN against the existing \
             TriangulatedFaceSetProcessor",
        );

    assert!(
        !mesh.positions.is_empty(),
        "TIN must produce vertices — got an empty mesh, which means the \
         processor accepted the type but bailed without emitting geometry",
    );
    assert_eq!(
        mesh.indices.len() % 3,
        0,
        "TIN must produce whole triangles — index count {} is not divisible by 3",
        mesh.indices.len(),
    );
    assert_eq!(
        mesh.indices.len() / 3,
        2,
        "Authored 2 triangles in the fixture; got {} after processing — \
         a different triangle count means the inherited CoordIndex was \
         parsed differently for the TIN subtype than for plain \
         IfcTriangulatedFaceSet",
        mesh.indices.len() / 3,
    );

    // Sanity-check the triangulated coordinates — the TIN authored four
    // distinct (x, y) corners on a 10 m square. After flat-shading the
    // processor duplicates verts per triangle (6 verts for 2 tris), so we
    // care about the bbox, not the literal vertex count.
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for chunk in mesh.positions.chunks_exact(3) {
        for k in 0..3 {
            min[k] = min[k].min(chunk[k]);
            max[k] = max[k].max(chunk[k]);
        }
    }
    let span_x = max[0] - min[0];
    let span_y = max[1] - min[1];
    assert!(
        (span_x - 10.0).abs() < 1e-3 && (span_y - 10.0).abs() < 1e-3,
        "TIN bbox span ({span_x:.3}, {span_y:.3}) should be (10.0, 10.0) m — \
         the authored corners are (0,0,0) (10,0,0) (10,10,1) (0,10,0)",
    );
}
