// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #3987: repeated per-job construction must not allocate unused routing state.
//! This standalone integration target survives a production-only revert and
//! measures a resource contract, not elapsed time or an assumed byte threshold.
use ifc_lite_geometry::GeometryRouter;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

struct CountingSystem;
thread_local! {
    static ENABLED: Cell<bool> = const { Cell::new(false) };
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}

fn record_allocation() {
    if ENABLED.try_with(Cell::get).unwrap_or(false) {
        let _ = ALLOCATIONS.try_with(|count| count.set(count.get() + 1));
    }
}

unsafe impl GlobalAlloc for CountingSystem {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record_allocation();
        // SAFETY: forward the allocator's original layout unchanged.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record_allocation();
        // SAFETY: forward the allocator's original layout unchanged.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record_allocation();
        // SAFETY: preserve pointer ownership, old layout and requested size.
        unsafe { System.realloc(pointer, layout, size) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: forward the allocation and its original layout unchanged.
        unsafe { System.dealloc(pointer, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: CountingSystem = CountingSystem;

struct Recording;
impl Drop for Recording {
    fn drop(&mut self) { ENABLED.with(|enabled| enabled.set(false)); }
}

#[test]
fn issue_3987_warmed_router_construction_allocates_no_unused_registry_or_schema() {
    // Initialize immutable shared schema and TLS before the measured scope.
    drop(std::hint::black_box(GeometryRouter::new()));
    ALLOCATIONS.with(|count| count.set(0));
    ENABLED.with(|enabled| enabled.set(true));
    let recording = Recording;
    let router = std::hint::black_box(GeometryRouter::new());
    drop(recording); // disable before assertions, formatting and router cleanup
    let allocations = ALLOCATIONS.with(Cell::get);
    assert_eq!(allocations, 0, "an unused per-job router must reuse immutable routing metadata");
    drop(router);
}
