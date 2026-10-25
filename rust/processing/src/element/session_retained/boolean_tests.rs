// SPDX-License-Identifier: MPL-2.0
//! #7955 H2c: real source Boolean replies are authenticated before consumption.
use super::*;
use super::adversarial_tests::with_case;
use super::super::session_tests::SOURCE;
fn nested() -> String {
    SOURCE.replace("#13=IFCEXTRUDEDAREASOLID", "#13=IFCBOOLEANRESULT(.DIFFERENCE.,#113,#213);#113=IFCEXTRUDEDAREASOLID")
        .replace("ENDSEC;END-ISO", "#213=IFCBOOLEANRESULT(.UNION.,#114,#115);#114=IFCEXTRUDEDAREASOLID(#14,#5,#15,1.);#115=IFCEXTRUDEDAREASOLID(#14,#5,#15,2.);ENDSEC;END-ISO")
}
#[test]
fn h2c_sdk_nested_boolean_source_volume_and_wrong_operator_receipt_recovery() {
    with_case(None, &nested(), |execution, decoder, router, worker, _, _| {
        for _ in 0..3 {
            let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
            let receipt = issued.execute(worker, 0.001, 15., MeshLimits::default()).unwrap();
            assert!(receipt.realizations()[0].construction().is_some());
            execution.accept(receipt, decoder, router).unwrap_or_else(|error| panic!("{}", error.reason));
        }
        let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
        let IssuedRetainedOperation::Boolean { inputs, .. } = &issued.operations[0] else { panic!("Boolean issued") };
        // Execute a real but wrong operation with the SAME input handles and
        // frames. Its solid is valid; only operation authentication rejects it.
        let wrong = worker.evaluate_retained_boolean(inputs[0].operand().native_dependency().unwrap(), inputs[1].operand().native_dependency().unwrap(),
            ifc_lite_geometry_runtime::protocol::BooleanOperation::Difference, 0.001, 15., MeshLimits::default()).unwrap();
        let mut completed = issued.execute(worker, 0.001, 15., MeshLimits::default()).unwrap();
        let receipt = Arc::get_mut(&mut completed.realizations[0]).unwrap();
        let correct = std::mem::replace(&mut receipt.kind, native_types::RealizationKind::Boolean(Box::new(wrong)));
        let mut rejected = execution.accept(completed, decoder, router).expect_err("wrong operator must refuse");
        assert!(matches!(&rejected.reason, RetainedExecutionError::Receipt(ReceiptFailure::ForeignBooleanOperationOrOrderedInputs)));
        assert_eq!(execution.discharged_count(), 3);
        rejected.work.realizations[0].validate_live().unwrap();
        Arc::get_mut(&mut rejected.work.realizations[0]).unwrap().kind = correct;
        execution.accept(rejected.work, decoder, router).unwrap_or_else(|error| panic!("{}", error.reason));
        let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
        let completed = issued.execute(worker, 0.001, 15., MeshLimits::default()).unwrap();
        // Authored 2 x 4 profile: depth 3 minus union(depth 1, depth 2)
        // leaves depth 1, so volume is exactly 8 m3, independent of SDK metadata.
        let actual = worker.volume(completed.realizations[0].solid(), 1e-8).unwrap();
        assert!((actual - 8.).abs() <= 1e-7, "source-derived volume: {actual}");
        execution.accept(completed, decoder, router).unwrap_or_else(|error| panic!("{}", error.reason));
        assert_eq!(execution.discharged_count(), 5);
        assert!(execution.issue_next(decoder, router, worker).unwrap().is_none());
        execution.validate_witness().unwrap();
        assert_eq!(execution.traversal_plan().unwrap().values().len(), 1);
    });
}


#[test]
fn h2c_sdk_empty_definition_reaches_later_operands_and_final_witness() {
    for keep_union in [false, true] {
        let top = if keep_union { "#13=IFCBOOLEANRESULT(.UNION.,#213,#113);#213=IFCBOOLEANRESULT(.DIFFERENCE.,#114,#114);" }
            else { "#13=IFCBOOLEANRESULT(.DIFFERENCE.,#114,#114);" };
        let bytes = SOURCE.replace("#13=IFCEXTRUDEDAREASOLID", &format!("{top}#113=IFCEXTRUDEDAREASOLID"))
            .replace("ENDSEC;END-ISO", "#114=IFCEXTRUDEDAREASOLID(#14,#5,#15,1.);ENDSEC;END-ISO");
        with_case(None, &bytes, |execution, decoder, router, worker, _, _| {
            let mut empties = 0;
            while let Some(issued) = execution.issue_next(decoder, router, worker).unwrap() {
                let mut completed = issued.execute(worker, 0.001, 15., MeshLimits::default()).unwrap();
                if completed.realizations()[0].is_empty() {
                    Arc::get_mut(&mut completed.realizations[0]).unwrap().empty = false;
                    let mut rejected = execution.accept(completed, decoder, router).expect_err("wrong empty report must refuse");
                    assert!(execution.pending.as_ref().unwrap().operations.iter().all(|operation|
                        operation.expected().value().evaluated_empty().is_none()), "rejection cannot bind logical outcomes");
                    Arc::get_mut(&mut rejected.work.realizations[0]).unwrap().empty = true;
                    completed = rejected.work;
                }
                for receipt in completed.realizations() {
                    if receipt.is_empty() {
                        empties += 1;
                        assert!(worker.is_empty(receipt.solid()).unwrap());
                    }
                }
                execution.accept(completed, decoder, router).unwrap_or_else(|error| panic!("{}", error.reason));
                for (logical, receipt) in &execution.ledger {
                    assert_eq!(logical.evaluated_empty(), Some(receipt.is_empty()));
                }
            }
            assert_eq!(empties, 1, "self-difference must return a certified empty operand");
            execution.validate_witness().unwrap();
            let plan = execution.traversal_plan().unwrap();
            assert_eq!(plan.values().len(), 1);
            assert_eq!(plan.values().next().unwrap().evaluated_empty(), Some(!keep_union));
            assert_eq!(plan.values().next().unwrap().evaluated_empty().unwrap(), !keep_union);
            let (_, receipt) = execution.ledger.iter().find(|(value, _)| value.as_ref().definition() == plan.values().next().unwrap().definition()).unwrap();
            let volume = worker.volume(receipt.solid(), 1e-8).unwrap();
            assert!((volume - if keep_union { 24. } else { 0. }).abs() <= 1e-7);
        });
    }
}


#[test]
fn h2c_sdk_mapped_boolean_operand_scale_changes_the_authored_cut_volume() {
    // A 2 x 4 x 3 host is cut by a mapped 2 x 4 x 1 extrusion scaled by 2,
    // unioned with a depth-0.5 extrusion. The mapped cutter covers the host's
    // XY footprint and removes 2 m of its height: 8 m3 remain. Ignoring the
    // map's scale leaves 16 m3, so this oracle observes the mapping itself.
    let bytes = nested().replace(".UNION.,#114,#115", ".UNION.,#314,#115")
        .replace("#115=IFCEXTRUDEDAREASOLID(#14,#5,#15,2.)", "#115=IFCEXTRUDEDAREASOLID(#14,#5,#15,0.5)")
        .replace("ENDSEC;END-ISO", "#314=IFCMAPPEDITEM(#315,#316);#315=IFCREPRESENTATIONMAP(#5,#317);#316=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,2.,$);#317=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#114));ENDSEC;END-ISO");
    with_case(None, &bytes, |execution, decoder, router, worker, _, _| {
        while let Some(issued) = execution.issue_next(decoder, router, worker).unwrap() {
            let completed = issued.execute(worker, 0.001, 15., MeshLimits::default()).unwrap();
            execution.accept(completed, decoder, router).unwrap_or_else(|error| panic!("{}", error.reason));
        }
        assert_eq!(execution.discharged_count(), 6);
        execution.validate_witness().unwrap();
        let plan = execution.traversal_plan().unwrap();
        let (_, receipt) = execution.ledger.iter().find(|(value, _)| value.as_ref().definition() == plan.values().next().unwrap().definition()).unwrap();
        let actual = worker.volume(receipt.solid(), 1e-8).unwrap();
        assert!((actual - 8.).abs() <= 1e-7, "mapped source volume: {actual}");
        assert_eq!(plan.values().next().unwrap().evaluated_empty(), Some(false));
    });
}
