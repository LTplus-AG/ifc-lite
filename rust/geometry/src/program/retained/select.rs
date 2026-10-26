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
            })))
        }
        #[cfg(all(target_arch = "wasm32", not(feature = "wasm_source_capture")))]
        {
            let _ = (contract, program);
            None
        }
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
