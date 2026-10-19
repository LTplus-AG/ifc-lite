// SPDX-License-Identifier: MPL-2.0
//! Characterization for SOURCE_CACHE_RESOURCE_RETENTION.md, base 4251bceb.
//! These expose existing ownership boundaries, not implemented permit coverage.
use crate::execution_owner::{ExecutionLeaseError, SourceResourceContext};
use crate::{EntityDecoder, SourceBundle};
use std::sync::Arc;

const POINTS: &[u8] = b"DATA;#1=IFCCARTESIANPOINT((1.,2.,3.));#2=IFCPOLYLOOP((#1,#1,#1));";

#[test]
fn retention_plan_attributes_survive_entity_cache_decoder_and_source() {
    let source = SourceBundle::new(POINTS.to_vec());
    let source_weak = Arc::downgrade(&source);
    let mut decoder = source.decoder();
    let entity = decoder.decode_by_id(1).unwrap();
    let attributes = Arc::clone(&entity.attributes);
    let backing = Arc::downgrade(&attributes);
    drop(entity);
    decoder.clear_entity_cache();
    drop(decoder);
    drop(source);
    assert!(source_weak.upgrade().is_none());
    assert_eq!(attributes[0].as_list().unwrap()[0].as_float(), Some(1.));
    assert!(backing.upgrade().is_some());
    drop(attributes);
    assert!(backing.upgrade().is_none());
}

#[test]
fn retention_plan_raw_drain_and_external_entity_arc_keep_actual_backing() {
    let source = SourceBundle::new(POINTS.to_vec());
    let mut decoder = source.decoder();
    decoder.decode_by_id(1).unwrap();
    let drained = decoder.drain_cache();
    let entity = Arc::clone(drained.get(&1).unwrap());
    let backing = Arc::downgrade(&entity.attributes);
    drop(decoder);
    drop(source);
    drop(drained);
    assert_eq!(entity.get_list(0).unwrap()[2].as_float(), Some(3.));
    assert!(backing.upgrade().is_some());
    drop(entity);
    assert!(backing.upgrade().is_none());
}

#[test]
fn retention_plan_typed_transfer_shares_attributes_beyond_both_cache_owners() {
    let source = SourceBundle::new(POINTS.to_vec());
    let mut producer = source.decoder();
    let first = producer.decode_by_id(1).unwrap();
    let backing = Arc::downgrade(&first.attributes);
    let cache = producer.drain_source_cache();
    drop(first);
    drop(producer);
    let mut consumer = source.decoder();
    assert!(consumer.inject_source_cache(&cache));
    drop(cache);
    let escaped = consumer.decode_by_id(1).unwrap().attributes;
    assert!(Arc::ptr_eq(&escaped, &backing.upgrade().unwrap()));
    consumer.clear_cache();
    drop(consumer);
    drop(source);
    assert_eq!(escaped[0].as_list().unwrap()[1].as_float(), Some(2.));
    drop(escaped);
    assert!(backing.upgrade().is_none());
}

#[test]
fn retention_plan_clear_keeps_allocated_map_capacity_and_drain_moves_it() {
    let source = SourceBundle::new(POINTS.to_vec());
    let mut decoder = source.decoder();
    decoder.reserve_cache(64);
    decoder.decode_by_id(1).unwrap();
    decoder.get_polyloop_coords_cached(2).unwrap();
    decoder.cache_placement_transform(3, [4.; 16]);
    let capacities = (decoder.cache.capacity(), decoder.point_cache.capacity(),
        decoder.placement_transform_cache.capacity());
    assert!(capacities.0 > 0 && capacities.1 > 0 && capacities.2 > 0);
    decoder.clear_cache();
    assert_eq!((decoder.cache.len(), decoder.point_cache.len(),
        decoder.placement_transform_cache.len()), (0, 0, 0));
    assert_eq!((decoder.cache.capacity(), decoder.point_cache.capacity(),
        decoder.placement_transform_cache.capacity()), capacities);
    let entities = decoder.drain_cache();
    let points = decoder.take_point_cache();
    let placements = decoder.take_placement_transform_cache();
    drop(decoder);
    assert_eq!((entities.capacity(), points.capacity(), placements.capacity()), capacities);
}

#[test]
fn retention_plan_refused_foreign_transfer_drops_only_donor_backing() {
    let source = SourceBundle::new(POINTS.to_vec());
    let foreign = SourceBundle::new(POINTS.to_vec());
    let mut donor = foreign.decoder();
    let entity = donor.decode_by_id(1).unwrap();
    let donor_backing = Arc::downgrade(&entity.attributes);
    drop(entity);
    let cache = donor.drain_source_cache();
    drop(donor);
    let mut target = source.decoder();
    let target_entity = target.decode_by_id(1).unwrap();
    let identity = target.execution_identity();
    assert!(!target.inject_source_cache(&cache));
    assert_eq!(target.execution_identity(), identity);
    assert!(Arc::ptr_eq(&target_entity.attributes,
        &target.decode_by_id(1).unwrap().attributes));
    assert!(donor_backing.upgrade().is_some());
    drop(cache);
    assert!(donor_backing.upgrade().is_none());
    assert!(source.owns_decoder(&target));
}

#[test]
fn retention_plan_source_context_unwinds_but_escaped_attributes_remain() {
    let source = SourceBundle::new(POINTS.to_vec());
    let mut decoder = source.decoder();
    let mut root = decoder.try_execution_lease().unwrap();
    let account = Arc::new(());
    let account_weak = Arc::downgrade(&account);
    let context = SourceResourceContext::new(account);
    let mut child = None;
    let mut escaped = None;
    let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let work = root.begin_synchronous_work(decoder.execution_identity()).unwrap();
        let _scope = work.source_borrow_scope_with_resources(Some(context));
        child = decoder.try_source_execution_lease().unwrap();
        escaped = Some(decoder.decode_by_id(1).unwrap().attributes);
        panic!("intentional source-work unwind");
    }));
    assert!(unwind.is_err());
    assert_eq!(child.as_ref().unwrap().source_resource_context().unwrap_err(),
        ExecutionLeaseError::ExpiredWork);
    assert!(decoder.try_source_execution_lease().unwrap().is_none());
    drop(child);
    assert!(account_weak.upgrade().is_none(), "context is not cache backing ownership");
    drop(root);
    decoder.clear_cache();
    drop(decoder);
    drop(source);
    assert_eq!(escaped.unwrap()[0].as_list().unwrap()[0].as_float(), Some(1.));
}

#[test]
fn retention_plan_resource_context_does_not_authenticate_compatibility_imports() {
    let source = SourceBundle::new(POINTS.to_vec());
    let mut decoder = source.decoder();
    let mut foreign = EntityDecoder::new(b"DATA;#1=IFCCARTESIANPOINT((9.,8.,7.));");
    foreign.decode_by_id(1).unwrap();
    let cache = foreign.drain_cache();
    let mut root = decoder.try_execution_lease().unwrap();
    let work = root.begin_synchronous_work(decoder.execution_identity()).unwrap();
    let scope = work.source_borrow_scope_with_resources(Some(SourceResourceContext::new(Arc::new(()))));
    let child = decoder.try_source_execution_lease().unwrap().unwrap();
    decoder.inject_shared_cache(&cache);
    assert!(!source.owns_decoder(&decoder));
    assert_eq!(child.validate(decoder.execution_identity()),
        Err(ExecutionLeaseError::ConfigurationChanged));
    assert_eq!(decoder.decode_by_id(1).unwrap().get_list(0).unwrap()[0].as_float(), Some(9.));
    drop(child);
    drop(scope);
    drop(work);
}
