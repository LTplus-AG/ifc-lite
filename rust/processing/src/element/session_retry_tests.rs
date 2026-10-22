// SPDX-License-Identifier: MPL-2.0
//! The strategy-retry drain runs every registered processor's drain hook, so
//! it executes inside the product's owner epoch: a hook that produces a
//! canonical child on the same router keeps its child's geometry.
use super::session_tests::{assert_same, canonical, leaked_job, options, router, Context, SOURCE};
use super::*;
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::{BoolFailure, ExtrudedAreaSolidProcessor, GeometryProcessor, TessellationQuality};
use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
};

/// Fails the wall's first extrusion so the primary strategy is abandoned for
/// the voids fallback, and produces slab 20 from its first drain hook.
struct RetryThenChild {
    router: Weak<GeometryRouter>,
    calls: Rc<Cell<usize>>,
    calls_at_drain: Rc<Cell<Option<usize>>>,
    child: Rc<RefCell<Option<ProducedElementMeshes>>>,
}
impl GeometryProcessor for RetryThenChild {
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
        if self.calls.get() == 1 {
            return Err(ifc_lite_geometry::Error::geometry("first attempt refused"));
        }
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity, decoder, schema, quality)
    }
    fn take_bool_failures(&self) -> Vec<BoolFailure> {
        // Only the first drain that happens after the failed attempt produces
        // a child, as a real once-only extension can.
        if self.calls.get() == 0 || self.calls_at_drain.get().is_some() {
            return Vec::new();
        }
        self.calls_at_drain.set(Some(self.calls.get()));
        let router = self.router.upgrade().unwrap();
        let mut decoder = EntityDecoder::new(SOURCE);
        decoder.seed_unit_scales(router.unit_scale(), 1.);
        let job = leaked_job(&mut decoder, 20);
        let child = produce_element_meshes(job, &Context::default().borrowed(), &options(), &mut decoder, &router);
        *self.child.borrow_mut() = Some(child);
        Vec::new()
    }
}

#[test]
fn retry_drain_hook_keeps_a_nested_child_on_the_same_router() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut base = router(&mut decoder);
    let calls = Rc::new(Cell::new(0));
    let calls_at_drain = Rc::new(Cell::new(None));
    let child = Rc::new(RefCell::new(None));
    let router = Rc::new_cyclic(|weak| {
        base.register(Box::new(RetryThenChild {
            router: weak.clone(),
            calls: calls.clone(),
            calls_at_drain: calls_at_drain.clone(),
            child: child.clone(),
        }));
        base
    });
    let job = leaked_job(&mut decoder, 10);
    let wall = produce_element_meshes(job, &Context::default().borrowed(), &options(), &mut decoder, &router);
    assert!(calls.get() >= 2, "the first attempt was refused and the product retried");
    assert_eq!(
        calls_at_drain.get(),
        Some(1),
        "the hook ran at the retry drain, after the refused attempt and before the next strategy"
    );
    let child = child.borrow_mut().take().expect("the drain hook produced its child");
    assert_same(&child, &canonical(20, false));
    assert!((child.geometry_volume.unwrap() - 4.).abs() < 1e-5);
    assert!(!wall.meshes.is_empty(), "the retried wall still publishes");
    assert!(decoder.try_execution_lease().is_ok() && router.try_execution_lease().is_ok());
}
