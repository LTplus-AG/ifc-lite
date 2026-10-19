// SPDX-License-Identifier: MPL-2.0
//! Standard container allocator; no reference counts, pointer registry or TLS.
use super::backend::{Cost, StorageEvent};
use super::gate::Gate;
use super::failure;
use crate::execution_owner::AllocationClass;
use crate::resource_stop::{Dimension, ProgramStop, RefusalReason};
use std::{alloc::{AllocError, Allocator, Global, Layout}, ptr::NonNull};

#[derive(Clone)]
pub(super) struct ResourceAllocator { gate: Gate }
impl ResourceAllocator {
    pub fn new(gate: Gate) -> Self { Self { gate } }
    pub fn enter_operation(&self) -> Result<(), ProgramStop> {
        self.gate.before(Cost { work: 1, ..Default::default() })
    }
    pub fn work_and_copy(&self, work: usize, copies: usize) -> Result<(), ProgramStop> {
        let work = u64::try_from(work).map_err(|_| self.overflow())?;
        let copies = u64::try_from(copies).map_err(|_| self.record(failure(
            Dimension::CopyBytes, u64::MAX, 0, RefusalReason::Overflow)))?;
        self.gate.before(Cost { work, copies, live: 0, ..Default::default() })
    }
    pub fn record(&self, stop: ProgramStop) -> ProgramStop { self.gate.record(stop) }
    pub fn error(&self) -> ProgramStop {
        self.gate.record(failure(Dimension::LiveBytes, 0, 0, RefusalReason::Allocation))
    }
    pub fn reserve_error(&self, error: std::collections::TryReserveError) -> ProgramStop {
        use std::collections::TryReserveErrorKind;
        match error.kind() {
            TryReserveErrorKind::CapacityOverflow => self.overflow(),
            TryReserveErrorKind::AllocError { .. } => self.error(),
        }
    }
    pub fn overflow(&self) -> ProgramStop {
        self.gate.record(failure(Dimension::LiveBytes, u64::MAX, 0, RefusalReason::Overflow))
    }
    fn debit(&self, layout: Layout, copies: usize) -> Result<u64, AllocError> {
        let live = u64::try_from(layout.size()).map_err(|_| { self.overflow(); AllocError })?;
        let copies = u64::try_from(copies).map_err(|_| { self.overflow(); AllocError })?;
        self.gate.before(Cost { live, work: 1, copies, ..Default::default() }).map_err(|_| AllocError)?;
        Ok(live)
    }
    fn failed_global(&self, bytes: u64) -> AllocError {
        self.gate.backend().refund(bytes, AllocationClass::Container);
        self.gate.record(failure(Dimension::LiveBytes, bytes, 0, RefusalReason::Allocation));
        AllocError
    }
    fn allocate_impl(&self, layout: Layout, zeroed: bool) -> Result<NonNull<[u8]>, AllocError> {
        let bytes = self.debit(layout, 0)?;
        let result = if zeroed { Global.allocate_zeroed(layout) } else { Global.allocate(layout) };
        match result {
            Ok(memory) => {
                if bytes != 0 { self.gate.backend().observe(StorageEvent::Allocated(bytes), AllocationClass::Container); }
                Ok(memory)
            }
            Err(_) => Err(self.failed_global(bytes)),
        }
    }
    /// Caller upholds std Allocator's original pointer/layout/size conditions.
    unsafe fn resize(&self, ptr: NonNull<u8>, old: Layout, new: Layout, mode: Resize)
        -> Result<NonNull<[u8]>, AllocError> {
        let copies = match mode { Resize::Shrink => new.size(), _ => old.size() };
        let bytes = self.debit(new, copies)?;
        // SAFETY: delegated unchanged from this allocator's std trait methods.
        let result = unsafe { match mode {
            Resize::Grow => Global.grow(ptr, old, new),
            Resize::GrowZeroed => Global.grow_zeroed(ptr, old, new),
            Resize::Shrink => Global.shrink(ptr, old, new),
        } };
        match result {
            Ok(memory) => {
                if old.size() != 0 || bytes != 0 {
                    self.gate.backend().observe(StorageEvent::Replaced { old: old.size() as u64, new: bytes }, AllocationClass::Container);
                }
                self.gate.backend().refund(old.size() as u64, AllocationClass::Container);
                Ok(memory)
            }
            Err(_) => Err(self.failed_global(bytes)),
        }
    }
}
enum Resize { Grow, GrowZeroed, Shrink }

// SAFETY: every successful block is allocated by Global with the original Layout;
// all clones retain the same refund domain. None changes pointer/Layout or frees
// it twice. Standard callers own blocks. Admission failure never reaches Global.
unsafe impl Allocator for ResourceAllocator {
    fn allocate(&self, layout: Layout) -> Result<NonNull<[u8]>, AllocError> {
        self.allocate_impl(layout, false)
    }
    fn allocate_zeroed(&self, layout: Layout) -> Result<NonNull<[u8]>, AllocError> {
        self.allocate_impl(layout, true)
    }
    unsafe fn deallocate(&self, ptr: NonNull<u8>, layout: Layout) {
        // SAFETY: caller supplies the unchanged Global block and fitting Layout.
        unsafe { Global.deallocate(ptr, layout); }
        if layout.size() != 0 {
            self.gate.backend().observe(StorageEvent::Deallocated(layout.size() as u64), AllocationClass::Container);
        }
        self.gate.backend().refund(layout.size() as u64, AllocationClass::Container);
    }
    unsafe fn grow(&self, ptr: NonNull<u8>, old: Layout, new: Layout)
        -> Result<NonNull<[u8]>, AllocError> {
        // SAFETY: caller upholds grow's original pointer/layout requirements.
        unsafe { self.resize(ptr, old, new, Resize::Grow) }
    }
    unsafe fn grow_zeroed(&self, ptr: NonNull<u8>, old: Layout, new: Layout)
        -> Result<NonNull<[u8]>, AllocError> {
        // SAFETY: caller upholds grow_zeroed's original pointer/layout requirements.
        unsafe { self.resize(ptr, old, new, Resize::GrowZeroed) }
    }
    unsafe fn shrink(&self, ptr: NonNull<u8>, old: Layout, new: Layout)
        -> Result<NonNull<[u8]>, AllocError> {
        // SAFETY: caller upholds shrink's original pointer/layout requirements.
        unsafe { self.resize(ptr, old, new, Resize::Shrink) }
    }
}
