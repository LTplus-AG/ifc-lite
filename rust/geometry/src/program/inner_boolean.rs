// SPDX-License-Identifier: MPL-2.0
//! The common program's selected boolean child, retaining its actual recorder.
use super::boolean::{BooleanProgram, BooleanPoll, BooleanTicket, ReadyBoolean};
use super::inner::{GeometryProgram, ProgramStage, ProgramError, ReplyValue};
use super::item::{ItemResult, ItemStep};
use crate::{GeometryRouter, ProcessorEmitter};
use ifc_lite_core::{EntityDecoder, IfcType};

pub(super) struct BooleanControl {
    pub program: BooleanProgram,
    binding: Option<(IfcType, ProcessorEmitter)>,
    action: Option<BooleanAction>,
}
enum BooleanAction { Source(BooleanTicket), Ready(ReadyBoolean) }
impl BooleanControl {
    pub(super) fn matches_router(&self,router:&GeometryRouter)->bool {
        self.binding.as_ref().is_some_and(|(ty,expected)| router.processor_for(ty)
            .and_then(|processor|router.processor_emitter(processor.as_ref()))==Some(*expected))
    }
    pub(super) fn take_ready(&mut self)->Option<ReadyBoolean>{
        if !matches!(self.action,Some(BooleanAction::Ready(_))){return None}
        let Some(BooleanAction::Ready(ready))=self.action.take()else{unreachable!()};Some(ready)
    }
    pub(super) fn emitter(&self) -> Option<ProcessorEmitter> { self.binding.as_ref().map(|(_,emitter)|*emitter) }
}
impl GeometryProgram {
    pub(crate) fn boolean(program: BooleanProgram) -> Self {
        // Allocate identity through the same owner, without any source access.
        let mut wrapper = Self::from_step(None);
        wrapper.step = None;
        wrapper.boolean = Some(Box::new(BooleanControl { program, binding:None, action:None }));
        wrapper
    }
    pub(crate) fn bind_processor(&mut self, ifc_type: IfcType, emitter: ProcessorEmitter) {
        self.selected_binding=Some((ifc_type.clone(),emitter));
        if let Some(boolean)=&mut self.boolean {boolean.binding=Some((ifc_type,emitter));}
    }
    pub(super) fn poll_boolean(&mut self) -> Option<ProgramStage> {
        let state = self.boolean.as_mut().expect("boolean child");
        match state.program.request() {
            Ok(BooleanPoll::Source(ticket)) => {
                state.action = Some(BooleanAction::Source(ticket)); Some(ProgramStage::Source)
            }
            Ok(BooleanPoll::Ready(ready)) => {
                state.action = Some(BooleanAction::Ready(ready)); Some(ProgramStage::Numerical)
            }
            result => {
                let result = match result { Ok(BooleanPoll::Complete((mesh,_))) => Ok(mesh),
                    Err(error) => Err(error), _ => unreachable!() };
                self.step = Some(ItemStep::Complete(ItemResult { result:result.map(super::retained::ItemValue::Mesh),
                    reports: state.program.take_reports(), emitter:state.emitter() }));
                self.boolean = None;
                None
            }
        }
    }
    pub(super) fn execute_boolean(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>)
        -> std::result::Result<ReplyValue, ProgramError> {
        let state = self.boolean.as_mut().expect("boolean child");
        let (ty, expected) = state.binding.as_ref().expect("selected processor binding");
        let processor = router.processor_for(ty).ok_or(ProgramError::WrongEmitter)?;
        if router.processor_emitter(processor.as_ref()) != Some(*expected) { return Err(ProgramError::WrongEmitter) }
        let recorder = processor.boolean_recorder().ok_or(ProgramError::WrongEmitter)?;
        Ok(match state.action.take().expect("reached boolean action") {
            BooleanAction::Source(ticket) => ReplyValue::BooleanSource(state.program.execute_source(ticket, recorder, decoder)
                .expect("owned source ticket")),
            BooleanAction::Ready(ready) => ReplyValue::BooleanNumerical(ready.execute()),
        })
    }
    pub(super) fn accept_boolean(&mut self, reply: ReplyValue, router: &GeometryRouter) {
        let state = self.boolean.as_mut().expect("boolean child");
        let processor = router.processor_for(&state.binding.as_ref().expect("bound child").0).expect("selected processor");
        let recorder = processor.boolean_recorder().expect("actual boolean recorder");
        let result = match reply {
            ReplyValue::BooleanSource(reply) => state.program.accept_source(reply, recorder)
                .unwrap_or_else(|_| panic!("validated source reply")),
            ReplyValue::BooleanNumerical(reply) => state.program.accept_numerical(reply, recorder)
                .unwrap_or_else(|_| panic!("validated numerical reply")),
            _ => unreachable!(),
        };
        if let Err(error) = result {
            self.step = Some(ItemStep::Complete(ItemResult { result: Err(error),
                reports:state.program.take_reports(), emitter:state.emitter() }));
            self.boolean = None;
        }
    }
}
