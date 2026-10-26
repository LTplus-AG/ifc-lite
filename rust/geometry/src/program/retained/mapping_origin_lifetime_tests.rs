// SPDX-License-Identifier: MPL-2.0
//! #7955 B2a: owned Core, shared first cause and original resource-stop priority.
use super::*;
use crate::resource::{Dimension, ExecutionAccount, ExecutionPolicy, ResourceLimits, ProgramStop, RefusalReason};

#[test]
fn issue_7955_b2a_core_origin_survives_consumption_teardown_and_thread_transfer() {
    for mode in 0..3 {
        let (failure, recorded, source_weak) = {
            let bytes = two_occurrences("#81,#999999", "");
            let source = SourceBundle::new(bytes.as_bytes().to_vec());
            let weak = Arc::downgrade(&source);
            let mut decoder = source.decoder();
            let router = GeometryRouter::with_units(&bytes, &mut decoder);
            assert!(matches!(decoder.decode_by_id(999999),
                Err(ifc_lite_core::Error::ParseError { position: 0, message }) if message == "Entity #999999 not found"));
            let entity = decoder.decode_by_id(10).unwrap();
            let traversal = RetainedTraversal::new(contract());
            let mut program = match mode {
                0 => traversal.product_parts(&entity),
                1 => traversal.product_submeshes(&entity, true, None),
                _ => traversal.type_map(decoder.decode_by_id(61).unwrap(), None),
            };
            assert_eq!(drive(&mut program, &router, &mut decoder).len(), 1);
            let recorded = Arc::downgrade(&program.selection().unwrap().failure_handle().origin().unwrap());
            let failure = finish(program, mode).unwrap_err();
            drop(decoder.try_execution_lease().expect("mapping failure holds no decoder lease"));
            (failure, recorded, weak)
        };
        assert!(source_weak.upgrade().is_none(), "mapping origin must release source storage");
        std::thread::spawn(move || {
            let failure = origin(failure);
            assert!(Arc::ptr_eq(&failure, &recorded.upgrade().expect("same owned cause after teardown")));
            assert_origin(&failure, FailureSite::MappingTarget, 999999, ExpectedCause::Missing(999999));
        }).join().unwrap();
    }
}

#[test]
fn issue_7955_b2a_first_mapping_cause_survives_later_roots_and_original_stop() {
    let bytes = two_occurrences("#81,$", "");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let good = decoder.decode_by_id(20).unwrap();
    let traversal = RetainedTraversal::new(contract());
    let mut sibling = traversal.product_parts(&good);
    let mut bad = traversal.product_parts(&entity);
    assert_eq!(drive(&mut bad, &router, &mut decoder).len(), 1);
    let first = origin(bad.finish().unwrap_err());
    let mut later = traversal.type_map(decoder.decode_by_id(4).unwrap(), None);
    assert!(drive(&mut later, &router, &mut decoder).is_empty());
    let later = origin(later.finish_type_map(60, 1, [1.; 4]).unwrap_err());
    assert!(Arc::ptr_eq(&first, &later), "later actual MappingSource rejection cannot overwrite target");
    assert_origin(&later, FailureSite::MappingTarget, 93, ExpectedCause::Mapping(MappingReason::ReferenceRequired));
    assert_eq!(drive(&mut sibling, &router, &mut decoder).len(), 1);
    assert!(Arc::ptr_eq(&first, &origin(sibling.finish().unwrap_err())));
    let mut fresh = RetainedProgram::product_parts(&good, contract());
    assert_eq!(drive(&mut fresh, &router, &mut decoder).len(), 1);
    assert_eq!(fresh.finish().unwrap().values.len(), 1);

    let mut stopped = traversal.product_parts(&good);
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    account.cancel();
    account.scope(|| assert_eq!(stopped.request().err(), Some(RetainedProgramError::Stopped(ProgramStop::Cancelled))));
    assert!(matches!(stopped.finish(), Err(RetainedFailure::Stopped(ProgramStop::Cancelled))));
    assert_origin(&first, FailureSite::MappingTarget, 93, ExpectedCause::Mapping(MappingReason::ReferenceRequired));
}

#[test]
fn issue_7955_b2a_zero_origin_storage_keeps_original_stop_and_unconsumed_reply() {
    let bytes = SOURCE.replace("#61=IFCREPRESENTATIONMAP(#7,#12)", "#61=IFCREPRESENTATIONMAP(#7,$)");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes, &mut decoder);
    let entity = decoder.decode_by_id(20).unwrap();
    // Allocate the traversal before the zero allowance, so the failure is the
    // first cause's charge, not creation of the failure slot or a child buffer.
    let traversal = RetainedTraversal::new(contract());
    let mut sibling = traversal.product_parts(&entity);
    let mut program = traversal.type_map(decoder.decode_by_id(61).unwrap(), None);
    let handle = program.selection().unwrap().failure_handle();
    let ticket = program.request().unwrap().unwrap();
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        live_bytes: Some(0), ..Default::default()
    }));
    let (reply, expected) = account.scope(|| {
        let (reply, operations) = program.admit(ticket, &router, &mut decoder).unwrap();
        assert!(operations.is_empty());
        (reply, account.check().expect_err("B2a cause storage must be charged"))
    });
    let requested = (std::mem::size_of::<OriginFailure>() + 2 * std::mem::size_of::<usize>()) as u64;
    assert!(matches!(expected, ProgramStop::ResourceRefused(f) if f.dimension == Dimension::LiveBytes
        && f.requested == requested && f.remaining == 0 && f.reason == RefusalReason::Limit));
    assert!(handle.origin().is_none(), "failed storage never publishes an uncharged cause");
    assert_eq!(crate::resource::check_current(), Ok(()));
    let rejected = program.accept(reply, &router).err().unwrap();
    assert_eq!(rejected.error, RetainedProgramError::Stopped(expected));
    assert_eq!(rejected.reply.0.request, ticket.0);
    let rejected = program.accept(rejected.reply, &router).err().unwrap();
    assert_eq!(rejected.error, RetainedProgramError::Stopped(expected));
    assert_eq!(program.inner.pending, Some((ticket.0, true)));
    drop(rejected.reply);
    let other = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    other.cancel();
    other.scope(|| assert_eq!(program.request().err(), Some(RetainedProgramError::Stopped(expected))));
    let mut new_sibling = traversal.product_parts(&entity);
    for root in [&mut sibling, &mut new_sibling] {
        assert_eq!(root.request().err(), Some(RetainedProgramError::Stopped(expected)));
    }
    assert!(matches!(program.finish_type_map(60, 1, [1.; 4]), Err(RetainedFailure::Stopped(stop)) if stop == expected));
}
