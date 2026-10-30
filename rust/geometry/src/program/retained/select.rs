// SPDX-License-Identifier: MPL-2.0
use super::RetainedContract;
#[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
use super::RetainedPlanOperation;
use crate::GeometryRouter;
#[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
use crate::Result;
use ifc_lite_core::{DecodedEntity, EntityDecoder};
#[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
#[derive(Clone)]
pub(crate) struct RetainedSelection(std::sync::Arc<SelectionInner>, std::sync::Arc<Vec<u32>>);
#[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
struct SelectionInner {
    contract: RetainedContract,
    program: u64,
    walk: std::sync::Arc<super::walk::RetainedWalk>,
    cache: super::cache::RetainedCache,
}
#[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
#[derive(Clone)]
pub(crate) enum RetainedSelection {}
/// A controller's retained state, boxed out of the controller's inline layout.
/// On the default wasm engine no retained state can exist (`RetainedSelection`
/// is uninhabited), so the slot holds the zero-sized uninhabited [`Absent`]:
/// it is a constant `None`, and the optimizer drops every retained branch from
/// the shipped bundle instead of carrying it as dead weight.
#[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
pub(crate) type RetainedSlot<T> = Option<Box<T>>;
#[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
pub(crate) type RetainedSlot<T> = Option<Absent<T>>;
/// Uninhabited and zero-sized for any `T`, unlike a struct holding a
/// `RetainedSelection` beside sized fields (which stays a live enum variant).
#[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
pub(crate) enum Absent<T> {
    #[allow(dead_code)] // never constructed: that is the point
    Never(std::convert::Infallible, std::marker::PhantomData<T>),
}
#[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
impl<T> std::ops::Deref for Absent<T> {
    type Target = T;
    fn deref(&self) -> &T {
        match self { Self::Never(never, _) => match *never {} }
    }
}
#[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
impl<T> std::ops::DerefMut for Absent<T> {
    fn deref_mut(&mut self) -> &mut T {
        match self { Self::Never(never, _) => match *never {} }
    }
}
impl RetainedSelection {
    pub(in crate::program) fn failure_handle(&self) -> super::failure::FailureHandle {
        #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
        { super::failure::FailureHandle::new(self.0.walk.clone()) }
        #[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
        { match *self {} }
    }
    pub(in crate::program) fn new(contract: RetainedContract, program: u64) -> Option<Self> {
        #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
        {
            Some(Self(std::sync::Arc::new(SelectionInner {
                contract,
                program,
                walk: std::sync::Arc::new(super::walk::RetainedWalk::new()),
                cache: super::cache::RetainedCache::default(),
            }), std::sync::Arc::new(Vec::new())))
        }
        #[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
        {
            let _ = (contract, program);
            None
        }
    }
    pub(in crate::program) fn for_root(&self) -> Self {
        #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
        { Self(std::sync::Arc::new(SelectionInner {
            contract: self.0.contract, program: self.0.program,
            walk: self.0.walk.clone(), cache: self.0.cache.for_root(),
        }), std::sync::Arc::new(Vec::new())) }
        #[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
        { match *self {} }
    }
    pub(in crate::program) fn program(&self) -> u64 {
        #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
        {
            self.0.program
        }
        #[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
        {
            match *self {}
        }
    }
    pub(in crate::program) fn execute(
        &self,
        item: &DecodedEntity,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder,
    ) -> crate::program::item::ItemStep {
        #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
        {
            use crate::program::item::ItemStep;
            if matches!(item.ifc_type, ifc_lite_core::IfcType::IfcBooleanResult | ifc_lite_core::IfcType::IfcBooleanClippingResult | ifc_lite_core::IfcType::IfcCsgSolid)
                && router.processor_origin(&item.ifc_type) == Some(crate::router::ProcessorOrigin::Builtin) {
                return match self.nested_boolean(item.id).and_then(|selection|
                    crate::program::boolean::BooleanMachine::new_retained(item, router.tessellation_quality(), selection)) {
                    Ok(machine) => ItemStep::Boolean { machine, reports: Default::default() },
                    Err(error) => ItemStep::RetainedComplete(Err(error), self.clone()),
                };
            }
            match self.capture(item, router, decoder) {
                Ok(operation) => ItemStep::RetainedReady(Box::new(operation), self.clone()),
                Err(error) => ItemStep::RetainedComplete(Err(error), self.clone()),
            }
        }
        #[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
        {
            let _ = (item, router, decoder);
            match *self {}
        }
    }
    // A mapped operand can re-enter the Boolean controller. Carry its Boolean
    // ancestry across that boundary: local mapping/operand sets alone cannot
    // see a mixed cycle or bound the native call stack of nested controllers.
    #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
    fn nested_boolean(&self, id: u32) -> Result<Self> {
        self.0.walk.enter(id, &self.1)?;
        let mut path = Vec::new();
        crate::resource::reserve_headers(&mut path, self.1.len() + 1)?.retain();
        path.extend(self.1.iter().copied());
        path.push(id);
        crate::resource::charge(crate::resource::Cost {
            live_bytes: (std::mem::size_of::<Vec<u32>>() + 2 * std::mem::size_of::<usize>()) as u64,
            ..Default::default()
        })?.retain();
        Ok(Self(self.0.clone(), std::sync::Arc::new(path)))
    }
    #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
    pub(in crate::program) fn capture(
        &self,
        item: &DecodedEntity,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder,
    ) -> Result<RetainedPlanOperation> {
        let processor = router.processor_origin(&item.ifc_type);
        if processor != Some(crate::router::ProcessorOrigin::Builtin)
        {
            self.failure_handle().record(super::failure::FailureSite::Constructor, Some(item.id),
                super::failure::OriginCause::Processor(processor));
            return Err(crate::Error::geometry(
                "retained custom processor unsupported",
            ));
        }
        super::capture::capture(
            item,
            decoder,
            router.unit_scale(),
            self.0.contract,
            self.0.program,
            &self.failure_handle(),
        )
    }
}

impl RetainedSelection {
    pub(in crate::program) fn validate_owner(&self, decoder: &EntityDecoder, router: &GeometryRouter) -> crate::Result<()> {
        #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
        { self.0.cache.validate_owner(decoder.execution_identity(),router.execution_identity()) }
        #[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
        { let _ = (decoder,router); match *self {} }
    }
    pub(in crate::program) fn check(&self) -> std::result::Result<(), crate::resource::ProgramStop> {
        #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
        { self.0.walk.check() }
        #[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
        { match *self {} }
    }
    pub(in crate::program) fn remember_stop(&self, stop: crate::resource::ProgramStop) -> crate::resource::ProgramStop {
        #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
        { self.0.walk.remember(stop) }
        #[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
        { let _ = stop; match *self {} }
    }
    pub(in crate::program) fn refuse_bound(&self, requested: u64) -> crate::resource::ProgramStop {
        #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
        { self.0.walk.refuse(requested) }
        #[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
        { let _ = requested; match *self {} }
    }
    pub(in crate::program) fn charge(&self) -> std::result::Result<(), crate::resource::ProgramStop> {
        self.charge_work(1)
    }
    pub(in crate::program) fn charge_work(&self, work: u64) -> std::result::Result<(), crate::resource::ProgramStop> {
        #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
        { self.0.walk.charge(work) }
        #[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
        { let _ = work; match *self {} }
    }
    pub(in crate::program) fn enter(&self, id: u32, path: &[u32]) -> crate::Result<()> {
        #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
        { self.0.walk.enter(id, path).map_err(Into::into) }
        #[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
        { let _ = (id, path); match *self {} }
    }
    pub(in crate::program) fn cached(&self, decoder: &EntityDecoder, router: &GeometryRouter,
        source: u32) -> crate::Result<Option<Vec<super::LogicalRetainedValue>>> {
        #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
        { self.0.cache.admit(decoder.execution_identity(), router.execution_identity(), source, &self.0.walk) }
        #[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
        { let _ = (decoder, router, source); match *self {} }
    }
    pub(in crate::program) fn publish(&self, source: u32,
        values: &[super::LogicalRetainedValue]) -> crate::Result<()> {
        #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
        { self.0.cache.publish(source, values, &self.0.walk) }
        #[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
        { let _ = (source, values); match *self {} }
    }
    #[cfg(all(test, any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
    pub(in crate::program) fn set_work_limit(&self, limit: u64) { self.0.walk.set_limit(limit); }
}
