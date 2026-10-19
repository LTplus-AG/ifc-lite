// SPDX-License-Identifier: MPL-2.0
//! Source-free numerical packets. Continuations and publication stay executor-held.
use super::inner::{GeometryProgram, ProgramError, ProgramReply, ProgramRequest, ProgramStage, ReplyValue};
use super::item::{ItemStep, ReadyItem};
use crate::ProcessorEmitter;

pub struct ReadyOperation {
    request:ProgramRequest,
    payload:ReadyPayload,
    emitter:Option<ProcessorEmitter>,
}
enum ReadyPayload {
    Item(ReadyItem),
    Boolean(super::boolean::ReadyBoolean),
    Mapping(super::inner_mapping::MappingReadyWork),
    Cache(super::inner_cache::ReadyCacheWork),
    Voids(super::inner_voids::VoidReadyWork),
    Opening(super::openings::OpeningReady),
    Product(super::inner_product_adapter::ProductReadyWork),
    TypeMap(super::inner_type_map::TypeMapReadyWork),
    Layers(super::inner_layers::LayerReadyWork),
    Nested(Envelope,Box<ReadyOperation>),
}
enum Envelope { Item, Mapping, Cache, Voids, Opening, Product, TypeMap, Layers }
impl ReadyOperation {
    pub(crate) fn execute(self)->ProgramReply {
        let value=match self.payload {
            ReadyPayload::Item(ready)=>ReplyValue::Item(ItemStep::Complete(ready.execute())),
            ReadyPayload::Boolean(ready)=>ReplyValue::BooleanNumerical(ready.execute()),
            ReadyPayload::Mapping(ready)=>ReplyValue::Mapping(ready.execute()),
            ReadyPayload::Cache(ready)=>ReplyValue::Cache(ready.execute()),
            ReadyPayload::Voids(ready)=>ReplyValue::Voids(ready.execute()),
            ReadyPayload::Product(ready)=>ReplyValue::Product(ready.execute()),
            ReadyPayload::TypeMap(ready)=>ReplyValue::TypeMap(ready.execute()),
            ReadyPayload::Layers(ready)=>ReplyValue::Layers(ready.execute()),
            ReadyPayload::Opening(ready)=>ReplyValue::Opening(super::inner_opening::OpeningAdapterReply::from_ready(ready.execute())),
            ReadyPayload::Nested(envelope,ready)=>{
                let reply=ready.execute();
                match envelope {
                    Envelope::Product=>ReplyValue::Product(super::inner_product_adapter::ProductAdapterReply::wrap_child_reply(reply)),
                    Envelope::TypeMap=>ReplyValue::TypeMap(super::inner_type_map::TypeMapReply::wrap_child_reply(reply)),
                    Envelope::Layers=>ReplyValue::Layers(super::inner_layers::LayerReply::wrap_child_reply(reply)),
                    Envelope::Item=>ReplyValue::ItemChild(Box::new(reply)),
                    Envelope::Mapping=>ReplyValue::Mapping(super::inner_mapping::MappingReply::wrap_child_reply(reply)),
                    Envelope::Cache=>ReplyValue::Cache(super::inner_cache::CacheReply::wrap_child_reply(reply)),
                    Envelope::Voids=>ReplyValue::Voids(super::inner_voids::VoidReply::wrap_child_reply(reply)),
                    Envelope::Opening=>ReplyValue::Opening(super::inner_opening::OpeningAdapterReply::wrap_child_reply(reply)),
                }
            }
        };
        ProgramReply {request:self.request,value,emitter:self.emitter}
    }
}
impl GeometryProgram {
    /// Moving a packet consumes the actual pending recipe once. Tickets hold no work.
    pub(crate) fn take_ready(&mut self,request:ProgramRequest)->Result<ReadyOperation,ProgramError> {
        self.before_execute(request)?;
        if request.stage()!=ProgramStage::Numerical {return Err(ProgramError::StaleRequest)}
        let (payload,tag,emitter)=if let Some(state)=&mut self.mapping {
            if let Some(ready)=state.take_ready(){let tag=0x1000+u32::from(ready.tag());(ReadyPayload::Mapping(ready),tag,None)}
            else {let ready=state.take_child_ready()?.ok_or(ProgramError::StaleRequest)?;(ReadyPayload::Nested(Envelope::Mapping,Box::new(ready)),0x1080,None)}
        } else if let Some(state)=&mut self.cache {
            if let Some(ready)=state.take_ready(){let tag=0x2000+u32::from(ready.tag());(ReadyPayload::Cache(ready),tag,None)}
            else {let ready=state.take_child_ready()?.ok_or(ProgramError::StaleRequest)?;(ReadyPayload::Nested(Envelope::Cache,Box::new(ready)),0x2001,None)}
        } else if let Some(state)=&mut self.voids {
            if let Some(ready)=state.take_ready(){let tag=0x7000+u32::from(ready.tag());(ReadyPayload::Voids(ready),tag,None)}
            else {let ready=state.take_child_ready()?.ok_or(ProgramError::StaleRequest)?;(ReadyPayload::Nested(Envelope::Voids,Box::new(ready)),0x7001,None)}
        } else if let Some(state)=&mut self.opening {
            if let Some(ready)=state.take_ready(){let tag=0x8000+u32::from(ready.tag());(ReadyPayload::Opening(ready),tag,None)}
            else {let ready=state.take_child_ready()?.ok_or(ProgramError::StaleRequest)?;(ReadyPayload::Nested(Envelope::Opening,Box::new(ready)),0x8065,None)}
        } else if let Some(state)=&mut self.product {
            if let Some(ready)=state.take_ready(){let tag=0x3000+u32::from(ready.tag());(ReadyPayload::Product(ready),tag,None)}
            else {let ready=state.take_child_ready()?.ok_or(ProgramError::StaleRequest)?;(ReadyPayload::Nested(Envelope::Product,Box::new(ready)),0x3039,None)}
        } else if let Some(state)=&mut self.type_map {
            if let Some(ready)=state.take_ready(){let tag=0x4000+u32::from(ready.tag());(ReadyPayload::TypeMap(ready),tag,None)}
            else {let ready=state.take_child_ready()?.ok_or(ProgramError::StaleRequest)?;(ReadyPayload::Nested(Envelope::TypeMap,Box::new(ready)),0x4006,None)}
        } else if let Some(state)=&mut self.layers {
            if let Some(ready)=state.take_ready(){let tag=0x5000+u32::from(ready.tag());(ReadyPayload::Layers(ready),tag,None)}
            else {let ready=state.take_child_ready()?.ok_or(ProgramError::StaleRequest)?;(ReadyPayload::Nested(Envelope::Layers,Box::new(ready)),0x5001,None)}
        } else if let Some(state)=&mut self.boolean {
            let emitter=state.emitter();
            (ReadyPayload::Boolean(state.take_ready().ok_or(ProgramError::StaleRequest)?),2,emitter)
        } else if matches!(self.step,Some(ItemStep::Child(_))) {
            let Some(ItemStep::Child(child))=self.step.as_mut() else{unreachable!()};
            let ready=child.program.take_ready(child.program.pending_request().expect("requested item child"))?;
            (ReadyPayload::Nested(Envelope::Item,Box::new(ready)),10,None)
        } else {
            if !matches!(self.step,Some(ItemStep::Ready(_))){return Err(ProgramError::StaleRequest)}
            let Some(ItemStep::Ready(mut ready))=self.step.take() else{unreachable!()};
            self.pending_item_reports=Some(ready.detach_reports());
            let emitter=Some(ready.emitter);(ReadyPayload::Item(ready),0,emitter)
        };
        self.expected_payload=Some(tag);self.expected_emitter=emitter;self.pending=Some((request,true));
        Ok(ReadyOperation {request,payload,emitter})
    }
}
