// SPDX-License-Identifier: MPL-2.0
//! Sealed standard-container storage. No custom counts, header layout or registry.
use super::build_error::{BuildError, OwnerError};
use super::super::allocator::ResourceAllocator;
use std::{alloc::{Allocator, Global, Layout}, sync::{Arc, Weak}};

/// Only the two implementations below select storage policy. Global is an
/// explicit Raw domain, never a fallback when a tracked operation is stopped.
pub(super) trait Domain: Allocator + Clone {
    const RAW: bool;
    fn enter(&self) -> Result<(), OwnerError>;
    fn copy_work(&self, work: usize, bytes: usize) -> Result<(), OwnerError>;
    fn allocation_error(&self) -> OwnerError;
    fn overflow_error(&self) -> OwnerError;
    fn reserve_error(&self, error: std::collections::TryReserveError) -> OwnerError;
    fn same_domain(&self, other: &Self) -> bool;
}
impl Domain for ResourceAllocator {
    const RAW: bool = false;
    fn enter(&self) -> Result<(), OwnerError> { self.enter_operation().map_err(OwnerError::Stopped) }
    fn copy_work(&self, work: usize, bytes: usize) -> Result<(), OwnerError> {
        self.work_and_copy(work, bytes).map_err(OwnerError::Stopped)
    }
    fn allocation_error(&self) -> OwnerError { OwnerError::Stopped(self.error()) }
    fn overflow_error(&self) -> OwnerError { OwnerError::Stopped(self.overflow()) }
    fn reserve_error(&self, error: std::collections::TryReserveError) -> OwnerError {
        OwnerError::Stopped(ResourceAllocator::reserve_error(self, error))
    }
    fn same_domain(&self, other: &Self) -> bool {
        // Dependency: the Global-proof owner's separately frozen cfg(test) API.
        self.same_storage_domain(other)
    }
}
impl Domain for Global {
    const RAW: bool = true;
    fn enter(&self) -> Result<(), OwnerError> { Ok(()) }
    fn copy_work(&self, _: usize, _: usize) -> Result<(), OwnerError> { Ok(()) }
    fn allocation_error(&self) -> OwnerError { OwnerError::Allocation }
    fn overflow_error(&self) -> OwnerError { OwnerError::Overflow }
    fn reserve_error(&self, error: std::collections::TryReserveError) -> OwnerError {
        match error.kind() {
            std::collections::TryReserveErrorKind::CapacityOverflow => OwnerError::Overflow,
            std::collections::TryReserveErrorKind::AllocError { .. } => OwnerError::Allocation,
        }
    }
    fn same_domain(&self, _: &Self) -> bool { true }
}

/// Private closed set of nonpanicking internal payloads. No blanket impl for
/// arbitrary T: a heap-owning Global payload must never hide in tracked storage.
pub(super) trait Stored<A: Domain> {
    fn compatible(&self, allocator: &A) -> bool;
}
macro_rules! scalars {
    ($($ty:ty),*) => { $(impl<A: Domain> Stored<A> for $ty {
        fn compatible(&self, _: &A) -> bool { true }
    })* };
}
scalars!((), u8, u32, u64, i64, f32, f64);

pub(super) struct Shared<T: Stored<A>, A: Domain>(Arc<T, A>);
pub(super) struct SharedWeak<T: Stored<A>, A: Domain>(Weak<T, A>);
impl<T: Stored<A>, A: Domain> Shared<T, A> {
    pub fn try_new(allocator: &A, value: T) -> Result<Self, BuildError<T>> {
        if let Err(error) = allocator.enter() { return Err(BuildError::new(error, value)); }
        if !value.compatible(allocator) { return Err(BuildError::new(OwnerError::ForeignDomain, value)); }
        // Inspectable nightly primitive: allocate the standard Arc first, so
        // failed admission/Global allocation can return the intact donor.
        let mut block = match Arc::<T, A>::try_new_uninit_in(allocator.clone()) {
            Ok(block) => block,
            Err(_) => return Err(BuildError::new(allocator.allocation_error(), value)),
        };
        let Some(slot) = Arc::get_mut(&mut block) else {
            return Err(BuildError::new(OwnerError::Invariant, value));
        };
        slot.write(value);
        // SAFETY: newly unique standard Arc; initialized once, no fallible step
        // after writing. MaybeUninit<T> has T's layout. No raw Arc construction.
        Ok(Self(unsafe { block.assume_init() }))
    }
    pub fn get(&self) -> &T { &self.0 }
    pub fn allocator(&self) -> &A { Arc::allocator(&self.0) }
    pub fn downgrade(&self) -> SharedWeak<T, A> { SharedWeak(Arc::downgrade(&self.0)) }
}
impl<T: Stored<A>, A: Domain> Clone for Shared<T, A> {
    fn clone(&self) -> Self { Self(Arc::clone(&self.0)) }
}
impl<T: Stored<A>, A: Domain> Clone for SharedWeak<T, A> {
    fn clone(&self) -> Self { Self(self.0.clone()) }
}
impl<T: Stored<A>, A: Domain> SharedWeak<T, A> {
    pub fn upgrade(&self) -> Option<Shared<T, A>> { self.0.upgrade().map(Shared) }
}

pub(super) fn copy_bytes<A: Domain>(allocator: &A, input: &[u8])
    -> Result<Box<[u8], A>, OwnerError> {
    allocator.enter()?;
    allocator.copy_work(input.len(), input.len())?;
    Layout::array::<u8>(input.len()).map_err(|_| allocator.overflow_error())?;
    let mut block = Box::<[u8], A>::try_new_uninit_slice_in(input.len(), allocator.clone())
        .map_err(|_| allocator.allocation_error())?;
    // Source is a fixed borrowed slice, not user initialization callbacks.
    // No fallible step or panic-capable element operation occurs in this loop.
    for (slot, &byte) in block.iter_mut().zip(input) { slot.write(byte); }
    // SAFETY: every u8 was initialized, including the empty-slice case.
    Ok(unsafe { block.assume_init() })
}
