// SPDX-License-Identifier: MPL-2.0
//! Linear Boolean requests. Source replies own their uncommitted continuation;
//! numerical replies own their effects until the validated consuming accept.
use super::{BooleanState, Frame, Services, Value, work};
use super::reports::{PendingReports,UnwindReports};
use crate::processors::boolean::{BooleanClippingProcessor, OperandPath};
use crate::{BoolFailure, Error, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_PROGRAM: AtomicU64 = AtomicU64::new(1);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BooleanTicket { program: u64, sequence: u64 }
enum Pending {
    Child,
    Source { ticket: BooleanTicket, frame: Frame },
    SourceReply(BooleanTicket),
    Numerical { ticket: BooleanTicket, kind: work::Kind, next: work::Continuation },
}
pub(crate) enum BooleanPoll {
    Child(Box<crate::program::GeometryProgram>),
    Source(BooleanTicket),
    Ready(ReadyBoolean),
    Complete(Value),
    RetainedComplete(crate::program::retained::LogicalRetainedValue),
}
pub(crate) struct ReadyBoolean { ticket: BooleanTicket, operation: work::Ready, unwind_sink:crate::processors::boolean::FailureSink, reports: PendingReports }
pub(crate) struct BooleanNumericalReply { ticket: BooleanTicket, kind: work::Kind, value: Result<work::Reply>, reports: crate::construction::ConstructionReports }
pub(crate) struct BooleanSourceReply {
    ticket: BooleanTicket,
    state: BooleanState,
    result: Result<()>,
    failures: FailureDelta,
}
struct FailureDelta { keep: usize, append: Vec<BoolFailure> }
pub(crate) struct BooleanProgram {
    id: u64,
    sequence: u64,
    state: Option<BooleanState>,
    pending: Option<Pending>,
}
impl BooleanProgram {
    pub(crate) fn new_boolean(entity: DecodedEntity, quality: TessellationQuality) -> Self {
        Self::with_path(OperandPath::default(), quality, Frame::Boolean(entity, 0))
    }
    pub(crate) fn new_csg(entity: DecodedEntity, quality: TessellationQuality) -> Self {
        Self::with_path(OperandPath::default(), quality,
            Frame::Csg { entity, depth: 0, guarded: false })
    }
    pub(super) fn with_path(path: OperandPath, quality: TessellationQuality, first: Frame) -> Self {
        Self { id: NEXT_PROGRAM.fetch_add(1, Ordering::Relaxed), sequence: 0,
            state: Some(BooleanState::new(path, quality, first)), pending: None }
    }
    #[cfg(test)]
    pub(super) fn from_test_state(state: BooleanState) -> Self {
        Self { id: NEXT_PROGRAM.fetch_add(1, Ordering::Relaxed), sequence: 0,
            state: Some(state), pending: None }
    }
    #[cfg(test)]
    pub(super) fn bind_test_emitter(&mut self,recorder:&BooleanClippingProcessor){
        self.state.as_mut().expect("test Boolean state").unwind_sink=Some(recorder.effects.unwind_sink());
    }
    pub(crate) fn request(&mut self) -> Result<BooleanPoll> {
        if self.pending.is_some() { return Err(Error::geometry("Boolean reply is still pending")); }
        let result = self.request_inner();
        if result.is_err() { self.release_active(); }
        result
    }
    fn request_inner(&mut self) -> Result<BooleanPoll> {
        let state = self.state.as_mut().expect("idle Boolean state");
        let frame = loop {
            let Some(frame) = state.frames.pop() else {
                crate::resource::check_current()?;
                return Ok(match state.retained_value.take() {
                    Some(value)=>BooleanPoll::RetainedComplete(value),
                    None=>BooleanPoll::Complete(state.value.take().expect("completed Boolean value")),
                });
            };
            match frame {
                Frame::ExitPath(id) => {
                    state.visited.remove(id);
                    let exited = state.active.pop();
                    debug_assert_eq!(exited, Some(id));
                }
                Frame::Walk(walk) => state.walk(walk)?,
                Frame::AfterBase(walk) if state.retained.is_some() => {
                    let value=state.retained_value.take().expect("retained base");
                    state.frames.push(Frame::Steps(walk.retained_steps(value)));
                }
                Frame::AfterBase(walk) => {
                    let value = state.value.take().expect("base continuation value");
                    #[cfg(test)]
                    super::unwind_tests::after_base(&value);
                    #[cfg(test)]
                    super::resource_tests::after_base(&value);
                    state.frames.push(Frame::Steps(walk.steps(value, false)));
                }
                Frame::AfterBatch { walk, cutters, mark } => state.finish_batch(walk, cutters, mark)?,
                Frame::AfterStep { steps, operator, host } => state.solid(steps, operator, host),
                Frame::RetainedAfterStep {steps,operator,host} => state.retained_solid(steps,operator,host)?,
                Frame::Steps(steps) if steps.nodes.is_empty() => {
                    if let Some(value)=steps.retained {state.retained_value=Some(value);}
                    else {state.value = Some((steps.mesh, steps.empty_recorded));}
                }
                Frame::Operand { entity, operator: _, depth } if matches!(entity.ifc_type,
                    ifc_lite_core::IfcType::IfcBooleanResult | ifc_lite_core::IfcType::IfcBooleanClippingResult) => {
                    state.frames.push(Frame::Boolean(entity, depth + 1));
                }
                Frame::Operand { entity, operator: _, depth: _ } if entity.ifc_type == ifc_lite_core::IfcType::IfcCsgSolid => {
                    state.frames.push(Frame::Csg { entity, depth: 0, guarded: true });
                }
                frame => break frame,
            }
        };
        self.sequence = self.sequence.checked_add(1).expect("Boolean sequence overflow");
        let ticket = BooleanTicket { program: self.id, sequence: self.sequence };
        match frame {
            Frame::RetainedChild(child)=>{self.pending=Some(Pending::Child);Ok(BooleanPoll::Child(child))}
            Frame::Numerical(operation, next) => {
                self.pending = Some(Pending::Numerical { ticket, kind: operation.kind(), next });
                let reports=PendingReports::new(std::mem::take(&mut state.reports));
                state.pending_reports=Some(reports.clone());
                Ok(BooleanPoll::Ready(ReadyBoolean { ticket, operation, unwind_sink:state.unwind_sink.clone().expect("actual Boolean emitter source admission"), reports }))
            }
            frame => {
                self.pending = Some(Pending::Source { ticket, frame });
                Ok(BooleanPoll::Source(ticket))
            }
        }
    }
    /// Executes only the reached source frame. The lexical guard retains the
    /// caller's actual path if source admission panics; no guard is suspended.
    pub(crate) fn execute_source(&mut self, ticket: BooleanTicket,
        recorder: &BooleanClippingProcessor, decoder: &mut EntityDecoder,
    ) -> Result<BooleanSourceReply> {
        self.execute_source_with_router(ticket,recorder,decoder,None)
    }
    pub(crate) fn execute_source_with_router(&mut self, ticket:BooleanTicket,
        recorder:&BooleanClippingProcessor, decoder:&mut EntityDecoder,
        router:Option<&crate::GeometryRouter>) -> Result<BooleanSourceReply> {
        if !matches!(&self.pending, Some(Pending::Source { ticket: expected, .. }) if *expected == ticket) {
            return Err(Error::geometry("Mismatched Boolean source request"));
        }
        let Some(Pending::Source { frame, .. }) = self.pending.take() else { unreachable!() };
        self.pending = Some(Pending::SourceReply(ticket));
        let mut state = self.state.take().expect("source Boolean state");
        state.unwind_sink=Some(recorder.effects.unwind_sink());
        // Keep historical marks meaningful while capturing only this frame's
        // publication delta. On unwind leave reached records in the live sink.
        let original = recorder.effects.take_failures();
        recorder.absorb_failures(original.clone());
        let ((result, mut state), reports) = crate::processors::diagnostic_capture::capture(|| {
            let mut restoring = RestoreState { slot: &mut self.state, state: Some(state) };
            let result = restoring.state.as_mut().expect("owned source state")
                .source_frame(frame, &mut Services { recorder, decoder, router });
            (result, restoring.state.take().expect("source state reply"))
        });
        state.reports.merge(reports);
        let after = recorder.effects.take_failures();
        let keep = original.iter().zip(&after).take_while(|(a, b)| a == b).count();
        let append = after.into_iter().skip(keep).collect();
        recorder.absorb_failures(original);
        Ok(BooleanSourceReply { ticket, state,
            result, failures: FailureDelta { keep, append } })
    }
    pub(crate) fn accept_source(&mut self, reply: BooleanSourceReply,
        recorder: &BooleanClippingProcessor,
    ) -> std::result::Result<Result<()>, Box<BooleanSourceReply>> {
        if !matches!(self.pending, Some(Pending::SourceReply(expected)) if expected == reply.ticket) {
            return Err(Box::new(reply));
        }
        self.pending = None;
        recorder.rewind_to(reply.failures.keep);
        recorder.absorb_failures(reply.failures.append);
        self.state = Some(reply.state);
        if reply.result.is_err() { self.release_active(); }
        Ok(reply.result)
    }
    pub(crate) fn accept_numerical(&mut self, reply: BooleanNumericalReply,
        recorder: &BooleanClippingProcessor,
    ) -> std::result::Result<Result<()>, Box<BooleanNumericalReply>> {
        if !matches!(&self.pending, Some(Pending::Numerical { ticket, kind, .. })
            if *ticket == reply.ticket && *kind == reply.kind
                && reply.value.as_ref().map_or(true, |value| value.kind() == *kind)) { return Err(Box::new(reply)); }
        let Some(Pending::Numerical { next, .. }) = self.pending.take() else { unreachable!() };
        let state=self.state.as_mut().expect("numerical Boolean state");
        if let Some(reports)=state.pending_reports.take(){state.reports.merge(reports.take());}
        state.reports.merge(reply.reports);
        let result = match reply.value {
            Ok(value) => self.state.as_mut().expect("numerical Boolean state")
                .accept_numerical(next, value, recorder),
            Err(error) => Err(error),
        };
        if result.is_err() { self.release_active(); }
        Ok(result)
    }
    pub(crate) fn accept_retained_child(&mut self, value: Result<crate::program::retained::LogicalRetainedValue>) -> Result<()> {
        if !matches!(self.pending,Some(Pending::Child)) {return Err(Error::geometry("stale retained Boolean child"));}
        self.pending=None;
        match value {
            Ok(value)=>{self.state.as_mut().expect("Boolean child state").retained_value=Some(value);Ok(())}
            Err(error)=>{self.release_active();Err(error)}
        }
    }
    pub(crate) fn select_retained(&mut self, contract: crate::program::retained::RetainedContract, program:u64) {
        let state=self.state.as_mut().expect("unstarted Boolean state");
        state.retained=Some((contract,program));
        state.retained_cache=Some(Default::default());
    }
    pub(crate) fn cancel(&mut self) -> Result<()> {
        self.release_active();
        self.pending = None;
        if let Some(state) = &mut self.state { state.frames.clear(); state.value = None; state.retained_value=None; }
        Err(crate::resource::ProgramStop::Cancelled.into())
    }
    fn release_active(&mut self) {
        if let Some(state) = &mut self.state {
            for id in state.active.drain(..) { state.visited.remove(id); }
        }
    }
    pub(crate) fn take_reports(&mut self) -> crate::construction::ConstructionReports {
        self.state.as_mut().map_or_else(Default::default,|state|{
            let mut reports=std::mem::take(&mut state.reports);
            if let Some(pending)=state.pending_reports.take(){reports.merge(pending.take());}
            reports
        })
    }
    pub(super) fn take_path(&mut self) -> OperandPath {
        self.state.as_mut().map_or_else(OperandPath::default,
            |state| std::mem::take(&mut state.visited))
    }
    pub(super) fn drain(&mut self, recorder: &BooleanClippingProcessor,
        decoder: &mut EntityDecoder,
    ) -> Result<Value> {
        loop {
            match self.request()? {
                BooleanPoll::Source(ticket) => {
                    let reply = self.execute_source(ticket, recorder, decoder)?;
                    self.accept_source(reply, recorder).unwrap_or_else(|_| panic!("own source reply rejected"))?;
                }
                BooleanPoll::Ready(ready) => {
                    let reply = ready.execute();
                    self.accept_numerical(reply, recorder).unwrap_or_else(|_| panic!("own numerical reply rejected"))?;
                }
                BooleanPoll::Complete(value) => return Ok(value),
                BooleanPoll::Child(_)=>return Err(Error::geometry("retained child cannot enter exact drain")),
                BooleanPoll::RetainedComplete(_)=>return Err(Error::geometry("retained Boolean cannot enter exact drain")),
            }
        }
    }
}
impl ReadyBoolean {
    pub(crate) fn admit_retained(self) -> Result<(BooleanNumericalReply, Vec<crate::program::retained::RetainedPlanOperation>)> {
        let kind=self.operation.kind();
        let work::Ready::Retained(operation)=self.operation else {
            return Err(Error::geometry("exact Boolean operation cannot discharge retained work"));
        };
        let value=crate::program::retained::copy_values(std::slice::from_ref(operation.value()))?
            .pop().expect("one retained output");
        let mut operations=Vec::new();
        crate::resource::reserve_headers(&mut operations,1)?.retain();
        operations.push(operation);
        // Keep reached source reports in the controller's shared pending log.
        // Cancellation must still drain them while this original reply is held
        // outside the program awaiting its physical receipt.
        let _pending=UnwindReports(self.reports);
        Ok((BooleanNumericalReply {ticket:self.ticket,kind,value:Ok(work::Reply::Retained(Ok(value))),
            reports:Default::default()},operations))
    }
    pub(crate) fn execute(self) -> BooleanNumericalReply {
        let kind = self.operation.kind();
        let (value, reports) = crate::processors::diagnostic_capture::capture(|| {
            let _pending = UnwindReports(self.reports);
            crate::resource::check_current().map_err(Error::from)
                .map(|()| self.operation.execute(self.unwind_sink))
        });
        BooleanNumericalReply { ticket: self.ticket, kind, value, reports }
    }
}
impl BooleanNumericalReply {
    pub(in crate::program) fn bind_retained_outcome(&mut self, slot: crate::program::LogicalRetainedSlot, empty:bool) -> bool {
        match &mut self.value {
            Ok(work::Reply::Retained(Ok(value))) if value.slot()==slot=>{value.empty=empty;true}
            _=>false,
        }
    }
}
struct RestoreState<'a> { slot: &'a mut Option<BooleanState>, state: Option<BooleanState> }
impl Drop for RestoreState<'_> {
    fn drop(&mut self) {
        if let Some(mut state) = self.state.take() {
            if std::thread::panicking() {
                crate::processors::diagnostic_capture::restore_before_current(&state.reports);
                state.reports = Default::default();
            }
            *self.slot = Some(state);
        }
    }
}


#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
