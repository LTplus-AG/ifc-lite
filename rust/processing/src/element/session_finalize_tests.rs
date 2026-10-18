// SPDX-License-Identifier: MPL-2.0
//! Final diagnostic callbacks retain restored ambient appearance and synchronous
//! nested-producer access, including unwind of the publication boundary.
use super::super::*;
use super::super::session::ProductState;
use super::super::session_tests::{Context, SOURCE, assert_same, canonical, job, metadata, options, router};
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::{BoolFailure, ExtrudedAreaSolidProcessor, GeometryProcessor, TessellationQuality};
use std::{cell::{Cell, RefCell}, rc::{Rc, Weak}};

struct FinalHook {
    router: Weak<GeometryRouter>,
    fired: Rc<Cell<bool>>,
    panic_final: Rc<Cell<bool>>,
    product_modes: Rc<RefCell<Vec<bool>>>,
    final_mode: Rc<Cell<Option<bool>>>,
    child: Rc<RefCell<Option<ProducedElementMeshes>>>,
}
impl GeometryProcessor for FinalHook {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcExtrudedAreaSolid] }
    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder, schema: &IfcSchema,
        quality: TessellationQuality) -> ifc_lite_geometry::Result<Mesh> {
        let router = self.router.upgrade().unwrap();
        let mode = router.set_preserve_triangle_order(true);
        router.set_preserve_triangle_order(mode);
        self.product_modes.borrow_mut().push(mode);
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity, decoder, schema, quality)
    }
    fn take_bool_failures(&self) -> Vec<BoolFailure> {
        // Nested final drains revisit this same registration. Only the first
        // reached callback initiates a child, as a real once-only extension can.
        if self.fired.replace(true) { return Vec::new(); }
        let router = self.router.upgrade().unwrap();
        let mode = router.set_preserve_triangle_order(true);
        router.set_preserve_triangle_order(mode);
        self.final_mode.set(Some(mode));
        if self.panic_final.get() { panic!("extension failed in final diagnostic drain"); }
        let mut decoder = EntityDecoder::new(SOURCE);
        decoder.seed_unit_scales(router.unit_scale(), 1.);
        let entity = decoder.decode_by_id(20).unwrap();
        let child = produce_element_meshes(&job(&entity, &metadata(20)), &Context::default().borrowed(),
            &options(), &mut decoder, &router);
        *self.child.borrow_mut() = Some(child);
        Vec::new()
    }
}
struct Fixture {
    decoder: EntityDecoder<'static>,
    router: Rc<GeometryRouter>,
    fired: Rc<Cell<bool>>,
    panic_final: Rc<Cell<bool>>,
    product_modes: Rc<RefCell<Vec<bool>>>,
    final_mode: Rc<Cell<Option<bool>>>,
    child: Rc<RefCell<Option<ProducedElementMeshes>>>,
}
impl Fixture {
    fn new() -> Self {
        let mut decoder = EntityDecoder::new(SOURCE);
        let mut base = router(&mut decoder);
        let fired = Rc::new(Cell::new(false));
        let panic_final = Rc::new(Cell::new(false));
        let product_modes = Rc::new(RefCell::new(Vec::new()));
        let final_mode = Rc::new(Cell::new(None));
        let child = Rc::new(RefCell::new(None));
        let router = Rc::new_cyclic(|weak| {
            base.register(Box::new(FinalHook { router: weak.clone(), fired: fired.clone(),
                panic_final: panic_final.clone(), product_modes: product_modes.clone(),
                final_mode: final_mode.clone(), child: child.clone() }));
            base
        });
        Self { decoder, router, fired, panic_final, product_modes, final_mode, child }
    }
    fn ready(&mut self) -> ProductState {
        let entity = self.decoder.decode_by_id(10).unwrap();
        let mut session = ProductState::new(&job(&entity, &metadata(10)),
            &Context::default().borrowed(), &options(), &mut self.decoder, &self.router);
        // Isolate the established mode-restoration contract from palette
        // discovery: numerical work runs with true; caller ambient stays false.
        session.keep_order = true;
        while session.advance(&Context::default().borrowed(), &mut self.decoder, &self.router) {}
        session
    }
}

#[test]
fn final_diagnostic_hook_can_produce_fresh_decoder_child_in_restored_caller_mode() {
    let mut fixture = Fixture::new();
    let session = fixture.ready();
    assert!(!fixture.fired.get(), "the final drain must remain after all numerical work");
    let wall = session.finish(&fixture.decoder, &fixture.router);
    assert_eq!(fixture.final_mode.get(), Some(false));
    assert_eq!(*fixture.product_modes.borrow(), vec![true, false]);
    let child = fixture.child.borrow_mut().take().expect("final hook published actual slab");
    assert_same(&wall, &canonical(10, false));
    assert_same(&child, &canonical(20, false));
    assert!((wall.geometry_volume.unwrap() - 24.).abs() < 1e-8);
    assert!((child.geometry_volume.unwrap() - 4.).abs() < 1e-8);
    fixture.router.try_execution_lease().expect("publication releases root reservation");
}

#[test]
fn final_diagnostic_hook_panic_restores_caller_state_and_releases_publication_owner() {
    let mut fixture = Fixture::new();
    fixture.panic_final.set(true);
    let session = fixture.ready();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(||
        session.finish(&fixture.decoder, &fixture.router)));
    assert!(result.is_err());
    assert_eq!(fixture.final_mode.get(), Some(false));
    assert!(fixture.child.borrow().is_none());
    assert!(!fixture.router.set_preserve_triangle_order(false));
    fixture.decoder.try_execution_lease().expect("panic releases decoder root");
    fixture.router.try_execution_lease().expect("panic releases router root");
    // The consumed session cannot publish or resume. A separate canonical
    // product can still use the same warm owners after the hook's once guard.
    let entity = fixture.decoder.decode_by_id(20).unwrap();
    let child = produce_element_meshes(&job(&entity, &metadata(20)), &Context::default().borrowed(),
        &options(), &mut fixture.decoder, &fixture.router);
    assert_same(&child, &canonical(20, false));
}
