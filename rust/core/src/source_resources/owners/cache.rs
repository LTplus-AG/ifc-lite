// SPDX-License-Identifier: MPL-2.0
//! Pinned standard-allocator hashbrown backing; no public decoder cache switch.
use super::{build_error::{BuildError, OwnerError}, storage::{Domain, Stored}};
use rustc_hash::FxBuildHasher;

/// Internal u32 keys and the closed, nonpanicking Stored payload set only.
/// Global authoring storage is a distinct type from ResourceAllocator storage.
pub(super) struct CacheOwner<T: Stored<A>, A: Domain> {
    entries: hashbrown::HashMap<u32, T, FxBuildHasher, A>,
}
impl<T: Stored<A>, A: Domain> CacheOwner<T, A> {
    pub fn try_new(allocator: &A) -> Result<Self, OwnerError> {
        allocator.enter()?;
        Ok(Self { entries: hashbrown::HashMap::with_hasher_in(FxBuildHasher, allocator.clone()) })
    }
    pub fn len(&self) -> usize { self.entries.len() }
    pub fn is_empty(&self) -> bool { self.entries.is_empty() }
    pub fn capacity(&self) -> usize { self.entries.capacity() }
    pub fn get(&self, key: u32) -> Option<&T> { self.entries.get(&key) }
    pub fn try_insert(&mut self, key: u32, value: T) -> Result<Option<T>, BuildError<T>> {
        let allocator = self.entries.allocator().clone();
        if let Err(error) = allocator.enter() { return Err(BuildError::new(error, value)); }
        if !value.compatible(&allocator) { return Err(BuildError::new(OwnerError::ForeignDomain, value)); }
        if let Some(slot) = self.entries.get_mut(&key) { return Ok(Some(std::mem::replace(slot, value))); }
        // hashbrown capacity includes only slots usable without a rehash,
        // accounting for tombstones. Spare-capacity insertion copies no table.
        if self.entries.len() == self.entries.capacity() {
            let count = self.entries.capacity();
            let Some(bytes) = count.checked_mul(std::mem::size_of::<(u32, T)>()) else {
                return Err(BuildError::new(allocator.overflow_error(), value));
            };
            if let Err(error) = allocator.copy_work(count, bytes) { return Err(BuildError::new(error, value)); }
        }
        if let Err(error) = self.entries.try_reserve(1) {
            let error = match error {
                hashbrown::TryReserveError::CapacityOverflow => allocator.overflow_error(),
                hashbrown::TryReserveError::AllocError { .. } => allocator.allocation_error(),
            };
            return Err(BuildError::new(error, value));
        }
        // hashbrown 0.15.5: reserve(1) funds insert's reserve(1), including
        // tombstones. No intervening mutation or custom Hash/Eq callback.
        Ok(self.entries.insert(key, value))
    }
    pub fn remove_for_cleanup(&mut self, key: u32) -> Option<T> { self.entries.remove(&key) }
    pub fn clear_for_cleanup(&mut self) { self.entries.clear(); }
    pub fn take_for_cleanup(&mut self) -> Self {
        let empty = Self { entries: hashbrown::HashMap::with_hasher_in(FxBuildHasher, self.entries.allocator().clone()) };
        std::mem::replace(self, empty)
    }
    pub fn replace_for_cleanup(&mut self, donor: Self) -> Self { std::mem::replace(self, donor) }
}
