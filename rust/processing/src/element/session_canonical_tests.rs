// SPDX-License-Identifier: MPL-2.0
//! The canonical producer preserves synchronous nested custom producers on the
//! same, mixed or ancestor owners without admitting an independently
//! interleaved sibling continuation.
use super::session::ProductState;
use super::session_protocol::{WorkError, WorkRequest};
use super::session_tests::{assert_same, canonical, complete, leaked_job, options, router, Context, SOURCE};
use super::*;
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::{ExtrudedAreaSolidProcessor, GeometryProcessor, TessellationQuality};
use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
};

#[derive(Clone, Copy)]
enum Owners {
    Shared,
    FreshRouter,
    FreshDecoder,
    BusyFreshRouter,
    BusyFreshDecoder,
}

type Dormant = Rc<RefCell<Option<(ProductState<'static>, WorkRequest)>>>;
struct NestedExtrusion {
    router: Weak<GeometryRouter>,
    child: Rc<RefCell<Option<ProducedElementMeshes>>>,
    calls: Rc<Cell<usize>>,
    sibling: Dormant,
    panic_child: Rc<Cell<bool>>,
    owners: Owners,
}
impl GeometryProcessor for NestedExtrusion {
    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcExtrudedAreaSolid]
    }
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> ifc_lite_geometry::Result<Mesh> {
        self.calls.set(self.calls.get() + 1);
        if entity.id == 23 && self.panic_child.get() {
            panic!("nested custom extrusion interrupted");
        }
        if entity.id == 13 {
            self.nested_child(decoder);
        }
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity, decoder, schema, quality)
    }
}
impl NestedExtrusion {
    fn nested_child(&self, decoder: &mut EntityDecoder) {
        let router = self.router.upgrade().unwrap();
        // Lexical child authority cannot turn ordinary owner acquisition or an
        // independent resumable sibling into reentrant admission.
        assert!(decoder.try_execution_lease().is_err());
        assert!(router.try_execution_lease().is_err());
        if let Some((sibling, request)) = self.sibling.borrow_mut().as_mut() {
            let calls = self.calls.get();
            assert_eq!(
                sibling.execute(*request, &Context::default().borrowed(), decoder, &router).err(),
                Some(WorkError::OwnerBusy)
            );
            assert_eq!(self.calls.get(), calls);
            assert!(sibling.meshes.is_empty());
            assert!(sibling.hasher.as_ref().unwrap().is_empty());
        }
        // Legitimate mutable-decoder maintenance inside the outer work changes
        // generation before the lexical child is admitted.
        decoder.clear_entity_cache();
        let scale = decoder.length_unit_scale();
        decoder.seed_unit_scales(scale, 1.);
        let job = leaked_job(decoder, 20);
        let ctx = Context::default();
        let result = match self.owners {
            Owners::Shared => produce_element_meshes(job, &ctx.borrowed(), &options(), decoder, &router),
            Owners::FreshRouter | Owners::BusyFreshRouter => {
                // A fresh built-in router avoids recursing through this
                // extension while reusing the actual parent decoder.
                let child_router = super::session_tests::router(decoder);
                let _busy = matches!(self.owners, Owners::BusyFreshRouter)
                    .then(|| child_router.try_execution_lease().unwrap());
                produce_element_meshes(job, &ctx.borrowed(), &options(), decoder, &child_router)
            }
            Owners::FreshDecoder | Owners::BusyFreshDecoder => {
                let mut child_decoder = EntityDecoder::new(SOURCE);
                child_decoder.seed_unit_scales(router.unit_scale(), 1.);
                let _busy = matches!(self.owners, Owners::BusyFreshDecoder)
                    .then(|| child_decoder.try_execution_lease().unwrap());
                produce_element_meshes(job, &ctx.borrowed(), &options(), &mut child_decoder, &router)
            }
        };
        *self.child.borrow_mut() = Some(result);
    }
}
struct Fixture {
    decoder: EntityDecoder<'static>,
    router: Rc<GeometryRouter>,
    child: Rc<RefCell<Option<ProducedElementMeshes>>>,
    calls: Rc<Cell<usize>>,
    sibling: Dormant,
    panic_child: Rc<Cell<bool>>,
}
impl Fixture {
    fn new() -> Self {
        Self::with_owners(Owners::Shared)
    }
    fn with_owners(owners: Owners) -> Self {
        let mut decoder = EntityDecoder::new(SOURCE);
        let mut geometry_router = router(&mut decoder);
        let child = Rc::new(RefCell::new(None));
        let calls = Rc::new(Cell::new(0));
        let sibling = Rc::new(RefCell::new(None));
        let panic_child = Rc::new(Cell::new(false));
        let router = Rc::new_cyclic(|router| {
            geometry_router.register(Box::new(NestedExtrusion {
                router: router.clone(),
                child: child.clone(),
                calls: calls.clone(),
                sibling: sibling.clone(),
                panic_child: panic_child.clone(),
                owners,
            }));
            geometry_router
        });
        Self { decoder, router, child, calls, sibling, panic_child }
    }
    fn produce_wall(&mut self) -> ProducedElementMeshes {
        let job = leaked_job(&mut self.decoder, 10);
        produce_element_meshes(job, &Context::default().borrowed(), &options(), &mut self.decoder, &self.router)
    }
}
fn assert_released(fixture: &Fixture) {
    let decoder = fixture.decoder.try_execution_lease().expect("root decoder released");
    let router = fixture.router.try_execution_lease().expect("root router released");
    drop((decoder, router));
}

#[test]
fn canonical_nested_product_preserves_geometry_style_metadata_and_hash_while_sibling_remains_exclusive() {
    let mut fixture = Fixture::new();
    let sibling_job = leaked_job(&mut fixture.decoder, 50);
    let ctx = Context::default();
    let mut execution =
        ProductState::new(sibling_job, &ctx.borrowed(), &options(), &mut fixture.decoder, &fixture.router).unwrap();
    let request = execution.request().unwrap().unwrap();
    *fixture.sibling.borrow_mut() = Some((execution, request));
    let wall = fixture.produce_wall();
    assert_eq!(fixture.calls.get(), 2, "both actual extrusion callbacks must execute");
    let child = fixture.child.borrow_mut().take().expect("nested canonical slab completed");
    assert_same(&wall, &canonical(10, false));
    assert_same(&child, &canonical(20, false));
    assert!((wall.geometry_volume.unwrap() - 24.).abs() < 1e-5);
    assert!((child.geometry_volume.unwrap() - 4.).abs() < 1e-5);
    assert_ne!(wall.geometry_hash, child.geometry_hash);
    assert_ne!(wall.meshes[0].color, child.meshes[0].color);
    // Completion releases the root lease. The rejected sibling's original
    // request remains usable, so no planning/geometry is silently discarded.
    let (mut sibling, request) = fixture.sibling.borrow_mut().take().unwrap();
    let reply = sibling.execute(request, &ctx.borrowed(), &mut fixture.decoder, &fixture.router).unwrap();
    sibling.accept(reply, &ctx.borrowed(), &mut fixture.decoder, &fixture.router).unwrap();
    let produced = complete(sibling, &ctx.borrowed(), &mut fixture.decoder, &fixture.router);
    assert_same(&produced, &canonical(50, false));
}

#[test]
fn nested_custom_panic_releases_ancestor_reservation_and_restores_lexical_admission() {
    let mut fixture = Fixture::new();
    fixture.panic_child.set(true);
    let interrupted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| fixture.produce_wall()));
    assert!(interrupted.is_err());
    assert_eq!(fixture.calls.get(), 2, "panic happened inside the real nested callback");
    assert!(fixture.child.borrow().is_none(), "interrupted child never published");
    // Both reservations and the lexical capability must unwind. A fresh
    // canonical root on those same owners can construct both products again.
    assert_released(&fixture);
    fixture.panic_child.set(false);
    let wall = fixture.produce_wall();
    assert_same(&wall, &canonical(10, false));
    let child = fixture.child.borrow_mut().take().expect("nested canonical retry completed");
    assert_same(&child, &canonical(20, false));
}

#[test]
fn canonical_nested_product_accepts_one_fresh_compatible_owner_without_losing_geometry() {
    for owners in [Owners::FreshRouter, Owners::FreshDecoder] {
        let mut fixture = Fixture::with_owners(owners);
        let wall = fixture.produce_wall();
        let child = fixture.child.borrow_mut().take().expect("mixed owner child completed");
        assert_same(&wall, &canonical(10, false));
        assert_same(&child, &canonical(20, false));
        assert!((wall.geometry_volume.unwrap() - 24.).abs() < 1e-5);
        assert!((child.geometry_volume.unwrap() - 4.).abs() < 1e-5);
        let expected = if matches!(owners, Owners::FreshRouter) { 1 } else { 2 };
        assert_eq!(fixture.calls.get(), expected, "fresh built-in router bypasses custom override");
        assert_released(&fixture);
    }
}

#[test]
fn canonical_nested_product_never_borrows_an_independent_half_reserved_by_another_product() {
    for owners in [Owners::BusyFreshRouter, Owners::BusyFreshDecoder] {
        let mut fixture = Fixture::with_owners(owners);
        let wall = fixture.produce_wall();
        // The parent still publishes; the refused child publishes nothing.
        assert_same(&wall, &canonical(10, false));
        let child = fixture.child.borrow_mut().take().expect("refused child returned");
        assert!(child.meshes.is_empty() && child.geometry_hash.is_none(), "occupied owner was admitted");
        assert_eq!(fixture.calls.get(), 1, "child work must be rejected before a custom callback");
        assert_released(&fixture);
    }
}

fn produce_fixture(id: u32, decoder: &mut EntityDecoder, router: &GeometryRouter) -> ProducedElementMeshes {
    let job = leaked_job(decoder, id);
    produce_element_meshes(job, &Context::default().borrowed(), &options(), decoder, router)
}
struct AncestorExtrusion {
    ancestor: Weak<GeometryRouter>,
    children: Rc<RefCell<Vec<ProducedElementMeshes>>>,
}
impl GeometryProcessor for AncestorExtrusion {
    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcExtrudedAreaSolid]
    }
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> ifc_lite_geometry::Result<Mesh> {
        match entity.id {
            13 => {
                // Both B owners are fresh. Their lexical frame must not hide
                // A's authority when B reaches back to the ancestor router.
                let mut child_decoder = EntityDecoder::new(SOURCE);
                let mut child_router = router(&mut child_decoder);
                child_router.register(Box::new(Self {
                    ancestor: self.ancestor.clone(),
                    children: self.children.clone(),
                }));
                let child = produce_fixture(20, &mut child_decoder, &child_router);
                self.children.borrow_mut().push(child);
            }
            23 => {
                // A's decoder is mutably borrowed by its paused callback; a
                // fresh decoder makes this composition safe ordinary Rust.
                let mut grand_decoder = EntityDecoder::new(SOURCE);
                let ancestor = self.ancestor.upgrade().unwrap();
                grand_decoder.seed_unit_scales(ancestor.unit_scale(), 1.);
                let grandchild = produce_fixture(50, &mut grand_decoder, &ancestor);
                self.children.borrow_mut().push(grandchild);
                assert!(ancestor.try_execution_lease().is_err(), "grandchild must not release A's root");
                assert!(decoder.try_execution_lease().is_err(), "B remains exclusive during its callback");
            }
            _ => {}
        }
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity, decoder, schema, quality)
    }
}

#[test]
fn canonical_grandchild_can_reuse_live_ancestor_hidden_by_independent_middle_product() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut geometry_router = router(&mut decoder);
    let children = Rc::new(RefCell::new(Vec::new()));
    let router = Rc::new_cyclic(|ancestor| {
        geometry_router.register(Box::new(AncestorExtrusion { ancestor: ancestor.clone(), children: children.clone() }));
        geometry_router
    });
    let wall = produce_fixture(10, &mut decoder, &router);
    let children = children.borrow();
    assert_eq!(children.len(), 2, "both nested products must actually execute");
    assert_same(&children[0], &canonical(50, false));
    assert_same(&children[1], &canonical(20, false));
    assert_same(&wall, &canonical(10, false));
    assert!((wall.geometry_volume.unwrap() - 24.).abs() < 1e-5);
    assert!((children[1].geometry_volume.unwrap() - 4.).abs() < 1e-5);
    let decoder_lease = decoder.try_execution_lease().expect("A decoder released after publication");
    let router_lease = router.try_execution_lease().expect("A router released after publication");
    drop((decoder_lease, router_lease));
}
