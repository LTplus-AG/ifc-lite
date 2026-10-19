// SPDX-License-Identifier: MPL-2.0
//! Voided host composition: canonical body child, one context, ordered cut parts.
use super::inner::{GeometryOutput, GeometryProgram, ProgramError, ProgramReply, ProgramRequest, ProgramStage};
use super::openings::execute::{ReadyOperation, NumericalOutcome};
use crate::{GeometryRouter, Mesh, Result, SubMesh, SubMeshCollection, ResolvedTextureMap};
use crate::router::processing::SourceHygiene;
use super::product_control::ProductConsumer;
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use rustc_hash::FxHashMap;
use std::sync::Arc;

#[derive(Clone,Copy)]
pub(super) enum VoidConsumer { Parts, Styled }
enum ChildRole { Layer, PlainParts, BodyParts, BodyStyled, Context }
struct Child { program:Box<GeometryProgram>, role:ChildRole }
enum Action { Select, Child(ProgramRequest), ChildFinished, PrepareCut(HostPart), Cut(ReadyOperation), Finish(ReadyFinish) }
struct HostPart { mesh:Mesh, id:Option<u32> }
enum Output { Parts(Vec<Mesh>), Styled(SubMeshCollection) }
pub(super) struct ReadyFinish { part:HostPart, output:Output }
pub(super) enum VoidReadyWork { Cut(ReadyOperation), Finish(ReadyFinish) }
impl VoidReadyWork {
    pub(super) fn tag(&self)->u16 {match self {Self::Cut(_)=>5,Self::Finish(_)=>6}}
    pub(super) fn execute(self)->VoidReply {VoidReply(match self {
        Self::Cut(ready)=>Reply::Cut(ready.execute()),Self::Finish(ready)=>Reply::Finished(ready.execute()),
    })}
}
pub(super) struct VoidReply(Reply);
enum Reply { Selected(Vec<u32>), Child(Box<ProgramReply>), ChildFinished(Result<GeometryOutput>),
    Prepared(ReadyOperation), Cut(NumericalOutcome), Finished(Result<Output>), Stopped(crate::Error) }
impl VoidReply {
    pub(super) fn wrap_child_reply(reply:ProgramReply)->Self {Self(Reply::Child(Box::new(reply)))}
    pub(super) fn tag(&self)->u16 {match self.0 {Reply::Selected(_)=>0,Reply::Child(_)=>1,
        Reply::ChildFinished(_)=>2,Reply::Prepared(_)=>3,Reply::Cut(_)=>5,Reply::Finished(_)=>6,Reply::Stopped(_)=>7}}
}
pub(super) struct VoidControl {
    element:DecodedEntity, consumer:VoidConsumer, ids:Vec<u32>, action:Option<Action>, child:Option<Child>,
    parts:std::vec::IntoIter<HostPart>, current_id:Option<u32>, context:Option<Arc<crate::router::voids::ReadyVoidContext>>,
    accumulated:Option<Output>, output:Option<Result<GeometryOutput>>,
}
impl VoidControl {
    pub(super) fn new(element:DecodedEntity,consumer:VoidConsumer)->Self {
        let child=matches!(consumer,VoidConsumer::Styled).then(||Child {
            program:Box::new(GeometryProgram::layer_attempt(element.clone(),true)),role:ChildRole::Layer });
        Self {element,consumer,ids:Vec::new(),action:child.is_none().then_some(Action::Select),child,
            parts:Vec::new().into_iter(),current_id:None,context:None,accumulated:None,output:None}
    }
    pub(super) fn poll(&mut self)->std::result::Result<Option<ProgramStage>,ProgramError> {
        if self.output.is_some(){return Ok(None)}
        if self.action.is_none() {
            if let Some(child)=&mut self.child {
                self.action=Some(match child.program.request()? {Some(request)=>Action::Child(request),None=>Action::ChildFinished});
            } else if let Some(part)=self.parts.next(){self.action=Some(Action::PrepareCut(part));}
            else {
                self.output=Some(Ok(match self.accumulated.take().expect("completed void host") {
                    Output::Parts(parts)=>GeometryOutput::Parts(parts),Output::Styled(meshes)=>GeometryOutput::Submeshes(meshes),
                }));return Ok(None)
            }
        }
        Ok(self.action.as_ref().map(|action|match action {
            Action::Child(request)=>request.stage(),Action::Cut(_)|Action::Finish(_)=>ProgramStage::Numerical,
            _=>ProgramStage::Source,
        }))
    }
    pub(super) fn take_ready(&mut self)->Option<VoidReadyWork> {
        if !matches!(self.action,Some(Action::Cut(_)|Action::Finish(_))){return None}
        Some(match self.action.take().expect("void numerical recipe") {
            Action::Cut(ready)=>VoidReadyWork::Cut(ready),Action::Finish(ready)=>VoidReadyWork::Finish(ready),_=>unreachable!(),
        })
    }
    pub(super) fn take_child_ready(&mut self)->std::result::Result<Option<super::inner::ReadyOperation>,ProgramError> {
        let Some(Action::Child(request))=self.action.as_ref() else{return Ok(None)};
        if request.stage()!=ProgramStage::Numerical{return Ok(None)}
        let ready=self.child.as_mut().expect("void child").program.take_ready(*request)?;
        self.action=None;Ok(Some(ready))
    }
    pub(super) fn execute(&mut self,router:&GeometryRouter,decoder:&mut EntityDecoder<'_>,
        _textures:Option<&FxHashMap<u32,ResolvedTextureMap>>,voids:Option<&FxHashMap<u32,Vec<u32>>>)
        ->std::result::Result<VoidReply,ProgramError> {
        if let Some(ready)=self.take_ready(){return Ok(ready.execute())}
        if let Err(stop)=crate::resource::check_current(){return Ok(VoidReply(Reply::Stopped(stop.into())))}
        Ok(VoidReply(match self.action.take().expect("requested void action") {
            Action::Select=>Reply::Selected(voids.and_then(|index|index.get(&self.element.id)).cloned().unwrap_or_default()),
            Action::Child(request)=>Reply::Child(Box::new(self.child.as_mut().expect("void child").program
                .execute_with_inputs(request,router,decoder,None,voids)?)),
            Action::ChildFinished=>{
                let child=self.child.as_mut().expect("completed void child");
                // The parent retains the child role until authenticated accept.
                Reply::ChildFinished(child.program.take_geometry_output())
            }
            Action::PrepareCut(part)=>{
                self.current_id=part.id;
                Reply::Prepared(ReadyOperation::new(part.mesh,Arc::clone(self.context.as_ref().expect("ready opening context")),
                    self.element.id,router.tessellation_quality(),crate::router::voids::numerical_configuration()))
            }
            Action::Cut(_)|Action::Finish(_)=>unreachable!("numerical recipe extracted above"),
        }))
    }
    pub(super) fn validate_reply(&self,reply:&VoidReply,router:&GeometryRouter)->std::result::Result<(),ProgramError> {
        if let Reply::Child(reply)=&reply.0 {
            self.child.as_ref().ok_or(ProgramError::WrongPayload)?.program.validate_reply(reply,router)?;
        }
        Ok(())
    }
    pub(super) fn accept(&mut self,reply:VoidReply,router:&GeometryRouter) {
        if let Err(error)=self.accept_inner(reply.0,router) {
            self.cancel_with_reports(router);self.output=Some(Err(error));
        }
    }
    fn accept_inner(&mut self,reply:Reply,router:&GeometryRouter)->Result<()> {
        if !matches!(&reply,Reply::Child(_)|Reply::Cut(_)){crate::resource::check_current()?;}
        match reply {
            Reply::Selected(ids)=>{
                self.ids=ids;
                let (program,role)=match self.consumer {
                    VoidConsumer::Parts if self.ids.is_empty()=>(GeometryProgram::product(self.element.clone(),ProductConsumer::Merged,SourceHygiene::Watertight),ChildRole::PlainParts),
                    VoidConsumer::Parts=>(GeometryProgram::opening_body(self.element.clone()),ChildRole::BodyParts),
                    VoidConsumer::Styled if self.ids.is_empty()=>{self.output=Some(Ok(GeometryOutput::Submeshes(SubMeshCollection::new())));return Ok(())}
                    VoidConsumer::Styled=>(GeometryProgram::product(self.element.clone(),ProductConsumer::Styled {allow_instancing:false},SourceHygiene::BooleanOperand),ChildRole::BodyStyled),
                };
                self.child=Some(Child {program:Box::new(program),role});
            }
            Reply::Child(reply)=>self.child.as_mut().expect("void child").program.accept(*reply,router).expect("validated void child reply"),
            Reply::ChildFinished(result)=>{
                let role=self.child.take().expect("completed void child").role;
                match (role,result?) {
                    (ChildRole::Layer,GeometryOutput::LayerCandidate(Some(meshes)))=>self.output=Some(Ok(GeometryOutput::Submeshes(meshes))),
                    (ChildRole::Layer,GeometryOutput::LayerCandidate(None))=>self.action=Some(Action::Select),
                    (ChildRole::PlainParts,GeometryOutput::Parts(parts))=>self.output=Some(Ok(GeometryOutput::Parts(parts))),
                    (ChildRole::BodyParts,GeometryOutput::Parts(parts))=>{
                        self.parts=parts.into_iter().map(|mesh|HostPart {mesh,id:None}).collect::<Vec<_>>().into_iter();
                        self.accumulated=Some(Output::Parts(Vec::new()));self.start_context();
                    }
                    (ChildRole::BodyStyled,GeometryOutput::Submeshes(meshes))=>{
                        if meshes.is_empty(){self.output=Some(Ok(GeometryOutput::Submeshes(SubMeshCollection::new())));return Ok(())}
                        self.accumulated=Some(Output::Styled(SubMeshCollection {sub_meshes:Vec::new(),ids_are_materials:meshes.ids_are_materials}));
                        self.parts=meshes.sub_meshes.into_iter().map(|sub|HostPart {mesh:sub.mesh,id:Some(sub.geometry_id)}).collect::<Vec<_>>().into_iter();
                        self.start_context();
                    }
                    (ChildRole::Context,GeometryOutput::OpeningContext(context))=>self.context=Some(context),
                    _=>return Err(crate::Error::geometry("Wrong void child output")),
                }
            }
            Reply::Prepared(ready)=>self.action=Some(Action::Cut(ready)),
            Reply::Cut(outcome)=>{
                let mesh=outcome.publish(router)?;
                self.action=Some(Action::Finish(ReadyFinish {part:HostPart {mesh,id:self.current_id},output:self.accumulated.take().expect("host output") }));
            }
            Reply::Finished(output)=>self.accumulated=Some(output?),
            Reply::Stopped(error)=>return Err(error),
        }
        crate::resource::check_current()?;Ok(())
    }
    fn start_context(&mut self){self.child=Some(Child {program:Box::new(GeometryProgram::opening_context(self.element.clone(),std::mem::take(&mut self.ids))),role:ChildRole::Context});}
    pub(super) fn take_output(&mut self)->Option<Result<GeometryOutput>>{self.output.take()}
    pub(super) fn cancel_with_reports(&mut self,router:&GeometryRouter){if let Some(child)=&mut self.child{child.program.cancel_with_reports(router).expect("validated cancellation router");}self.cancel();}
    pub(super) fn cancel(&mut self){if let Some(child)=&mut self.child{child.program.cancel();}self.child=None;self.action=None;self.context=None;self.accumulated=None;self.parts=Vec::new().into_iter();}
}
impl ReadyFinish {
    fn clean_part(&mut self) -> Result<()> {
        crate::resource::check_current()?;
        crate::router::voids::hygiene::clean_void_output(&mut self.part.mesh);
        crate::resource::check_current()?;
        Ok(())
    }
    fn execute(mut self)->Result<Output>{
        self.clean_part()?;
        match &mut self.output {
            Output::Parts(parts)=>{self.part.mesh.instance_meta=None;crate::resource::reserve_headers(parts,1)?.retain();parts.push(self.part.mesh);}
            Output::Styled(meshes)=>if !self.part.mesh.is_empty(){crate::resource::reserve_headers(&mut meshes.sub_meshes,1)?.retain();meshes.sub_meshes.push(SubMesh::new(self.part.id.expect("styled item identity"),self.part.mesh));},
        }
        Ok(self.output)
    }
}

#[cfg(test)]
#[path = "inner_voids_tests.rs"]
mod tests;
