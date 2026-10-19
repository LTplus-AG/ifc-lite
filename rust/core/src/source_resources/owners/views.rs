// SPDX-License-Identifier: MPL-2.0
//! Borrowed reads are representation-neutral, not a borrowed Raw DTO disguise.
use super::{attribute::{Node, NodeKind, Scalar, TextKind}, buffer::OwnedBuffer, storage::Domain};
use crate::{AttributeValue as RawAttributeValue, Logical};

enum Value<'a, A: Domain> { Raw(&'a RawAttributeValue), Owned(&'a Node<A>) }
pub(super) struct AttributeRef<'a, A: Domain>(Value<'a, A>);
impl<A: Domain> Copy for AttributeRef<'_, A> {}
impl<A: Domain> Clone for AttributeRef<'_, A> { fn clone(&self) -> Self { *self } }
impl<A: Domain> Copy for Value<'_, A> {}
impl<A: Domain> Clone for Value<'_, A> { fn clone(&self) -> Self { *self } }
impl<'a, A: Domain> AttributeRef<'a, A> {
    pub fn raw(value: &'a RawAttributeValue) -> Self { Self(Value::Raw(value)) }
    pub fn owned(value: &'a Node<A>) -> Self { Self(Value::Owned(value)) }
    fn scalar(self) -> Option<Scalar> {
        match self.0 {
            Value::Raw(RawAttributeValue::EntityRef(id)) => Some(Scalar::EntityRef(*id)),
            Value::Raw(RawAttributeValue::Integer(value)) => Some(Scalar::Integer(*value)),
            Value::Raw(RawAttributeValue::Float(value)) => Some(Scalar::Float(*value)),
            Value::Raw(RawAttributeValue::Null) => Some(Scalar::Null),
            Value::Raw(RawAttributeValue::Derived) => Some(Scalar::Derived),
            Value::Owned(Node { kind: NodeKind::Scalar(value) }) => Some(*value),
            _ => None,
        }
    }
    pub fn as_entity_ref(self) -> Option<u32> {
        match self.scalar()? { Scalar::EntityRef(id) => Some(id), _ => None }
    }
    pub fn as_float(self) -> Option<f64> {
        match self.unwrap_typed().scalar()? {
            Scalar::Integer(value) => Some(value as f64), Scalar::Float(value) => Some(value), _ => None,
        }
    }
    pub fn as_int(self) -> Option<i64> {
        match self.unwrap_typed().scalar()? {
            Scalar::Integer(value) => Some(value),
            Scalar::Float(value) if value.fract() == 0.0 && value >= i64::MIN as f64 && value < i64::MAX as f64 => Some(value as i64),
            _ => None,
        }
    }
    fn text(self, kind: TextKind) -> Option<&'a str> {
        match self.0 {
            Value::Raw(RawAttributeValue::String(text)) if kind == TextKind::String => Some(text),
            Value::Raw(RawAttributeValue::Enum(text)) if kind == TextKind::Enum => Some(text),
            Value::Raw(RawAttributeValue::Binary(text)) if kind == TextKind::Binary => Some(text),
            Value::Owned(Node { kind: NodeKind::Text(own_kind, text) }) if *own_kind == kind => Some(text.as_str()),
            _ => None,
        }
    }
    pub fn as_string(self) -> Option<&'a str> { self.unwrap_typed().text(TextKind::String) }
    pub fn as_enum(self) -> Option<&'a str> { self.unwrap_typed().text(TextKind::Enum) }
    pub fn as_binary_hex(self) -> Option<&'a str> { self.text(TextKind::Binary) }
    pub fn as_typed(self) -> Option<(&'a str, Self)> {
        match self.0 {
            Value::Raw(RawAttributeValue::Typed { name, value }) => Some((name, Self::raw(value))),
            Value::Owned(Node { kind: NodeKind::Typed(typed) }) => {
                Some((typed.get().name.as_str(), Self::owned(&typed.get().value)))
            }
            _ => None,
        }
    }
    pub fn unwrap_typed(self) -> Self {
        let mut value = self;
        while let Some((_, child)) = value.as_typed() { value = child; }
        value
    }
    pub fn typed_value(self, name: &str) -> Option<Self> {
        let (own_name, child) = self.as_typed()?;
        own_name.eq_ignore_ascii_case(name).then_some(child)
    }
    pub fn as_list(self) -> Option<AttributeListRef<'a, A>> {
        match self.0 {
            Value::Raw(RawAttributeValue::List(values)) => Some(AttributeListRef::raw(values)),
            Value::Owned(Node { kind: NodeKind::List(values) }) => Some(values.view()),
            _ => None,
        }
    }
    pub fn as_ref_members(self) -> Option<AttributeListRef<'a, A>> {
        if self.as_entity_ref().is_some() { return Some(AttributeListRef(List::Single(self))); }
        if let Some(list) = self.as_list() { return Some(list); }
        let (name, child) = self.as_typed()?;
        if child.as_entity_ref().is_some() { return Some(AttributeListRef(List::Single(child))); }
        if name == "IFCPROPERTYSETDEFINITIONSET" { return child.as_list(); }
        None
    }
    pub fn is_null(self) -> bool { matches!(self.scalar(), Some(Scalar::Null | Scalar::Derived)) }
    pub fn as_logical(self) -> Option<Logical> {
        match self.as_enum()? {
            "T" | "TRUE" => Some(Logical::True), "F" | "FALSE" => Some(Logical::False),
            "U" | "X" => Some(Logical::Unknown), _ => None,
        }
    }
    pub fn as_bool(self) -> Option<bool> { self.as_logical().and_then(Logical::to_bool) }
    /// Only already-owned storage can share a subtree without copying. Raw DTO
    /// conversion needs the explicit fallible copier in a later migration unit.
    pub fn share_owned(self) -> Option<Node<A>> {
        match self.0 { Value::Raw(_) => None, Value::Owned(value) => Some(value.clone()) }
    }
}

enum List<'a, A: Domain> {
    Raw(&'a [RawAttributeValue]), Owned(&'a OwnedBuffer<Node<A>, A>), Single(AttributeRef<'a, A>),
}
pub(super) struct AttributeListRef<'a, A: Domain>(List<'a, A>);
impl<A: Domain> Copy for List<'_, A> {}
impl<A: Domain> Clone for List<'_, A> { fn clone(&self) -> Self { *self } }
impl<A: Domain> Copy for AttributeListRef<'_, A> {}
impl<A: Domain> Clone for AttributeListRef<'_, A> { fn clone(&self) -> Self { *self } }
impl<'a, A: Domain> AttributeListRef<'a, A> {
    pub fn raw(values: &'a [RawAttributeValue]) -> Self { Self(List::Raw(values)) }
    pub fn owned(values: &'a OwnedBuffer<Node<A>, A>) -> Self { Self(List::Owned(values)) }
    pub fn len(self) -> usize {
        match self.0 { List::Raw(values) => values.len(), List::Owned(values) => values.len(), List::Single(_) => 1 }
    }
    pub fn is_empty(self) -> bool { self.len() == 0 }
    pub fn get(self, index: usize) -> Option<AttributeRef<'a, A>> {
        match self.0 {
            List::Raw(values) => values.get(index).map(AttributeRef::raw),
            List::Owned(values) => values.get(index).map(AttributeRef::owned),
            List::Single(value) => (index == 0).then_some(value),
        }
    }
    pub fn iter(self) -> impl ExactSizeIterator<Item = AttributeRef<'a, A>> + 'a {
        (0..self.len()).map(move |index| match self.0 {
            List::Raw(values) => AttributeRef::raw(&values[index]),
            List::Owned(values) => AttributeRef::owned(&values.iter().as_slice()[index]),
            List::Single(value) => value,
        })
    }
}
