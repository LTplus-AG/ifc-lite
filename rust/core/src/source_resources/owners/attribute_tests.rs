// SPDX-License-Identifier: MPL-2.0
use super::{attribute::{AttributeOwner, ListOwner, Node, Scalar, TextKind}, buffer::OwnedBuffer,
    build_error::{BuildError, OwnerError}, shared_entity::SharedEntity, storage::Domain,
    text::OwnedText, views::AttributeRef};
use crate::source_resources::fixtures::{clean, run};
use crate::{AttributeValue as Raw, IfcType};
use std::{alloc::Global, sync::Arc};

pub(super) fn ok<T>(result: Result<T, OwnerError>) -> T {
    result.unwrap_or_else(|error| panic!("owner construction failed: {error:?}"))
}
pub(super) fn built<T, D>(result: Result<T, BuildError<D>>) -> T {
    result.unwrap_or_else(|error| panic!("owner construction failed: {:?}", error.error))
}
pub(super) fn text<A: Domain>(allocator: &A, kind: TextKind, value: &str) -> Node<A> {
    built(Node::try_text(allocator, kind, ok(OwnedText::try_new(allocator, value))))
}
pub(super) fn list<A: Domain>(allocator: &A, values: impl IntoIterator<Item = Node<A>>) -> ListOwner<A> {
    let mut buffer = ok(OwnedBuffer::try_new(allocator));
    for value in values { built(buffer.try_push(value)); }
    built(ListOwner::try_new(allocator, buffer))
}
pub(super) fn typed<A: Domain>(allocator: &A, name: &str, value: Node<A>) -> Node<A> {
    built(Node::try_typed(allocator, ok(OwnedText::try_new(allocator, name)), value))
}
fn assert_scalar_reads<A: Domain>(raw: &Raw, owned: AttributeRef<'_, A>) {
    assert_eq!(owned.as_entity_ref(), raw.as_entity_ref());
    assert_eq!(owned.as_float().map(f64::to_bits), raw.as_float().map(f64::to_bits));
    assert_eq!(owned.as_int(), raw.as_int());
    assert_eq!(owned.as_string(), raw.as_string());
    assert_eq!(owned.as_enum(), raw.as_enum());
    assert_eq!(owned.as_binary_hex(), raw.as_binary_hex());
    assert_eq!(owned.is_null(), raw.is_null());
    assert_eq!(owned.as_logical(), raw.as_logical());
    assert_eq!(owned.as_bool(), raw.as_bool());
}

#[test]
fn unit2_owned_scalars_match_existing_dto_invariants_in_both_storage_domains() {
    fn check<A: Domain>(allocator: &A) {
        for (raw, scalar) in [
            (Raw::EntityRef(19), Scalar::EntityRef(19)),
            (Raw::Integer(i64::MIN), Scalar::Integer(i64::MIN)),
            (Raw::Float(-0.), Scalar::Float(-0.)),
            (Raw::Float(3.5), Scalar::Float(3.5)),
            (Raw::Float(f64::NAN), Scalar::Float(f64::NAN)),
            (Raw::Float(i64::MAX as f64), Scalar::Float(i64::MAX as f64)),
            (Raw::Float(f64::INFINITY), Scalar::Float(f64::INFINITY)),
            (Raw::Null, Scalar::Null), (Raw::Derived, Scalar::Derived),
        ] {
            assert_scalar_reads(&raw, Node::<A>::scalar(scalar).view());
            assert_scalar_reads(&raw, AttributeRef::<A>::raw(&raw));
        }
        for (kind, value, raw) in [
            (TextKind::String, "", Raw::String(String::new())),
            (TextKind::String, "A\u{00e9}\u{1f600}", Raw::String("A\u{00e9}\u{1f600}".into())),
            (TextKind::Binary, "0FF", Raw::Binary("0FF".into())),
            (TextKind::Enum, "X", Raw::Enum("X".into())),
            (TextKind::Enum, "TRUE", Raw::Enum("TRUE".into())),
            (TextKind::Enum, "F", Raw::Enum("F".into())),
            (TextKind::Enum, "other", Raw::Enum("other".into())),
        ] { assert_scalar_reads(&raw, text(allocator, kind, value).view()); }
        let raw = Raw::Typed { name: "IFCREAL".into(), value: Box::new(Raw::Float(-0.)) };
        assert_scalar_reads(&raw, typed(allocator, "IFCREAL", Node::scalar(Scalar::Float(-0.))).view());
        let raw = Raw::Typed { name: "IFCBINARY".into(), value: Box::new(Raw::Binary("0FF".into())) };
        assert_scalar_reads(&raw, typed(allocator, "IFCBINARY", text(allocator, TextKind::Binary, "0FF")).view());
    }
    check(&Global); // Control/authoring owner only, never the canonical Raw parser.
    run(16384, |decoder, work, gate, budget, _| {
        gate.scope(decoder, work, |_, allocator| { check(allocator); Ok(()) }).unwrap();
        clean(budget);
    });
}

#[test]
fn unit2_nested_typed_list_and_reference_member_views_preserve_order_and_shape() {
    run(16384, |decoder, work, gate, budget, _| {
        gate.scope(decoder, work, |_, allocator| {
            let members = list(allocator, [Node::scalar(Scalar::EntityRef(7)), Node::scalar(Scalar::EntityRef(7)),
                Node::scalar(Scalar::EntityRef(3))]);
            let node = typed(allocator, "IFCPROPERTYSETDEFINITIONSET", built(Node::try_list(allocator, members)));
            let view = node.view();
            assert!(view.as_list().is_none(), "typed value does not become a bare list");
            assert!(view.typed_value("wrong").is_none());
            let child = view.typed_value("ifcpropertysetdefinitionset").unwrap();
            let items = child.as_list().unwrap();
            assert_eq!(items.len(), 3);
            assert!(!items.is_empty());
            assert!(items.get(3).is_none());
            assert_eq!(items.iter().filter_map(|item| item.as_entity_ref()).collect::<Vec<_>>(), [7, 7, 3]);
            assert_eq!(view.as_ref_members().unwrap().iter().filter_map(|item| item.as_entity_ref()).collect::<Vec<_>>(), [7, 7, 3]);
            let scalar = typed(allocator, "IFCLABEL", text(allocator, TextKind::String, "Name"));
            assert_eq!(scalar.view().as_string(), Some("Name"));
            let ref_node = typed(allocator, "OTHER", Node::scalar(Scalar::EntityRef(4)));
            assert_eq!(ref_node.view().as_ref_members().unwrap().get(0).unwrap().as_entity_ref(), Some(4));
            let ordinary = typed(allocator, "OTHER", built(Node::try_list(allocator, list(allocator, []))));
            assert!(ordinary.view().as_ref_members().is_none());
            assert!(scalar.view().as_ref_members().is_none());
            Ok(())
        }).unwrap();
        clean(budget);
    });
}

#[test]
fn unit2_raw_root_is_shared_without_deep_conversion_and_refuses_tracked_enrollment() {
    let raw = Arc::new(vec![Raw::Typed { name: "IFCLABEL".into(), value: Box::new(Raw::String("name".into())) },
        Raw::List(vec![Raw::EntityRef(1), Raw::EntityRef(1)]), Raw::EntityRef(4)]);
    let owner = AttributeOwner::<Global>::Raw(raw.clone());
    let alias = owner.clone();
    let weak = owner.downgrade().clone();
    assert_eq!(Arc::strong_count(&raw), 3);
    assert_eq!(owner.view().get(0).unwrap().as_string(), Some("name"));
    assert!(owner.view().get(0).unwrap().share_owned().is_none());
    let raw_typed = owner.view().get(0).unwrap();
    assert_eq!(raw_typed.typed_value("ifclabel").unwrap().as_string(), Some("name"));
    assert_eq!(owner.view().get(1).unwrap().as_ref_members().unwrap().len(), 2);
    assert_eq!(owner.view().get(2).unwrap().as_ref_members().unwrap().len(), 1);
    let entity = built(SharedEntity::try_new(&Global, 22, &IfcType::IfcWall, alias));
    assert_eq!((entity.id(), entity.ifc_type().id(), entity.ifc_type().as_str()),
        (22, IfcType::IfcWall.id(), IfcType::IfcWall.as_str()));
    assert_eq!(entity.get(0).unwrap().as_string(), Some("name"));
    assert!(entity.get(3).is_none());
    drop(entity);
    drop(owner);
    drop(raw);
    assert!(weak.upgrade().is_none());
    run(4096, |decoder, work, gate, budget, _| {
        gate.scope(decoder, work, |_, allocator| {
            let raw = AttributeOwner::Raw(Arc::new(vec![Raw::Integer(4)]));
            let refused = SharedEntity::try_new(allocator, 1, &IfcType::IfcWall, raw)
                .err().expect("Raw DTOs must not hide in tracked entities");
            assert_eq!(refused.error, OwnerError::ForeignDomain);
            assert_eq!(refused.donor.view().get(0).unwrap().as_int(), Some(4));
            assert_eq!(budget.stats().allocations, 0);
            Ok(())
        }).unwrap();
        clean(budget);
    });
}

// Unit-2 compiled review: IfcType::Unknown owns a Global String in the DTO.
#[test]
fn unit2_unknown_entity_keyword_uses_accounted_backing_and_borrowed_reads() {
    run(16384, |decoder, work, gate, budget, _| {
        let entity = gate.scope(decoder, work, |_, allocator| {
            let keyword = IfcType::from_str("IfcVendorSpecificEntity");
            assert!(matches!(keyword, IfcType::Unknown(_)));
            let attrs = AttributeOwner::Owned(list(allocator, [Node::scalar(Scalar::Integer(19))]));
            let entity = built(SharedEntity::try_new(allocator, 42, &keyword, attrs));
            assert_eq!(entity.ifc_type().as_str(), keyword.as_str());
            assert_eq!(entity.ifc_type().id(), keyword.id());
            assert!(budget.stats().live >= keyword.as_str().len() as u64);
            drop(keyword);
            Ok(entity)
        }).unwrap();
        assert_eq!(entity.ifc_type().as_str(), "IFCVENDORSPECIFICENTITY");
        let before = budget.stats();
        let weak = entity.downgrade();
        let alias = entity.clone();
        let upgraded = weak.upgrade().unwrap();
        assert_eq!(upgraded.ifc_type(), alias.ifc_type());
        assert_eq!(budget.stats().allocations, before.allocations);
        assert_eq!(budget.stats().copies, before.copies);
        drop(entity); drop(alias); drop(upgraded);
        assert!(weak.upgrade().is_none());
        drop(weak);
        clean(budget);
    });
}

#[test]
fn unit2_unknown_keyword_allocation_refusal_returns_original_attribute_owner() {
    run(16384, |decoder, work, gate, budget, _| {
        gate.scope(decoder, work, |_, allocator| {
            let attrs = AttributeOwner::Owned(list(allocator, [Node::scalar(Scalar::Integer(19))]));
            let before = budget.stats();
            let keyword = IfcType::from_str("IFCVENDORSPECIFICENTITY");
            budget.limit(before.live);
            let failure = SharedEntity::try_new(allocator, 42, &keyword, attrs).err().unwrap();
            assert!(matches!(failure.error, OwnerError::Stopped(_)));
            assert_eq!(failure.donor.view().get(0).unwrap().scalar(), Some(Scalar::Integer(19)));
            assert_eq!(budget.stats().live, before.live);
            assert_eq!(keyword.as_str(), "IFCVENDORSPECIFICENTITY");
            Ok(())
        }).unwrap();
        clean(budget);
    });
}
