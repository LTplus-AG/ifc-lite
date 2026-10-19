// SPDX-License-Identifier: MPL-2.0
use super::{attribute::AttributeOwner, build_error::{BuildError, OwnerError},
    storage::{Domain, Shared, SharedWeak, Stored}, views::AttributeRef};
use crate::IfcType;

struct EntityBlock<A: Domain> { id: u32, ifc_type: IfcType, attributes: AttributeOwner<A> }
impl<A: Domain> Stored<A> for EntityBlock<A> {
    fn compatible(&self, allocator: &A) -> bool { self.attributes.compatible(allocator) }
}
pub(super) struct SharedEntity<A: Domain>(Shared<EntityBlock<A>, A>);
pub(super) struct EntityWeak<A: Domain>(SharedWeak<EntityBlock<A>, A>);
impl<A: Domain> SharedEntity<A> {
    pub fn try_new(allocator: &A, id: u32, ifc_type: IfcType, attributes: AttributeOwner<A>)
        -> Result<Self, BuildError<AttributeOwner<A>>> {
        if let Err(error) = allocator.enter() { return Err(BuildError::new(error, attributes)); }
        if !attributes.compatible(allocator) { return Err(BuildError::new(OwnerError::ForeignDomain, attributes)); }
        Shared::try_new(allocator, EntityBlock { id, ifc_type, attributes }).map(Self)
            .map_err(|error| BuildError::new(error.error, error.donor.attributes))
    }
    pub fn id(&self) -> u32 { self.0.get().id }
    pub fn ifc_type(&self) -> IfcType { self.0.get().ifc_type }
    pub fn get(&self, index: usize) -> Option<AttributeRef<'_, A>> { self.0.get().attributes.view().get(index) }
    pub fn downgrade(&self) -> EntityWeak<A> { EntityWeak(self.0.downgrade()) }
}
impl<A: Domain> Clone for SharedEntity<A> {
    fn clone(&self) -> Self { Self(self.0.clone()) }
}
impl<A: Domain> Clone for EntityWeak<A> {
    fn clone(&self) -> Self { Self(self.0.clone()) }
}
impl<A: Domain> EntityWeak<A> {
    pub fn upgrade(&self) -> Option<SharedEntity<A>> { self.0.upgrade().map(SharedEntity) }
}
impl<A: Domain> Stored<A> for SharedEntity<A> {
    fn compatible(&self, allocator: &A) -> bool { self.0.allocator().same_domain(allocator) }
}
