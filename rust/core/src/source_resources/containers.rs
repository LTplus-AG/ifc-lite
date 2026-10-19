// SPDX-License-Identifier: MPL-2.0
//! Bounded adapters, not replacements for public decoder/cache APIs.
use super::allocator::ResourceAllocator;
use crate::resource_stop::ProgramStop;
use std::{alloc::Layout, mem::MaybeUninit, sync::Arc};
use rustc_hash::FxBuildHasher;

pub(super) fn try_arc<T>(allocator: &ResourceAllocator, value: T)
    -> Result<Arc<T, ResourceAllocator>, ProgramStop> {
    allocator.enter_operation()?;
    Arc::try_new_in(value, allocator.clone()).map_err(|_| allocator.error())
}
pub(super) fn try_push<T>(values: &mut Vec<T, ResourceAllocator>, value: T) -> Result<(), ProgramStop> {
    let allocator = values.allocator().clone();
    allocator.enter_operation()?;
    values.try_reserve(1).map_err(|error| allocator.reserve_error(error))?;
    values.push_within_capacity(value).map(|_| ()).map_err(|_| allocator.overflow())
}
pub(super) type Cache<T> = hashbrown::HashMap<u32, T, FxBuildHasher, ResourceAllocator>;
pub(super) fn empty_cache<T>(allocator: &ResourceAllocator) -> Cache<T> {
    // Construction/cleanup movement creates no storage and confers no work rights.
    Cache::with_hasher_in(FxBuildHasher, allocator.clone())
}
pub(super) fn try_insert<T>(cache: &mut Cache<T>, key: u32, value: T) -> Result<Option<T>, ProgramStop> {
    let allocator = cache.allocator().clone();
    allocator.enter_operation()?;
    if let Some(slot) = cache.get_mut(&key) { return Ok(Some(std::mem::replace(slot, value))); }
    let copies = cache.capacity().checked_mul(std::mem::size_of::<(u32, T)>())
        .ok_or_else(|| allocator.overflow())?;
    allocator.work_and_copy(cache.capacity(), copies)?;
    cache.try_reserve(1).map_err(|error| match error {
        hashbrown::TryReserveError::CapacityOverflow => allocator.overflow(),
        hashbrown::TryReserveError::AllocError { .. } => allocator.error(),
    })?;
    // Pinned hashbrown 0.15.5: successful reserve makes insert's reserve(1)
    // nonallocating. No intervening mutation or user Hash/Eq callback (u32 keys).
    Ok(cache.insert(key, value))
}

pub(super) fn try_import_copy(cache: &mut Cache<u32>, entries: &[(u32, u32)])
    -> Result<(), ProgramStop> {
    let allocator = cache.allocator().clone();
    allocator.enter_operation()?;
    let copies = cache.capacity().checked_add(entries.len())
        .and_then(|count| count.checked_mul(std::mem::size_of::<(u32, u32)>()))
        .ok_or_else(|| allocator.overflow())?;
    let work = cache.capacity().checked_add(entries.len()).ok_or_else(|| allocator.overflow())?;
    allocator.work_and_copy(work, copies)?;
    // Conservative upper bound includes duplicate keys; no content changes yet.
    cache.try_reserve(entries.len()).map_err(|error| match error {
        hashbrown::TryReserveError::CapacityOverflow => allocator.overflow(),
        hashbrown::TryReserveError::AllocError { .. } => allocator.error(),
    })?;
    for &(key, value) in entries {
        if let Some(slot) = cache.get_mut(&key) { *slot = value; }
        else { cache.insert(key, value); }
    }
    Ok(())
}

struct Prefix<T> {
    values: Option<Box<[MaybeUninit<T>], ResourceAllocator>>,
    initialized: usize,
}
impl<T> Drop for Prefix<T> {
    fn drop(&mut self) {
        if let Some(values) = self.values.as_mut() {
            // SAFETY: only this prefix was initialized. Slice drop glue cleans
            // remaining prefix elements on unwind; the MaybeUninit box then
            // deallocates independently, never dropping these values twice.
            unsafe {
                let prefix = std::ptr::slice_from_raw_parts_mut(values.as_mut_ptr().cast::<T>(), self.initialized);
                std::ptr::drop_in_place(prefix);
            }
        }
    }
}
pub(super) fn try_box_slice<T>(allocator: &ResourceAllocator, len: usize,
    mut initialize: impl FnMut(usize) -> Result<T, ProgramStop>)
    -> Result<Box<[T], ResourceAllocator>, ProgramStop> {
    allocator.enter_operation()?; // Preserve existing original stop BEFORE overflow.
    Layout::array::<T>(len).map_err(|_| allocator.overflow())?;
    let values = Box::<[T], ResourceAllocator>::try_new_uninit_slice_in(len, allocator.clone())
        .map_err(|_| allocator.error())?;
    let mut guard = Prefix { values: Some(values), initialized: 0 };
    for index in 0..len {
        allocator.enter_operation()?;
        let value = initialize(index).map_err(|stop| allocator.record(stop))?;
        // No fallible operation occurs between initialization and prefix update.
        let values = guard.values.as_mut().ok_or_else(|| allocator.error())?;
        values[index].write(value);
        guard.initialized += 1;
    }
    let values = guard.values.take().ok_or_else(|| allocator.error())?;
    // SAFETY: all len elements have been initialized; guard no longer owns them.
    Ok(unsafe { values.assume_init() })
}

pub(super) struct CleanupOwner<T>(pub Option<T>);
impl<T> CleanupOwner<T> {
    pub fn empty() -> Self { Self(None) }
    pub fn take_for_cleanup(&mut self) -> Self { Self(self.0.take()) }
    pub fn replace_for_cleanup(&mut self, incoming: Self) -> Self { std::mem::replace(self, incoming) }
}
