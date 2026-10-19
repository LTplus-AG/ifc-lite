// SPDX-License-Identifier: MPL-2.0
//! Linear inner-operation protocol. Recipes live in the executor, never tickets.
use super::item::{ItemPhase, ItemSource, ItemStep};
use crate::{GeometryRouter, Mesh, ProcessorEmitter, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use super::inner_boolean::BooleanControl;
use std::sync::atomic::{AtomicU64, Ordering};

/// Opaque continuation for a reached geometry occurrence.
pub struct GeometryProgram {
    pub(super) id: u64,
    sequence: u64,
    pub(super) retained: Option<super::retained::RetainedContract>,
    pub(super) step: Option<ItemStep>,
    pub(super) boolean: Option<BooleanControl>,
    pub(super) pending: Option<(ProgramRequest, bool)>,
    pub(super) expected_emitter: Option<ProcessorEmitter>,
    cancelled: bool,
    pub(super) opening:Option<super::inner_opening::OpeningAdapter>,
    pub(super) layers:Option<super::inner_layers::LayerControl>,
    pub(super) voids:Option<super::inner_voids::VoidControl>,
    pub(super) type_map: Option<super::inner_type_map::TypeMapControl>,
    pub(super) product: Option<super::inner_product_adapter::ProductRootAdapter>,
    pub(super) cache: Option<super::inner_cache::CacheControl>,
    pub(super) mapping: Option<super::inner_mapping::MappingControl>,
    pub(super) outcome: Option<Result<GeometryOutput>>,
    pub(super) expected_payload: Option<u32>,
    expected_router: Option<ifc_lite_core::execution_owner::ExecutionIdentity>,
    expected_decoder:Option<ifc_lite_core::execution_owner::ExecutionIdentity>,
    pub(super) pending_item_reports:Option<super::item::PendingItemReports>,
    pub(super) selected_binding:Option<(ifc_lite_core::IfcType,ProcessorEmitter)>,
}
/// Identity only. Copying this value cannot copy or replay its recipe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProgramRequest { program: u64, sequence: u64, stage: ProgramStage }
impl ProgramRequest { pub(super) fn stage(self)->ProgramStage {self.stage} }
pub(super) enum GeometryOutput { Retained(Vec<super::retained::LogicalRetainedValue>), Mesh(Mesh), Parts(Vec<Mesh>), Submeshes(crate::SubMeshCollection), TypeParts(Vec<(Mesh,Vec<f32>,Option<crate::processors::texture::TextureAttachment>)>), LayerCandidate(Option<crate::SubMeshCollection>), OpeningContext(std::sync::Arc<crate::router::voids::ReadyVoidContext>) }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ProgramStage { Source, Extension, Numerical }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProgramError { UnsupportedRetained, WrongPayload, WrongOwner, Outstanding, StaleRequest, AlreadyExecuted, NotExecuted, WrongEmitter, Cancelled }
pub use super::inner_ready::ReadyOperation;
pub struct ProgramReply { pub(super) request: ProgramRequest, pub(super) value: ReplyValue, pub(super) emitter: Option<ProcessorEmitter> }
pub(super) enum ReplyValue { ItemChild(Box<ProgramReply>), Opening(super::inner_opening::OpeningAdapterReply), Layers(super::inner_layers::LayerReply), Voids(super::inner_voids::VoidReply), TypeMap(super::inner_type_map::TypeMapReply), Product(super::inner_product_adapter::ProductAdapterReply), Mapping(super::inner_mapping::MappingReply), Cache(super::inner_cache::CacheReply), Item(ItemStep), BooleanSource(super::boolean::BooleanSourceReply), BooleanNumerical(super::boolean::BooleanNumericalReply) }
pub struct RejectedProgramReply { pub error: ProgramError, pub reply: ProgramReply }
impl ReplyValue {
    pub(super) fn tag(&self)->u32 {match self { Self::Item(_)=>0,Self::ItemChild(_)=>10, Self::BooleanSource(_)=>1,
        Self::BooleanNumerical(_)=>2,Self::Cache(reply)=>0x2000+u32::from(reply.tag()),Self::Mapping(reply)=>0x1000+u32::from(reply.tag()),Self::Product(reply)=>0x3000+u32::from(reply.tag()),Self::TypeMap(reply)=>0x4000+u32::from(reply.tag()),Self::Layers(reply)=>0x5000+u32::from(reply.tag()),Self::Voids(reply)=>0x7000+u32::from(reply.tag()),Self::Opening(reply)=>0x8000+u32::from(reply.tag()) }}
}
impl std::fmt::Debug for RejectedProgramReply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RejectedProgramReply").field("error", &self.error).field("request", &self.reply.request).finish()
    }
}
impl GeometryProgram {
    pub(crate) fn item(item: DecodedEntity, offset: (f64,f64,f64)) -> Self {
        Self::from_step(Some(ItemStep::Source(ItemSource::new(item, offset))))
    }
    pub(super) fn from_step(step: Option<ItemStep>) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let id = NEXT.fetch_update(Ordering::Relaxed, Ordering::Relaxed,
            |id| id.checked_add(1)).expect("geometry program identities exhausted");
        Self { id, sequence: 0, retained: None, step, pending: None, expected_emitter: None,
            cancelled: false, boolean: None, selected_binding:None, pending_item_reports:None, expected_decoder:None, expected_router: None, expected_payload: None, cache: None, mapping: None, outcome: None, product: None, type_map: None,layers:None,voids:None,opening:None }
    }
    /// Reduce control without borrowing source, router callbacks or a live scope.
    pub fn request(&mut self) -> std::result::Result<Option<ProgramRequest>, ProgramError> {
        if self.cancelled { return Err(ProgramError::Cancelled) }
        if self.pending.is_some() { return Err(ProgramError::Outstanding) }
        let stage = loop {
            if self.outcome.is_some() {return Ok(None)}
            if let Some(opening)=&mut self.opening {
                match opening.poll()? {Some(stage)=>break stage,None=>{self.outcome=opening.take_output();self.opening=None;continue}}
            }
            if let Some(voids)=&mut self.voids {
                match voids.poll()? {Some(stage)=>break stage,None=>{self.outcome=voids.take_output();self.voids=None;continue}}
            }
            if let Some(layers)=&mut self.layers {
                match layers.poll()? {Some(stage)=>break stage,None=>{self.outcome=layers.take_output();self.layers=None;continue}}
            }
            if let Some(type_map)=&mut self.type_map {
                match type_map.poll()? {
                    Some(stage)=>break stage,
                    None=>{self.outcome=type_map.take_output();self.type_map=None;continue}
                }
            }
            if let Some(product)=&mut self.product {
                match product.poll()? {
                    Some(stage)=>break stage,
                    None=>{self.outcome=product.take_output();self.product=None;continue}
                }
            }
            if let Some(cache)=&mut self.cache {
                match cache.poll()? {
                    Some(stage)=>break stage,
                    None=>{self.outcome=Some(cache.take_output().map(GeometryOutput::Mesh));self.cache=None;continue}
                }
            }
            if let Some(mapping)=&mut self.mapping {
                match mapping.poll()? {
                    Some(stage)=>break stage,
                    None=>{self.outcome=mapping.take_output();self.mapping=None;continue}
                }
            }
            if self.boolean.is_some() {
                match self.poll_boolean() {
                    Some(stage) => break stage,
                    None => continue,
                }
            }
            match self.step.as_mut().expect("idle program owns state") {
                ItemStep::Complete(_) => return Ok(None),
                ItemStep::Ready(_) => break ProgramStage::Numerical,
                ItemStep::Source(source) => break match source.phase {
                    ItemPhase::RtcExtension(_) | ItemPhase::PlainExtension => ProgramStage::Extension,
                    _ => ProgramStage::Source,
                },
                ItemStep::Child(child) => match child.program.request()? {
                    Some(child_request) => break child_request.stage,
                    None => {
                        let Some(ItemStep::Child(child)) = self.step.take() else { unreachable!() };
                        self.step = Some(child.finish());
                    }
                },
            }
        };
        self.sequence = self.sequence.checked_add(1).expect("geometry sequence exhausted");
        let request = ProgramRequest { program: self.id, sequence: self.sequence, stage };
        self.pending = Some((request, false));
        Ok(Some(request))
    }
    pub(crate) fn execute(&mut self, request: ProgramRequest, router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>) -> std::result::Result<ProgramReply, ProgramError> {
        self.execute_with_textures(request,router,decoder,None)
    }
    pub(crate) fn execute_with_textures(&mut self, request: ProgramRequest, router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>, textures: Option<&rustc_hash::FxHashMap<u32,crate::ResolvedTextureMap>>)
        -> std::result::Result<ProgramReply,ProgramError> {
        self.execute_with_inputs(request,router,decoder,textures,None)
    }
    pub fn execute_with_inputs(&mut self,request:ProgramRequest,router:&GeometryRouter,decoder:&mut EntityDecoder<'_>,
        textures:Option<&rustc_hash::FxHashMap<u32,crate::ResolvedTextureMap>>,void_index:Option<&rustc_hash::FxHashMap<u32,Vec<u32>>>)
        ->std::result::Result<ProgramReply,ProgramError> {
        self.before_execute(request)?;
        if self.expected_decoder.is_some_and(|owner|owner!=decoder.execution_identity()){return Err(ProgramError::WrongOwner)}
        if !self.selected_matches(router){return Err(ProgramError::WrongEmitter)}
        if self.expected_router.is_some_and(|owner|owner!=router.execution_identity()) {return Err(ProgramError::WrongOwner)}
        if request.stage==ProgramStage::Numerical {
            self.expected_router = Some(router.execution_identity());
            self.expected_decoder=Some(decoder.execution_identity());
            if self.retained.is_some() { return Err(ProgramError::UnsupportedRetained) }
            return Ok(self.take_ready(request)?.execute());
        }
        self.expected_router = Some(router.execution_identity());
        self.expected_decoder = Some(decoder.execution_identity());
        // Consume admission before any callback can unwind. A copied ticket
        // cannot replay work after its recipe was moved into a lexical call.
        self.pending=Some((request,true));
        router.drain_mapping_cleanup();
        let value = if let Some(opening)=&mut self.opening {
            ReplyValue::Opening(opening.execute(router,decoder,textures,void_index)?)
        } else if let Some(voids)=&mut self.voids {
            ReplyValue::Voids(voids.execute(router,decoder,textures,void_index)?)
        } else if let Some(layers)=&mut self.layers {
            ReplyValue::Layers(layers.execute(router,decoder,textures,void_index)?)
        } else if let Some(type_map)=&mut self.type_map {
            ReplyValue::TypeMap(type_map.execute(router,decoder,textures)?)
        } else if let Some(product)=&mut self.product {
            ReplyValue::Product(product.execute_with_inputs(router,decoder,textures,void_index)?)
        } else if let Some(cache)=&mut self.cache {
            ReplyValue::Cache(cache.execute(router,decoder)?)
        } else if let Some(mapping)=&mut self.mapping {
            ReplyValue::Mapping(mapping.execute(router,decoder,textures)?)
        } else if self.boolean.is_some() {
            self.execute_boolean(router, decoder)?
        } else if matches!(self.step,Some(ItemStep::Child(_))) {
            let Some(ItemStep::Child(child))=self.step.as_mut() else {unreachable!()};
            let request=child.program.pending_request().expect("requested child");
            ReplyValue::ItemChild(Box::new(child.program.execute_with_inputs(request,router,decoder,textures,void_index)?))
        } else {
            let step=self.step.take().expect("unexecuted request owns recipe");
            ReplyValue::Item(match step {
                ItemStep::Source(source)=>match self.retained { Some(contract)=>source.execute_retained(router,decoder,contract,self.id), None=>source.execute(router,decoder) },
                _=>unreachable!("numerical recipes extracted above"),
            })
        };
        let emitter = match &value {
            ReplyValue::Item(ItemStep::Ready(ready)) => Some(ready.emitter),
            ReplyValue::Item(ItemStep::Complete(value)) => value.emitter,
            _ => self.boolean.as_ref().and_then(|state| state.emitter()),
        };
        self.expected_payload = Some(value.tag());
        self.expected_emitter = emitter;
        self.expected_router = Some(router.execution_identity());
        self.expected_decoder=Some(decoder.execution_identity());
        self.pending = Some((request, true));
        Ok(ProgramReply { request, value, emitter })
    }
    pub(super) fn pending_request(&self) -> Option<ProgramRequest> { self.pending.map(|(request,_)|request) }
    pub(super) fn before_execute(&self, request: ProgramRequest) -> std::result::Result<(), ProgramError> {
        if self.cancelled { return Err(ProgramError::Cancelled) }
        match self.pending {
            Some((pending, false)) if pending == request => Ok(()),
            Some((pending, true)) if pending == request => Err(ProgramError::AlreadyExecuted),
            _ => Err(ProgramError::StaleRequest),
        }
    }
    pub(super) fn validate_cancel_router(&self, router: &GeometryRouter) -> std::result::Result<(), ProgramError> {
        if self.expected_router.is_some_and(|owner| owner != router.execution_identity()) {
            return Err(ProgramError::WrongOwner);
        }
        Ok(())
    }
    fn selected_matches(&self,router:&GeometryRouter)->bool {
        self.selected_binding.as_ref().is_none_or(|(ty,emitter)|router.processor_for(ty)
            .and_then(|processor|router.processor_emitter(processor.as_ref()))==Some(*emitter))
    }
    pub fn validate_reply(&self,reply:&ProgramReply,router:&GeometryRouter)->std::result::Result<(),ProgramError> {
        let error = if !self.selected_matches(router){Some(ProgramError::WrongEmitter)} else if self.boolean.as_ref().is_some_and(|state|!state.matches_router(router)) {Some(ProgramError::WrongEmitter)} else if self.expected_router.is_some_and(|owner| owner != router.execution_identity()) { Some(ProgramError::WrongOwner) } else if self.cancelled { Some(ProgramError::Cancelled) } else {
            match self.pending {
                Some((pending, true)) if pending == reply.request => {
                    if self.expected_payload != Some(reply.value.tag()) {Some(ProgramError::WrongPayload)}
                    else {(reply.emitter != self.expected_emitter).then_some(ProgramError::WrongEmitter)}
                }
                Some((pending, false)) if pending == reply.request => Some(ProgramError::NotExecuted),
                _ => Some(ProgramError::StaleRequest),
            }
        };
        if let Some(error)=error{return Err(error)}
        match &reply.value {
            ReplyValue::Mapping(reply)=>self.mapping.as_ref().ok_or(ProgramError::WrongPayload)?.validate_reply(reply,router),
            ReplyValue::Cache(reply)=>self.cache.as_ref().ok_or(ProgramError::WrongPayload)?.validate_reply(reply,router),
            ReplyValue::Product(reply)=>self.product.as_ref().ok_or(ProgramError::WrongPayload)?.validate_reply(reply,router),
            ReplyValue::TypeMap(reply)=>self.type_map.as_ref().ok_or(ProgramError::WrongPayload)?.validate_reply(reply,router),
            ReplyValue::Layers(reply)=>self.layers.as_ref().ok_or(ProgramError::WrongPayload)?.validate_reply(reply,router),
            ReplyValue::Opening(reply)=>self.opening.as_ref().ok_or(ProgramError::WrongPayload)?.validate_reply(reply,router),
            ReplyValue::Voids(reply)=>self.voids.as_ref().ok_or(ProgramError::WrongPayload)?.validate_reply(reply,router),
            ReplyValue::ItemChild(reply)=>match self.step.as_ref() {
                Some(ItemStep::Child(child))=>child.program.validate_reply(reply,router),_=>Err(ProgramError::WrongPayload),
            },
            _=>Ok(()),
        }
    }
    pub fn accept(&mut self, reply: ProgramReply, router: &GeometryRouter)
        -> std::result::Result<(), Box<RejectedProgramReply>> {
        if let Err(error)=self.validate_reply(&reply,router) {return Err(Box::new(RejectedProgramReply {error,reply}))}
        router.drain_mapping_cleanup();
        match reply.value {
            ReplyValue::Opening(reply)=>self.opening.as_mut().expect("opening continuation").accept(reply,router),
            ReplyValue::Layers(reply)=>self.layers.as_mut().expect("layer continuation").accept(reply,router),
            ReplyValue::Voids(reply)=>self.voids.as_mut().expect("void continuation").accept(reply,router),
            ReplyValue::TypeMap(reply)=>self.type_map.as_mut().expect("type map continuation").accept(reply,router),
            ReplyValue::Product(reply)=>self.product.as_mut().expect("product continuation").accept(reply,router),
            ReplyValue::Cache(reply)=>self.cache.as_mut().expect("cache continuation").accept(reply,router),
            ReplyValue::Mapping(reply)=>self.mapping.as_mut().expect("mapping continuation").accept(reply,router),
            ReplyValue::ItemChild(reply) => {
                let Some(ItemStep::Child(child))=self.step.as_mut() else {unreachable!()};
                child.program.accept(*reply,router).expect("validated nested program reply");
            }
            ReplyValue::Item(mut step) => {
                if let ItemStep::Complete(value) = &mut step {
                    if let Some(reports)=self.pending_item_reports.take(){
                        let mut source=reports.take();source.merge(std::mem::take(&mut value.reports));value.reports=source;
                    }
                    if value.reports.curve_capped { router.record_unsupported_item(ifc_lite_core::IfcType::IfcBSplineCurveWithKnots); }
                    for ty in &value.reports.face_refused { router.record_unsupported_item(ty.clone()); }
                    value.reports=Default::default();
                }
                self.step = Some(step);
            }
            value => self.accept_boolean(value, router),
        }
        self.pending = None;
        self.expected_emitter = None;
        Ok(())
    }
    /// Cooperative explicit cancellation discards this occurrence's partial work.
    pub(crate) fn cancel(&mut self) {
        self.cancelled = true; self.step = None;
        if let Some(state) = &mut self.boolean { let _ = state.program.cancel(); }
        if let Some(mapping)=&mut self.mapping {mapping.cancel()}
        if let Some(product)=&mut self.product {product.cancel()}
        if let Some(type_map)=&mut self.type_map {type_map.cancel()}
        if let Some(layers)=&mut self.layers {layers.cancel()}
        if let Some(voids)=&mut self.voids {voids.cancel()}
        self.opening=None; }
    pub(crate) fn finish(self) -> Result<Mesh> { self.finish_with_reports().result.and_then(super::retained::ItemValue::into_mesh) }
    pub(crate) fn finish_with_reports(self) -> super::item::ItemResult {
        assert!(self.pending.is_none(), "outstanding geometry request");
        if let Some(outcome)=self.outcome {
            let result=outcome.and_then(|outcome|match outcome {
                GeometryOutput::Mesh(mesh)=>Ok(mesh),
                GeometryOutput::Parts(mut parts) if parts.len()<=1=>Ok(parts.pop().unwrap_or_default()),
                _=>Err(crate::Error::geometry("Geometry output is not one mesh")),
            });
            return super::item::ItemResult {result:result.map(super::retained::ItemValue::Mesh),reports:Default::default(),emitter:None}
        }
        match self.step { Some(ItemStep::Complete(value)) => value,
            _ => panic!("geometry program must complete before publication") }
    }
    pub(crate) fn drain(mut self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>) -> Result<Mesh> {
        while let Some(request) = self.request().expect("synchronous geometry request") {
            let reply = self.execute(request, router, decoder).expect("synchronous geometry work");
            self.accept(reply, router).expect("synchronous geometry acceptance");
        }
        self.finish()
    }
}

#[cfg(test)]
#[path = "inner_tests.rs"]
mod tests;

#[cfg(test)]
#[path="inner_item_reports_tests.rs"]
mod item_reports_tests;
