// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
use ifc_lite_geometry::{document::{RetainedPrism, PrismRole, PrismLoop, PrismSegment, RetainedRecipe, GeometryDocument},
    program::transactions::{Traversal, OperationKind, TransactionFailureKind}, GeometryRouter};
use ifc_lite_core::SourceBundle;
const ID: [f64; 16] = [1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.];
fn box_prism() -> RetainedPrism {
    let points = [[0.,0.],[1.,0.],[1.,1.],[0.,1.]];
    RetainedPrism { source_id: 5, role: PrismRole::HalfSpace, frame: ID, direction: [0.,0.,1.], depth: 1.,
        loops: vec![PrismLoop { outer: true, segments: (0..4).map(|i| PrismSegment::Line { start: points[i], end: points[(i+1)%4] }).collect() }] }
}
// #7955 CUT-0: the wire layout is the adapter's compatibility contract.
#[test]
fn prism_matches_hand_written_format_one() {
    let mut expected = Vec::new();
    for n in [1u32,1,4,0] { expected.extend(n.to_le_bytes()); }
    for n in [0f64,0.,1.,1.] { expected.extend(n.to_le_bytes()); }
    for n in [0u32,4] { expected.extend(n.to_le_bytes()); }
    for line in [[0f64,0.,0.,1.,0.,0.],[1.,0.,0.,1.,1.,0.],[1.,1.,0.,0.,1.,0.],[0.,1.,0.,0.,0.,0.]] {
        for n in [1u32,0] { expected.extend(n.to_le_bytes()); }
        for n in line.into_iter().chain([0.;6]) { expected.extend(n.to_le_bytes()); }
    }
    let prism = box_prism(); let p = prism.lower().unwrap();
    assert_eq!(p.bytes, expected); assert_eq!(p.source_from_evaluation, ID);
    assert_eq!(p.evaluation_bounds.unwrap().0, [0.,0.,0.,1.,1.,1.]);
    let mut d = GeometryDocument::new(); let handle = d.add_retained_prism(prism.clone()).unwrap();
    assert_eq!(d.retained_recipe(handle).unwrap(), &RetainedRecipe::Prism(prism));
}
#[test]
fn arc_wire_is_center_basis_radius_and_signed_angles_and_bounds_contain_surface() {
    let mut prism = box_prism();
    prism.direction = [0.6,0.,0.8]; prism.depth = 3.;
    prism.loops[0].segments = vec![PrismSegment::Arc { center: [0.,0.], radius: 1., start_angle: 0., sweep_angle: std::f64::consts::FRAC_PI_2 },
        PrismSegment::Line { start: [0.,1.], end: [0.,0.] }, PrismSegment::Line { start: [0.,0.], end: [1.,0.] }];
    let p = prism.lower().unwrap();
    assert_eq!(u32::from_le_bytes(p.bytes[56..60].try_into().unwrap()), 3);
    let values: Vec<_> = p.bytes[64..160].chunks_exact(8).map(|b| f64::from_le_bytes(b.try_into().unwrap())).collect();
    assert_eq!(values, vec![0.,0.,0.,0.,0.,1.,1.,0.,0.,1.,0.,std::f64::consts::FRAC_PI_2]);
    let b = p.evaluation_bounds.unwrap().0;
    for i in 0..=1000 { for depth in [0.,1.5,3.] {
        let a = std::f64::consts::FRAC_PI_2 * i as f64 / 1000.;
        for (k, coordinate) in [a.cos()+0.6*depth,a.sin(),0.8*depth].into_iter().enumerate() {
            assert!(coordinate >= b[k] && coordinate <= b[k+3]);
        }
    } }
    for broken in 0..4 { let mut bad = prism.clone(); match broken {
        0 => bad.frame[0] = 2., 1 => bad.direction[2] = 0., 2 => bad.depth = f64::NAN,
        _ => bad.loops[0].segments.pop().map(|_| ()).unwrap(),
    }; assert!(bad.lower().is_err()); }
}
const SOURCE: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCDIRECTION((0.,0.,1.));
#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4.,6.);#5=IFCEXTRUDEDAREASOLID(#4,#2,#3,2.);
#6=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,1.);#7=IFCCARTESIANPOINT((20.,0.,0.));#8=IFCAXIS2PLACEMENT3D(#7,$,$);
#9=IFCEXTRUDEDAREASOLID(#6,#8,#3,1.);#10=IFCBOOLEANRESULT(.DIFFERENCE.,#5,#9);
#11=IFCBOOLEANRESULT(.DIFFERENCE.,#10,#999);
#12=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10));#13=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
#14=IFCWALL('w',$,$,$,$,$,#13,$,$);ENDSEC;END-ISO-10303-21;";
// #7955 CUT-0 mutation witness: Difference must never take the right bounds.
#[test]
fn difference_and_intersection_keep_host_bounds_union_contains_both_frames() {
    for op in ["DIFFERENCE","INTERSECTION","UNION"] {
        let text = SOURCE.replace(".DIFFERENCE.", &format!(".{op}."));
        let source = SourceBundle::new(text.as_bytes().to_vec()); let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&text, &mut decoder);
        let entity = decoder.decode_by_id(14).unwrap(); let traversal = Traversal::new(1,1);
        let mut program = traversal.product_parts(&entity); let mut checked = false;
        while let Some(ticket) = program.request().unwrap() {
            let (reply, operations, _) = program.admit(ticket,&router,&mut decoder).unwrap();
            for operation in operations {
                if let OperationKind::Boolean { inputs, .. } = operation.kind() {
                    let b = operation.value().evaluation_bounds().unwrap();
                    let left = inputs[0].evaluation_bounds().unwrap(); let right = inputs[1].evaluation_bounds().unwrap();
                    assert_ne!(left,right);
                    if op != "UNION" { assert_eq!(b,left); }
                    else { assert!(b.0[3] > left.0[3] + 10.); assert_eq!(b.0[4],left.0[4]); }
                    checked = true;
                }
                operation.bind_numerical_outcome(false).unwrap();
            }
            program.accept(reply,&router).unwrap_or_else(|e| panic!("{:?}",e.error));
        }
        assert!(checked); assert_eq!(program.finish().unwrap().values().len(),1);
    }
}
#[test]
fn already_empty_host_refuses_before_unresolvable_second_operand() {
    let text = SOURCE.replace("'CSG',(#10)","'CSG',(#11)");
    let source = SourceBundle::new(text.as_bytes().to_vec()); let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&text,&mut decoder); let entity = decoder.decode_by_id(14).unwrap();
    let traversal = Traversal::new(1,1); let mut program = traversal.product_parts(&entity);
    let error = loop {
        let ticket = match program.request() { Ok(Some(t))=>t, Err(e)=>break e, Ok(None)=>panic!("accepted empty host") };
        let (reply,operations,_) = match program.admit(ticket,&router,&mut decoder) { Ok(r)=>r, Err(e)=>break e };
        for op in operations { op.bind_numerical_outcome(matches!(op.kind(),OperationKind::Boolean{..})).unwrap(); }
        if let Err(e)=program.accept(reply,&router) { break e.error; }
    };
    assert_eq!(error.kind(),TransactionFailureKind::EmptyResult);
    assert_eq!(error.origin_view(),Some(("boolean_step",Some(11),"boolean")));
}

#[test]
fn prism_normalizes_arc_sense_and_encodes_circle_holes() {
    let mut prism=box_prism();
    prism.loops[0].segments=vec![PrismSegment::Arc { center:[0.,0.], radius:1., start_angle:std::f64::consts::FRAC_PI_2,
        sweep_angle:-std::f64::consts::FRAC_PI_2 }, PrismSegment::Line { start:[1.,0.],end:[0.,0.] },
        PrismSegment::Line { start:[0.,0.],end:[0.,1.] }];
    let payload=prism.lower().unwrap();
    let arc=payload.bytes[56..].chunks_exact(104).find(|b| u32::from_le_bytes(b[..4].try_into().unwrap())==3).unwrap();
    let sweep=f64::from_le_bytes(arc[96..104].try_into().unwrap());
    assert_eq!(sweep,std::f64::consts::FRAC_PI_2);
    prism.loops=vec![PrismLoop {outer:true,segments:vec![PrismSegment::Circle{center:[0.,0.],radius:2.}]},
        PrismLoop {outer:false,segments:vec![PrismSegment::Circle{center:[0.,0.],radius:1.}]}];
    let payload=prism.lower().unwrap();
    assert_eq!(payload.loops,2); assert_eq!(payload.segments,2);
    assert_eq!(payload.evaluation_bounds.unwrap().0,[-2.,-2.,0.,2.,2.,1.]);
    // Inner loop kind=2 and clockwise full turn; outer loop remains CCW.
    assert_eq!(u32::from_le_bytes(payload.bytes[168..172].try_into().unwrap()),2);
    assert_eq!(f64::from_le_bytes(payload.bytes[264..272].try_into().unwrap()),-std::f64::consts::TAU);
}
#[test]
fn halfspace_dispatch_keeps_all_three_current_refusals() {
    for (kind,args) in [("IFCHALFSPACESOLID","#2,.T."),("IFCBOXEDHALFSPACE","#2,.T.,$"),("IFCPOLYGONALBOUNDEDHALFSPACE","#2,.T.,$,$")] {
        let text=SOURCE.replace("#9=IFCEXTRUDEDAREASOLID(#6,#8,#3,1.)",&format!("#9={kind}({args})"));
        let source=SourceBundle::new(text.as_bytes().to_vec());let mut decoder=source.decoder();
        let router=GeometryRouter::new();let wall=decoder.decode_by_id(14).unwrap();let traversal=Traversal::new(1,1);
        let mut program=traversal.product_parts(&wall);
        let error=loop {
            let ticket=match program.request(){Ok(Some(t))=>t,Err(e)=>break e,Ok(None)=>panic!("halfspace admitted")};
            let (reply,_,_)=match program.admit(ticket,&router,&mut decoder){Ok(r)=>r,Err(e)=>break e};
            if let Err(e)=program.accept(reply,&router){break e.error;}
        };
        assert_eq!(error.kind(),TransactionFailureKind::OperationUnsupported);
        assert_eq!(error.origin_view(),Some(("boolean_second_operand",Some(9),"recipe")));
    }
}
