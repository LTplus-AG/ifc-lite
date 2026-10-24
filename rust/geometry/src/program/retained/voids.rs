// SPDX-License-Identifier: MPL-2.0
//! Adapted from the retained opening traversal in 0468365905 (#7955).
//! Child products use the existing mapping/Boolean walk. No router effect is
//! published here: accepted Empty is provisional until terminal publication.
use super::*;
use crate::program::inner::{ProgramError, ProgramStage};
use crate::program::product::{ProductControl, ProductOutput, ProductReply};
use crate::{GeometryRouter, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

pub(in crate::program) enum VoidReply {
    Child(ProductReply),
    Selected(Result<Option<DecodedEntity>>),
    Cut(LogicalRetainedValue, RetainedOpeningCut),
}
impl VoidReply {
    pub(in crate::program) fn tag(&self) -> u8 {
        match self { Self::Child(r) => r.tag(), Self::Selected(_) => 80, Self::Cut(..) => 81 }
    }
}
pub(in crate::program) struct RetainedVoids<'a> {
    selection: RetainedSelection,
    product: u32,
    ids: &'a [u32],
    child: Option<Box<ProductControl<'a>>>,
    host_done: bool,
    selected: usize,
    cutters: Vec<Vec<LogicalRetainedValue>>,
    hosts: Vec<LogicalRetainedValue>,
    original: Vec<LogicalRetainedSlot>,
    part: usize,
    opening: usize,
    cutter: usize,
    cuts: Vec<RetainedOpeningCut>,
    empty_host: bool,
    result: Option<Result<ProductOutput>>,
}
impl<'a> RetainedVoids<'a> {
    pub(in crate::program) fn new(host: &'a DecodedEntity, ids: &'a [u32], selection: RetainedSelection) -> Result<Self> {
        crate::resource::charge(crate::resource::Cost { live_bytes: (std::mem::size_of::<Self>() + std::mem::size_of::<ProductControl>()) as u64, ..Default::default() })?.retain();
        let mut child = ProductControl::retained(host, selection.for_root());
        child.select_retained_styled(false, None);
        Ok(Self { child: Some(Box::new(child)), selection, product: host.id, ids,
            host_done: false, selected: 0, cutters: Vec::new(), hosts: Vec::new(),
            original: Vec::new(), part: 0, opening: 0, cutter: 0, cuts: Vec::new(),
            empty_host: false, result: None })
    }
    pub(in crate::program) fn selection(&self) -> &RetainedSelection { &self.selection }
    fn needs_source(&self) -> bool {
        self.part < self.hosts.len() && !self.hosts[self.part].is_empty()
            && self.opening >= self.cutters.len() && self.selected < self.ids.len()
    }
    pub(in crate::program) fn stage(&self) -> std::result::Result<Option<ProgramStage>, ProgramError> {
        if self.result.is_some() { return Ok(None); }
        if let Some(child) = &self.child { return child.stage(); }
        Ok(Some(if self.needs_source() {
            ProgramStage::Source
        } else { ProgramStage::Numerical }))
    }
    pub(in crate::program) fn retained_ready(&self) -> bool {
        self.child.as_ref().map_or(self.host_done && !self.needs_source(),
            |child| child.retained_ready())
    }
    pub(in crate::program) fn execute(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder)
        -> std::result::Result<VoidReply, ProgramError> {
        if let Some(child) = &mut self.child { return child.execute(router, decoder).map(VoidReply::Child); }
        let result = (|| {
            self.selection.charge().map_err(crate::Error::ProgramStopped)?;
            let id = *self.ids.get(self.selected).ok_or_else(|| crate::Error::geometry("opening cursor"))?;
            let entity = decoder.decode_by_id(id)?;
            if entity.id != id || !entity.ifc_type.is_subtype_of(IfcType::IfcOpeningElement) {
                return Err(crate::Error::geometry("malformed reached opening"));
            }
            if !router.opening_requires_subtraction(id, decoder) { return Ok(None); }
            crate::resource::check_current()?;
            super::opening_source::validate_opening_shape(&entity, decoder, &self.selection)?;
            Ok(Some(entity))
        })();
        // Preserve the stop as an error; an empty cutter list is not a refusal.
        Ok(VoidReply::Selected(result))
    }
    pub(in crate::program) fn admit(&mut self)
        -> std::result::Result<(VoidReply, Vec<RetainedPlanOperation>), ProgramError> {
        if let Some(child) = &mut self.child {
            return child.admit_retained().map(|(reply, ops)| (VoidReply::Child(reply), ops));
        }
        let result = self.next_cut();
        match result {
            Ok(Some((operation, cut))) => {
                let value = operation.value.try_copy().map_err(stop)?;
                let mut ops = Vec::new();
                crate::resource::reserve_headers(&mut ops, 1).map_err(ProgramError::TraversalStopped)?.retain();
                ops.push(operation);
                Ok((VoidReply::Cut(value, cut), ops))
            }
            Ok(None) => Err(ProgramError::StaleRequest),
            Err(error) => { let error = stop(error); Err(error) }
        }
    }
    fn next_cut(&mut self) -> Result<Option<(RetainedPlanOperation, RetainedOpeningCut)>> {
        self.advance()?;
        if self.result.is_some() { return Ok(None); }
        let left = self.hosts[self.part].try_copy()?;
        let right = self.cutters[self.opening][self.cutter].try_copy()?;
        let mut operation = boolean::boolean_operation([left, right], crate::BoolOp::Difference)?;
        // The output is already in the host's physical frame; preserve its
        // occurrence presentation, not the cutter's material or placement.
        operation.value.product_placed = true;
        operation.value.presentation = copy_values(&self.hosts[self.part..self.part+1])?
            .pop().expect("host").presentation;
        let RetainedOperationKind::Boolean { inputs, .. } = &operation.kind else { unreachable!() };
        let cut = RetainedOpeningCut { product: self.product, host_part: self.original[self.part],
            requested_opening: self.ids[self.opening], opening_ordinal: self.opening,
            cutter_ordinal: self.cutter, inputs: [inputs[0].try_copy()?, inputs[1].try_copy()?],
            output: operation.value.try_copy()? };
        Ok(Some((operation, cut)))
    }
    fn advance(&mut self) -> Result<()> {
        while self.part < self.hosts.len() {
            self.selection.charge().map_err(crate::Error::ProgramStopped)?;
            if !self.hosts[self.part].is_empty() && self.opening < self.ids.len() {
                if self.opening >= self.cutters.len() { return Ok(()); }
                if self.cutter < self.cutters[self.opening].len() { return Ok(()); }
                self.opening += 1; self.cutter = 0; continue;
            }
            self.part += 1; self.opening = 0; self.cutter = 0;
        }
        let completion = RetainedOpeningCompletion { product: self.product, related: self.ids.len(),
            cuts: std::mem::take(&mut self.cuts), empty_host: self.empty_host };
        self.result = Some(Ok(ProductOutput::RetainedVoided(std::mem::take(&mut self.hosts),
            self.selection.clone(), completion)));
        Ok(())
    }
    pub(in crate::program) fn accept(&mut self, reply: VoidReply, router: &GeometryRouter) {
        if let Err(error) = self.accept_inner(reply, router) { self.result = Some(Err(error)); }
    }
    fn accept_inner(&mut self, reply: VoidReply, router: &GeometryRouter) -> Result<()> {
        match reply {
            VoidReply::Child(reply) => {
                let child = self.child.as_mut().expect("opening child");
                child.accept(reply, router);
                if let Some(result) = child.take_result() {
                    let ProductOutput::Retained(values, _) = result? else {
                        return Err(crate::Error::geometry("opening child output"));
                    };
                    self.child = None;
                    if !self.host_done {
                        // A missing representation is not an authenticated Empty.
                        if values.is_empty() { return Err(crate::Error::geometry("missing retained host body")); }
                        self.empty_host = values.iter().all(LogicalRetainedValue::is_empty);
                        crate::resource::reserve_headers(&mut self.original, values.len())?.retain();
                        self.original.extend(values.iter().map(LogicalRetainedValue::slot));
                        self.hosts = values; self.host_done = true;
                    } else {
                        if values.is_empty() { return Err(crate::Error::geometry("missing reached opening body")); }
                        crate::resource::reserve_headers(&mut self.cutters, 1)?.retain();
                        self.cutters.push(values); self.selected += 1;
                    }
                }
            }
            VoidReply::Selected(result) => match result? {
                Some(entity) => {
                    crate::resource::charge(crate::resource::Cost { live_bytes: std::mem::size_of::<ProductControl>() as u64, ..Default::default() })?.retain();
                    self.child = Some(Box::new(ProductControl::retained_owned(entity, self.selection.for_root())));
                }
                None => {
                    crate::resource::reserve_headers(&mut self.cutters, 1)?.retain();
                    self.cutters.push(Vec::new()); self.selected += 1;
                }
            },
            VoidReply::Cut(value, cut) => {
                if value.evaluated_empty().is_none() { return Err(crate::Error::geometry("unauthenticated opening outcome")); }
                crate::resource::reserve_headers(&mut self.cuts, 1)?.retain();
                self.cuts.push(cut);
                self.hosts[self.part] = value; self.cutter += 1;
            }
        }
        if self.child.is_none() && self.host_done && !self.needs_source() {
            self.advance()?;
        }
        Ok(())
    }
    pub(in crate::program) fn take_result(&mut self) -> Option<Result<ProductOutput>> { self.result.take() }
}
fn stop(error: crate::Error) -> ProgramError {
    match error { crate::Error::ProgramStopped(stop) => ProgramError::TraversalStopped(stop),
        _ => ProgramError::UnsupportedRetained }
}

#[cfg(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")))]
#[path = "voids_tests.rs"]
mod tests;
