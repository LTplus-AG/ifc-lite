// SPDX-License-Identifier: MPL-2.0
//! #8091: opaque custom logs must not cross a failed product boundary.
use super::*;
use crate::element::session_tests::{leaked_job, options, router, Context, SOURCE};
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::resource::{self, ProgramStop};
use ifc_lite_geometry::{BooleanClippingProcessor, BoolFailure, ExtrudedAreaSolidProcessor,
    GeometryProcessor, TessellationQuality};
use std::{cell::{Cell, RefCell}, rc::Rc};

struct OpaqueRecorder {
    pending: RefCell<Vec<BoolFailure>>,
    record_next: Rc<Cell<bool>>,
    stop_next: Cell<bool>,
    panic_next: Cell<bool>,
    hooks: Rc<Cell<usize>>,
}

impl GeometryProcessor for OpaqueRecorder {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcExtrudedAreaSolid] }

    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        schema: &IfcSchema, quality: TessellationQuality) -> ifc_lite_geometry::Result<Mesh> {
        let mesh = ExtrudedAreaSolidProcessor::new(schema.clone())
            .process(entity, decoder, schema, quality)?;
        if self.record_next.replace(false) {
            // A real unsupported Boolean produces the private log; this custom
            // processor deliberately does not expose its Boolean recorder.
            let recorder = BooleanClippingProcessor::new();
            let boolean = decoder.decode_by_id(87).unwrap();
            recorder.process(&boolean, decoder, schema, quality)?;
            let failures = recorder.take_failures();
            assert_eq!(failures.len(), 1);
            self.pending.borrow_mut().extend(failures);
        }
        assert!(!self.panic_next.replace(false), "custom constructor unwind");
        if self.stop_next.replace(false) { resource::stop(ProgramStop::Cancelled); }
        Ok(mesh)
    }

    fn take_bool_failures(&self) -> Vec<BoolFailure> {
        self.hooks.set(self.hooks.get() + 1);
        std::mem::take(&mut *self.pending.borrow_mut())
    }
}

fn opaque_log_after_failed_product(panic: bool) {
    let source = SOURCE.replace("ENDSEC;END-ISO-10303-21;",
        "#87=IFCBOOLEANRESULT(.XOR.,#13,$);
#90=IFCSLAB('fresh',$,'Fresh',$,$,#19,#91,$,.FLOOR.);
#91=IFCPRODUCTDEFINITIONSHAPE($,$,(#92));
#92=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#93));
#93=IFCEXTRUDEDAREASOLID(#14,#5,#15,1.5);
ENDSEC;END-ISO-10303-21;");
    let mut decoder = EntityDecoder::new(&source);
    let mut router = router(&mut decoder);
    router.disable_content_dedup();
    let record_next = Rc::new(Cell::new(true));
    let hooks = Rc::new(Cell::new(0));
    router.register(Box::new(OpaqueRecorder { pending: RefCell::new(Vec::new()),
        record_next: record_next.clone(), stop_next: Cell::new(!panic),
        panic_next: Cell::new(panic), hooks: hooks.clone() }));
    let job = leaked_job(&mut decoder, 10);
    let first = std::panic::catch_unwind(std::panic::AssertUnwindSafe(||
        produce_element_meshes(job, &Context::default().borrowed(), &options(), &mut decoder, &router)));
    if panic { assert!(first.is_err()); } else { assert!(first.unwrap().meshes.is_empty()); }
    assert_eq!(hooks.get(), 0, "stopped or unwinding production must run no final hook");
    let next = leaked_job(&mut decoder, 20);
    let output = produce_element_meshes(next, &Context::default().borrowed(), &options(), &mut decoder, &router);
    assert!(!output.meshes.is_empty());
    assert!(hooks.get() > 0, "the successful successor reaches the custom final drain");
    assert!(output.csg_failures.is_empty(), "successor published a failed product's opaque report");
    let reports = router.take_csg_failures();
    assert_eq!(reports.values().map(Vec::len).sum::<usize>(), 1,
        "the original report remains available explicitly instead of being discarded");
    assert!(router.take_csg_failures().is_empty(), "explicit retrieval is once-only");

    // Explicit retrieval restores an unambiguous boundary. New reports from
    // successful custom work must still be published, rather than suppressed.
    record_next.set(true);
    let job = leaked_job(&mut decoder, 90);
    let fresh = produce_element_meshes(job, &Context::default().borrowed(), &options(), &mut decoder, &router);
    assert!(!fresh.meshes.is_empty());
    assert!(!record_next.get(), "the fresh item must execute the custom constructor");
    assert_eq!(fresh.csg_failures.values().map(Vec::len).sum::<usize>(), 1);
    assert!(router.take_csg_failures().is_empty());
}

#[test]
fn issue_8091_opaque_custom_log_survives_cancel_without_leaking_to_successor() {
    opaque_log_after_failed_product(false);
}

#[test]
fn issue_8091_opaque_custom_log_survives_unwind_without_leaking_to_successor() {
    opaque_log_after_failed_product(true);
}

#[test]
fn issue_8091_nested_scope_does_not_assign_opaque_parent_log_to_child() {
    let source = SOURCE.replace("ENDSEC;END-ISO-10303-21;",
        "#87=IFCBOOLEANRESULT(.XOR.,#13,$);ENDSEC;END-ISO-10303-21;");
    let mut decoder = EntityDecoder::new(&source);
    let mut router = router(&mut decoder);
    let hooks = Rc::new(Cell::new(0));
    router.register(Box::new(OpaqueRecorder { pending: RefCell::new(Vec::new()),
        record_next: Rc::new(Cell::new(true)), stop_next: Cell::new(false),
        panic_next: Cell::new(false), hooks: hooks.clone() }));
    router.with_product_csg_scope(|| {
        let item = decoder.decode_by_id(13).unwrap();
        assert!(!router.process_representation_item(&item, &mut decoder).unwrap().is_empty());
        assert_eq!(hooks.get(), 0);
        router.with_product_csg_scope(|| {
            assert_eq!(hooks.get(), 0, "nested entry runs no final callbacks");
            assert!(router.take_csg_failures_checked().unwrap().is_empty(),
                "child adopted the parent's opaque log");
        });
        assert!(router.take_csg_failures_checked().unwrap().is_empty());
    });
    let reports = router.take_csg_failures();
    assert_eq!(reports.values().map(Vec::len).sum::<usize>(), 1);
    assert!(router.take_csg_failures().is_empty());
}

#[test]
fn issue_8091_retry_drain_cannot_complete_later_unwinding_opaque_work() {
    let source = SOURCE.replace("ENDSEC;END-ISO-10303-21;",
        "#87=IFCBOOLEANRESULT(.XOR.,#13,$);ENDSEC;END-ISO-10303-21;");
    let mut decoder = EntityDecoder::new(&source);
    let mut router = router(&mut decoder);
    let hooks = Rc::new(Cell::new(0));
    router.register(Box::new(OpaqueRecorder { pending: RefCell::new(Vec::new()),
        record_next: Rc::new(Cell::new(true)), stop_next: Cell::new(false),
        panic_next: Cell::new(true), hooks: hooks.clone() }));
    let failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        router.with_product_csg_scope(|| {
            assert!(router.take_csg_failures_checked().unwrap().is_empty());
            assert_eq!(hooks.get(), 1, "the intermediate drain completed");
            let item = decoder.decode_by_id(13).unwrap();
            let _ = router.process_representation_item(&item, &mut decoder);
        });
    }));
    assert!(failed.is_err());
    assert_eq!(hooks.get(), 1, "unwind must not replay the intermediate hook");
    router.with_product_csg_scope(|| {
        assert!(router.finish_product_csg_failures().unwrap().is_empty(),
            "a retry drain falsely completed the failed product's opaque log");
    });
    let reports = router.take_csg_failures();
    assert_eq!(reports.values().map(Vec::len).sum::<usize>(), 1);
    assert!(router.take_csg_failures().is_empty());
}
