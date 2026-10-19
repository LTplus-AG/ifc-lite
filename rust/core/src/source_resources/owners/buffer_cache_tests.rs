// SPDX-License-Identifier: MPL-2.0
use super::{attribute::{AttributeOwner, ListOwner, Node, Scalar, TextKind},
    attribute_tests::{built, list, ok, text}, buffer::OwnedBuffer, build_error::OwnerError,
    cache::CacheOwner, shared_entity::SharedEntity, text::OwnedText};
use crate::source_resources::{backend::Backend, fixtures::{clean, run}, gate::Gate};
use crate::{IfcType, resource_stop::ProgramStop};
use std::{alloc::Global, sync::Arc};

#[test]
fn unit2_identical_source_and_account_with_distinct_gates_cannot_merge_backing() {
    run(32768, |decoder, work, gate, budget, _| {
        let foreign_gate = Gate::new(decoder, work).unwrap();
        let (foreign_text, foreign_list, foreign_attrs, foreign_node, foreign_buffer, foreign_entity) =
            foreign_gate.scope(decoder, work, |_, allocator| {
                let foreign_text = ok(OwnedText::try_new(allocator, "foreign"));
                let foreign_list = list(allocator, [Node::scalar(Scalar::Integer(3))]);
                let foreign_attrs = AttributeOwner::Owned(list(allocator, []));
                let foreign_node = text(allocator, TextKind::String, "value");
                let mut foreign_buffer = ok(OwnedBuffer::try_new(allocator));
                built(foreign_buffer.try_push(Node::scalar(Scalar::Integer(11))));
                let foreign_entity = built(SharedEntity::try_new(allocator, 4, &IfcType::IfcWall,
                    AttributeOwner::Owned(list(allocator, []))));
                Ok((foreign_text, foreign_list, foreign_attrs, foreign_node, foreign_buffer, foreign_entity))
            }).unwrap();
        gate.scope(decoder, work, |_, allocator| {
            let mut buffer = ok(OwnedBuffer::try_new(allocator));
            let mut cache = ok(CacheOwner::try_new(allocator));
            let name = ok(OwnedText::try_new(allocator, "IFCLABEL"));
            let before = budget.stats();
            let refused = Node::try_text(allocator, TextKind::String, foreign_text).err().unwrap();
            assert_eq!(refused.error, OwnerError::ForeignDomain);
            assert_eq!(refused.donor.as_str(), "foreign");
            let refused_list = Node::try_list(allocator, foreign_list).err().unwrap();
            assert_eq!(refused_list.error, OwnerError::ForeignDomain);
            assert_eq!(refused_list.donor.view().get(0).unwrap().as_int(), Some(3));
            let refused_attrs = SharedEntity::try_new(allocator, 3, &IfcType::IfcWall, foreign_attrs).err().unwrap();
            assert_eq!(refused_attrs.error, OwnerError::ForeignDomain);
            let refused_typed = Node::try_typed(allocator, name, foreign_node).err().unwrap();
            assert_eq!(refused_typed.error, OwnerError::ForeignDomain);
            assert_eq!(refused_typed.donor.0.as_str(), "IFCLABEL");
            assert_eq!(refused_typed.donor.1.view().as_string(), Some("value"));
            let refused_buffer = ListOwner::try_new(allocator, foreign_buffer).err().unwrap();
            assert_eq!(refused_buffer.error, OwnerError::ForeignDomain);
            assert_eq!(refused_buffer.donor.len(), 1);
            let refused_push = buffer.try_push(refused_typed.donor.1).err().unwrap();
            assert_eq!(refused_push.error, OwnerError::ForeignDomain);
            assert!(buffer.is_empty());
            let refused_cache = cache.try_insert(4, foreign_entity).err().unwrap();
            assert_eq!(refused_cache.error, OwnerError::ForeignDomain);
            assert_eq!(refused_cache.donor.id(), 4);
            assert!(cache.is_empty());
            assert_eq!(budget.stats().allocations, before.allocations);
            assert_eq!(budget.stats().live, before.live);
            // A refusal did not stop the compatible gate or publish any child.
            built(buffer.try_push(text(allocator, TextKind::String, "own")));
            assert_eq!(buffer.get(0).unwrap().view().as_string(), Some("own"));
            Ok(())
        }).unwrap();
        clean(budget);
    });
}

#[test]
fn unit2_inline_arc_refusal_returns_complete_list_typed_and_entity_donors() {
    for stage in 0..3 {
        run(16384, |decoder, work, gate, budget, _| {
            let result = gate.scope(decoder, work, |_, allocator| {
                let mut buffer = ok(OwnedBuffer::try_new(allocator));
                built(buffer.try_push(Node::scalar(Scalar::Integer(9))));
                let name = ok(OwnedText::try_new(allocator, "IFCINTEGER"));
                let attrs = AttributeOwner::Owned(list(allocator, [Node::scalar(Scalar::Integer(7))]));
                let before = budget.stats();
                budget.limit(before.live);
                match stage {
                    0 => {
                        let capacity = buffer.capacity();
                        let refused = ListOwner::try_new(allocator, buffer).err().unwrap();
                        assert!(matches!(refused.error, OwnerError::Stopped(_)));
                        assert_eq!(refused.donor.capacity(), capacity);
                        assert_eq!(refused.donor.get(0).unwrap().view().as_int(), Some(9));
                        assert_eq!(budget.stats().live, before.live);
                    }
                    1 => {
                        let refused = Node::try_typed(allocator, name, Node::scalar(Scalar::Integer(5))).err().unwrap();
                        assert!(matches!(refused.error, OwnerError::Stopped(_)));
                        assert_eq!(refused.donor.0.as_str(), "IFCINTEGER");
                        assert_eq!(refused.donor.1.view().as_int(), Some(5));
                        assert_eq!(budget.stats().live, before.live);
                    }
                    _ => {
                        let refused = SharedEntity::try_new(allocator, 1, &IfcType::IfcWall, attrs).err().unwrap();
                        assert!(matches!(refused.error, OwnerError::Stopped(_)));
                        assert_eq!(refused.donor.view().get(0).unwrap().as_int(), Some(7));
                        assert_eq!(budget.stats().live, before.live);
                    }
                }
                assert_eq!(budget.stats().allocations, before.allocations);
                Err::<(), _>(allocator.error())
            });
            assert!(result.is_err());
            clean(budget);
        });
    }
}

#[test]
fn unit2_buffer_refused_grow_preserves_data_and_cleanup_moves_empty_capacity_after_expiry() {
    let (mut moved, budget) = run(16384, |decoder, work, gate, budget, _| {
        let mut moved = None;
        let result = gate.scope(decoder, work, |_, allocator| {
            let mut values = ok(OwnedBuffer::try_new(allocator));
            ok(values.try_reserve(4));
            for index in 0..values.capacity() { built(values.try_push(index as u64)); }
            let capacity = values.capacity();
            let before = budget.stats();
            budget.limit(before.live);
            let refused = values.try_push(999u64).err().unwrap();
            assert_eq!(refused.donor, 999);
            assert!(matches!(refused.error, OwnerError::Stopped(_)));
            assert_eq!(values.len(), capacity);
            assert_eq!(values.get(capacity - 1), Some(&((capacity - 1) as u64)));
            assert_eq!(budget.stats().live, before.live);
            assert_eq!(budget.stats().observed, before.observed);
            values.clear_for_cleanup();
            assert_eq!(values.capacity(), capacity);
            let after_failure = budget.stats();
            moved = Some(values.take_for_cleanup());
            assert_eq!(moved.as_ref().unwrap().capacity(), capacity);
            assert_eq!(values.capacity(), 0);
            assert_eq!(budget.stats().work, after_failure.work);
            assert_eq!(budget.stats().allocations, before.allocations);
            Err::<(), _>(allocator.error())
        });
        assert!(result.is_err());
        (moved.unwrap(), Arc::clone(budget))
    });
    assert_eq!(moved.len(), 0);
    assert!(moved.capacity() >= 4);
    let after_expiry = budget.stats();
    let retained = moved.take_for_cleanup();
    drop(moved.replace_for_cleanup(retained));
    assert_eq!(budget.stats().work, after_expiry.work);
    assert_eq!(budget.stats().allocations, after_expiry.allocations);
    drop(moved);
    clean(&budget);
}

#[test]
fn unit2_cache_replacement_tombstones_and_cleanup_keep_actual_bucket_storage() {
    run(65536, |decoder, work, gate, budget, _| {
        gate.scope(decoder, work, |_, allocator| {
            let mut cache = ok(CacheOwner::try_new(allocator));
            for key in 0..80 { assert!(built(cache.try_insert(key, key + 1)).is_none()); }
            for key in (0..80).step_by(2) { assert_eq!(cache.remove_for_cleanup(key), Some(key + 1)); }
            let before = budget.stats();
            assert_eq!(built(cache.try_insert(1, 700)), Some(2));
            assert_eq!(budget.stats().allocations, before.allocations);
            assert_eq!(budget.stats().live, before.live);
            for key in 80..140 { built(cache.try_insert(key, key + 1)); }
            assert_eq!(cache.get(1), Some(&700));
            assert_eq!(cache.len(), 100);
            let capacity = cache.capacity();
            cache.clear_for_cleanup();
            let before_cleanup = budget.stats();
            let moved = cache.take_for_cleanup();
            assert_eq!(moved.capacity(), capacity);
            assert_eq!(moved.len(), 0);
            assert_eq!(cache.capacity(), 0);
            drop(cache.replace_for_cleanup(moved));
            assert_eq!(budget.stats().work, before_cleanup.work);
            assert_eq!(budget.stats().allocations, before_cleanup.allocations);
            drop(cache);
            clean(budget);
            Ok(())
        }).unwrap();
    });
}

#[test]
fn unit2_cache_failed_growth_returns_entity_donor_and_preserves_old_entries() {
    run(16384, |decoder, work, gate, budget, _| {
        let result = gate.scope(decoder, work, |_, allocator| {
            let mut cache = ok(CacheOwner::try_new(allocator));
            let donor = built(SharedEntity::try_new(allocator, 8, &IfcType::IfcWall,
                AttributeOwner::Owned(list(allocator, []))));
            built(cache.try_insert(0, donor.clone()));
            let capacity = cache.capacity();
            for key in 1..capacity { built(cache.try_insert(key as u32, donor.clone())); }
            let before = budget.stats();
            budget.limit(before.live);
            let refused = cache.try_insert(capacity as u32, donor).err().unwrap();
            assert!(matches!(refused.error, OwnerError::Stopped(_)));
            assert_eq!(refused.donor.id(), 8);
            assert_eq!(cache.len(), capacity);
            assert_eq!(cache.capacity(), capacity);
            assert_eq!(cache.get(0).unwrap().id(), 8);
            assert_eq!(budget.stats().live, before.live);
            assert_eq!(budget.stats().allocations, before.allocations);
            Err::<(), _>(allocator.error())
        });
        assert!(result.is_err());
        clean(budget);
    });
}

#[test]
fn unit2_zero_size_buffer_has_no_fictitious_bytes_and_stopped_work_still_refuses_push() {
    run(4096, |decoder, work, gate, budget, _| {
        let result = gate.scope(decoder, work, |_, allocator| {
            let mut values = ok(OwnedBuffer::try_new(allocator));
            built(values.try_push(()));
            assert_eq!(values.len(), 1);
            assert_eq!(budget.stats().live, 0);
            assert_eq!(budget.stats().allocations, 0);
            let old_work = budget.stats().work;
            budget.stop(ProgramStop::Cancelled);
            assert_eq!(values.try_push(()).err().unwrap().error, OwnerError::Stopped(ProgramStop::Cancelled));
            assert_eq!(values.len(), 1);
            assert!(budget.stats().work >= old_work);
            Err::<(), _>(ProgramStop::Cancelled)
        });
        assert_eq!(result, Err(ProgramStop::Cancelled));
        clean(budget);
    });
    let mut raw = ok(OwnedBuffer::try_new(&Global));
    built(raw.try_push(7u32));
    assert_eq!(raw.get(0), Some(&7));
}

#[test]
fn unit2_failed_nested_candidate_cleans_initialized_prefix_without_changing_old_aliases() {
    run(16384, |decoder, work, gate, budget, _| {
        let result = gate.scope(decoder, work, |_, allocator| {
            let old = list(allocator, [text(allocator, TextKind::String, "old")]);
            let alias = old.clone();
            let baseline = budget.stats().live;
            let mut candidate = ok(OwnedBuffer::try_new(allocator));
            built(candidate.try_push(text(allocator, TextKind::String, "first")));
            let candidate_live = budget.stats().live;
            budget.limit(candidate_live + 3); // new text Box fits; its Arc does not
            let error = OwnedText::try_new(allocator, "new").err().unwrap();
            assert!(matches!(error, OwnerError::Stopped(_)));
            assert_eq!(budget.stats().live, candidate_live);
            drop(candidate); // initialized first child and vector backing refund
            assert_eq!(budget.stats().live, baseline);
            assert_eq!(alias.view().get(0).unwrap().as_string(), Some("old"));
            drop(old);
            drop(alias);
            clean(budget);
            Err::<(), _>(allocator.error())
        });
        assert!(result.is_err());
        clean(budget);
    });
}

#[test]
fn unit2_original_stop_precedes_overflow_and_spare_capacity_mutation() {
    run(4096, |decoder, work, gate, budget, resources| {
        let result = gate.scope(decoder, work, |_, allocator| {
            let mut values = ok(OwnedBuffer::<u32, _>::try_new(allocator));
            ok(values.try_reserve(1));
            let mut cache = ok(CacheOwner::try_new(allocator));
            built(cache.try_insert(1, 7u32));
            let scope = work.source_borrow_scope_with_resources(Some(crate::source_resources::fixtures::context(resources)));
            scope.resource_stop_handle().stop(ProgramStop::Cancelled);
            assert_eq!(values.try_reserve(usize::MAX), Err(OwnerError::Stopped(ProgramStop::Cancelled)));
            assert_eq!(values.try_push(3).err().unwrap().error, OwnerError::Stopped(ProgramStop::Cancelled));
            assert_eq!(values.len(), 0);
            assert_eq!(cache.try_insert(1, 8).err().unwrap().error, OwnerError::Stopped(ProgramStop::Cancelled));
            assert_eq!(cache.get(1), Some(&7));
            Err::<(), _>(ProgramStop::Cancelled)
        });
        assert_eq!(result, Err(ProgramStop::Cancelled));
        clean(budget);
    });
    let mut raw = ok(OwnedBuffer::<u64, _>::try_new(&Global));
    assert_eq!(raw.try_reserve(usize::MAX), Err(OwnerError::Overflow));
    assert_eq!(raw.len(), 0);
    let mut raw_cache = ok(CacheOwner::try_new(&Global));
    assert!(built(raw_cache.try_insert(3, 4u32)).is_none());
    assert_eq!(raw_cache.get(3), Some(&4));
}
