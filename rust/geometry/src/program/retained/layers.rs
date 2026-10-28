// SPDX-License-Identifier: MPL-2.0
//! Two atomic admissions: N region constructions, then N host intersections.
use super::*;
use super::layer_family::{LayerCompletion, LayerSpec, ShapeLayer};
use super::failure::{CompletionReason, FailureSite, RetainedFailure};
use crate::program::inner::retained_program::RetainedProgramError as Protocol;
use ifc_lite_core::execution_owner::ExecutionIdentity;

pub(crate) struct LayerBands {
    pub(crate) selection: RetainedSelection,
    pub(crate) id: u64,
    host: RetainedProductPlan,
    spec: LayerSpec,
    regions: Vec<crate::document::RetainedPrism>,
    values: Vec<LogicalRetainedValue>,
    phase: u64,
    pending: Option<bool>,
    router: Option<ExecutionIdentity>,
    failure: Option<RetainedFailure>,
}
impl LayerBands {
    pub(crate) fn new(selection: RetainedSelection, id: u64, host: RetainedProductPlan, spec: LayerSpec)
        -> Result<Self, RetainedFailure> {
        if host.values.len() != 1 { return Err(RetainedFailure::LayerStrategy("layer_multi_part")); }
        let value = &host.values[0];
        if value.slot.program != selection.program() || value.evaluated_empty() != Some(false) {
            return Err(RetainedFailure::Completion(CompletionReason::Incomplete));
        }
        spec.interfaces(*value.object_frame()).map_err(RetainedFailure::LayerStrategy)?;
        let regions = super::layer_cutters::regions(value, &spec)
            .map_err(|e| selection.failure_handle().common(FailureSite::LayerBand, e))?;
        Ok(Self { selection, id, host, spec, regions, values: Vec::new(), phase: 0,
            pending: None, router: None, failure: None })
    }
    pub(crate) fn request(&mut self) -> Result<Option<u64>, Protocol> {
        if self.pending.is_some() { return Err(Protocol::Outstanding); }
        if self.phase >= 2 || self.failure.is_some() { return Ok(None); }
        self.pending = Some(false);
        Ok(Some(self.phase))
    }
    pub(crate) fn validate_ticket(&self, id: u64, seq: u64) -> Result<(), Protocol> {
        if id != self.id || seq != self.phase || self.pending.is_none() { return Err(Protocol::StaleRequest); }
        Ok(())
    }
    pub(crate) fn admit(&mut self, id: u64, seq: u64, router: &crate::GeometryRouter,
        decoder: &ifc_lite_core::EntityDecoder) -> Result<Vec<RetainedPlanOperation>, Protocol> {
        self.validate_ticket(id, seq)?;
        if self.pending == Some(true) { return Err(Protocol::AlreadyExecuted); }
        self.selection.validate_owner(decoder, router).map_err(|e| match e {
            crate::Error::ProgramStopped(stop) => Protocol::Stopped(stop), _ => Protocol::WrongOwner,
        })?;
        self.router = Some(router.execution_identity());
        self.selection.charge().map_err(Protocol::Stopped)?;
        let built = self.operations();
        self.pending = Some(true);
        match built {
            Ok(operations) => Ok(operations),
            Err(e) => {
                self.failure = Some(self.selection.failure_handle().common(FailureSite::LayerBand, e));
                Ok(Vec::new())
            }
        }
    }
    fn operations(&mut self) -> crate::Result<Vec<RetainedPlanOperation>> {
        let host = &self.host.values[0];
        let mut operations = Vec::new();
        crate::resource::reserve_headers(&mut operations, self.spec.layers.len())?.retain();
        if self.phase == 0 {
            for region in std::mem::take(&mut self.regions) { operations.push(cutter::prism_operation(host, region)?); }
        } else {
            for region in &self.values {
                let mut operation = boolean::boolean_operation([host.try_copy()?, region.try_copy()?], crate::BoolOp::Intersection)?;
                crate::resource::reserve_headers(&mut operation.value.presentation, host.presentation.len())?.retain();
                operation.value.presentation.extend_from_slice(&host.presentation);
                operation.value.product_placed = host.product_placed;
                operations.push(operation);
            }
        }
        let mut values = Vec::new();
        crate::resource::reserve_headers(&mut values, operations.len())?.retain();
        for operation in &operations { values.push(operation.value.try_copy()?); }
        self.values = values;
        Ok(operations)
    }
    pub(crate) fn validate_reply(&self, id: u64, seq: u64, router: &crate::GeometryRouter) -> Result<(), Protocol> {
        self.validate_ticket(id, seq)?;
        if self.router != Some(router.execution_identity()) { return Err(Protocol::WrongOwner); }
        if self.pending != Some(true) { return Err(Protocol::NotExecuted); }
        Ok(())
    }
    pub(crate) fn accept(&mut self) -> Result<(), Protocol> {
        if self.failure.is_none() && self.values.iter().any(|v| v.evaluated_empty().is_none()) { return Err(Protocol::NotExecuted); }
        self.pending = None;
        self.phase += 1;
        Ok(())
    }
    pub(crate) fn finish(mut self) -> Result<RetainedProductPlan, RetainedFailure> {
        if let Some(e) = self.failure { return Err(e); }
        if self.pending.is_some() || self.phase != 2 { return Err(RetainedFailure::Completion(CompletionReason::Incomplete)); }
        let count = self.values.iter().filter(|v| v.evaluated_empty() == Some(false)).count();
        if count == 0 { return Err(RetainedFailure::LayerEmpty); }
        if count >= 2 {
            let interfaces = self.spec.interfaces(*self.host.values[0].object_frame()).map_err(RetainedFailure::LayerStrategy)?;
            let mut tags = Vec::new();
            let mut bands = Vec::new();
            for (index, value) in self.values.into_iter().enumerate() {
                if value.evaluated_empty() == Some(true) { continue; }
                tags.push(ShapeLayer { index: index as u16, material_id: self.spec.layers[index].0 });
                bands.push(value);
            }
            self.host.values = bands;
            self.host.layers = Some(LayerCompletion { tags, interfaces });
        }
        // Publication must still run cap removal atomically for layered plans.
        self.host.remaining.retain(|r| *r != RetainedRequirement::MaterialLayers);
        Ok(self.host)
    }
}
