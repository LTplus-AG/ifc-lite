// SPDX-License-Identifier: MPL-2.0
//! #7955 late S1 review: reached admission, original stops and linear ownership.
use super::*;
use crate::resource::{
    Dimension, ExecutionAccount, ExecutionPolicy, ProgramStop, RefusalReason,
    ResourceFailure, ResourceLimits,
};

fn reached_ticket(
    program: &mut RetainedProgram,
    router: &GeometryRouter,
    decoder: &mut EntityDecoder,
) -> RetainedTicket {
    while let Some(ticket) = program.request().unwrap() {
        if matches!(&program.inner.control, Control::Product(c) if c.retained_ready()) {
            return ticket;
        }
        let (reply, operations) = program.admit(ticket, router, decoder).unwrap();
        assert!(operations.is_empty());
        program.accept(reply, router).unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    panic!("expected a reached construction");
}

#[test]
fn default_step_errors_keep_the_one_byte_protocol_contract() {
    // This is the explicit F3 layout contract for the exact step error, not a
    // performance verdict or a pin of platform-dependent controller layouts.
    assert_eq!(std::mem::size_of::<ProgramError>(), 1);
    assert_eq!(std::mem::size_of::<std::result::Result<(), ProgramError>>(), 1);
}

#[test]
fn admission_budget_stop_preserves_original_stop_ticket_and_reached_operation() {
    // Work 0 fails the output header reserve; 1 fails try_copy's value reserve;
    // 2 fails try_copy's per-value charge. These are real resource operations.
    for budget in [0, 1, 2] {
        let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(SOURCE, &mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = RetainedProgram::product_parts(&entity, contract());
        let ticket = reached_ticket(&mut program, &router, &mut decoder);
        let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
            work: Some(budget),
            ..Default::default()
        }));
        let expected = ProgramStop::ResourceRefused(ResourceFailure {
            dimension: Dimension::Work,
            requested: 1,
            remaining: 0,
            reason: RefusalReason::Limit,
        });
        account.scope(|| {
            assert_eq!(account.check(), Ok(()), "no pre-existing stop");
            assert_eq!(
                program.admit(ticket, &router, &mut decoder).err(),
                Some(RetainedProgramError::Stopped(expected)),
                "budget {budget} must report the original refusal"
            );
            assert_eq!(account.check(), Err(expected));
            assert_eq!(account.usage().work, budget);
            assert_eq!(program.inner.pending, Some((ticket.0, false)));
            assert_eq!(program.inner.expected_payload, None);
            assert!(matches!(&program.inner.control, Control::Product(c) if c.retained_ready()));
            assert_eq!(program.validate_ticket(ticket), Err(RetainedProgramError::Stopped(expected)));
        });
        // S2 strengthens S1: the original stop remains terminal after scope
        // exit. Inspect the reached child directly solely to prove that the
        // failed admission left its real operation intact; never resume the facade.
        assert_eq!(program.validate_ticket(ticket), Err(RetainedProgramError::Stopped(expected)));
        assert_eq!(program.admit(ticket, &router, &mut decoder).err(), Some(RetainedProgramError::Stopped(expected)));
        assert_eq!(program.inner.pending, Some((ticket.0, false)));
        let Control::Product(control) = &mut program.inner.control else { panic!("product") };
        let (_, operations) = control.admit_retained().unwrap();
        assert_eq!(operations.len(), 1);
        assert!(matches!(operations[0].value().definition(),
            LogicalRetainedDefinition::Source { source_id: 13, .. }));
        assert!(matches!(program.finish(), Err(RetainedFailure::Stopped(stop)) if stop == expected));
    }
}

#[test]
fn source_step_stop_returns_its_reply_for_intact_rejection() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let traversal = RetainedTraversal::new(contract());
    let mut program = traversal.product_parts(&entity);
    let mut existing_sibling = traversal.product_parts(&entity);
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        work: Some(0),
        ..Default::default()
    }));
    let (reply, ticket, stop) = account.scope(|| {
        loop {
            let ticket = program.request().unwrap().expect("source capture must be reached");
            let (reply, operations) = program.admit(ticket, &router, &mut decoder).unwrap();
            assert!(operations.is_empty());
            if let Err(stop) = account.check() {
                assert_eq!(stop, ProgramStop::ResourceRefused(ResourceFailure {
                    dimension: Dimension::Work, requested: 1, remaining: 0,
                    reason: RefusalReason::Limit,
                }));
                assert_eq!(program.inner.pending, Some((ticket.0, true)));
                assert_eq!(reply.0.request, ticket.0);
                assert!(matches!(&reply.0.value,
                    ReplyValue::Product(ProductReply::Item(ItemStep::RetainedComplete(Err(Error::ProgramStopped(actual)), _)))
                    if *actual == stop));
                // No facade check or accept in this scope may incidentally latch it.
                return (reply, ticket, stop);
            }
            program.accept(reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
        }
    });
    assert_eq!(crate::resource::check_current(), Ok(()));
    let rejected = program.accept(reply, &router).err().unwrap();
    assert_eq!(rejected.error, RetainedProgramError::Stopped(stop));
    assert_eq!(rejected.reply.0.request, ticket.0);
    let rejected = program.accept(rejected.reply, &router).err().unwrap();
    assert_eq!(rejected.error, RetainedProgramError::Stopped(stop));
    assert_eq!(rejected.reply.0.request, ticket.0);
    assert_eq!(existing_sibling.request().err(), Some(RetainedProgramError::Stopped(stop)));
    assert_eq!(traversal.product_parts(&entity).request().err(), Some(RetainedProgramError::Stopped(stop)));
    assert!(matches!(program.finish(), Err(RetainedFailure::Stopped(actual)) if actual == stop));
}

#[test]
fn refused_exact_execution_does_not_bind_an_unbound_reached_controller() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    reached_ticket(&mut program, &router, &mut decoder);
    // Put the real reached controller in a fresh protocol wrapper to exercise
    // first-owner binding. Normal product traversal has already bound owners.
    let mut inner = GeometryProgram::with_control(program.inner.control);
    let request = inner.request().unwrap().unwrap();
    assert_eq!(inner.execute(request, &router, &mut decoder).err(), Some(ProgramError::UnsupportedRetained));
    assert!(inner.expected_router.is_none());
    assert!(inner.expected_decoder.is_none());
    assert_eq!(inner.pending, Some((request, false)));
    assert!(matches!(&inner.control, Control::Product(c) if c.retained_ready()));
}

#[test]
fn item_exact_guard_independently_preserves_a_real_reached_construction() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let item = decoder.decode_by_id(13).unwrap();
    let mut control = ItemControl::new((0., 0., 0.));
    control.retained = RetainedSelection::new(contract(), 1);
    let source_reply = control.execute(&item, &router, &mut decoder).unwrap();
    control.accept(source_reply, &router);
    assert!(control.retained_ready());
    assert_eq!(control.execute(&item, &router, &mut decoder).err(), Some(ProgramError::UnsupportedRetained));
    assert!(control.retained_ready());
    let (_, operations) = control.admit_retained().unwrap();
    assert_eq!(operations.len(), 1);
    assert!(matches!(operations[0].value().definition(), LogicalRetainedDefinition::Source { source_id: 13, .. }));
}

#[test]
fn refused_type_map_execution_does_not_bind_an_unbound_reached_controller() {
    // #7955 restack: S1's first-owner rule applies to the S2 root as well.
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let mut program = RetainedProgram::type_map(decoder.decode_by_id(61).unwrap(), None, contract());
    loop {
        let ticket = program.request().unwrap().expect("type source construction");
        if matches!(&program.inner.control, Control::Mapping(c) if c.retained_ready()) { break; }
        let (reply, operations) = program.admit(ticket, &router, &mut decoder).unwrap();
        assert!(operations.is_empty());
        program.accept(reply, &router).unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    let mut inner = GeometryProgram::with_control(program.inner.control);
    let request = inner.request().unwrap().unwrap();
    assert_eq!(inner.execute(request, &router, &mut decoder).err(), Some(ProgramError::UnsupportedRetained));
    assert!(inner.expected_router.is_none());
    assert!(inner.expected_decoder.is_none());
    assert_eq!(inner.pending, Some((request, false)));
    assert!(matches!(&inner.control, Control::Mapping(c) if c.retained_ready()));
}
