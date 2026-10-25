// SPDX-License-Identifier: MPL-2.0
//! #8091: an exposed recorder is not an exhaustive custom-storage contract.
use super::*;
use crate::element::session_tests::{leaked_job, options, router, Context, SOURCE};
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::resource::{self, ProgramStop};
use ifc_lite_geometry::{BooleanClippingProcessor, BoolFailure, ExtrudedAreaSolidProcessor,
    GeometryProcessor, TessellationQuality};
use std::{cell::{Cell, RefCell}, rc::Rc};

fn source() -> String {
    SOURCE.replace("ENDSEC;END-ISO-10303-21;", "#87=IFCBOOLEANRESULT(.XOR.,#13,$);
#90=IFCWALL('bool',$,'Boolean',$,$,#9,#91,$,$);
#91=IFCPRODUCTDEFINITIONSHAPE($,$,(#92));
#92=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#87));
ENDSEC;END-ISO-10303-21;")
}

fn unsupported_reports(decoder: &mut EntityDecoder, schema: &IfcSchema,
    quality: TessellationQuality) -> Vec<BoolFailure> {
    let recorder = BooleanClippingProcessor::new();
    let boolean = decoder.decode_by_id(87).unwrap();
    assert!(!recorder.process(&boolean, decoder, schema, quality).unwrap().is_empty());
    let reports = recorder.take_failures();
    assert_eq!(reports.len(), 1);
    reports
}

struct MixedRecorder {
    exposed: BooleanClippingProcessor,
    private: RefCell<Vec<BoolFailure>>,
    schema: IfcSchema,
    panic: bool,
    hooks: Rc<Cell<usize>>,
}
impl GeometryProcessor for MixedRecorder {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcBooleanResult] }
    fn boolean_recorder(&self) -> Option<&BooleanClippingProcessor> { Some(&self.exposed) }
    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        schema: &IfcSchema, quality: TessellationQuality) -> ifc_lite_geometry::Result<Mesh> {
        self.exposed.process(entity, decoder, schema, quality)
    }
    fn lower_owned(&self, _entity: &DecodedEntity, decoder: &mut EntityDecoder,
        quality: TessellationQuality, _rtc: Option<(f64, f64, f64)>)
        -> Option<ifc_lite_geometry::Result<ifc_lite_geometry::program::OwnedConstructor>> {
        self.private.borrow_mut().extend(unsupported_reports(decoder, &self.schema, quality));
        assert!(!self.panic, "mixed recorder unwind");
        resource::stop(ProgramStop::Cancelled);
        None
    }
    fn take_bool_failures(&self) -> Vec<BoolFailure> {
        self.hooks.set(self.hooks.get() + 1);
        let mut reports = std::mem::take(&mut *self.private.borrow_mut());
        reports.extend(self.exposed.take_failures());
        reports
    }
}

#[test]
fn issue_8091_exposed_recorder_does_not_scope_a_wrappers_private_log() {
    for panic in [false, true] {
        let source = source();
        let mut decoder = EntityDecoder::new(&source);
        let mut router = router(&mut decoder);
        let hooks = Rc::new(Cell::new(0));
        router.register(Box::new(MixedRecorder { exposed: BooleanClippingProcessor::new(),
            private: RefCell::new(Vec::new()), schema: router.schema().clone(), panic, hooks: hooks.clone() }));
        let failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let job = leaked_job(&mut decoder, 90);
            produce_element_meshes(job, &Context::default().borrowed(), &options(), &mut decoder, &router)
        }));
        if panic { assert!(failed.is_err()); } else { assert!(failed.unwrap().meshes.is_empty()); }
        assert_eq!(hooks.get(), 0, "stop/unwind runs no final callback");
        let next = leaked_job(&mut decoder, 10);
        let next = produce_element_meshes(next, &Context::default().borrowed(), &options(), &mut decoder, &router);
        assert!(!next.meshes.is_empty());
        assert!(next.csg_failures.is_empty(), "successor stole the wrapper's private report");
        let reports = router.take_csg_failures();
        assert_eq!(reports.values().map(Vec::len).sum::<usize>(), 1);
        assert!(router.take_csg_failures().is_empty());
    }
}

struct TwoDrains { private: RefCell<Vec<BoolFailure>>, calls: Cell<usize> }
impl GeometryProcessor for TwoDrains {
    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcExtrudedAreaSolid, IfcType::IfcExtrudedAreaSolidTapered]
    }
    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        schema: &IfcSchema, quality: TessellationQuality) -> ifc_lite_geometry::Result<Mesh> {
        let mesh = ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity, decoder, schema, quality)?;
        self.private.borrow_mut().extend(unsupported_reports(decoder, schema, quality));
        Ok(mesh)
    }
    fn take_bool_failures(&self) -> Vec<BoolFailure> {
        self.calls.set(self.calls.get() + 1);
        assert_ne!(self.calls.get(), 2, "later final callback unwinds");
        std::mem::take(&mut *self.private.borrow_mut())
    }
}

#[test]
fn issue_8091_later_callback_unwind_preserves_already_drained_reports() {
    let source = source();
    let mut decoder = EntityDecoder::new(&source);
    let mut router = router(&mut decoder);
    // One registered instance is visited for each supported type. Its first
    // drain returns the real failure; its later drain deliberately unwinds.
    router.register(Box::new(TwoDrains { private: RefCell::new(Vec::new()), calls: Cell::new(0) }));
    let failed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let job = leaked_job(&mut decoder, 10);
        produce_element_meshes(job, &Context::default().borrowed(), &options(), &mut decoder, &router)
    }));
    assert!(failed.is_err());
    let reports = router.take_csg_failures();
    assert_eq!(reports.values().map(Vec::len).sum::<usize>(), 1,
        "a later callback discarded the already-returned report");
    assert!(router.take_csg_failures().is_empty());
}
