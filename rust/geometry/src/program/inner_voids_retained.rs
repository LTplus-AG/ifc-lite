// SPDX-License-Identifier: MPL-2.0
//! Logical values in the original void controller; cuts use sealed binary work.
use super::*;
use crate::program::openings::retained::{GroupEligibility, RetainedVoidContext};
use crate::program::retained::{
    self, LogicalRetainedValue, RetainedContract, RetainedPlanOperation,
};

pub(super) struct RetainedState {
    pub contract: RetainedContract,
    pub program: u64,
    parts: std::vec::IntoIter<LogicalRetainedValue>,
    output: Vec<LogicalRetainedValue>,
    current: Option<LogicalRetainedValue>,
    host_part: Option<crate::program::retained::LogicalRetainedSlot>,
    context: Option<Arc<RetainedVoidContext>>,
    opening: usize,
    value: usize,
    accepted_cuts: u64,
    related: usize,
    empty_host: bool,
}
impl VoidControl {
    pub(in crate::program) fn select_retained(&mut self, contract: RetainedContract, program: u64) {
        if let Some(child) = &mut self.child {
            // Preserve the reached layer eligibility before host source admission.
            child.program.select_retained_layer(contract);
        }
        let permit = match crate::resource::charge(crate::resource::Cost {
            live_bytes: std::mem::size_of::<RetainedState>() as u64,
            ..Default::default()
        }) {
            Ok(permit) => permit,
            Err(stop) => {
                self.output = Some(Err(stop.into()));
                return;
            }
        };
        self.retained = Some(Box::new(RetainedState {
            contract,
            program,
            parts: Vec::new().into_iter(),
            output: Vec::new(),
            current: None,
            host_part: None,
            context: None,
            opening: 0,
            value: 0,
            accepted_cuts: 0,
            related: 0,
            empty_host: false,
        }));
        permit.retain();
    }
    pub(super) fn retained_poll(&mut self) -> crate::Result<()> {
        crate::program::retained_walk::charge(1)?;
        let state = self.retained.as_mut().expect("retained void control");
        if state.current.is_some() {
            self.action = Some(Action::RetainedNext);
            return Ok(());
        }
        if let Some(value) = state.parts.next() {
            state.host_part = Some(value.slot());
            state.current = Some(value);
            state.opening = 0;
            state.value = 0;
            self.action = Some(Action::RetainedNext);
            return Ok(());
        }
        let completion = crate::program::retained_openings::RetainedOpeningCompletion::new(
            self.element.id,
            state.related,
            state.accepted_cuts,
            state.empty_host,
            state.context.as_ref().map(|context| context.grouping),
        );
        self.output = Some(Ok(GeometryOutput::RetainedVoided(
            std::mem::take(&mut state.output),
            completion,
        )));
        Ok(())
    }
    pub(super) fn retained_child(
        &mut self,
        role: ChildRole,
        output: GeometryOutput,
    ) -> crate::Result<()> {
        let state = self.retained.as_mut().expect("retained void child");
        match (role, output) {
            (ChildRole::Layer, GeometryOutput::LayerCandidate(None)) => {
                self.action = Some(Action::Select)
            }
            (ChildRole::PlainParts, GeometryOutput::Retained(values)) => {
                state.empty_host = values.iter().all(LogicalRetainedValue::is_empty);
                state.parts = values.into_iter();
                state.related = 0;
            }
            (ChildRole::BodyParts | ChildRole::BodyStyled, GeometryOutput::Retained(values)) => {
                state.empty_host = values.iter().all(LogicalRetainedValue::is_empty);
                state.parts = values.into_iter();
                state.related = self.ids.len();
                // The actual semantic Empty gate precedes ALL opening source work.
                if !state.empty_host && !self.ids.is_empty() {
                    self.start_context();
                }
            }
            (ChildRole::Context, GeometryOutput::RetainedOpeningContext(context)) => {
                state.context = Some(context)
            }
            _ => return Err(crate::Error::geometry("wrong retained void child output")),
        }
        Ok(())
    }
    pub(super) fn retained_next(&mut self) -> crate::Result<Option<RetainedPlanOperation>> {
        crate::program::retained_walk::charge(1)?;
        let state = self.retained.as_mut().expect("retained cut control");
        let host = state.current.take().expect("current retained host");
        if !host.is_empty() {
            if let Some(context) = &state.context {
                match context.grouping {
                    GroupEligibility::DeferredMeshOnlyProbes => {}
                }
                while let Some(opening) = context.openings.get(state.opening) {
                    crate::program::retained_walk::charge(1)?;
                    crate::resource::charge(crate::resource::Cost {
                        work: 1,
                        ..Default::default()
                    })?
                    .retain();
                    if let Some(value) = opening.values.get(state.value) {
                        state.value += 1;
                        // Keep the requested occurrence boundary and the actual
                        // ordered value. Never merge mapped cutter parts as a union.
                        let right = value.try_copy()?;
                        let mut operation = retained::boolean_operation(
                            [host, right],
                            crate::document::BooleanOperation::Difference,
                            state.program,
                        )?;
                        operation.opening =
                            Some(crate::program::retained_openings::RetainedOpeningCut {
                                product: self.element.id,
                                host_part: state.host_part.expect("original host part"),
                                requested_opening: opening.requested_id,
                                opening_ordinal: state.opening,
                                cutter_ordinal: state.value - 1,
                            });
                        return Ok(Some(operation));
                    }
                    state.opening += 1;
                    state.value = 0;
                }
            }
        }
        crate::resource::reserve_headers(&mut state.output, 1)?.retain();
        state.output.push(host);
        Ok(None)
    }
    pub(super) fn accept_retained_cut(
        &mut self,
        value: LogicalRetainedValue,
        router: &GeometryRouter,
    ) -> crate::Result<()> {
        let state = self.retained.as_mut().expect("retained cut result");
        state.accepted_cuts = state
            .accepted_cuts
            .checked_add(1)
            .ok_or_else(crate::resource::overflow)?;
        if value.is_empty() {
            router.record_void_consumed_host(self.element.id);
        }
        state.current = Some(value);
        Ok(())
    }
}

pub(super) fn copy_selected_ids(ids: &[u32]) -> crate::Result<Vec<u32>> {
    crate::program::retained_walk::charge(ids.len() as u64)?;
    crate::resource::charge(crate::resource::Cost {
        work: ids.len() as u64,
        copy_bytes: std::mem::size_of_val(ids) as u64,
        ..Default::default()
    })?
    .retain();
    let mut output = Vec::new();
    crate::resource::reserve_headers(&mut output, ids.len())?.retain();
    output.extend_from_slice(ids);
    Ok(output)
}
