// SPDX-License-Identifier: MPL-2.0
//! Regression witnesses for the unit-2 independent review's variant/depth findings.
use super::{attribute::{AttributeOwner, ListOwner, Node, Scalar},
    attribute_tests::{built, list, ok}, build_error::OwnerError, cache::CacheOwner, text::OwnedText,
    views::AttributeRef};
use crate::{AttributeValue as Raw, parser::MAX_NESTING_DEPTH};
use crate::source_resources::fixtures::{clean, run};
use std::alloc::Global;

#[test]
fn unit2_review_exact_scalar_projection_preserves_immediate_variant_and_float_bits() {
    for scalar in [Scalar::Integer(1), Scalar::Integer(i64::MIN), Scalar::Integer(i64::MAX),
        Scalar::Float(1.), Scalar::Float(-0.), Scalar::Float(f64::from_bits(0x7ff8000000000123)),
        Scalar::Null, Scalar::Derived, Scalar::EntityRef(u32::MAX)] {
        let raw = match scalar {
            Scalar::Integer(x) => Raw::Integer(x), Scalar::Float(x) => Raw::Float(x),
            Scalar::Null => Raw::Null, Scalar::Derived => Raw::Derived,
            Scalar::EntityRef(x) => Raw::EntityRef(x),
        };
        let node = Node::<Global>::scalar(scalar);
        for actual in [node.view().scalar(), AttributeRef::<Global>::raw(&raw).scalar()] {
            match (scalar, actual.unwrap()) {
                (Scalar::Float(expected), Scalar::Float(actual)) => assert_eq!(expected.to_bits(), actual.to_bits()),
                (expected, actual) => assert_eq!(expected, actual),
            }
        }
        let name = ok(OwnedText::try_new(&Global, "IFCREAL"));
        let typed = built(Node::try_typed(&Global, name, node));
        assert!(typed.view().scalar().is_none());
        assert!(typed.view().as_typed().unwrap().1.scalar().is_some());
    }
}

#[test]
fn unit2_review_typed_list_and_mixed_depth_refuse_before_allocation_and_keep_donors() {
    run(4_000_000, |decoder, work, gate, budget, _| {
        gate.scope(decoder, work, |_, allocator| {
            for mode in 0..3 {
                let name = ok(OwnedText::try_new(allocator, "IFCLABEL"));
                let mut node = Node::scalar(Scalar::Integer(7));
                for depth in 1..=MAX_NESTING_DEPTH {
                    node = if mode == 0 || (mode == 2 && depth % 2 == 0) {
                        built(Node::try_typed(allocator, name.clone(), node))
                    } else {
                        built(Node::try_list(allocator, list(allocator, [node])))
                    };
                }
                // A root attribute buffer is storage, not another lexical list.
                let root = AttributeOwner::Owned(list(allocator, [node]));
                let node = root.view().get(0).unwrap().share_owned().unwrap();
                let weak = node.downgrade().unwrap();
                let allocations = budget.stats().allocations;
                let error = Node::try_typed(allocator, name.clone(), node).err().unwrap();
                assert_eq!(error.error, OwnerError::Nesting);
                assert_eq!(budget.stats().allocations, allocations);
                let (_, node) = error.donor;
                let donor = list(allocator, [node]);
                let allocations = budget.stats().allocations;
                let error = Node::try_list(allocator, donor).err().unwrap();
                assert_eq!(error.error, OwnerError::Nesting);
                assert_eq!(budget.stats().allocations, allocations);
                assert_eq!(error.donor.view().len(), 1);
                drop(error);
                drop(root);
                assert!(weak.upgrade().is_none());
                drop(weak);
            }
            Ok(())
        }).unwrap();
        clean(budget);
    });
}

#[test]
fn unit2_review_empty_list_and_scalar_root_have_no_artificial_depth() {
    let owner: ListOwner<Global> = list(&Global, []);
    assert!(built(Node::try_list(&Global, owner)).view().as_list().unwrap().is_empty());
}

#[test]
fn unit2_review_spare_capacity_cache_insert_does_not_charge_table_copy() {
    run(16384, |decoder, work, gate, budget, _| {
        gate.scope(decoder, work, |_, allocator| {
            let mut cache = ok(CacheOwner::try_new(allocator));
            built(cache.try_insert(1, 10u32));
            assert!(cache.capacity() > cache.len());
            let copies = budget.stats().copies;
            let allocations = budget.stats().allocations;
            built(cache.try_insert(2, 20u32));
            assert_eq!(cache.get(2), Some(&20));
            assert_eq!(budget.stats().copies, copies);
            assert_eq!(budget.stats().allocations, allocations);
            cache.clear_for_cleanup();
            Ok(())
        }).unwrap();
        clean(budget);
    });
}

#[test]
fn unit2_review_owner_bound_matches_canonical_parser_boundary() {
    for depth in [MAX_NESTING_DEPTH, MAX_NESTING_DEPTH + 1] {
        let source = format!("#1=IFCWALL({}1{});", "(".repeat(depth as usize), ")".repeat(depth as usize));
        assert_eq!(crate::parser::parse_entity(&source).is_ok(), depth == MAX_NESTING_DEPTH);
    }
}
