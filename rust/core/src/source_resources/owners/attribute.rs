// SPDX-License-Identifier: MPL-2.0
use super::{buffer::OwnedBuffer, build_error::{BuildError, OwnerError},
    storage::{Domain, Shared, SharedWeak, Stored}, text::{OwnedText, TextWeak},
    views::{AttributeListRef, AttributeRef}};
use crate::AttributeValue as RawAttributeValue;
use std::sync::{Arc, Weak};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Scalar { EntityRef(u32), Integer(i64), Float(f64), Null, Derived }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TextKind { String, Binary, Enum }

/// Separate representation: no String, raw Vec, DTO subtree or allocating Clone.
pub(super) struct Node<A: Domain> { pub(super) kind: NodeKind<A> }
pub(super) enum NodeKind<A: Domain> {
    Scalar(Scalar),
    Text(TextKind, OwnedText<A>),
    List(ListOwner<A>),
    Typed(Shared<TypedBlock<A>, A>),
}
pub(super) struct TypedBlock<A: Domain> {
    pub name: OwnedText<A>,
    pub value: Node<A>,
    depth: u32,
}
impl<A: Domain> Stored<A> for TypedBlock<A> {
    fn compatible(&self, allocator: &A) -> bool {
        self.name.compatible(allocator) && self.value.compatible(allocator)
    }
}
impl<A: Domain> Clone for Node<A> {
    fn clone(&self) -> Self {
        Self { kind: match &self.kind {
            NodeKind::Scalar(value) => NodeKind::Scalar(*value),
            NodeKind::Text(kind, text) => NodeKind::Text(*kind, text.clone()),
            NodeKind::List(list) => NodeKind::List(list.clone()),
            NodeKind::Typed(typed) => NodeKind::Typed(typed.clone()),
        } }
    }
}
impl<A: Domain> Node<A> {
    fn depth(&self) -> u32 {
        match &self.kind {
            NodeKind::Scalar(_) | NodeKind::Text(_, _) => 0,
            NodeKind::List(list) => list.1 + 1,
            NodeKind::Typed(typed) => typed.get().depth,
        }
    }
    /// Scalars own no backing, carry no authority, and can be copied freely.
    pub fn scalar(value: Scalar) -> Self { Self { kind: NodeKind::Scalar(value) } }
    pub fn try_text(allocator: &A, kind: TextKind, text: OwnedText<A>)
        -> Result<Self, BuildError<OwnedText<A>>> {
        if let Err(error) = allocator.enter() { return Err(BuildError::new(error, text)); }
        if !text.compatible(allocator) { return Err(BuildError::new(OwnerError::ForeignDomain, text)); }
        Ok(Self { kind: NodeKind::Text(kind, text) })
    }
    pub fn try_list(allocator: &A, list: ListOwner<A>) -> Result<Self, BuildError<ListOwner<A>>> {
        if let Err(error) = allocator.enter() { return Err(BuildError::new(error, list)); }
        if !list.compatible(allocator) { return Err(BuildError::new(OwnerError::ForeignDomain, list)); }
        if list.1 >= crate::parser::MAX_NESTING_DEPTH {
            return Err(BuildError::new(OwnerError::Nesting, list));
        }
        Ok(Self { kind: NodeKind::List(list) })
    }
    pub fn try_typed(allocator: &A, name: OwnedText<A>, value: Self)
        -> Result<Self, BuildError<(OwnedText<A>, Self)>> {
        if let Err(error) = allocator.enter() { return Err(BuildError::new(error, (name, value))); }
        if !name.compatible(allocator) || !value.compatible(allocator) {
            return Err(BuildError::new(OwnerError::ForeignDomain, (name, value)));
        }
        let Some(depth) = value.depth().checked_add(1)
            .filter(|depth| *depth <= crate::parser::MAX_NESTING_DEPTH) else {
            return Err(BuildError::new(OwnerError::Nesting, (name, value)));
        };
        Shared::try_new(allocator, TypedBlock { name, value, depth })
            .map(|typed| Self { kind: NodeKind::Typed(typed) })
            .map_err(|error| BuildError::new(error.error, (error.donor.name, error.donor.value)))
    }
    pub fn view(&self) -> AttributeRef<'_, A> { AttributeRef::owned(self) }
    /// Scalars have no allocation to weaken. Backed values use standard Weak;
    /// no root/path allocation is introduced to retain a selected subtree.
    pub fn downgrade(&self) -> Option<NodeWeak<A>> {
        match &self.kind {
            NodeKind::Scalar(_) => None,
            NodeKind::Text(kind, text) => Some(NodeWeak::Text(*kind, text.downgrade())),
            NodeKind::List(list) => Some(NodeWeak::List(list.downgrade())),
            NodeKind::Typed(typed) => Some(NodeWeak::Typed(typed.downgrade())),
        }
    }
}
impl<A: Domain> Stored<A> for Node<A> {
    fn compatible(&self, allocator: &A) -> bool {
        match &self.kind {
            NodeKind::Scalar(_) => true,
            NodeKind::Text(_, text) => text.compatible(allocator),
            NodeKind::List(list) => list.compatible(allocator),
            NodeKind::Typed(typed) => typed.allocator().same_domain(allocator),
        }
    }
}

pub(super) enum NodeWeak<A: Domain> {
    Text(TextKind, TextWeak<A>), List(ListWeak<A>), Typed(SharedWeak<TypedBlock<A>, A>),
}
impl<A: Domain> Clone for NodeWeak<A> {
    fn clone(&self) -> Self {
        match self {
            Self::Text(kind, weak) => Self::Text(*kind, weak.clone()),
            Self::List(weak) => Self::List(weak.clone()),
            Self::Typed(weak) => Self::Typed(weak.clone()),
        }
    }
}
impl<A: Domain> NodeWeak<A> {
    pub fn upgrade(&self) -> Option<Node<A>> {
        let kind = match self {
            Self::Text(kind, weak) => NodeKind::Text(*kind, weak.upgrade()?),
            Self::List(weak) => NodeKind::List(weak.upgrade()?),
            Self::Typed(weak) => NodeKind::Typed(weak.upgrade()?),
        };
        Some(Node { kind })
    }
}

pub(super) struct ListOwner<A: Domain>(Shared<OwnedBuffer<Node<A>, A>, A>, u32);
pub(super) struct ListWeak<A: Domain>(SharedWeak<OwnedBuffer<Node<A>, A>, A>, u32);
impl<A: Domain> ListOwner<A> {
    pub fn try_new(allocator: &A, values: OwnedBuffer<Node<A>, A>)
        -> Result<Self, BuildError<OwnedBuffer<Node<A>, A>>> {
        if let Err(error) = allocator.enter() { return Err(BuildError::new(error, values)); }
        if !values.compatible(allocator) { return Err(BuildError::new(OwnerError::ForeignDomain, values)); }
        // Charge the entire inspection before scanning. Root attributes add no
        // lexical level; only Node::try_list wraps this storage in a STEP list.
        if let Err(error) = allocator.copy_work(values.len(), 0) {
            return Err(BuildError::new(error, values));
        }
        let depth = values.iter().map(Node::depth).max().unwrap_or(0);
        Shared::try_new(allocator, values).map(|block| Self(block, depth))
    }
    pub fn view(&self) -> AttributeListRef<'_, A> { AttributeListRef::owned(self.0.get()) }
    pub fn downgrade(&self) -> ListWeak<A> { ListWeak(self.0.downgrade(), self.1) }
}
impl<A: Domain> Clone for ListOwner<A> {
    fn clone(&self) -> Self { Self(self.0.clone(), self.1) }
}
impl<A: Domain> Clone for ListWeak<A> {
    fn clone(&self) -> Self { Self(self.0.clone(), self.1) }
}
impl<A: Domain> ListWeak<A> {
    pub fn upgrade(&self) -> Option<ListOwner<A>> { self.0.upgrade().map(|block| ListOwner(block, self.1)) }
}
impl<A: Domain> Stored<A> for ListOwner<A> {
    fn compatible(&self, allocator: &A) -> bool { self.0.allocator().same_domain(allocator) }
}

/// R3 Raw representation is retained exactly; no conversion/deep copy is hidden
/// behind sharing. Authored DTOs cannot inhabit the separate owned-node branch.
pub(super) enum AttributeOwner<A: Domain> {
    Raw(Arc<Vec<RawAttributeValue>>),
    Owned(ListOwner<A>),
}
pub(super) enum OwnerWeak<A: Domain> {
    Raw(Weak<Vec<RawAttributeValue>>), Owned(ListWeak<A>),
}
impl<A: Domain> AttributeOwner<A> {
    pub fn view(&self) -> AttributeListRef<'_, A> {
        match self {
            Self::Raw(values) => AttributeListRef::raw(values),
            Self::Owned(values) => values.view(),
        }
    }
    pub fn downgrade(&self) -> OwnerWeak<A> {
        match self {
            Self::Raw(values) => OwnerWeak::Raw(Arc::downgrade(values)),
            Self::Owned(values) => OwnerWeak::Owned(values.downgrade()),
        }
    }
}
impl<A: Domain> Clone for AttributeOwner<A> {
    fn clone(&self) -> Self {
        match self { Self::Raw(values) => Self::Raw(values.clone()), Self::Owned(values) => Self::Owned(values.clone()) }
    }
}
impl<A: Domain> Clone for OwnerWeak<A> {
    fn clone(&self) -> Self {
        match self { Self::Raw(values) => Self::Raw(values.clone()), Self::Owned(values) => Self::Owned(values.clone()) }
    }
}
impl<A: Domain> OwnerWeak<A> {
    pub fn upgrade(&self) -> Option<AttributeOwner<A>> {
        match self {
            Self::Raw(values) => values.upgrade().map(AttributeOwner::Raw),
            Self::Owned(values) => values.upgrade().map(AttributeOwner::Owned),
        }
    }
}
impl<A: Domain> Stored<A> for AttributeOwner<A> {
    fn compatible(&self, allocator: &A) -> bool {
        match self { Self::Raw(_) => A::RAW, Self::Owned(values) => values.compatible(allocator) }
    }
}
