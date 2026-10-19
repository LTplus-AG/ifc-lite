// SPDX-License-Identifier: MPL-2.0
use super::{attribute::{AttributeOwner, Node, Scalar, TextKind}, attribute_tests::{built, list, ok, text, typed},
    build_error::OwnerError, shared_entity::SharedEntity, text::OwnedText};
use crate::source_resources::{backend::Backend, fixtures::{clean, run}};
use crate::{IfcType, resource_stop::ProgramStop};
use std::sync::Arc;

#[test]
fn unit2_subtree_survives_entity_parent_and_weak_only_lifetime_retains_the_actual_account() {
    let (child_weak, budget_weak, resources_weak) = run(32768, |decoder, work, gate, budget, resources| {
        let child = gate.scope(decoder, work, |_, allocator| {
            let child = typed(allocator, "IFCLABEL", text(allocator, TextKind::String, "retained"));
            let attrs = AttributeOwner::Owned(list(allocator, [child]));
            let entity = built(SharedEntity::try_new(allocator, 7, IfcType::IfcWall, attrs));
            let entity_weak = entity.downgrade().clone();
            let child = entity.get(0).unwrap().share_owned().unwrap();
            drop(entity);
            assert!(entity_weak.upgrade().is_none());
            assert_eq!(child.view().as_string(), Some("retained"));
            drop(entity_weak);
            let weak = child.downgrade().unwrap();
            drop(child);
            assert!(weak.upgrade().is_none());
            assert!(budget.stats().live > 0, "actual typed Arc allocation remains until last Weak");
            assert_eq!(budget.stats().live, budget.stats().observed);
            Ok(weak)
        }).unwrap();
        (child, Arc::downgrade(budget), Arc::downgrade(resources))
    });
    // run's decoder/source/work/gate/account handles are all gone. Only the
    // allocator on the real Weak allocation retains the resource dependency.
    assert!(budget_weak.upgrade().is_some());
    assert!(resources_weak.upgrade().is_some());
    let budget = budget_weak.upgrade().unwrap();
    assert!(budget.stats().live > 0);
    std::thread::spawn(move || drop(child_weak)).join().unwrap();
    clean(&budget);
    assert!(resources_weak.upgrade().is_none());
    drop(budget);
    assert!(budget_weak.upgrade().is_none());
}

#[test]
fn unit2_text_box_refunds_on_last_strong_and_inline_arc_on_last_weak_after_cancel() {
    let (weak, budget) = run(4096, |decoder, work, gate, budget, _| {
        let mut retained = None;
        let result = gate.scope(decoder, work, |_, allocator| {
            let value = ok(OwnedText::try_new(allocator, "1234567"));
            let before = budget.stats();
            assert_eq!(before.allocations, 2, "one UTF8 Box plus one inline standard Arc allocation");
            let weak = value.downgrade();
            budget.stop(ProgramStop::Cancelled);
            let alias = value.clone();
            let weak_alias = weak.clone();
            let upgraded = weak_alias.upgrade().unwrap();
            assert_eq!(upgraded.as_str(), "1234567");
            drop(alias);
            drop(upgraded);
            drop(weak_alias);
            assert_eq!(budget.stats().work, before.work, "sharing is not an admitted operation");
            assert_eq!(budget.stats().copies, before.copies);
            assert_eq!(budget.stats().allocations, before.allocations);
            drop(value);
            assert_eq!(budget.stats().live, before.live - 7);
            assert_eq!(budget.stats().frees, 1);
            assert!(weak.upgrade().is_none());
            retained = Some(weak);
            Ok(())
        });
        assert_eq!(result, Err(ProgramStop::Cancelled));
        (retained.unwrap(), Arc::clone(budget))
    });
    assert!(weak.upgrade().is_none());
    assert!(budget.stats().live > 0);
    drop(weak);
    clean(&budget);
}

#[test]
fn unit2_immutable_owner_sharing_uses_no_budget_even_after_work_expiry() {
    let (owner, budget) = run(16384, |decoder, work, gate, budget, _| {
        let owner = gate.scope(decoder, work, |_, allocator| {
            Ok(AttributeOwner::Owned(list(allocator, [
                typed(allocator, "IFCINTEGER", Node::scalar(Scalar::Integer(12))),
                built(Node::try_list(allocator, list(allocator, [text(allocator, TextKind::String, "child")]))),
            ])))
        }).unwrap();
        budget.limit(budget.stats().live);
        (owner, Arc::clone(budget))
    });
    let before = budget.stats();
    let alias = owner.clone();
    let weak = owner.downgrade().clone();
    let upgraded = weak.upgrade().unwrap();
    assert_eq!(upgraded.view().get(0).unwrap().as_int(), Some(12));
    let first = alias.view().get(0).unwrap().share_owned().unwrap();
    let nested_list = alias.view().get(1).unwrap().share_owned().unwrap();
    let first_weak = first.downgrade().unwrap().clone();
    let nested_weak = nested_list.downgrade().unwrap().clone();
    assert_eq!(first_weak.upgrade().unwrap().view().as_int(), Some(12));
    assert_eq!(nested_weak.upgrade().unwrap().view().as_list().unwrap().len(), 1);
    assert!(Node::<std::alloc::Global>::scalar(Scalar::Null).downgrade().is_none());
    assert_eq!(budget.stats().allocations, before.allocations);
    assert_eq!(budget.stats().live, before.live);
    assert_eq!(budget.stats().work, before.work);
    assert_eq!(budget.stats().copies, before.copies);
    drop((owner, alias, upgraded, weak));
    assert!(first_weak.upgrade().is_some());
    drop(first);
    drop(nested_list);
    assert!(first_weak.upgrade().is_none());
    assert!(nested_weak.upgrade().is_none());
    drop(first_weak);
    drop(nested_weak);
    clean(&budget);
}

#[test]
fn unit2_nested_backing_blocks_are_all_allocator_owned_without_double_inline_charge() {
    run(16384, |decoder, work, gate, budget, _| {
        gate.scope(decoder, work, |_, allocator| {
            let value = typed(allocator, "IFCLABEL", text(allocator, TextKind::String, "hello"));
            let nested = built(Node::try_list(allocator, list(allocator, [value])));
            let attrs = AttributeOwner::Owned(list(allocator, [nested]));
            let entity = built(SharedEntity::try_new(allocator, 1, IfcType::IfcWall, attrs));
            // Two text Boxes + two text Arcs + typed Arc + two Vec blocks +
            // two list Arcs + entity Arc. Arc inline payload is charged by A.
            assert_eq!(budget.stats().allocations, 10);
            assert_eq!(budget.stats().live, budget.stats().observed);
            let alias = entity.clone();
            let weak = entity.downgrade();
            assert_eq!(weak.upgrade().unwrap().id(), 1);
            drop(alias);
            drop(entity);
            assert!(weak.upgrade().is_none());
            assert_eq!(budget.stats().frees, 9);
            drop(weak);
            assert_eq!(budget.stats().frees, 10);
            clean(budget);
            Ok(())
        }).unwrap();
    });
}

#[test]
fn unit2_text_weak_and_returned_text_subtree_do_not_depend_on_a_parent() {
    run(4096, |decoder, work, gate, budget, _| {
        gate.scope(decoder, work, |_, allocator| {
            let parent = list(allocator, [text(allocator, TextKind::Binary, "0FF")]);
            let child = parent.view().get(0).unwrap().share_owned().unwrap();
            let weak = child.downgrade().unwrap().clone();
            drop(parent);
            assert_eq!(weak.upgrade().unwrap().view().as_binary_hex(), Some("0FF"));
            drop(child);
            assert!(weak.upgrade().is_none());
            drop(weak);
            clean(budget);
            Ok(())
        }).unwrap();
    });
}

#[test]
fn unit2_failed_text_construction_cleans_box_if_inline_arc_admission_fails() {
    run(7, |decoder, work, gate, budget, _| {
        let result = gate.scope(decoder, work, |_, allocator| {
            let error = OwnedText::try_new(allocator, "1234567").err().unwrap();
            assert!(matches!(error, OwnerError::Stopped(_)));
            assert_eq!(budget.stats().allocations, 1);
            clean(budget);
            Err::<(), _>(allocator.error())
        });
        assert!(result.is_err());
    });
}
