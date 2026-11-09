// SPDX-License-Identifier: MPL-2.0
//! #9268: a nested logical refusal belongs to the wall whose geometry is built.
use super::*;

const WALL: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
    #3=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)),$);\
    #4=IFCTRIANGULATEDFACESET(#3,$,.F.,((1,2,3)),$);\
    #5=IFCSHAPEREPRESENTATION($,'Body','Tessellation',(#4));\
    #6=IFCREPRESENTATIONMAP(#2,#5);\
    #7=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#1,1.,$);#8=IFCMAPPEDITEM(#6,#7);\
    #15=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#8,#8,#8));\
    #16=IFCREPRESENTATIONMAP(#2,#15);#18=IFCMAPPEDITEM(#16,#7);\
    #23=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#18));\
    #24=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));\
    #25=IFCWALL('0000000000000000000001',$,$,$,$,$,#24,$);";

#[test]
fn issue_9268_nested_logical_refusal_keeps_wall_identity() {
    for styled in [false, true] {
        for synchronous in [false, true] {
            let mut decoder = EntityDecoder::new(WALL);
            let wall = decoder.decode_by_id(25).unwrap();
            let router = GeometryRouter::new();
            let mut control = if styled {
                ProductControl::styled(&wall, false, None, SourceHygiene::Watertight)
            } else {
                ProductControl::merged(&wall, SourceHygiene::Watertight)
            };
            // Admission accepts the wall's root and nested lists. Constrain
            // only its executing mapping child, not the product admission walk.
            while !matches!(control.child, Child::Mapping(_)) {
                assert!(control.stage().unwrap().is_some());
                let reply = control.execute(&router, &mut decoder).unwrap();
                control.accept(reply, &router);
            }
            assert_eq!(router.take_budget_refusal_report().0, 0);
            let Child::Mapping(mapping) = &mut control.child else { unreachable!() };
            mapping.set_logical_limit(3);
            if synchronous {
                control.run(&router, &mut decoder).unwrap();
            } else {
                while control.stage().unwrap().is_some() {
                    let reply = control.execute(&router, &mut decoder).unwrap();
                    if matches!(&reply, ProductReply::Mapping(crate::program::mapping::MappingValue::Refused { .. })) {
                        assert_eq!(router.take_budget_refusal_report().0, 0,
                            "execution must not publish an unaccepted refusal");
                    }
                    control.accept(reply, &router);
                }
            }
            assert!(control.take_result().unwrap().is_ok());
            let (total, refusals) = router.take_budget_refusal_report();
            assert_eq!(total, 1, "styled={styled}, synchronous={synchronous}");
            assert_eq!(refusals.len(), 1);
            let refusal = &refusals[0];
            assert_eq!(refusal.product_id, Some(25));
            assert_eq!(refusal.product_type.as_deref(), Some("IfcWall"));
            assert_eq!(refusal.global_id.as_deref(), Some("0000000000000000000001"));
            assert_eq!((refusal.budget.as_str(), refusal.limit, refusal.reached, refusal.source_id),
                ("logical mapped attempts", 3, 4, 8));
            assert!(router.take_unsupported_items().is_empty());
        }
    }
}
