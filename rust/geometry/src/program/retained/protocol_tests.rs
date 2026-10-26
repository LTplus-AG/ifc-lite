// SPDX-License-Identifier: MPL-2.0
//! #7955: facade lifecycle errors preserve the outstanding logical operation.
use super::*;

pub(super) fn numerical_reply(
    program: &mut RetainedProgram,
    router: &GeometryRouter,
    decoder: &mut EntityDecoder,
) -> (RetainedTicket, RetainedReply, RetainedPlanOperation) {
    while let Some(ticket) = program.request().unwrap() {
        let (reply, mut operations) = program.admit(ticket, router, decoder).unwrap();
        if !operations.is_empty() {
            assert_eq!(operations.len(), 1);
            return (ticket, reply, operations.remove(0));
        }
        program
            .accept(reply, router)
            .unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    panic!("expected positive numerical admission");
}

#[test]
fn cancelled_facade_blocks_requests_admission_acceptance_and_finish() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut early = RetainedProgram::product_parts(&entity, contract());
    early.cancel();
    assert_eq!(early.request().err(), Some(RetainedProgramError::Cancelled));
    assert!(early.finish().is_err());

    let mut program = RetainedProgram::product_parts(&entity, contract());
    let (ticket, reply, _) = numerical_reply(&mut program, &router, &mut decoder);
    program.cancel();
    assert_eq!(
        program.request().err(),
        Some(RetainedProgramError::Cancelled)
    );
    assert_eq!(
        program.validate_ticket(ticket),
        Err(RetainedProgramError::Cancelled)
    );
    assert_eq!(
        program.admit(ticket, &router, &mut decoder).err(),
        Some(RetainedProgramError::Cancelled)
    );
    assert_eq!(
        program.validate_reply(&reply, &router),
        Err(RetainedProgramError::Cancelled)
    );
    let rejected = program.accept(reply, &router).err().unwrap();
    assert_eq!(rejected.error, RetainedProgramError::Cancelled);
    assert!(program.finish().is_err());
}

#[test]
fn cancelled_or_foreign_router_rejection_returns_numerical_reply_intact() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let foreign_router = GeometryRouter::new();
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let (_, reply, operation) = numerical_reply(&mut program, &router, &mut decoder);
    let mut cancelled = RetainedProgram::product_parts(&entity, contract());
    cancelled.cancel();
    let rejected = cancelled.accept(reply, &router).err().unwrap();
    assert_eq!(rejected.error, RetainedProgramError::Cancelled);
    let rejected = program
        .accept(rejected.reply, &foreign_router)
        .err()
        .unwrap();
    assert_eq!(rejected.error, RetainedProgramError::WrongOwner);
    program
        .accept(rejected.reply, &router)
        .unwrap_or_else(|e| panic!("{:?}", e.error));
    assert!(drive(&mut program, &router, &mut decoder).is_empty());
    let plan = program.finish().unwrap();
    assert_eq!(plan.values.len(), 1);
    assert_eq!(plan.values[0].definition(), operation.value().definition());
    assert!(plan.values[0].is_product_placed());
}

#[test]
fn copied_ticket_cannot_repeat_admission_or_replay_after_acceptance() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let (ticket, reply, _) = numerical_reply(&mut program, &router, &mut decoder);
    assert_eq!(
        program.request().err(),
        Some(RetainedProgramError::Outstanding)
    );
    assert_eq!(
        program.admit(ticket, &router, &mut decoder).err(),
        Some(RetainedProgramError::AlreadyExecuted)
    );
    program
        .accept(reply, &router)
        .unwrap_or_else(|e| panic!("{:?}", e.error));
    assert_eq!(
        program.validate_ticket(ticket),
        Err(RetainedProgramError::StaleRequest)
    );
    assert_eq!(
        program.admit(ticket, &router, &mut decoder).err(),
        Some(RetainedProgramError::StaleRequest)
    );
    assert!(drive(&mut program, &router, &mut decoder).is_empty());
    assert_eq!(program.finish().unwrap().values.len(), 1);
}

#[test]
fn finish_refuses_outstanding_unexecuted_and_unaccepted_tickets() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut unexecuted = RetainedProgram::product_parts(&entity, contract());
    assert!(unexecuted.request().unwrap().is_some());
    assert!(unexecuted.finish().is_err());
    let mut unaccepted = RetainedProgram::product_parts(&entity, contract());
    let (_, _reply, _) = numerical_reply(&mut unaccepted, &router, &mut decoder);
    assert!(unaccepted.finish().is_err());
}

#[test]
fn changed_decoder_generation_refuses_next_admission_without_finishing_product() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(SOURCE, &mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedProgram::product_parts(&entity, contract());
    let (_, reply, _) = numerical_reply(&mut program, &router, &mut decoder);
    program
        .accept(reply, &router)
        .unwrap_or_else(|e| panic!("{:?}", e.error));
    let next = program
        .request()
        .unwrap()
        .expect("product placement still needs source");
    decoder.clear_cache();
    assert_eq!(
        program.admit(next, &router, &mut decoder).err(),
        Some(RetainedProgramError::WrongOwner)
    );
    assert_eq!(program.validate_ticket(next), Ok(()));
    assert!(program.finish().is_err());
}
