// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::{
    program::transactions::{Requirement, Traversal},
    GeometryRouter,
};
const SOURCE: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X1'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#7=IFCAXIS2PLACEMENT3D(#8,$,$);#8=IFCCARTESIANPOINT((10.,20.,30.));
#9=IFCLOCALPLACEMENT($,#7);#10=IFCWALL('w',$,'Wall',$,$,#9,#11,$,$);
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));#12=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#13));
#13=IFCEXTRUDEDAREASOLID(#14,#5,#15,3.);#14=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);
#15=IFCDIRECTION((0.,0.,1.));
#17=IFCAXIS2PLACEMENT3D(#18,$,$);#18=IFCCARTESIANPOINT((-4.,3.,2.));
#19=IFCLOCALPLACEMENT($,#17);#20=IFCSLAB('s',$,'Slab',$,$,#19,#21,$,.FLOOR.);
#21=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));#22=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#23));
#23=IFCEXTRUDEDAREASOLID(#14,#5,#15,0.5);
#50=IFCALIGNMENT('a',$,'Road',$,$,$,$,#53);
#51=IFCCARTESIANPOINT((0.,0.,0.));#52=IFCCARTESIANPOINT((10.,0.,0.));#53=IFCPOLYLINE((#51,#52));
#60=IFCBOILERTYPE('t',$,'Library',$,$,$,(#61,#71),$,$,.NOTDEFINED.);
#61=IFCREPRESENTATIONMAP(#7,#12);#71=IFCREPRESENTATIONMAP(#17,#22);
ENDSEC;END-ISO-10303-21;";

// Refs #7955: product placement is discharged, presentation remains unproved.
#[test]
fn product_completion_keeps_presentation_obligations() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let traversal = Traversal::new(7, 9);
    let mut program = traversal.product_parts(&entity);
    let mut constructions = 0;
    while let Some(ticket) = program.request().unwrap() {
        let (reply, operations, _storage) = program.admit(ticket, &router, &mut decoder).unwrap();
        constructions += operations.len();
        program
            .accept(reply, &router)
            .unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    assert_eq!(constructions, 1);
    let plan = program.finish().unwrap();
    assert_eq!(plan.values().len(), 1);
    assert_eq!(
        &plan.values().next().unwrap().world_from_source().unwrap()[12..15],
        &[10., 20., 30.]
    );
    assert_eq!(
        plan.requirements().collect::<Vec<_>>(),
        vec![
            Requirement::OpeningClosure,
            Requirement::MaterialLayers,
            Requirement::IfcAppearance,
            Requirement::PersistentFaces,
        ]
    );
}

// Refs #7955: a reply refused for the wrong owner is resubmitted intact.
#[test]
fn rejected_reply_is_resubmitted_to_its_owner() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let foreign_router = GeometryRouter::new();
    let entity = decoder.decode_by_id(10).unwrap();
    let traversal = Traversal::new(7, 9);
    let mut program = traversal.product_parts(&entity);
    while let Some(ticket) = program.request().unwrap() {
        let (reply, _operations, _storage) = program.admit(ticket, &router, &mut decoder).unwrap();
        let rejected = match program.accept(reply, &foreign_router) {
            Err(rejected) => rejected,
            Ok(()) => panic!("a foreign router must not accept the reply"),
        };
        program
            .accept(rejected.into_reply(), &router)
            .unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    assert_eq!(program.finish().unwrap().values().len(), 1);
}
