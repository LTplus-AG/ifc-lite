// SPDX-License-Identifier: MPL-2.0
//! #7955 B1: completion reasons, opaque gaps, stop priority and storage lifetime.
use super::*;
use crate::resource::{ExecutionAccount, ExecutionPolicy, ResourceLimits, ProgramStop};

#[test]
fn issue_7955_completion_preserves_pending_protocol_and_root_reasons() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    program.request().unwrap().unwrap();
    assert!(matches!(program.finish(), Err(RetainedFailure::Completion(CompletionReason::UnexecutedRequest))));
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let ticket = program.request().unwrap().unwrap();
    let (reply, _) = program.admit(ticket, &router, &mut decoder).unwrap();
    assert!(matches!(program.finish(), Err(RetainedFailure::Completion(CompletionReason::UnacceptedReply))));
    drop(reply);
    let program = RetainedProgram::product_parts(&entity, contract());
    assert!(matches!(program.finish(), Err(RetainedFailure::Completion(CompletionReason::Incomplete))));
    let mut program = RetainedProgram::product_parts(&entity, contract());
    program.cancel();
    assert!(matches!(program.finish(), Err(RetainedFailure::Protocol(RetainedProgramError::Cancelled))));
    let program = RetainedProgram::product_parts(&entity, contract());
    assert!(matches!(program.finish_type_map(60, 1, [1.; 4]),
        Err(RetainedFailure::Completion(CompletionReason::TypeMapRootMissing))));
    let program = RetainedProgram::type_map(decoder.decode_by_id(61).unwrap(), None, contract());
    assert!(matches!(program.finish_type_map(60, 1, [f32::NAN; 4]),
        Err(RetainedFailure::Completion(CompletionReason::NonfiniteTypeColor))));
}

#[test]
fn issue_7955_mapping_completion_preserves_reached_singular_frame_cause() {
    let bytes = mapping_tests::mapped().replace("#84,1.,$", "#84,0.,$");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let mut program = RetainedProgram::type_map(decoder.decode_by_id(61).unwrap(), None, contract());
    assert!(drive(&mut program, &router, &mut decoder).is_empty());
    let failure = origin(program.finish_type_map(60, 1, [1.; 4]).unwrap_err());
    assert_eq!(failure.site, FailureSite::MappingPlacement);
    assert_eq!(failure.entity, Some(13), "the nested occurrence rejected its transform");
    assert!(matches!(failure.cause, OriginCause::Value(
        crate::program::retained::value_error::ValueReason::SingularFrame)));
}

#[test]
fn issue_7955_origin_cannot_replace_original_stop_or_poison_retry() {
    let bytes = malformed();
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    drive(&mut program, &router, &mut decoder);
    let handle = program.selection().unwrap().failure_handle();
    assert_eq!(handle.origin().unwrap().entity, Some(12));
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    account.cancel();
    account.scope(|| assert_eq!(program.request().err(), Some(RetainedProgramError::Stopped(ProgramStop::Cancelled))));
    assert!(matches!(program.finish(), Err(RetainedFailure::Stopped(ProgramStop::Cancelled))));
    assert_eq!(handle.origin().unwrap().entity, Some(12), "stop and source origin are independent");
    assert_eq!(crate::resource::check_current(), Ok(()));

    // A transient caller mistake has no source-origin authority.
    let good = decoder.decode_by_id(20).unwrap();
    let mut program = RetainedProgram::product_parts(&good, contract());
    let ticket = program.request().unwrap().unwrap();
    assert_eq!(program.request().err(), Some(RetainedProgramError::Outstanding));
    assert!(program.selection().unwrap().failure_handle().origin().is_none());
    let (reply, _) = program.admit(ticket, &router, &mut decoder).unwrap();
    assert_eq!(program.admit(ticket, &router, &mut decoder).err(), Some(RetainedProgramError::AlreadyExecuted));
    assert!(program.selection().unwrap().failure_handle().origin().is_none());
    program.accept(reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
    assert_eq!(drive(&mut program, &router, &mut decoder).len(), 1);
    assert_eq!(program.finish().unwrap().values.len(), 1);
}

#[test]
fn issue_7955_first_origin_storage_is_bounded_and_released_with_last_handle() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let nonproduct = decoder.decode_by_id(53).unwrap();
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let failure = account.scope(|| {
        let traversal = RetainedTraversal::new(contract());
        let failure = traversal.product_parts(&nonproduct).finish().unwrap_err();
        let held = account.usage().live_bytes;
        assert!(held > 0, "B1 retained origin storage must be accounted");
        for _ in 0..32 {
            assert!(traversal.product_parts(&nonproduct).finish().is_err());
            assert_eq!(account.usage().live_bytes, held, "later failures retain no additional cause storage");
        }
        failure
    });
    assert!(account.usage().live_bytes > 0, "consumed failure owns its reservation outside scope");
    assert_eq!(crate::resource::check_current(), Ok(()));
    let retained = origin(failure);
    assert!(matches!(retained.cause, OriginCause::Structure(StructuralReason::NotProduct)));
    assert!(account.usage().live_bytes > 0, "the inspected immutable cause owns its storage too");
    drop(retained);
    assert_eq!(account.usage().live_bytes, 0, "B1 last origin owner releases live storage");
}
