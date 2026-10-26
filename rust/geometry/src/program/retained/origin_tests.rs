// SPDX-License-Identifier: MPL-2.0
//! #7955 B1: independent refusal action, typed reporting and consumed ownership.
use super::*;
use crate::program::retained::failure::{OriginCause, OriginFailure, StructuralReason};
use std::sync::Arc;

fn origin(error: RetainedFailure) -> Arc<OriginFailure> {
    let RetainedFailure::Origin(handle) = error else { panic!("typed origin required: {error:?}") };
    handle.origin().expect("owned origin survives completion")
}
fn malformed() -> String { SOURCE.replace("'SweptSolid',(#13)", "'SweptSolid',(#13,$)") }

#[test]
fn issue_7955_structural_action_refuses_whole_plan_preserves_exact() {
    let expected = structure::exact_parts(SOURCE);
    assert_eq!(expected.len(), 1);
    for member in ["$", "*", "42", "'bad'", "(#13)"] {
        let bytes = SOURCE.replace("'SweptSolid',(#13)", &format!("'SweptSolid',(#13,{member})"));
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = RetainedProgram::product_parts(&entity, contract());
        let operations = drive(&mut program, &router, &mut decoder);
        let result = program.finish();
        assert!(result.is_err(), "B1 structural action must refuse whole plan");
        assert!(operations.is_empty(), "structure is rejected before a constructor escapes");
        structure::assert_exact_unchanged(&bytes, &expected);
    }
}

#[test]
fn issue_7955_structural_report_preserves_kind_before_common_erasure() {
    let bytes = malformed();
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    drive(&mut program, &router, &mut decoder);
    let failure = origin(program.finish().unwrap_err());
    assert!(matches!(failure.cause, OriginCause::Structure(StructuralReason::NonReferenceMember)),
        "B1 structural report must preserve NonReferenceMember");
    assert_eq!(failure.site, FailureSite::RepresentationItems);
    assert_eq!(failure.entity, Some(12));
}

#[test]
fn issue_7955_shape_and_decode_causes_remain_owned_enums() {
    for (representation, shape) in [("#53", true), ("#999999", false)] {
        let (error, source_weak, recorded) = {
            let bytes = SOURCE.replace("#9,#11,$,$", &format!("#9,{representation},$,$"));
            let source = SourceBundle::new(bytes.as_bytes().to_vec());
            let mut decoder = source.decoder();
            if !shape {
                // #7955: this deliberately dangling reference reaches decode_by_id's
                // missing-index ParseError rather than InvalidEntityRef.
                let error = decoder.decode_by_id(999999).unwrap_err();
                assert!(matches!(&error, ifc_lite_core::Error::ParseError { position: 0, message }
                    if message == "Entity #999999 not found"), "unexpected decoder cause: {error:?}");
            }
            let router = GeometryRouter::with_units(&bytes, &mut decoder);
            let entity = decoder.decode_by_id(10).unwrap();
            let mut program = RetainedProgram::product_parts(&entity, contract());
            assert!(drive(&mut program, &router, &mut decoder).is_empty());
            // A weak observer must not keep the cause alive on the handle's behalf.
            let recorded = Arc::downgrade(&program.selection().unwrap().failure_handle().origin()
                .expect("source cause must be recorded before completion"));
            let error = program.finish().expect_err("B1 invalid shape cannot publish a partial plan");
            drop(decoder.try_execution_lease().expect("failure holds no decoder lease"));
            (error, Arc::downgrade(&source), recorded)
        };
        assert!(source_weak.upgrade().is_none(), "failure must not retain source storage");
        std::thread::spawn(move || {
            let failure = origin(error);
            assert!(Arc::ptr_eq(&failure, &recorded.upgrade().expect("original cause survives")),
                "completion must preserve the original source cause");
            assert_eq!(failure.site, FailureSite::ProductShape);
            if shape {
                assert_eq!(failure.entity, Some(53));
                assert!(matches!(failure.cause, OriginCause::Shape(
                    crate::representation::ShapeError::NotAProductDefinitionShape(ifc_lite_core::IfcType::IfcPolyline))));
            } else {
                assert_eq!(failure.entity, Some(999999));
                assert!(matches!(&failure.cause, OriginCause::Core(ifc_lite_core::Error::ParseError { position: 0, message })
                    if message == "Entity #999999 not found"), "unexpected retained cause: {:?}", failure.cause);
            }
        }).join().unwrap();
    }
}

#[test]
fn issue_7955_recipe_report_keeps_actual_enum_without_partial_plan() {
    for (items, count, id) in [("#54", 0, 54), ("#13,#54", 1, 54), ("#113", 0, 113), ("#13,#113", 1, 113)] {
        // A registered Block reaches capture's family refusal. Negative depth
        // reaches the actual extrusion lowerer, which returns UnsupportedSource.
        let bytes = SOURCE.replace("'SweptSolid',(#13)", &format!("'SweptSolid',({items})"))
            .replace("ENDSEC;END-ISO", "#54=IFCBLOCK(#5,2.,3.,4.);#113=IFCEXTRUDEDAREASOLID(#14,#5,#15,-3.);ENDSEC;END-ISO");
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = RetainedProgram::product_parts(&entity, contract());
        let operations = drive(&mut program, &router, &mut decoder);
        assert_eq!(operations.len(), count);
        assert!(operations.iter().all(|operation| operation.construction().is_some()));
        let failure = origin(program.finish().expect_err("B1 unsupported recipe cannot publish a partial plan"));
        assert!(matches!(&failure.cause, OriginCause::Recipe(crate::document::RetainedRefusal::UnsupportedSource(_))),
            "B1 recipe report must preserve UnsupportedSource");
        assert_eq!(failure.site, FailureSite::Constructor);
        assert_eq!(failure.entity, Some(id));
    }
}

#[test]
fn issue_7955_recording_source_origin_does_not_preempt_owned_reply_acceptance() {
    let bytes = malformed();
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let foreign_router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let ticket = program.request().unwrap().unwrap();
    let (reply, operations) = program.admit(ticket, &router, &mut decoder).unwrap();
    assert!(operations.is_empty());
    let recorded = program.selection().unwrap().failure_handle().origin().unwrap();
    assert_eq!(program.inner.pending, Some((ticket.0, true)));
    let rejected = program.accept(reply, &foreign_router).err().unwrap();
    assert_eq!(rejected.error, RetainedProgramError::WrongOwner);
    assert_eq!(rejected.reply.0.request, ticket.0);
    program.accept(rejected.reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
    assert!(program.inner.pending.is_none(), "B1 owned error reply must be consumed");
    assert!(program.request().unwrap().is_none());
    let completed = origin(program.finish().unwrap_err());
    assert!(Arc::ptr_eq(&recorded, &completed));
}

#[test]
fn issue_7955_first_origin_survives_existing_new_mapping_roots_and_later_refusal() {
    let bytes = malformed();
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let bad = decoder.decode_by_id(10).unwrap();
    let good = decoder.decode_by_id(20).unwrap();
    let nonproduct = decoder.decode_by_id(53).unwrap();
    let traversal = RetainedTraversal::new(contract());
    let mut existing = traversal.product_parts(&good);
    let mut existing_map = traversal.type_map(decoder.decode_by_id(71).unwrap(), None);
    let mut program = traversal.product_parts(&bad);
    assert!(drive(&mut program, &router, &mut decoder).is_empty());
    let first = origin(program.finish().unwrap_err());
    // A distinct, genuinely reached rejection must not replace the first one.
    let second = traversal.product_parts(&nonproduct);
    let later = origin(second.finish().unwrap_err());
    assert_eq!(later.entity, Some(12), "B1 first origin must not be overwritten");
    assert!(Arc::ptr_eq(&first, &later));
    let mut new_root = traversal.product_parts(&good);
    for root in [&mut existing, &mut new_root, &mut existing_map] {
        assert_eq!(drive(root, &router, &mut decoder).len(), 1);
    }
    for error in [existing.finish().unwrap_err(), new_root.finish().unwrap_err(),
        existing_map.finish_type_map(60, 1, [1.; 4]).unwrap_err()] {
        assert!(Arc::ptr_eq(&first, &origin(error)), "B1 origins share the traversal across roots");
    }
    let mut fresh = RetainedTraversal::new(contract()).product_parts(&good);
    assert_eq!(drive(&mut fresh, &router, &mut decoder).len(), 1);
    assert_eq!(fresh.finish().unwrap().values.len(), 1, "fresh traversal remains usable");
}

#[test]
fn issue_7955_consumed_finish_owns_origin_after_source_and_controllers_drop() {
    let (failure, source_weak) = {
        let bytes = malformed();
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let weak = Arc::downgrade(&source);
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let traversal = RetainedTraversal::new(contract());
        let mut program = traversal.product_parts(&entity);
        drive(&mut program, &router, &mut decoder);
        // A diagnostic must hold no decoder lease, even while the controller lives.
        drop(decoder.try_execution_lease().expect("failure holds no decoder lease"));
        (program.finish().unwrap_err(), weak)
    };
    assert!(source_weak.upgrade().is_none(), "failure must not retain source storage");
    assert_eq!(crate::resource::check_current(), Ok(()), "no lexical context escapes");
    std::thread::spawn(move || {
        let retained = origin(failure);
        assert_eq!(retained.entity, Some(12), "B1 consumed finish must retain original entity");
        assert!(matches!(retained.cause, OriginCause::Structure(StructuralReason::NonReferenceMember)));
    }).join().unwrap();
}

#[test]
fn issue_7955_nested_boolean_source_origin_and_scale_two_classifier() {
    let bytes = boolean_tests::nested().replace(".UNION.,#114,#115", ".UNION.,#114,#53");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    assert_eq!(drive(&mut program, &router, &mut decoder).len(), 2);
    let failure = origin(program.finish().unwrap_err());
    assert_eq!(failure.entity, Some(53));
    assert!(matches!(failure.cause, OriginCause::Processor(None)), "unregistered polyline is not a custom registration");

    let bytes = mapping_tests::mapped().replace("#84,1.,$", "#84,2.,$");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let operations = drive(&mut program, &router, &mut decoder);
    assert_eq!(operations.len(), 2);
    assert!(matches!(operations[1].kind(), RetainedOperationKind::Affine { .. }));
    assert!(program.selection().unwrap().failure_handle().origin().is_none(),
        "a negative proper-rigid probe is not a source refusal");
    assert_eq!(program.finish().unwrap().values.len(), 1);
}

#[path = "origin_completion_tests.rs"]
mod completion;
