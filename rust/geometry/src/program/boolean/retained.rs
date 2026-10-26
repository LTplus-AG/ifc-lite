// SPDX-License-Identifier: MPL-2.0
//! Retained values follow the common Boolean spine and ordered operand walk.
// On the default wasm engine every retained state is uninhabited, so the
// bodies below are statically unreachable there; they stay compiled, not shipped.
#![cfg_attr(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")),
    allow(unreachable_code, unused_variables, unused_mut))]
use super::*;
use ifc_lite_core::slot;
use super::state::Steps;
use crate::program::retained::{LogicalRetainedValue, RetainedPlanOperation, RetainedSelection};
use crate::program::retained::failure::{BooleanReason, FailureSite, OriginCause};

pub(super) struct RetainedState {
    pub selection: RetainedSelection,
    value: Option<LogicalRetainedValue>,
}
impl Walk {
    pub(super) fn retained_steps(self, value: LogicalRetainedValue) -> Result<Steps> {
        let mut steps = self.steps((crate::Mesh::default(), false), false);
        steps.retained = Some(boxed(value)?);
        Ok(steps)
    }
}
impl BooleanMachine {
    #[cfg_attr(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")), allow(dead_code))]
    pub(in crate::program) fn new_retained(item: &DecodedEntity, quality: TessellationQuality, selection: RetainedSelection) -> Result<Box<Self>> {
        // `new` allocates its initial frame, before any continuation step runs.
        crate::resource::charge(crate::resource::Cost { live_bytes: std::mem::size_of::<Frame>() as u64,
            ..Default::default() })?.retain();
        let mut machine = Self::new(item, quality);
        #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
        { machine.retained = Some(boxed(RetainedState { selection, value: None })?); }
        #[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
        { let _ = machine; match selection {} }
        boxed(machine)
    }
    pub(in crate::program) fn retained_selection(&self) -> Option<&RetainedSelection> {
        self.retained.as_ref().map(|state| &state.selection)
    }
    pub(in crate::program) fn retained_ready(&self) -> bool {
        crate::program::retained::ENABLED && matches!(self.frames.last(), Some(Frame::RetainedReady { .. }))
            || matches!(self.frames.last(), Some(Frame::RetainedMapping(control)) if control.retained_ready())
    }
    pub(in crate::program) fn retained_source(&mut self, recorder: &BooleanClippingProcessor,
        router: &crate::GeometryRouter, decoder: &mut EntityDecoder) -> Result<()> {
        #[cfg(not(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime")))]
        { let _ = (recorder, router, decoder); Err(stale()) }
        #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
        {
        // Shared source/control steps push at most two frames. Reserve before
        // moving the active frame so bounded allocation failure is terminal.
        crate::resource::reserve_headers(&mut self.frames, 2)?.retain();
        let Some(frame) = self.frames.pop() else { return Err(stale()) };
        match frame {
            Frame::RetainedMapping(mut control) => {
                let reply = control.execute(router, decoder).map_err(|error| mapped_error(error.into()))?;
                self.frames.push(Frame::RetainedMappingReply { control, reply: boxed(reply)? });
            }
            Frame::Operand { entity, .. } if entity.ifc_type == ifc_lite_core::IfcType::IfcMappedItem => {
                let selection = self.retained_selection().ok_or_else(stale)?.clone();
                let control = crate::program::mapping::MappingControl::retained_occurrence(
                    crate::program::mapping::Reached::Nested(entity), selection);
                self.frames.push(Frame::RetainedMapping(boxed(control)?));
            }
            Frame::Operand { entity, .. } if !Frame::dispatches(&entity) => {
                let selection = self.retained_selection().ok_or_else(stale)?;
                selection.charge()?;
                let operation = selection.capture(&entity, router, decoder)?;
                self.frames.push(Frame::RetainedReady { operation: boxed(operation)?, steps: None });
            }
            frame => self.run(frame, recorder, decoder)?,
        }
        self.settle(recorder)
        }
    }
    pub(in crate::program) fn admit_retained(&mut self) -> Result<Vec<RetainedPlanOperation>> {
        if let Some(Frame::RetainedMapping(control)) = self.frames.last_mut() {
            let (reply, operations) = control.admit_retained().map_err(mapped_error)?;
            let Some(Frame::RetainedMapping(control)) = self.frames.pop() else { return Err(stale()) };
            self.frames.push(Frame::RetainedMappingReply { control, reply: boxed(reply)? });
            return Ok(operations);
        }
        let mut operations = Vec::new();
        crate::resource::reserve_headers(&mut operations, 1)?.retain();
        let Some(Frame::RetainedReady { operation, .. }) = self.frames.last() else { return Err(stale()) };
        let value = operation.value().try_copy()?;
        let Some(Frame::RetainedReady { operation, steps }) = self.frames.pop() else { return Err(stale()) };
        if let Some(mut steps) = steps {
            steps.retained = Some(boxed(value)?);
            self.frames.push(Frame::Steps(*steps));
        } else {
            self.retained.as_mut().ok_or_else(stale)?.value = Some(value);
        }
        operations.push(*operation);
        Ok(operations)
    }
    pub(in crate::program) fn finish_retained(&mut self) -> Result<LogicalRetainedValue> {
        if !self.frames.is_empty() { return Err(stale()); }
        self.take_retained_value()
    }
    pub(super) fn take_retained_value(&mut self) -> Result<LogicalRetainedValue> {
        self.retained.as_mut().and_then(|state| state.value.take()).ok_or_else(stale)
    }
    pub(super) fn retained_first_operand(&self, node: &DecodedEntity, decoder: &mut EntityDecoder)
        -> Result<DecodedEntity> {
        let site = FailureSite::BooleanFirstOperand;
        let attr = node.get(slot::IfcBooleanResult::FIRST_OPERAND.index())
            .ok_or_else(|| self.source_refusal(site, node.id, BooleanReason::OperandAttributeMissing,
                "BooleanResult missing FirstOperand"))?;
        decoder.resolve_ref(attr)
            .map_err(|error| self.source_core(site, attr.as_entity_ref().unwrap_or(node.id), error))?
            .ok_or_else(|| self.source_refusal(site, node.id, BooleanReason::OperandReferenceRequired,
                "Failed to resolve FirstOperand"))
    }
    fn source_refusal(&self, site: FailureSite, entity: u32, reason: BooleanReason,
        diagnostic: &'static str) -> Error {
        if let Some(selection) = self.retained_selection() {
            selection.failure_handle().record(site, Some(entity), OriginCause::Boolean(reason));
        }
        Error::geometry(diagnostic)
    }
    fn source_core(&self, site: FailureSite, entity: u32, error: ifc_lite_core::Error) -> Error {
        let diagnostic = Error::geometry(format!("Core parser error: {error}"));
        if let Some(selection) = self.retained_selection() {
            selection.failure_handle().record(site, Some(entity), OriginCause::Core(error));
        }
        diagnostic
    }
    pub(super) fn retained_steps(&mut self, mut steps: Steps, recorder: &BooleanClippingProcessor,
        decoder: &mut EntityDecoder) -> Result<()> {
        let host = steps.retained.take().ok_or_else(stale)?;
        let Some(node) = steps.nodes.pop() else {
            self.retained.as_mut().ok_or_else(stale)?.value = Some(*host);
            return Ok(());
        };
        // Exact display permits omitted clipping operators; retained plans
        // require the authored operation and never infer a subtraction.
        let keyword = node.get(slot::IfcBooleanResult::OPERATOR.index()).and_then(|value| value.as_enum())
            .ok_or_else(|| self.source_refusal(FailureSite::BooleanOperator, node.id,
                BooleanReason::OperatorRequired, "missing retained Boolean operator"))?;
        if node.ifc_type == IfcType::IfcBooleanClippingResult && keyword.trim_matches('.') != "DIFFERENCE" {
            return Err(self.source_refusal(FailureSite::BooleanOperator, node.id,
                BooleanReason::InvalidClippingOperator, "invalid retained clipping operator"));
        }
        let operator = crate::processors::boolean::boolean_operator(&node)
            .map_err(|_| self.source_refusal(FailureSite::BooleanOperator, node.id,
                BooleanReason::UnknownOperator, "unknown retained Boolean operator"))?;
        let second = recorder.second_operand_result_or_record(operator, &node, decoder);
        crate::resource::check_current()?;
        let attr = node.get(slot::IfcBooleanResult::SECOND_OPERAND.index());
        let second = second.map_err(|error| self.source_core(FailureSite::BooleanSecondOperand,
            attr.and_then(|value| value.as_entity_ref()).unwrap_or(node.id), error))?
            .ok_or_else(|| self.source_refusal(FailureSite::BooleanSecondOperand, node.id,
                if attr.is_none() { BooleanReason::OperandAttributeMissing }
                else { BooleanReason::OperandReferenceRequired }, "missing retained Boolean operand"))?;
        let depth = steps.depth;
        self.frames.push(Frame::RetainedAfterStep { steps: boxed(steps)?, operator, host });
        self.frames.push(Frame::Operand { entity: second, operator, depth });
        Ok(())
    }
    pub(super) fn retained_solid(&mut self, steps: Steps, operator: BoolOp, host: LogicalRetainedValue) -> Result<()> {
        let right = self.take_retained_value()?;
        let operation = crate::program::retained::boolean::boolean_operation([host, right], operator)?;
        self.frames.push(Frame::RetainedReady { operation: boxed(operation)?, steps: Some(boxed(steps)?) });
        Ok(())
    }
}

fn mapped_error(error: crate::program::inner::retained_program::RetainedProgramError) -> Error {
    match error {
        crate::program::inner::retained_program::RetainedProgramError::Stopped(stop) => stop.into(),
        _ => Error::geometry(format!("retained mapped operand: {error:?}")),
    }
}
impl BooleanMachine {
    /// Mapping effects commit only when the enclosing item reply is accepted.
    pub(in crate::program) fn accept_retained_mapping(&mut self, router: &crate::GeometryRouter) -> Result<()> {
        if !crate::program::retained::ENABLED
            || !matches!(self.frames.last(), Some(Frame::RetainedMappingReply { .. })) { return Ok(()); }
        let Some(Frame::RetainedMappingReply { mut control, reply }) = self.frames.pop() else { return Err(stale()) };
        control.accept(*reply, router);
        if let Some(result) = control.take_result() {
            let crate::program::mapping::MappingOutput::Retained(mut values) = result? else {
                return Err(Error::geometry("mapped Boolean operand returned exact meshes"));
            };
            if values.len() != 1 { return Err(Error::geometry("mapped Boolean operand requires one solid")); }
            self.retained.as_mut().ok_or_else(stale)?.value = values.pop();
        } else {
            self.frames.push(Frame::RetainedMapping(control));
        }
        Ok(())
    }
}

fn boxed<T>(value: T) -> Result<Box<T>> {
    crate::resource::charge(crate::resource::Cost {
        live_bytes: std::mem::size_of::<T>() as u64, ..Default::default()
    })?.retain();
    Ok(Box::new(value))
}
