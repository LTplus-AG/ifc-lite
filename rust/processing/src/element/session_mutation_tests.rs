// SPDX-License-Identifier: MPL-2.0
//! Trusted callbacks retain the existing mutable-decoder contract; external
//! pending-work changes and owner replacement remain admission failures.
use super::super::*;
use super::super::session::ProductState;
use super::super::session_protocol::WorkError;
use super::super::session_tests::{Context, SOURCE, assert_same, canonical, job, metadata, options, router};
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::{ExtrudedAreaSolidProcessor, GeometryProcessor, TessellationQuality};
use std::{cell::Cell, panic::{catch_unwind, AssertUnwindSafe}, rc::Rc};

#[derive(Clone, Copy)]
enum Mutation { CacheAndUnits, Replace, Panic }
struct MutatingExtrusion { mode: Mutation, calls: Rc<Cell<usize>> }
impl GeometryProcessor for MutatingExtrusion {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcExtrudedAreaSolid] }
    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        schema: &IfcSchema, quality: TessellationQuality) -> ifc_lite_geometry::Result<Mesh> {
        self.calls.set(self.calls.get() + 1);
        // Both calls were legal inside the existing mutable-decoder extension.
        // Clearing memoization and reseeding equal units do not change the solid.
        decoder.clear_entity_cache();
        let scale = decoder.length_unit_scale();
        decoder.seed_unit_scales(scale, 1.);
        match self.mode {
            Mutation::Replace => *decoder = EntityDecoder::new(SOURCE),
            Mutation::Panic => panic!("registered constructor failed after cache maintenance"),
            Mutation::CacheAndUnits => {}
        }
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity, decoder, schema, quality)
    }
}
struct Harness {
    decoder: EntityDecoder<'static>,
    router: GeometryRouter,
    context: Context,
    calls: Rc<Cell<usize>>,
}
impl Harness {
    fn new(mode: Mutation) -> Self {
        let mut decoder = EntityDecoder::new(SOURCE);
        let mut router = router(&mut decoder);
        let calls = Rc::new(Cell::new(0));
        router.register(Box::new(MutatingExtrusion { mode, calls: calls.clone() }));
        Self { decoder, router, context: Context::default(), calls }
    }
    fn session(&mut self) -> ProductState {
        let entity = self.decoder.decode_by_id(10).unwrap();
        ProductState::new(&job(&entity, &metadata(10)), &self.context.borrowed(), &options(),
            &mut self.decoder, &self.router)
    }
}

#[test]
fn registered_constructor_can_clear_cache_and_reseed_equal_units_without_losing_geometry() {
    let mut h = Harness::new(Mutation::CacheAndUnits);
    let mut session = h.session();
    let request = session.request().unwrap().unwrap();
    let before = h.decoder.execution_identity();
    let reply = session.execute(request, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    assert_ne!(h.decoder.execution_identity(), before, "real decoder maintenance changed its generation");
    assert_eq!(h.calls.get(), 1);
    assert!(session.meshes.is_empty(), "geometry remains unassembled until acceptance");
    session.accept(reply, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    while session.advance(&h.context.borrowed(), &mut h.decoder, &h.router) {}
    let produced = session.finish(&h.decoder, &h.router);
    assert_same(&produced, &canonical(10, false));
    assert!((produced.geometry_volume.unwrap() - 24.).abs() < 1e-8);
}

#[test]
fn external_cache_mutation_after_trusted_work_still_rejects_the_unconsumed_packet() {
    let mut h = Harness::new(Mutation::CacheAndUnits);
    let mut session = h.session();
    let request = session.request().unwrap().unwrap();
    let reply = session.execute(request, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap();
    h.decoder.clear_entity_cache();
    let rejected = session.accept(reply, &h.context.borrowed(), &mut h.decoder, &h.router).unwrap_err();
    assert_eq!(rejected.error, WorkError::WrongOwner);
    assert_eq!(rejected.reply.request, request);
    assert!(session.meshes.is_empty() && session.hasher.as_ref().unwrap().is_empty());
    assert_eq!(h.calls.get(), 1);
    drop(rejected);
    drop(session);
    h.decoder.try_execution_lease().expect("terminal drop releases reservation");
    h.router.try_execution_lease().expect("terminal drop releases router");
}

#[test]
fn replacing_decoder_inside_callback_is_terminal_and_cannot_re_admit_the_ticket() {
    let mut h = Harness::new(Mutation::Replace);
    let mut session = h.session();
    let request = session.request().unwrap().unwrap();
    assert_eq!(session.execute(request, &h.context.borrowed(), &mut h.decoder, &h.router).err(),
        Some(WorkError::WrongOwner));
    assert!(session.scopes.is_none(), "owner commit failure poisons execution");
    assert!(session.meshes.is_empty());
    assert!(catch_unwind(AssertUnwindSafe(|| session.request())).is_err());
    assert_eq!(h.calls.get(), 1, "a replacement cannot replay the old request");
}

#[test]
fn callback_panic_never_commits_owner_changes_and_cannot_publish_or_resume() {
    let mut h = Harness::new(Mutation::Panic);
    let mut session = h.session();
    let request = session.request().unwrap().unwrap();
    let panic = catch_unwind(AssertUnwindSafe(|| {
        let _ = session.execute(request, &h.context.borrowed(), &mut h.decoder, &h.router);
    }));
    assert!(panic.is_err());
    assert!(session.scopes.is_none());
    assert!(session.meshes.is_empty());
    assert!(catch_unwind(AssertUnwindSafe(|| session.request())).is_err());
    assert_eq!(h.calls.get(), 1);
    // The unwound work token releases admission; the poisoned session cannot
    // use that release to admit its still-outstanding request again.
    h.decoder.try_execution_lease().expect("panic releases its work owner");
    h.router.try_execution_lease().expect("panic releases its router owner");
}
