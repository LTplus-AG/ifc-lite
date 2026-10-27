// SPDX-License-Identifier: MPL-2.0
//! #7955 B2b: error-reply ownership, first cause and exact recovery controls.
use super::*;

#[test]
fn issue_7955_b2b_foreign_reply_rejection_preserves_source_error_and_valid_continuation() {
    for mode in 0..3 {
        for bad in [false, true] {
            let bytes = fixture("IFCBOOLEANRESULT", if bad { ".DIFFERENCE.,#113,#999999" } else { ".DIFFERENCE.,#113,#213" });
            let source = SourceBundle::new(bytes.as_bytes().to_vec());
            let mut decoder = source.decoder();
            let router = GeometryRouter::with_units(&bytes, &mut decoder);
            let foreign = GeometryRouter::with_units(&bytes, &mut decoder);
            let entity = decoder.decode_by_id(10).unwrap();
            let mut program = program(&entity, &mut decoder, mode);
            let handle = program.selection().unwrap().failure_handle();
            let mut operations = Vec::new();
            let mut retried = false;
            for _ in 0..100 {
                let Some(ticket) = program.request().unwrap() else { break };
                let (reply, reached) = program.admit(ticket, &router, &mut decoder).unwrap();
                let retry = !retried && if bad { handle.origin().is_some() } else { !reached.is_empty() };
                operations.extend(reached);
                if retry {
                    let recorded = handle.origin();
                    let rejected = program.accept(reply, &foreign).err().unwrap();
                    assert_eq!(rejected.error, RetainedProgramError::WrongOwner);
                    assert_eq!(rejected.reply.0.request, ticket.0);
                    assert_eq!(program.inner.pending, Some((ticket.0, true)));
                    if bad {
                        assert!(Arc::ptr_eq(recorded.as_ref().unwrap(), &handle.origin().unwrap()));
                    } else {
                        assert!(handle.origin().is_none(), "caller rejection has no source-origin authority");
                    }
                    program.accept(rejected.reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
                    assert!(program.inner.pending.is_none(), "legitimate packet is consumed once");
                    retried = true;
                } else {
                    program.accept(reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
                }
            }
            assert!(retried, "bounded walk must reach the selected reply");
            assert!(program.request().unwrap().is_none());
            if bad {
                assert_eq!(operations.len(), 1);
                let failure = origin(finish(program, mode).unwrap_err());
                assert!(Arc::ptr_eq(&failure, &handle.origin().unwrap()));
                assert_eq!(failure.site, FailureSite::BooleanSecondOperand);
                assert!(matches!(failure.cause, OriginCause::Core(_)));
            } else {
                assert_eq!(operations.len(), 3);
                assert_eq!(finish(program, mode).unwrap().values.len(), 1);
                assert!(handle.origin().is_none());
            }
        }
    }
}

#[test]
fn issue_7955_b2b_first_boolean_cause_survives_later_roots_and_original_stop() {
    use crate::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits, ProgramStop};
    let bytes = fixture("IFCBOOLEANRESULT", ".DIFFERENCE.,#113,$")
        .replace("#23=IFCEXTRUDEDAREASOLID(#14,#5,#15,0.5)", "#23=IFCBOOLEANRESULT(.BOGUS.,#113,#213)");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let wall = decoder.decode_by_id(10).unwrap();
    let slab = decoder.decode_by_id(20).unwrap();
    let traversal = RetainedTraversal::new(contract());
    let mut first = traversal.product_parts(&wall);
    let mut second = traversal.product_parts(&slab);
    assert_eq!(drive(&mut first, &router, &mut decoder).len(), 1);
    let first = origin(first.finish().unwrap_err());
    assert_eq!(first.site, FailureSite::BooleanSecondOperand);
    assert!(matches!(first.cause, OriginCause::Boolean(BooleanReason::OperandReferenceRequired)));
    assert_eq!(drive(&mut second, &router, &mut decoder).len(), 1);
    assert!(Arc::ptr_eq(&first, &origin(second.finish().unwrap_err())));
    // Independent traversal reaches the later, distinct actual predicate.
    let mut fresh = RetainedProgram::product_parts(&slab, contract());
    assert_eq!(drive(&mut fresh, &router, &mut decoder).len(), 1);
    let later = origin(fresh.finish().unwrap_err());
    assert_eq!(later.site, FailureSite::BooleanOperator);
    assert_eq!(later.entity, Some(23));
    assert!(matches!(later.cause, OriginCause::Boolean(BooleanReason::UnknownOperator)));

    let mut stopped = traversal.product_parts(&wall);
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    account.cancel();
    account.scope(|| assert_eq!(stopped.request().err(), Some(RetainedProgramError::Stopped(ProgramStop::Cancelled))));
    assert!(matches!(stopped.finish(), Err(RetainedFailure::Stopped(ProgramStop::Cancelled))));
    assert_eq!(first.entity, Some(13), "original stop and first source cause are independent");
}

#[test]
fn issue_7955_b2b_exact_second_operand_recovery_keeps_host_and_one_diagnostic() {
    for args in [".DIFFERENCE.,#113,#999999", ".DIFFERENCE.,#113,$", ".DIFFERENCE.,#113"] {
        let bytes = fixture("IFCBOOLEANRESULT", args);
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let host = decoder.decode_by_id(113).unwrap();
        let expected = GeometryProgram::item(&host, (0., 0., 0.)).drain(&router, &mut decoder).unwrap();
        assert!(!expected.is_empty());
        let node = decoder.decode_by_id(13).unwrap();
        let actual = GeometryProgram::item(&node, (0., 0., 0.)).drain(&router, &mut decoder).unwrap();
        assert_eq!(actual.positions, expected.positions);
        assert_eq!(actual.indices, expected.indices);
        router.drain_processor_failures();
        let failures: Vec<_> = router.take_csg_failures().into_values().flatten().collect();
        assert_eq!(failures.len(), 1, "shared typed resolver records the dropped exact cutter once");
        assert_eq!(failures[0].op, crate::BoolOp::Difference);
        assert!(matches!(failures[0].reason, crate::BoolFailureReason::EmptyOperand));
    }
}

#[test]
fn issue_7955_b2b_unconverted_csg_helper_remains_opaque_at_boolean_source() {
    let bytes = fixture("IFCBOOLEANRESULT", ".DIFFERENCE.,#113,#213")
        .replace("#213=IFCEXTRUDEDAREASOLID(#14,#5,#15,1.)", "#213=IFCCSGSOLID($)");
    let failure = run(&bytes, 0, 1);
    assert_eq!(failure.site, FailureSite::BooleanSource);
    assert_eq!(failure.entity, Some(13), "adapter knows its reached item, not the CSG helper's leaf");
    assert!(matches!(failure.cause, OriginCause::Opaque(crate::Error::GeometryError(_))));
}
