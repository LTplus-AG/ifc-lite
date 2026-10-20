// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::{build_entity_index, columnar_index::ColumnarEntityIndex, EntityDecoder};

const SOURCE: &str = "#1=IFCCARTESIANPOINT((1.,2.,3.));";

#[test]
fn every_decoder_constructor_reserves_its_own_input_even_for_identical_ids_and_bytes() {
    let index = build_entity_index(SOURCE);
    let mut decoders = [
        EntityDecoder::new(SOURCE),
        EntityDecoder::with_index(SOURCE, index.clone()),
        EntityDecoder::with_arc_index(SOURCE, Arc::new(index.clone())),
        EntityDecoder::with_arc_columnar_index(
            SOURCE,
            Arc::new(ColumnarEntityIndex::from_hashmap(&index).unwrap()),
        ),
    ];
    for i in 0..decoders.len() {
        let lease = decoders[i].try_execution_lease().unwrap();
        assert!(matches!(
            decoders[i].try_execution_lease(),
            Err(ExecutionLeaseError::AlreadyLeased)
        ));
        let point = decoders[i].decode_by_id(1).unwrap();
        assert_eq!(point.id, 1);
        lease.validate(decoders[i].execution_identity()).unwrap();
        for (j, decoder) in decoders.iter().enumerate() {
            if i != j {
                assert_eq!(
                    lease.validate(decoder.execution_identity()),
                    Err(ExecutionLeaseError::WrongOwner)
                );
            }
        }
        let moved = Box::new(std::mem::replace(
            &mut decoders[i],
            EntityDecoder::new(SOURCE),
        ));
        lease.validate(moved.execution_identity()).unwrap();
        let identity = moved.execution_identity();
        drop(moved);
        assert_eq!(
            lease.validate(identity),
            Err(ExecutionLeaseError::OwnerDropped)
        );
    }
}

#[test]
fn decoder_configuration_replacement_rejects_work_without_lending_its_reserved_owner() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let lease = decoder.try_execution_lease().unwrap();
    decoder.decode_by_id(1).unwrap();
    lease.validate(decoder.execution_identity()).unwrap();
    decoder.seed_unit_scales(0.001, 1.);
    assert_eq!(decoder.length_unit_scale(), 0.001);
    assert_eq!(
        lease.validate(decoder.execution_identity()),
        Err(ExecutionLeaseError::ConfigurationChanged)
    );
    assert!(matches!(
        decoder.try_execution_lease(),
        Err(ExecutionLeaseError::AlreadyLeased)
    ));
    let old_id = lease.id();
    drop(lease);
    let next = decoder.try_execution_lease().unwrap();
    assert_ne!(
        next.id(),
        old_id,
        "completed product tickets cannot alias the next reservation"
    );
    next.validate(decoder.execution_identity()).unwrap();
}

#[test]
fn input_index_replacement_invalidates_pending_work_even_if_model_entity_ids_match() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let lease = decoder.try_execution_lease().unwrap();
    decoder.set_entity_index(Arc::new(build_entity_index(SOURCE)));
    assert_eq!(
        lease.validate(decoder.execution_identity()),
        Err(ExecutionLeaseError::ConfigurationChanged)
    );
    assert_eq!(
        decoder.decode_by_id(1).unwrap().id,
        1,
        "ordinary decoding remains valid"
    );
}

#[test]
fn error_and_panic_drop_release_the_owner_and_send_reservations_can_be_cancelled_on_another_worker()
{
    let mut decoder = EntityDecoder::new(SOURCE);
    let result: Result<(), crate::Error> = (|| {
        let _lease = decoder.try_execution_lease().unwrap();
        decoder.decode_by_id(999)?;
        Ok(())
    })();
    assert!(result.is_err());
    let lease = decoder
        .try_execution_lease()
        .expect("error released reservation");
    std::thread::spawn(move || drop(lease)).join().unwrap();
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _lease = decoder.try_execution_lease().unwrap();
        decoder.decode_by_id(1).unwrap();
        panic!("worker failed after actual source admission");
    }));
    assert!(panic.is_err());
    decoder
        .try_execution_lease()
        .expect("unwind released reservation");
}

#[test]
fn trusted_synchronous_mutations_commit_only_on_the_same_live_owner() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut lease = decoder.try_execution_lease().unwrap();
    let before = lease.identity();
    let work = lease
        .begin_synchronous_work(decoder.execution_identity())
        .unwrap();
    decoder.clear_entity_cache();
    decoder.seed_unit_scales(1., 1.);
    assert_eq!(decoder.decode_by_id(1).unwrap().id, 1);
    work.commit(decoder.execution_identity()).unwrap();
    assert_ne!(before, lease.identity());
    lease.validate(decoder.execution_identity()).unwrap();
    // A later external mutation is not acknowledged by the completed work.
    decoder.clear_entity_cache();
    assert_eq!(
        lease.validate(decoder.execution_identity()),
        Err(ExecutionLeaseError::ConfigurationChanged)
    );
    assert!(matches!(
        lease.begin_synchronous_work(decoder.execution_identity()),
        Err(ExecutionLeaseError::ConfigurationChanged)
    ));
}

#[test]
fn trusted_scope_drop_and_panic_never_refresh_the_pending_lease() {
    for panic in [false, true] {
        let mut decoder = EntityDecoder::new(SOURCE);
        let mut lease = decoder.try_execution_lease().unwrap();
        let before = lease.identity();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _work = lease
                .begin_synchronous_work(decoder.execution_identity())
                .unwrap();
            decoder.clear_entity_cache();
            if panic {
                panic!("trusted callback failed");
            }
        }));
        assert_eq!(result.is_err(), panic);
        assert_eq!(lease.identity(), before);
        assert_eq!(
            lease.validate(decoder.execution_identity()),
            Err(ExecutionLeaseError::ConfigurationChanged)
        );
    }
}

#[test]
fn trusted_commit_rejects_replaced_or_dropped_owner_instances() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut lease = decoder.try_execution_lease().unwrap();
    let work = lease
        .begin_synchronous_work(decoder.execution_identity())
        .unwrap();
    let old = std::mem::replace(&mut decoder, EntityDecoder::new(SOURCE));
    assert_eq!(
        work.commit(decoder.execution_identity()),
        Err(ExecutionLeaseError::WrongOwner)
    );
    lease.validate(old.execution_identity()).unwrap();
    let work = lease
        .begin_synchronous_work(old.execution_identity())
        .unwrap();
    let old_id = old.execution_identity();
    drop(old);
    assert_eq!(work.commit(old_id), Err(ExecutionLeaseError::OwnerDropped));
}

#[test]
fn synchronous_child_keeps_root_exclusive_and_accepts_trusted_parent_maintenance() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut root = decoder.try_execution_lease().unwrap();
    let work = root
        .begin_synchronous_work(decoder.execution_identity())
        .unwrap();
    let capability = work.child_capability();
    decoder.clear_entity_cache();
    let mut child = capability.try_lease(decoder.execution_identity()).unwrap();
    assert!(matches!(
        decoder.try_execution_lease(),
        Err(ExecutionLeaseError::AlreadyLeased)
    ));
    let child_work = child
        .begin_synchronous_work(decoder.execution_identity())
        .unwrap();
    decoder.seed_unit_scales(1.0, 1.0);
    decoder.decode_by_id(1).unwrap();
    child_work.commit(decoder.execution_identity()).unwrap();
    child.validate(decoder.execution_identity()).unwrap();
    drop(child);
    assert!(matches!(
        decoder.try_execution_lease(),
        Err(ExecutionLeaseError::AlreadyLeased)
    ));
    work.commit(decoder.execution_identity()).unwrap();
    assert!(matches!(
        capability.try_lease(decoder.execution_identity()),
        Err(ExecutionLeaseError::ExpiredWork)
    ));
    root.validate(decoder.execution_identity()).unwrap();
    drop(root);
    decoder.try_execution_lease().unwrap();
}

#[test]
fn escaped_descendant_cannot_outlive_ancestor_or_cross_threads() {
    let decoder = EntityDecoder::new(SOURCE);
    let mut root = decoder.try_execution_lease().unwrap();
    let work = root
        .begin_synchronous_work(decoder.execution_identity())
        .unwrap();
    let capability = work.child_capability();
    let child = capability.try_lease(decoder.execution_identity()).unwrap();
    let identity = decoder.execution_identity();
    let child = std::thread::spawn(move || {
        assert_eq!(
            child.validate(identity),
            Err(ExecutionLeaseError::ExpiredWork)
        );
        child
    })
    .join()
    .unwrap();
    child.validate(identity).unwrap();
    let mut child = child;
    let child_work = child.begin_synchronous_work(identity).unwrap();
    let grandchild_cap = child_work.child_capability();
    let grandchild = grandchild_cap.try_lease(identity).unwrap();
    drop(work);
    assert_eq!(
        grandchild.validate(identity),
        Err(ExecutionLeaseError::ExpiredWork)
    );
    assert_eq!(
        child_work.commit(identity),
        Err(ExecutionLeaseError::ExpiredWork)
    );
    drop(child);
    assert!(matches!(
        decoder.try_execution_lease(),
        Err(ExecutionLeaseError::AlreadyLeased)
    ));
    drop(root);
    decoder.try_execution_lease().unwrap();
}

#[test]
fn child_capability_rejects_replacement_and_expires_on_parent_panic() {
    let decoder = EntityDecoder::new(SOURCE);
    let other = EntityDecoder::new(SOURCE);
    let mut root = decoder.try_execution_lease().unwrap();
    let mut escaped = None;
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let work = root
            .begin_synchronous_work(decoder.execution_identity())
            .unwrap();
        let capability = work.child_capability();
        assert!(matches!(
            capability.try_lease(other.execution_identity()),
            Err(ExecutionLeaseError::WrongOwner)
        ));
        escaped = Some(capability.try_lease(decoder.execution_identity()).unwrap());
        panic!("nested callback failed");
    }));
    assert!(result.is_err());
    assert_eq!(
        escaped.unwrap().validate(decoder.execution_identity()),
        Err(ExecutionLeaseError::ExpiredWork)
    );
    root.validate(decoder.execution_identity()).unwrap();
}

#[test]
fn mutable_decoder_source_borrow_can_run_joined_worker_without_unlocking_parent() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut root = decoder.try_execution_lease().unwrap();
    assert!(
        decoder.try_source_execution_lease().unwrap().is_none(),
        "pending root has no source authority"
    );
    let work = root
        .begin_synchronous_work(decoder.execution_identity())
        .unwrap();
    let source = work.source_borrow_scope();
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                let mut child = decoder.try_source_execution_lease().unwrap().unwrap();
                assert!(matches!(
                    decoder.try_execution_lease(),
                    Err(ExecutionLeaseError::AlreadyLeased)
                ));
                let child_work = child
                    .begin_synchronous_work(decoder.execution_identity())
                    .unwrap();
                let child_source = child_work.source_borrow_scope();
                decoder.clear_entity_cache();
                decoder.seed_unit_scales(1., 1.);
                assert_eq!(decoder.decode_by_id(1).unwrap().id, 1);
                drop(child_source);
                child_work.commit(decoder.execution_identity()).unwrap();
                child.validate(decoder.execution_identity()).unwrap();
            })
            .join()
            .unwrap();
    });
    // The worker's nested source scope restored the still-live parent scope.
    decoder
        .try_source_execution_lease()
        .unwrap()
        .unwrap()
        .validate(decoder.execution_identity())
        .unwrap();
    drop(source);
    work.commit(decoder.execution_identity()).unwrap();
    root.validate(decoder.execution_identity()).unwrap();
    assert!(decoder.try_source_execution_lease().unwrap().is_none());
    assert!(matches!(
        decoder.try_execution_lease(),
        Err(ExecutionLeaseError::AlreadyLeased)
    ));
}

#[test]
fn scoped_source_worker_panic_restores_authority_and_uncommitted_generation_is_rejected() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut root = decoder.try_execution_lease().unwrap();
    let before = root.identity();
    let work = root
        .begin_synchronous_work(decoder.execution_identity())
        .unwrap();
    let source = work.source_borrow_scope();
    std::thread::scope(|scope| {
        let failed = scope
            .spawn(|| {
                let mut child = decoder.try_source_execution_lease().unwrap().unwrap();
                let child_work = child
                    .begin_synchronous_work(decoder.execution_identity())
                    .unwrap();
                let _source = child_work.source_borrow_scope();
                decoder.clear_entity_cache();
                panic!("joined source worker failed");
            })
            .join();
        assert!(failed.is_err());
    });
    decoder
        .try_source_execution_lease()
        .unwrap()
        .unwrap()
        .validate(decoder.execution_identity())
        .unwrap();
    drop(source);
    drop(work);
    assert_eq!(root.identity(), before);
    assert_eq!(
        root.validate(decoder.execution_identity()),
        Err(ExecutionLeaseError::ConfigurationChanged)
    );
    assert!(decoder.try_source_execution_lease().unwrap().is_none());
}

#[test]
fn escaped_source_child_expires_with_work_and_cannot_authorize_replacement_decoder() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut root = decoder.try_execution_lease().unwrap();
    let work = root
        .begin_synchronous_work(decoder.execution_identity())
        .unwrap();
    let source = work.source_borrow_scope();
    let child = decoder.try_source_execution_lease().unwrap().unwrap();
    let mut replacement = EntityDecoder::new(SOURCE);
    assert!(replacement.try_source_execution_lease().unwrap().is_none());
    assert_eq!(
        child.validate(replacement.execution_identity()),
        Err(ExecutionLeaseError::WrongOwner)
    );
    drop(work);
    assert_eq!(
        child.validate(decoder.execution_identity()),
        Err(ExecutionLeaseError::ExpiredWork)
    );
    assert!(matches!(
        decoder.try_source_execution_lease(),
        Err(ExecutionLeaseError::ExpiredWork)
    ));
    drop(source);
    assert!(decoder.try_source_execution_lease().unwrap().is_none());
    drop(child);
    assert!(matches!(
        decoder.try_execution_lease(),
        Err(ExecutionLeaseError::AlreadyLeased)
    ));
    drop(root);
    decoder.try_execution_lease().unwrap();
}

// Resource integration round 2: actual source ancestry, including a worker
// whose child epoch was created after its Compatibility parent stopped.
#[test]
fn source_stop_observes_oldest_ancestor_and_cannot_extend_expired_authority() {
    use crate::resource_stop::{Dimension, ProgramStop, RefusalReason, ResourceFailure};
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut root = decoder.try_execution_lease().unwrap();
    let work = root
        .begin_synchronous_work(decoder.execution_identity())
        .unwrap();
    let source = work.source_borrow_scope();
    let ancestor = source.resource_stop_handle();
    let refusal = ProgramStop::ResourceRefused(ResourceFailure {
        dimension: Dimension::Work,
        requested: 2,
        remaining: 1,
        reason: RefusalReason::Limit,
    });
    assert_eq!(ancestor.stop(refusal), refusal);
    let escaped = std::thread::scope(|scope| {
        scope
            .spawn(|| {
                let mut child = decoder.try_source_execution_lease().unwrap().unwrap();
                let child_work = child
                    .begin_synchronous_work(decoder.execution_identity())
                    .unwrap();
                let child_source = child_work.source_borrow_scope();
                let handle = child_source.resource_stop_handle();
                assert_eq!(handle.check(), Err(refusal));
                assert_eq!(handle.stop(ProgramStop::Cancelled), refusal);
                assert_eq!(handle.check(), Err(refusal));
                drop(child_source);
                child_work.commit(decoder.execution_identity()).unwrap();
                child
            })
            .join()
            .unwrap()
    });
    drop(source);
    drop(work);
    // A retained stop handle is resource data, never an owner lease capability.
    assert_eq!(ancestor.stop(ProgramStop::Cancelled), refusal);
    assert_eq!(
        escaped.validate(decoder.execution_identity()),
        Err(ExecutionLeaseError::ExpiredWork)
    );
    assert!(decoder.try_source_execution_lease().unwrap().is_none());
    drop(escaped);
    drop(root);
    decoder.try_execution_lease().unwrap();
}
