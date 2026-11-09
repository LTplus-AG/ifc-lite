// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #8291: the real product walk captures authored face-set rows, with no kernel.
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::{document::{RetainedFaceSet, RetainedRecipe}, program::transactions::{OperationKind, Traversal}, GeometryRouter};

const SCAFFOLD: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X1'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#9=IFCLOCALPLACEMENT($,#5);
#20=IFCBUILDINGELEMENTPROXY('s',$,'Set',$,$,#9,#21,$,.NOTDEFINED.);
#21=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));#22=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#33));
#30=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1000.,0.,0.),(0.,1000.,0.),(0.,0.,1000.)));
/*BODY*/
ENDSEC;END-ISO-10303-21;";

fn captured(body: &str) -> RetainedFaceSet {
    let text = SCAFFOLD.replace("/*BODY*/", body);
    let source = SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&text, &mut decoder);
    let product = decoder.decode_by_id(20).unwrap();
    let traversal = Traversal::new(1, 1);
    let mut program = traversal.product_parts(&product);
    let mut found = None;
    while let Some(ticket) = program.request().unwrap() {
        let (reply, operations, _storage) = program.admit(ticket, &router, &mut decoder).unwrap();
        for operation in operations {
            if let OperationKind::Construction(RetainedRecipe::FaceSet(set)) = operation.kind() { found = Some(set.clone()); }
        }
        program.accept(reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    found.expect("one face-set construction")
}

#[test]
fn issue_8291_polygon_rows_are_authored_face_positions_through_the_product_walk() {
    let set = captured("#40=IFCINDEXEDPOLYGONALFACE((1,2,3));#41=IFCINDEXEDPOLYGONALFACE((1,2));#42=IFCINDEXEDPOLYGONALFACE((1,4,2));
#33=IFCPOLYGONALFACESET(#30,.F.,(#40,#41,#42),$);");
    assert_eq!(set.rows, [0, 2], "a skipped short face does not shift the rows after it");
    assert_eq!(set.row_count, 3);
    assert_eq!(set.length_unit_scale, 0.001);
}

#[test]
fn issue_8291_triangulated_rows_and_corners_reach_the_recipe() {
    let set = captured("#33=IFCTRIANGULATEDFACESET(#30,$,.F.,((1,2,3),(1,1,2),(1,4,2)),$);");
    assert_eq!(set.triangles, [0, 1, 2, 0, 3, 1], "the zero-area row leaves");
    assert_eq!(set.rows, [0, 2]);
}
