// SPDX-License-Identifier: MPL-2.0
use super::RetainedContract;
#[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
use super::RetainedPlanOperation;
use crate::GeometryRouter;
#[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
use crate::Result;
use ifc_lite_core::{DecodedEntity, EntityDecoder};
#[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
#[derive(Clone)]
pub(crate) struct RetainedSelection(std::sync::Arc<SelectionInner>);
#[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
struct SelectionInner {
    contract: RetainedContract,
    program: u64,
    walk: std::sync::Arc<super::walk::RetainedWalk>,
    cache: super::cache::RetainedCache,
}
#[cfg(all(target_arch = "wasm32", not(feature = "wasm_source_capture")))]
#[derive(Clone)]
pub(crate) enum RetainedSelection {}
impl RetainedSelection {
    pub(in crate::program) fn new(contract: RetainedContract, program: u64) -> Option<Self> {
        #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
        {
            Some(Self(std::sync::Arc::new(SelectionInner {
                contract,
                program,
                walk: std::sync::Arc::new(super::walk::RetainedWalk::new()),
                cache: super::cache::RetainedCache::default(),
            })))
        }
        #[cfg(all(target_arch = "wasm32", not(feature = "wasm_source_capture")))]
        {
            let _ = (contract, program);
            None
        }
    }
    pub(in crate::program) fn for_root(&self) -> Self {
        #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
        { Self(std::sync::Arc::new(SelectionInner {
            contract: self.0.contract, program: self.0.program,
            walk: self.0.walk.clone(), cache: self.0.cache.for_root(),
        })) }
        #[cfg(all(target_arch = "wasm32", not(feature = "wasm_source_capture")))]
        { match *self {} }
    }
    pub(in crate::program) fn program(&self) -> u64 {
        #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
        {
            self.0.program
        }
        #[cfg(all(target_arch = "wasm32", not(feature = "wasm_source_capture")))]
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
        #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
        {
            use crate::program::item::ItemStep;
            match self.capture(item, router, decoder) {
                Ok(operation) => ItemStep::RetainedReady(Box::new(operation), self.clone()),
                Err(error) => ItemStep::RetainedComplete(Err(error), self.clone()),
            }
        }
        #[cfg(all(target_arch = "wasm32", not(feature = "wasm_source_capture")))]
        {
            let _ = (item, router, decoder);
            match *self {}
        }
    }
    #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
    fn capture(
        &self,
        item: &DecodedEntity,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder,
    ) -> Result<RetainedPlanOperation> {
        if router.processor_origin(&item.ifc_type) != Some(crate::router::ProcessorOrigin::Builtin)
        {
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
        )
    }
}

impl RetainedSelection {
    pub(in crate::program) fn validate_owner(&self, decoder: &EntityDecoder, router: &GeometryRouter) -> crate::Result<()> {
        #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
        { self.0.cache.validate_owner(decoder.execution_identity(),router.execution_identity()) }
        #[cfg(all(target_arch = "wasm32", not(feature = "wasm_source_capture")))]
        { let _ = (decoder,router); match *self {} }
    }
    pub(in crate::program) fn check(&self) -> std::result::Result<(), crate::resource::ProgramStop> {
        #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
        { self.0.walk.check() }
        #[cfg(all(target_arch = "wasm32", not(feature = "wasm_source_capture")))]
        { match *self {} }
    }
    pub(in crate::program) fn charge(&self) -> std::result::Result<(), crate::resource::ProgramStop> {
        self.charge_work(1)
    }
    pub(in crate::program) fn charge_work(&self, work: u64) -> std::result::Result<(), crate::resource::ProgramStop> {
        #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
        { self.0.walk.charge(work) }
        #[cfg(all(target_arch = "wasm32", not(feature = "wasm_source_capture")))]
        { let _ = work; match *self {} }
    }
    pub(in crate::program) fn enter(&self, id: u32, path: &[u32]) -> crate::Result<()> {
        #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
        { self.0.walk.enter(id, path).map_err(Into::into) }
        #[cfg(all(target_arch = "wasm32", not(feature = "wasm_source_capture")))]
        { let _ = (id, path); match *self {} }
    }
    pub(in crate::program) fn cached(&self, decoder: &EntityDecoder, router: &GeometryRouter,
        source: u32) -> crate::Result<Option<Vec<super::LogicalRetainedValue>>> {
        #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
        { self.0.cache.admit(decoder.execution_identity(), router.execution_identity(), source, &self.0.walk) }
        #[cfg(all(target_arch = "wasm32", not(feature = "wasm_source_capture")))]
        { let _ = (decoder, router, source); match *self {} }
    }
    pub(in crate::program) fn publish(&self, source: u32,
        values: &[super::LogicalRetainedValue]) -> crate::Result<()> {
        #[cfg(any(not(target_arch = "wasm32"), feature = "wasm_source_capture"))]
        { self.0.cache.publish(source, values, &self.0.walk) }
        #[cfg(all(target_arch = "wasm32", not(feature = "wasm_source_capture")))]
        { let _ = (source, values); match *self {} }
    }
    #[cfg(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")))]
    pub(in crate::program) fn set_work_limit(&self, limit: u64) { self.0.walk.set_limit(limit); }
}
