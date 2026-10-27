// SPDX-License-Identifier: MPL-2.0
//! #7955: real mapping admission emits physical copies, never fake constructions.
use super::*;
#[test]
fn h2b_nonrigid_and_reflected_maps_bake_distinct_occurrences_from_one_original_definition() {
    for reflected in [false, true] {
        let bytes = if reflected {
            super::mapping_tests::mapped()
                .replace("OPERATOR3D($,$,#84,1.,$)", "OPERATOR3D(#201,#202,#84,1.,#203)")
                .replace("ENDSEC;END-ISO", "#201=IFCDIRECTION((1.,0.,0.));#202=IFCDIRECTION((0.,-1.,0.));#203=IFCDIRECTION((0.,0.,1.));ENDSEC;END-ISO")
        } else { super::mapping_tests::mapped().replace("#84,1.,$", "#84,2.,$") };
        let bytes = bytes.replace("'SweptSolid',(#13)", "'SweptSolid',(#13,#13)");
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = RetainedProgram::product_submeshes(&entity, true, None, contract());
        let operations = drive(&mut program, &router, &mut decoder);
        assert_eq!(operations.len(), 3, "one source and two independent physical occurrences");
        assert!(operations[0].construction().is_some());
        for operation in &operations[1..] {
            let RetainedOperationKind::Affine { input, matrix } = operation.kind() else { panic!("physical copy required") };
            assert_eq!(input.definition(), operations[0].value().definition());
            assert_eq!([matrix[0], matrix[5], matrix[10]], if reflected { [1., -1., 1.] } else { [2.; 3] });
            assert!(operation.construction().is_none());
            assert!(matches!(operation.value().definition(), LogicalRetainedDefinition::Operation(_)));
            assert_eq!(operation.value().object_frame(), &crate::math::mat4::col_major_array(&nalgebra::Matrix4::identity()));
            assert!(operation.value().world_from_source().is_none());
        }
        assert_ne!(operations[1].value().definition(), operations[2].value().definition());
        let plan = program.finish().unwrap();
        assert_eq!(plan.values.len(), 2);
        for (value, operation) in plan.values.iter().zip(&operations[1..]) {
            assert_eq!(value.definition(), operation.value().definition());
            assert!(value.is_product_placed());
            assert_eq!(value.presentation().len(), 2);
            let frame = value.object_frame();
            assert_eq!([frame[12], frame[13], frame[14]], [10., 20., 30.]);
        }
    }
}
#[test]
fn h2b_singular_map_refuses_before_reaching_source_construction() {
    let bytes = super::mapping_tests::mapped().replace("#84,1.,$", "#84,0.,$");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    assert!(drive(&mut program, &router, &mut decoder).is_empty());
    assert!(program.finish().is_err());
}
#[test]
fn h2b_rigid_mapping_keeps_source_definition_without_physical_conversion() {
    let bytes = super::mapping_tests::mapped();
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let operations = drive(&mut program, &router, &mut decoder);
    assert_eq!(operations.len(), 1);
    assert_eq!(program.finish().unwrap().values[0].definition(), operations[0].value().definition());
}

#[test]
fn h2b_affine_copy_budget_stop_is_typed_and_sticky_at_common_admission() {
    // #7955: reach the mapped source before refusing the physical-copy budget.
    let bytes = super::mapping_tests::mapped().replace("#84,1.,$", "#84,2.,$");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let map = decoder.decode_by_id(61).unwrap();
    let mut program = RetainedProgram::type_map(map, None, contract());
    let mut constructions = 0;
    while let Some(ticket) = program.request().unwrap() {
        let ready = matches!(&program.inner.control,
            Control::Mapping(control) if control.retained_ready());
        if constructions > 0 && ready {
            let account = crate::resource::ExecutionAccount::new(
                crate::resource::ExecutionPolicy::Bounded(crate::resource::ResourceLimits {
                    copy_bytes: Some(0), ..Default::default()
                }));
            account.scope(|| {
                let error = program.admit(ticket, &router, &mut decoder).err()
                    .expect("physical mapping must not publish operations after copy refusal");
                assert!(matches!(error, RetainedProgramError::Stopped(
                    crate::resource::ProgramStop::ResourceRefused(refusal))
                    if refusal.dimension == crate::resource::Dimension::CopyBytes));
                assert_eq!(program.request().err(), Some(error));
            });
            assert_eq!(constructions, 1, "the authentic source was reached first");
            return;
        }
        let (reply, operations) = program.admit(ticket, &router, &mut decoder).unwrap();
        constructions += operations.iter().filter(|operation| operation.construction().is_some()).count();
        program.accept(reply, &router).unwrap_or_else(|error| panic!("{:?}", error.error));
    }
    panic!("fixture never reached its nonrigid mapping admission");
}

#[test]
fn h2b_nested_nonuniform_affines_preserve_order_and_cached_inner_definition() {
    // #7955: inner scale (2,3,4), then outer (5,6,7); translations do not commute.
    let bytes = mapping_tests::mapped()
        .replace("'SweptSolid',(#13)", "'SweptSolid',(#90,#90)")
        .replace("OPERATOR3D($,$,#84,1.,$)", "OPERATOR3DNONUNIFORM($,$,#84,2.,$,3.,4.)")
        .replace("ENDSEC;END-ISO", "#90=IFCMAPPEDITEM(#91,#92);#91=IFCREPRESENTATIONMAP(#5,#93);#92=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#94,5.,$,6.,7.);#93=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#13));#94=IFCCARTESIANPOINT((11.,13.,17.));ENDSEC;END-ISO");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_submeshes(&entity, true, None, contract());
    let mut operations = Vec::new();
    while let Some(ticket) = program.request().unwrap() {
        if matches!(&program.inner.control, Control::Product(c) if c.retained_ready()) {
            assert_eq!(program.inner.execute(ticket.0, &router, &mut decoder).err(), Some(ProgramError::UnsupportedRetained));
        }
        let (reply, reached) = program.admit(ticket, &router, &mut decoder).unwrap();
        operations.extend(reached);
        program.accept(reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    assert_eq!(operations.len(), 4, "one constructor, one inner bake, two outer bakes");
    let RetainedOperationKind::Affine { matrix: inner, .. } = operations[1].kind() else { panic!("inner affine") };
    assert_eq!([inner[0], inner[5], inner[10]], [2.,3.,4.]);
    for operation in &operations[2..] {
        let RetainedOperationKind::Affine { input, matrix: outer } = operation.kind() else { panic!("outer affine") };
        assert_eq!(input.definition(), operations[1].value().definition());
        let combined = nalgebra::Matrix4::from_column_slice(outer) * nalgebra::Matrix4::from_column_slice(inner);
        // Source evaluation origin is (-1,-2,0) in file metres.
        let point = combined * nalgebra::Vector4::new(1.,2.,3.,1.);
        assert_eq!([point.x,point.y,point.z], [21.,37.,143.]);
    }
    let plan = program.finish().unwrap();
    assert_eq!(plan.values.len(),2);
    assert_ne!(plan.values[0].definition(),plan.values[1].definition());
    assert!(plan.values.iter().all(|v| matches!(v.definition(), LogicalRetainedDefinition::Operation(_)) && v.world_from_source().is_none()));
    assert_eq!(plan.remaining.len(),4);
}

#[test]
fn s2_r2_reached_singular_map_with_nan_determinant_refuses_whole_plan() {
    // #7955 R2: finite diag(0,1e200,1e200) has a NaN f64 determinant.
    let bytes = mapping_tests::mapped().replace("OPERATOR3D($,$,#84,1.,$)",
        "OPERATOR3DNONUNIFORM($,$,#84,0.,$,1.E200,1.E200)");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let target = decoder.decode_by_id(82).unwrap();
    let matrix = router.parse_cartesian_transformation_operator(&target, &mut decoder).unwrap();
    assert!(matrix.iter().all(|value| value.is_finite()));
    assert_eq!([matrix[(0, 0)], matrix[(1, 1)], matrix[(2, 2)]], [0., 1e200, 1e200]);
    assert!(matrix.fixed_view::<3, 3>(0, 0).determinant().is_nan());
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    assert!(drive(&mut program, &router, &mut decoder).is_empty());
    let error = program.finish().unwrap_err();
    assert!(error.to_string().contains("finite nonsingular affine"), "{error}");
}
