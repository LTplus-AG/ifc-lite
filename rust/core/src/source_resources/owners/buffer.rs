// SPDX-License-Identifier: MPL-2.0
use super::{build_error::{BuildError, OwnerError}, storage::{Domain, Stored}};

/// Unique mutable backing. Only sealed scalar/owner payloads can inhabit it.
/// No Clone, DerefMut, raw Vec extraction, mutation callback or deep copy trait.
pub(super) struct OwnedBuffer<T: Stored<A>, A: Domain> { values: Vec<T, A> }
impl<T: Stored<A>, A: Domain> OwnedBuffer<T, A> {
    pub fn try_new(allocator: &A) -> Result<Self, OwnerError> {
        allocator.enter()?;
        Ok(Self { values: Vec::new_in(allocator.clone()) })
    }
    pub fn allocator(&self) -> &A { self.values.allocator() }
    pub fn len(&self) -> usize { self.values.len() }
    pub fn is_empty(&self) -> bool { self.values.is_empty() }
    pub fn capacity(&self) -> usize { self.values.capacity() }
    pub fn get(&self, index: usize) -> Option<&T> { self.values.get(index) }
    pub fn iter(&self) -> std::slice::Iter<'_, T> { self.values.iter() }
    pub fn try_reserve(&mut self, additional: usize) -> Result<(), OwnerError> {
        let allocator = self.values.allocator().clone();
        allocator.enter()?;
        self.values.try_reserve(additional).map_err(|error| allocator.reserve_error(error))
    }
    pub fn try_push(&mut self, value: T) -> Result<(), BuildError<T>> {
        let allocator = self.values.allocator().clone();
        if let Err(error) = allocator.enter() { return Err(BuildError::new(error, value)); }
        if !value.compatible(&allocator) { return Err(BuildError::new(OwnerError::ForeignDomain, value)); }
        if let Err(error) = self.values.try_reserve(1) {
            return Err(BuildError::new(allocator.reserve_error(error), value));
        }
        self.values.push_within_capacity(value).map(|_| ())
            .map_err(|donor| BuildError::new(OwnerError::Invariant, donor))
    }
    /// Cleanup-only mutations never grant permission for later growth.
    pub fn clear_for_cleanup(&mut self) { self.values.clear(); }
    pub fn take_for_cleanup(&mut self) -> Self {
        let empty = Self { values: Vec::new_in(self.values.allocator().clone()) };
        std::mem::replace(self, empty)
    }
    pub fn replace_for_cleanup(&mut self, donor: Self) -> Self { std::mem::replace(self, donor) }
}
impl<T: Stored<A>, A: Domain> Stored<A> for OwnedBuffer<T, A> {
    fn compatible(&self, allocator: &A) -> bool { self.allocator().same_domain(allocator) }
}
