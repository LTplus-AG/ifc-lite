// SPDX-License-Identifier: MPL-2.0
//! Owner-migration unit 1: source-driven cache authority, independent dimensions.
use super::{containers::try_arc, fixtures::*, gate::Gate};
use crate::SourceBundle;
use crate::execution_owner::{ExecutionLeaseError, resource_prototype::Authority};
use std::sync::Arc;

#[test]
fn unit1_live_cache_publication_alone_revokes_an_already_captured_allocator() {
    run(4096, |decoder, work, gate, budget, _| {
        assert_eq!(decoder.decode_by_id(1).unwrap().get_list(0).unwrap().len(), 3);
        let generation = decoder.execution_identity();
        let provenance = decoder.cache_revision;
        let authority = Authority::capture(decoder, work).unwrap();
        assert!(gate.scope(decoder, work, |decoder, allocator| {
            // Exercise the actual writer publication seam independently: no
            // generation bump, source replacement, or raw provenance revocation.
            // A generation-only gate would incorrectly allocate here.
            decoder.execution_owner.cache_changed();
            assert_eq!(decoder.execution_identity(), generation);
            assert_eq!(decoder.cache_revision, provenance);
            assert_eq!(authority.validate(), Err(ExecutionLeaseError::ConfigurationChanged));
            try_arc(allocator, 7u64).map(drop)
        }).is_err());
        assert_eq!(budget.stats().allocations, 0);
    });
}

#[test]
fn unit1_raw_revocation_without_generation_change_is_visible_to_live_work() {
    run(4096, |decoder, work, gate, budget, _| {
        let generation = decoder.execution_identity();
        let authority = Authority::capture(decoder, work).unwrap();
        assert!(gate.scope(decoder, work, |decoder, allocator| {
            // Real raw-import revocation helper, before a possibly failing
            // installation. It must revoke even if installation never completes.
            decoder.revoke_cache_authority();
            assert_eq!(decoder.execution_identity(), generation);
            assert_eq!(authority.validate(), Err(ExecutionLeaseError::ConfigurationChanged));
            try_arc(allocator, 7u64).map(drop)
        }).is_err());
        assert_eq!(budget.stats().allocations, 0);
    });
}

#[test]
fn unit1_generation_change_is_rejected_with_an_unchanged_live_cache_revision() {
    let (source, resources, budget) = setup(4096);
    let decoder = source.decoder();
    let mut lease = decoder.try_execution_lease().unwrap();
    let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
    let _scope = work.source_borrow_scope_with_resources(Some(context(&resources)));
    let gate = Gate::new(&decoder, &work).unwrap();
    let authority = Authority::capture(&decoder, &work).unwrap();
    let revision = decoder.execution_owner.cache_revision();
    let mut decoder = decoder.with_strict_reals();
    assert_eq!(decoder.execution_owner.cache_revision(), revision);
    assert_eq!(authority.validate(), Err(ExecutionLeaseError::ConfigurationChanged));
    assert!(gate.scope(&mut decoder, &work, |_, allocator| try_arc(allocator, 7u64).map(drop)).is_err());
    assert_eq!(budget.stats().allocations, 0);
}

#[test]
fn unit1_live_source_publication_is_checked_separately_from_revision() {
    run(4096, |decoder, work, _, _, _| {
        let foreign = SourceBundle::new(decoder.source_bundle.as_ref().unwrap().bytes().to_vec());
        decoder.execution_owner.publish_cache_source(Some(&foreign));
        // Capture reads the selected decoder's current revision, so revision and
        // generation both match. A same-byte foreign live owner source still fails.
        assert!(matches!(Authority::capture(decoder, work), Err(ExecutionLeaseError::WrongOwner)));
    });
}

#[test]
fn unit1_source_replacement_revokes_the_previous_owner_source_before_new_work() {
    let (source, resources, budget) = setup(4096);
    let mut decoder = source.decoder();
    let mut lease = decoder.try_execution_lease().unwrap();
    {
        let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
        let _scope = work.source_borrow_scope_with_resources(Some(context(&resources)));
        let authority = Authority::capture(&decoder, &work).unwrap();
        decoder.set_entity_index(Arc::new(crate::decoder::build_entity_index(source.bytes())));
        assert_eq!(authority.validate(), Err(ExecutionLeaseError::ConfigurationChanged));
        work.commit(decoder.execution_identity()).unwrap();
    }
    let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
    let _scope = work.source_borrow_scope_with_resources(Some(context(&resources)));
    assert!(matches!(Authority::capture(&decoder, &work), Err(ExecutionLeaseError::WrongOwner)));
    assert_eq!(decoder.decode_by_id(1).unwrap().get_list(0).unwrap().len(), 3);
    assert_eq!(budget.stats().allocations, 0);
}

#[test]
fn unit1_lazy_fill_and_fresh_work_preserve_a_warm_same_source_cache() {
    let (source, resources, budget) = setup(4096);
    let mut decoder = source.decoder();
    let mut lease = decoder.try_execution_lease().unwrap();
    let revision = decoder.execution_owner.cache_revision();
    let mut retained = None;
    for iteration in 0..2 {
        let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
        let _scope = work.source_borrow_scope_with_resources(Some(context(&resources)));
        let gate = retained.get_or_insert_with(|| Gate::new(&decoder, &work).unwrap());
        gate.scope(&mut decoder, &work, |decoder, allocator| {
            let point = decoder.decode_by_id(1).unwrap();
            assert_eq!(point.get_list(0).unwrap().len(), 3);
            decoder.cache_placement_transform(1, [1.; 16]);
            assert_eq!(decoder.execution_owner.cache_revision(), revision);
            assert_eq!(decoder.cache_size(), 1);
            let value = try_arc(allocator, iteration)?;
            assert_eq!(*value, iteration);
            drop(value);
            Ok(())
        }).unwrap();
        work.commit(decoder.execution_identity()).unwrap();
    }
    assert_eq!(budget.stats().allocations, 2);
    clean(&budget);
}

#[test]
fn unit1_checked_warm_transfer_invalidates_old_work_and_allows_fresh_work() {
    let (source, resources, budget) = setup(4096);
    let mut donor = source.decoder();
    donor.decode_by_id(1).unwrap();
    let cache = donor.drain_source_cache();
    let mut decoder = source.decoder();
    let mut lease = decoder.try_execution_lease().unwrap();
    let retained;
    {
        let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
        let _scope = work.source_borrow_scope_with_resources(Some(context(&resources)));
        retained = Gate::new(&decoder, &work).unwrap();
        let old = Authority::capture(&decoder, &work).unwrap();
        assert!(decoder.inject_source_cache(&cache));
        assert_eq!(old.validate(), Err(ExecutionLeaseError::ConfigurationChanged));
        work.commit(decoder.execution_identity()).unwrap();
    }
    let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
    let _scope = work.source_borrow_scope_with_resources(Some(context(&resources)));
    retained.scope(&mut decoder, &work, |decoder, allocator| {
        assert_eq!(decoder.decode_by_id(1).unwrap().get_list(0).unwrap().len(), 3);
        try_arc(allocator, 7u64).map(drop)
    }).unwrap();
    clean(&budget);
}

#[test]
fn unit1_rejected_foreign_import_preserves_live_authority_and_warm_cache() {
    run(4096, |decoder, work, gate, budget, _| {
        decoder.decode_by_id(1).unwrap();
        let foreign = SourceBundle::new(b"DATA;#1=IFCCARTESIANPOINT((9.,8.,7.));".to_vec());
        let mut donor = foreign.decoder();
        donor.decode_by_id(1).unwrap();
        let cache = donor.drain_source_cache();
        let authority = Authority::capture(decoder, work).unwrap();
        gate.scope(decoder, work, |decoder, allocator| {
            assert!(!decoder.inject_source_cache(&cache));
            authority.validate().unwrap();
            assert_eq!(decoder.decode_by_id(1).unwrap().get_list(0).unwrap()[0].as_float(), Some(1.));
            try_arc(allocator, 7u64).map(drop)
        }).unwrap();
        clean(budget);
    });
}

#[test]
fn unit1_callback_mutation_is_rejected_even_without_a_later_allocation() {
    run(4096, |decoder, work, gate, budget, _| {
        assert!(gate.scope(decoder, work, |decoder, _| {
            decoder.clear_entity_cache();
            Ok(())
        }).is_err());
        assert_eq!(budget.stats().allocations, 0);
    });
}

#[test]
fn unit1_live_source_ancestry_has_no_inherited_sixteen_epoch_quota() {
    fn descend(decoder: &mut crate::EntityDecoder<'_>, remaining: usize) {
        let mut lease = decoder.try_source_execution_lease().unwrap().unwrap();
        let resources = lease.source_resource_context().unwrap();
        let work = lease.begin_synchronous_work(decoder.execution_identity()).unwrap();
        let _scope = work.source_borrow_scope_with_resources(resources);
        if remaining == 0 {
            let gate = Gate::new(decoder, &work).unwrap();
            gate.scope(decoder, &work, |_, allocator| try_arc(allocator, 7u64).map(drop)).unwrap();
        } else {
            descend(decoder, remaining - 1);
        }
    }
    run(4096, |decoder, _, _, budget, _| {
        descend(decoder, 20);
        assert_eq!(budget.stats().allocations, 1);
        clean(budget);
    });
}
