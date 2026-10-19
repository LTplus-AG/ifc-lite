// SPDX-License-Identifier: MPL-2.0
use super::{backend::Backend, containers::*, fixtures::*};
use crate::resource_stop::ProgramStop;
use std::sync::Arc;

#[test]
fn r4_standard_weak_keeps_only_actual_control_layout_after_nested_vec_drops() {
    let (weak, budget) = run(4096, |decoder, work, gate, budget, _| {
        let weak = gate.scope(decoder, work, |_, allocator| {
            let mut bytes = Vec::new_in(allocator.clone());
            try_push(&mut bytes, 9u64)?;
            let strong = try_arc(allocator, bytes)?;
            let weak = Arc::downgrade(&strong);
            let before = budget.stats();
            budget.limit(before.live); // no remaining allocation budget
            let alias = Arc::clone(&strong);
            let weak_alias = weak.clone();
            let upgraded = weak_alias.upgrade().unwrap();
            assert_eq!(budget.stats().allocations, before.allocations);
            assert_eq!(budget.stats().work, before.work);
            drop((alias, weak_alias, upgraded));
            let buffer_bytes = strong.capacity() * std::mem::size_of::<u64>();
            drop(strong);
            assert!(weak.upgrade().is_none());
            assert_eq!(budget.stats().live, before.live - buffer_bytes as u64);
            assert!(budget.stats().live > 0, "actual Arc control block remains allocated");
            assert_eq!(budget.stats().live, budget.stats().observed);
            Ok(weak)
        }).unwrap();
        (weak, Arc::clone(budget))
    });
    // Decoder, original work and source scope have ended. Drop is cleanup only.
    std::thread::spawn(move || drop(weak)).join().unwrap();
    clean(&budget);
}

#[test]
fn r4_standard_arc_payload_unwind_deallocates_header_and_nested_storage() {
    struct PanicPayload { _nested: Vec<u64, super::allocator::ResourceAllocator> }
    impl Drop for PanicPayload {
        fn drop(&mut self) { panic!("intentional payload destructor unwind"); }
    }
    let (value, budget) = run(4096, |decoder, work, gate, budget, _| {
        let value = gate.scope(decoder, work, |_, allocator| {
            let mut nested = Vec::new_in(allocator.clone());
            try_push(&mut nested, 7)?;
            try_arc(allocator, PanicPayload { _nested: nested })
        }).unwrap();
        (value, Arc::clone(budget))
    });
    let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(value)));
    assert!(unwind.is_err());
    clean(&budget);
}

#[test]
fn r4_cleanup_take_and_replacement_survive_cancel_and_unwind_without_authority() {
    struct Handoff<'a> {
        owned: CleanupOwner<Vec<u64, super::allocator::ResourceAllocator>>,
        destination: &'a mut CleanupOwner<Vec<u64, super::allocator::ResourceAllocator>>,
    }
    impl Drop for Handoff<'_> {
        fn drop(&mut self) {
            drop(self.destination.replace_for_cleanup(self.owned.take_for_cleanup()));
        }
    }
    run(4096, |decoder, work, gate, budget, _| {
        let owned = gate.scope(decoder, work, |_, allocator| {
            let mut bytes = Vec::new_in(allocator.clone());
            try_push(&mut bytes, 41)?;
            Ok(CleanupOwner(Some(bytes)))
        }).unwrap();
        let before = budget.stats();
        budget.stop(ProgramStop::Cancelled);
        let mut destination = CleanupOwner::empty();
        let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _handoff = Handoff { owned, destination: &mut destination };
            panic!("intentional cancelled worker unwind");
        }));
        assert!(unwind.is_err());
        assert_eq!(destination.0.as_ref().unwrap().as_slice(), &[41]);
        assert_eq!(budget.stats().allocations, before.allocations);
        assert_eq!(budget.stats().copies, before.copies);
        assert_eq!(budget.stats().live, before.live);
        let values = destination.0.as_mut().unwrap();
        assert_eq!(try_push(values, 42), Err(ProgramStop::Cancelled));
        assert_eq!(values.as_slice(), &[41]);
        drop(destination.take_for_cleanup());
        clean(budget);
    });
}

#[test]
fn r4_hashbrown_reserve_tombstones_replace_clear_and_moved_capacity() {
    run(65536, |decoder, work, gate, budget, _| {
        let mut moved = gate.scope(decoder, work, |_, allocator| {
            let mut cache = empty_cache(allocator);
            for id in 0..64 { assert_eq!(try_insert(&mut cache, id, id + 100)?, None); }
            for id in 0..48 { assert_eq!(cache.remove(&id), Some(id + 100)); }
            for id in 64..112 { try_insert(&mut cache, id, id + 100)?; }
            for id in 48..112 { assert_eq!(cache.get(&id), Some(&(id + 100))); }
            let before = budget.stats();
            budget.limit(before.live);
            assert_eq!(try_insert(&mut cache, 111, 900)?, Some(211));
            assert_eq!(budget.stats().allocations, before.allocations);
            assert_eq!(cache.get(&111), Some(&900));
            cache.clear();
            assert!(cache.is_empty());
            assert_eq!(budget.stats().live, before.live);
            Ok(CleanupOwner(Some(cache)))
        }).unwrap();
        let retained = budget.stats().live;
        let taken = moved.take_for_cleanup();
        assert!(moved.0.is_none());
        assert!(taken.0.as_ref().unwrap().capacity() > 0);
        assert_eq!(budget.stats().live, retained);
        drop(taken);
        clean(budget);
    });
}

#[test]
fn r4_hashbrown_batch_refusal_preserves_destination_and_charges_attempted_work() {
    run(65536, |decoder, work, gate, budget, _| {
        let result = gate.scope(decoder, work, |_, allocator| {
            let mut cache = empty_cache(allocator);
            try_insert(&mut cache, 1, 10)?;
            let before = budget.stats();
            budget.limit(before.live);
            let entries: Vec<_> = (2..34).map(|id| (id, id + 10)).collect();
            let failure = try_import_copy(&mut cache, &entries).unwrap_err();
            assert_eq!(cache.len(), 1);
            assert_eq!(cache.get(&1), Some(&10));
            assert_eq!(budget.stats().allocations, before.allocations);
            assert!(budget.stats().work > before.work);
            assert!(budget.stats().copies > before.copies);
            drop(cache);
            clean(budget);
            Err::<(), _>(failure)
        });
        assert_eq!(result, budget.stats().terminal.map_or(Ok(()), Err));
    });
}

#[test]
fn r4_hashbrown_batch_duplicate_keys_keep_last_value_and_share_no_hidden_allocation() {
    run(65536, |decoder, work, gate, budget, _| {
        gate.scope(decoder, work, |_, allocator| {
            let mut cache = empty_cache(allocator);
            try_import_copy(&mut cache, &[(1, 7), (2, 8), (1, 9)])?;
            assert_eq!((cache.get(&1), cache.get(&2)), (Some(&9), Some(&8)));
            assert_eq!(cache.len(), 2);
            drop(cache);
            clean(budget);
            Ok(())
        }).unwrap();
    });
}

#[test]
fn r4_retained_container_does_not_create_a_strong_source_ownership_cycle() {
    let (value, source_weak, budget) = run(4096, |decoder, work, gate, budget, _| {
        let source_weak = Arc::downgrade(decoder.source_bundle.as_ref().unwrap());
        let value = gate.scope(decoder, work, |_, allocator| try_arc(allocator, 17u64)).unwrap();
        (value, source_weak, Arc::clone(budget))
    });
    assert!(source_weak.upgrade().is_none(), "gate model identity must not retain source payload");
    assert_eq!(*value, 17);
    assert!(budget.stats().live > 0);
    drop(value);
    clean(&budget);
}

fn p2_cleanup_handoff<T>(mut original: CleanupOwner<T>) -> CleanupOwner<T> {
    let mut destination = CleanupOwner::empty();
    drop(destination.replace_for_cleanup(original.take_for_cleanup()));
    assert!(original.0.is_none());
    destination
}

fn p2_unchanged_accounting(budget: &Budget, before: Stats) {
    let after = budget.stats();
    // The fixed terminal bridge may record Coverage; no admission, storage
    // callback, refund or cumulative charge may occur on this refused mutation.
    assert_eq!((after.live, after.observed, after.peak, after.work, after.copies),
        (before.live, before.observed, before.peak, before.work, before.copies));
    assert_eq!((after.allocations, after.frees, after.replacements, after.refunded, after.violation),
        (before.allocations, before.frees, before.replacements, before.refunded, before.violation));
    assert_eq!(after.terminal, Some(super::coverage()));
}

#[test]
fn p2_healthy_cleanup_handoff_refuses_spare_capacity_push_without_destination_work() {
    let (owned, budget) = run(4096, |decoder, work, gate, budget, _| {
        let owned = gate.scope(decoder, work, |_, allocator| {
            let mut values = Vec::new_in(allocator.clone());
            values.try_reserve(8).map_err(|error| allocator.reserve_error(error))?;
            try_push(&mut values, 41u64)?;
            Ok(CleanupOwner(Some(values)))
        }).unwrap();
        (owned, Arc::clone(budget))
    }); // Original authenticated work, source scope and decoder have ended.
    let mut destination = p2_cleanup_handoff(owned);
    assert_eq!(budget.check(), Ok(()));
    let before = budget.stats();
    let values = destination.0.as_mut().unwrap();
    assert!(values.len() < values.capacity(), "push must need no allocator callback");
    let backing = (values.as_ptr(), values.capacity());
    assert_eq!(try_push(values, 42), Err(super::coverage()));
    assert_eq!(values.as_slice(), &[41]);
    assert_eq!((values.as_ptr(), values.capacity()), backing);
    p2_unchanged_accounting(&budget, before);
    drop(destination.take_for_cleanup());
    assert!(destination.0.is_none());
    clean(&budget);
}

#[test]
fn p2_healthy_cleanup_handoff_refuses_occupied_replacement_without_destination_work() {
    let (owned, budget) = run(4096, |decoder, work, gate, budget, _| {
        let owned = gate.scope(decoder, work, |_, allocator| {
            let mut cache = empty_cache(allocator);
            try_insert(&mut cache, 1, 41u64)?;
            Ok(CleanupOwner(Some(cache)))
        }).unwrap();
        (owned, Arc::clone(budget))
    });
    let mut destination = p2_cleanup_handoff(owned);
    assert_eq!(budget.check(), Ok(()));
    let before = budget.stats();
    let cache = destination.0.as_mut().unwrap();
    assert!(cache.len() < cache.capacity());
    let backing = (cache.get(&1).unwrap() as *const u64, cache.capacity());
    assert_eq!(try_insert(cache, 1, 42), Err(super::coverage()));
    assert_eq!(cache.len(), 1);
    assert_eq!(cache.get(&1), Some(&41));
    assert_eq!((cache.get(&1).unwrap() as *const u64, cache.capacity()), backing);
    p2_unchanged_accounting(&budget, before);
    drop(destination.take_for_cleanup());
    assert!(destination.0.is_none());
    clean(&budget);
}

#[test]
fn p2_healthy_cleanup_handoff_refuses_prereserved_insertion_without_destination_work() {
    let (owned, budget) = run(4096, |decoder, work, gate, budget, _| {
        let owned = gate.scope(decoder, work, |_, allocator| {
            let mut cache = empty_cache(allocator);
            // No removals/tombstones: successful reserve guarantees spare
            // insertion capacity without rehash or an allocator callback.
            try_insert(&mut cache, 1, 41u64)?;
            cache.try_reserve(8).map_err(|_| allocator.error())?;
            Ok(CleanupOwner(Some(cache)))
        }).unwrap();
        (owned, Arc::clone(budget))
    });
    let mut destination = p2_cleanup_handoff(owned);
    assert_eq!(budget.check(), Ok(()));
    let before = budget.stats();
    let cache = destination.0.as_mut().unwrap();
    assert!(cache.len() < cache.capacity(), "insert must need no allocator callback");
    let backing = (cache.get(&1).unwrap() as *const u64, cache.capacity());
    assert_eq!(try_insert(cache, 2, 42), Err(super::coverage()));
    assert_eq!(cache.len(), 1);
    assert_eq!((cache.get(&1), cache.get(&2)), (Some(&41), None));
    assert_eq!((cache.get(&1).unwrap() as *const u64, cache.capacity()), backing);
    p2_unchanged_accounting(&budget, before);
    drop(destination.take_for_cleanup());
    assert!(destination.0.is_none());
    clean(&budget);
}
