// SPDX-License-Identifier: MPL-2.0
//! #7955: actual facade admissions, ordered source identities, and linear ownership.
use super::*;

#[test]
fn h2c_boolean_dag_repeats_both_ordered_occurrences_and_preserves_obligations() {
    let bytes = boolean_tests::nested().replace(".DIFFERENCE.,#113,#213", ".INTERSECTION.,#213,#213");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let operations = drive(&mut program, &router, &mut decoder);
    assert_eq!(operations.len(), 7, "two distinct union occurrences then intersection");
    let RetainedOperationKind::Boolean { inputs, operation } = operations[6].kind() else { panic!("intersection") };
    assert_eq!(*operation, crate::BoolOp::Intersection);
    assert_eq!(inputs[0].definition(), operations[2].value().definition());
    assert_eq!(inputs[1].definition(), operations[5].value().definition());
    assert_ne!(inputs[0].definition(), inputs[1].definition());
    let plan = program.finish().unwrap();
    assert_eq!(plan.values.len(),1);
    assert_eq!(plan.values[0].definition(), operations[6].value().definition(),
        "the final occurrence retains the ordered intersection, with no removal authority");
    assert_eq!(plan.remaining, vec![RetainedRequirement::OpeningClosure, RetainedRequirement::MaterialLayers,
        RetainedRequirement::IfcAppearance, RetainedRequirement::PersistentFaces]);
}

#[test]
fn h2_operations_preserve_tickets_across_exact_foreign_and_cancelled_calls() {
    for affine in [false, true] {
        let bytes = if affine { mapping_tests::mapped().replace("#84,1.,$", "#84,2.,$") }
            else { boolean_tests::nested() };
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let foreign_router = GeometryRouter::new();
        let mut foreign_decoder = source.decoder();
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = RetainedProgram::product_parts(&entity, contract());
        let mut observed = 0;
        while let Some(ticket) = program.request().unwrap() {
            if matches!(&program.inner.control, Control::Product(c) if c.retained_ready()) {
                assert_eq!(program.inner.execute(ticket.0, &router, &mut decoder).err(), Some(ProgramError::UnsupportedRetained));
                assert_eq!(program.admit(ticket, &router, &mut foreign_decoder).err(), Some(RetainedProgramError::WrongOwner));
            }
            let (reply, operations) = program.admit(ticket, &router, &mut decoder).unwrap();
            let reply = if operations.iter().any(|op| op.construction().is_none()) {
                observed += 1;
                assert_eq!(program.admit(ticket, &router, &mut decoder).err(), Some(RetainedProgramError::AlreadyExecuted));
                let mut cancelled = RetainedProgram::product_parts(&entity, contract());
                cancelled.cancel();
                let rejected = cancelled.accept(reply, &router).err().unwrap();
                assert_eq!(rejected.error, RetainedProgramError::Cancelled);
                let rejected = program.accept(rejected.reply, &foreign_router).err().unwrap();
                assert_eq!(rejected.error, RetainedProgramError::WrongOwner);
                let mut foreign = RetainedProgram::product_parts(&entity, contract());
                let _ = foreign.request().unwrap();
                let rejected = foreign.accept(rejected.reply, &router).err().unwrap();
                assert_eq!(rejected.error, RetainedProgramError::StaleRequest);
                rejected.reply
            } else { reply };
            program.accept(reply, &router).unwrap_or_else(|e| panic!("{:?}",e.error));
        }
        assert_eq!(observed, if affine {1} else {2});
        assert_eq!(program.finish().unwrap().values.len(),1);
        // Cancelling the actual issuer after an operation is admitted cannot finish.
        let mut program = RetainedProgram::product_parts(&entity, contract());
        loop {
            let ticket = program.request().unwrap().expect("operation");
            let (reply, operations) = program.admit(ticket,&router,&mut decoder).unwrap();
            if operations.iter().any(|op| op.construction().is_none()) {
                program.cancel();
                assert_eq!(program.accept(reply,&router).err().unwrap().error,RetainedProgramError::Cancelled);
                assert!(program.finish().is_err());
                break;
            }
            program.accept(reply,&router).unwrap_or_else(|e| panic!("{:?}",e.error));
        }
    }
}

#[test]
fn h2c_cached_boolean_definition_keeps_distinct_rigid_operand_frames() {
    let bytes = mapping_tests::mapped()
        .replace("'SweptSolid',(#13)", "'SweptSolid',(#90)")
        .replace("ENDSEC;END-ISO", "#90=IFCBOOLEANRESULT(.DIFFERENCE.,#13,#91);#91=IFCMAPPEDITEM(#81,#92);#92=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#93,1.,$);#93=IFCCARTESIANPOINT((7.,8.,9.));ENDSEC;END-ISO");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes,&mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity,contract());
    let operations = drive(&mut program,&router,&mut decoder);
    assert_eq!(operations.len(),2,"one cached definition and one ordered difference");
    let RetainedOperationKind::Boolean { inputs, operation } = operations[1].kind() else { panic!("difference") };
    assert_eq!(*operation,crate::BoolOp::Difference);
    assert_eq!(inputs[0].definition(),inputs[1].definition());
    assert_ne!(inputs[0].slot(),inputs[1].slot());
    for (input, translation) in inputs.iter().zip([[1.,2.,6.],[6.,6.,9.]]) {
        assert_eq!([input.object_frame()[12],input.object_frame()[13],input.object_frame()[14]],translation);
    }
    assert_eq!(operations[1].value().object_frame(),inputs[0].object_frame());
    assert_eq!(program.finish().unwrap().values.len(),1);
}

#[test]
fn h2c_boolean_work_and_depth_refusals_remain_sticky() {
    let mut declarations = String::new();
    for id in 300..440 { declarations.push_str(&format!("#{id}=IFCBOOLEANRESULT(.UNION.,#13,#{});",id+1)); }
    declarations.push_str("#440=IFCBOOLEANRESULT(.UNION.,#13,#13);");
    let bytes = SOURCE.replace("'SweptSolid',(#13)","'SweptSolid',(#300)")
        .replace("ENDSEC;END-ISO", &(declarations+"ENDSEC;END-ISO"));
    for limit in [Some(15),None] {
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes,&mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = RetainedProgram::product_parts(&entity,contract());
        if let Some(limit) = limit { program.selection().unwrap().set_work_limit(limit); }
        let error = mapping_tests::stop(&mut program,&router,&mut decoder);
        assert!(matches!(error, RetainedProgramError::Stopped(_)));
        assert_eq!(program.request().err(),Some(error));
        assert!(program.finish().is_err());
    }
}

#[test]
fn h2_operations_reject_foreign_domains_and_invalid_frames() {
    // Real admitted source values, never synthetic numerical results.
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE,&mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut a = RetainedProgram::product_parts(&entity,contract());
    let mut b = RetainedProgram::product_parts(&entity,contract());
    let mut left = drive(&mut a,&router,&mut decoder).remove(0).value().try_copy().unwrap();
    let right = drive(&mut b,&router,&mut decoder).remove(0).value().try_copy().unwrap();
    assert!(crate::program::retained::boolean::boolean_operation([left.try_copy().unwrap(),right],crate::BoolOp::Difference).is_err());
    let slot = left.slot();
    // A nonrigid frame cannot enter an ordered Boolean without physical affine admission.
    let mut transform = nalgebra::Matrix4::identity();
    transform[(0,0)] = 2.;
    // Use the original domain through the selection; this is a real logical placement.
    let domain = a.selection().unwrap().program();
    left.place_in_place(&transform,domain,RetainedPlacementStage::Mapping {source_id:61}).unwrap();
    assert_ne!(left.slot(),slot);
    assert!(crate::program::retained::boolean::boolean_operation(
        [left.try_copy().unwrap(),left.try_copy().unwrap()],crate::BoolOp::Difference).is_err());
    transform[(0,0)] = f64::NAN;
    assert!(left.place_in_place(&transform,domain,RetainedPlacementStage::Mapping {source_id:61}).is_err());
    assert!(left.place_in_place(&nalgebra::Matrix4::identity(),domain+1,RetainedPlacementStage::Mapping {source_id:61}).is_err());
}

#[test]
fn h2c_resource_refusal_survives_the_account_scope_and_other_roots() {
    let source = SourceBundle::new(boolean_tests::nested().into_bytes());
    let mut decoder = source.decoder();
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(10).unwrap();
    let traversal = RetainedTraversal::new(contract());
    let mut program = traversal.product_parts(&entity);
    let mut existing_sibling = traversal.product_parts(&entity);
    let account = crate::resource::ExecutionAccount::new(crate::resource::ExecutionPolicy::Bounded(
        crate::resource::ResourceLimits {work:Some(0),..Default::default()}));
    // #7955: the first request resolves product structure and need not charge
    // account work. Reach an actual source admission rather than pinning a stage.
    let stop = account.scope(|| {
        for _ in 0..100 {
            let ticket = program.request().unwrap().expect("source admission must be reached");
            match program.admit(ticket, &router, &mut decoder) {
                Err(stop) => return stop,
                Ok((reply, operations)) => {
                    assert!(operations.is_empty(), "zero work cannot publish a source operation");
                    if let Err(rejected) = program.accept(reply, &router) { return rejected.error; }
                }
            }
        }
        panic!("bounded driver never reached charged source admission");
    });
    assert!(matches!(stop, RetainedProgramError::Stopped(
        crate::resource::ProgramStop::ResourceRefused(failure))
        if failure.dimension == crate::resource::Dimension::Work));
    assert_eq!(crate::resource::check_current(), Ok(()), "account scope has ended");
    assert_eq!(program.request().err(),Some(stop));
    assert_eq!(existing_sibling.request().err(),Some(stop));
    let mut sibling = traversal.product_parts(&entity);
    assert_eq!(sibling.request().err(),Some(stop));
    assert!(matches!(program.finish(), Err(RetainedFailure::Stopped(failure))
        if RetainedProgramError::Stopped(failure) == stop));
}

#[test]
fn h2c_malformed_clipping_operator_and_empty_mapped_operand_refuse_whole_plan() {
    let mapped = mapping_tests::mapped()
        .replace("'SweptSolid',(#13)","'SweptSolid',(#113,#90)")
        .replace("'SweptSolid',(#113)","'SweptSolid',()")
        .replace("ENDSEC;END-ISO","#90=IFCBOOLEANRESULT(.DIFFERENCE.,#113,#13);ENDSEC;END-ISO");
    let clipping = boolean_tests::nested().replace("IFCBOOLEANRESULT(.DIFFERENCE.,", "IFCBOOLEANCLIPPINGRESULT($,");
    for bytes in [mapped,clipping] {
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes,&mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = RetainedProgram::product_parts(&entity,contract());
        let operations = drive(&mut program,&router,&mut decoder);
        assert!(!operations.is_empty(),"provisional inputs reached before refusal");
        assert!(program.finish().is_err(),"no authenticated empty or inferred clipping operation");
    }
}
