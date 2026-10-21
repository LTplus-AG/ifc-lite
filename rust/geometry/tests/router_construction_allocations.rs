// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #3987: repeated per-job construction must not allocate unused routing state.
//! This standalone integration target survives a production-only revert and
//! measures a resource contract, not elapsed time or an assumed byte threshold.
use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{
    ExtrudedAreaSolidProcessor, GeometryProcessor, GeometryRouter, TessellationQuality,
    TriangulatedFaceSetProcessor,
};
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

fn count_allocations<T>(work: impl FnOnce() -> T) -> (T, usize) {
    ALLOCATIONS.with(|count| count.set(0));
    ENABLED.with(|enabled| enabled.set(true));
    let recording = Recording;
    let value = std::hint::black_box(work());
    drop(recording);
    (value, ALLOCATIONS.with(Cell::get))
}

/// The common item program sits on the hottest per-item path: on a warmed
/// router it may allocate only what the selected processor's own work and the
/// returned copy of the router-local hash-cache mesh allocate. A boxed
/// controller, a cloned source entity or eager report storage shows up here.
#[test]
fn warmed_item_gateway_allocates_only_processor_work_and_its_output() {
    const EXTRUSION: &str = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
        #3=IFCDIRECTION((0.,0.,1.));#4=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.,2.);\
        #5=IFCEXTRUDEDAREASOLID(#4,#2,#3,3.);";
    const SURVEY: &str = "#1=IFCCARTESIANPOINTLIST3D(((5000000.,0.,0.),(5000001.,0.,0.),(5000000.,1.,0.)),$);\
        #2=IFCTRIANGULATEDFACESET(#1,$,.F.,((1,2,3)),$);";
    let quality = TessellationQuality::Medium;
    for (source, id, rtc) in [(EXTRUSION, 5, None), (SURVEY, 2, Some((5_000_000., 0., 0.)))] {
        let mut decoder = EntityDecoder::new(source);
        let item = decoder.decode_by_id(id).unwrap();
        let mut router = GeometryRouter::with_scale_and_local_frame(1., false);
        if let Some(offset) = rtc {
            router.set_rtc_offset(offset);
        }
        let schema = router.schema().clone();
        let processor: Box<dyn GeometryProcessor> = match rtc {
            None => Box::new(ExtrudedAreaSolidProcessor::new(schema.clone())),
            Some(_) => Box::new(TriangulatedFaceSetProcessor::new()),
        };
        let direct = |decoder: &mut EntityDecoder| match rtc {
            None => processor.process(&item, decoder, &schema, quality).unwrap(),
            Some(offset) => processor.process_in_rtc_frame(&item, decoder, &schema, quality, offset).unwrap().unwrap(),
        };
        // Warm the router's hash cache, lazy registry slot and thread-locals.
        let warmed = router.process_representation_item(&item, &mut decoder).unwrap();
        let _ = direct(&mut decoder);
        let (_, processor_work) = count_allocations(|| direct(&mut decoder).clone());
        let (mesh, gateway) = count_allocations(|| router.process_representation_item(&item, &mut decoder).unwrap());
        assert_eq!(mesh.positions, warmed.positions);
        assert!(processor_work > 0, "the measured processor work allocates its own mesh");
        assert_eq!(gateway, processor_work, "item program allocations beyond processor work (rtc={rtc:?})");
    }
}
