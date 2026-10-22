// SPDX-License-Identifier: MPL-2.0
//! Real packets cannot switch model snapshots or complete an expired source.
use super::owned_session::OwnedProductExecution;
use super::session_protocol::{WorkError, WorkPayload};
use super::session_tests::{assert_same, canonical, leaked_job, options, router, SOURCE};
use super::session_work::PrimaryOutcome;
use super::*;

#[test]
fn foreign_context_request_and_reply_are_rejected_intact_before_geometry_or_hash_mutation() {
    let model = ProductionModel::new();
    let a = model.snapshot(OwnedMeshProductionData::default());
    let b = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = EntityDecoder::new(SOURCE);
    let router = router(&mut decoder);
    let job = leaked_job(&mut decoder, 10);
    let mut session = OwnedProductExecution::new(job, &a, &options(), &mut decoder, &router).unwrap();
    let request = session.request().unwrap().unwrap();
    let mut foreign = request;
    foreign.context = Some(b.id());
    assert_eq!(session.execute(foreign, &mut decoder, &router).err(), Some(WorkError::WrongContext));
    assert!(decoder.try_execution_lease().is_ok(), "forged request never reached owner/cache admission");
    let mut reply = session.execute(request, &mut decoder, &router).unwrap();
    let delivered = matches!(&reply.payload, WorkPayload::Primary(PrimaryOutcome::Candidate(parts)) if !parts.sub_meshes.is_empty());
    assert!(delivered, "fixture must deliver real geometry");
    reply.context = Some(b.id());
    let rejected = session.accept(reply, &mut decoder, &router).unwrap_err();
    assert_eq!(rejected.error, WorkError::WrongContext);
    assert!(session.state.meshes.is_empty());
    assert!(session.state.hasher.as_ref().unwrap().is_empty());
    assert_eq!(rejected.reply.context, Some(b.id()), "rejection returns the actual unconsumed packet");
    let mut reply = rejected.reply;
    reply.context = Some(a.id());
    session.accept(reply, &mut decoder, &router).unwrap();
    while session.advance(&mut decoder, &router).unwrap() {}
    assert_same(&session.finish(&decoder, &router).unwrap(), &canonical(10, false));
}

#[test]
fn borrowed_ticket_cannot_be_executed_by_an_owned_product() {
    let context = ProductionModel::new().snapshot(OwnedMeshProductionData::default());
    let mut decoder = EntityDecoder::new(SOURCE);
    let router = router(&mut decoder);
    let job = leaked_job(&mut decoder, 10);
    let mut session = OwnedProductExecution::new(job, &context, &options(), &mut decoder, &router).unwrap();
    let mut request = session.request().unwrap().unwrap();
    request.context = None;
    assert_eq!(session.execute(request, &mut decoder, &router).err(), Some(WorkError::WrongContext));
    assert!(session.state.meshes.is_empty());
}

#[test]
fn source_expiry_returns_real_pending_packet_and_dropping_session_releases_runtime_owners() {
    let model = ProductionModel::new();
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = EntityDecoder::new(SOURCE);
    let router = router(&mut decoder);
    let job = leaked_job(&mut decoder, 10);
    let mut session = OwnedProductExecution::new(job, &context, &options(), &mut decoder, &router).unwrap();
    let request = session.request().unwrap().unwrap();
    let reply = session.execute(request, &mut decoder, &router).unwrap();
    model.invalidate_source();
    let rejected = session.accept(reply, &mut decoder, &router).unwrap_err();
    assert_eq!(rejected.error, WorkError::StaleSource);
    assert_eq!(rejected.reply.request, request);
    assert_eq!(rejected.reply.context, Some(context.id()));
    assert!(session.state.meshes.is_empty());
    assert!(session.state.hasher.as_ref().unwrap().is_empty());
    assert!(decoder.try_execution_lease().is_err(), "expired work still owns its reservation until dropped");
    drop(rejected);
    drop(session);
    let fresh = model.snapshot(OwnedMeshProductionData::default());
    let actual = produce_element_meshes_owned(job, &fresh, &options(), &mut decoder, &router).unwrap();
    assert_same(&actual, &canonical(10, false));
}

#[test]
fn owned_driver_reports_an_occupied_owner_as_a_typed_error() {
    let context = ProductionModel::new().snapshot(OwnedMeshProductionData::default());
    let mut decoder = EntityDecoder::new(SOURCE);
    let router = router(&mut decoder);
    let job = leaked_job(&mut decoder, 10);
    let held = router.try_execution_lease().unwrap();
    assert_eq!(
        produce_element_meshes_owned(job, &context, &options(), &mut decoder, &router).err(),
        Some(ProductionContextError::OwnerUnavailable)
    );
    assert!(decoder.try_execution_lease().is_ok(), "the refused product released its decoder half");
    drop(held);
    assert_same(&produce_element_meshes_owned(job, &context, &options(), &mut decoder, &router).unwrap(), &canonical(10, false));
}
