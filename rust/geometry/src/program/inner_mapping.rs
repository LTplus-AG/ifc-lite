// SPDX-License-Identifier: MPL-2.0
//! Common-program adapter for both canonical mapping consumers. The mapping
//! frames own control; this adapter schedules their actual child programs.
use super::inner::{GeometryOutput, GeometryProgram, ProgramError, ProgramReply, ProgramRequest, ProgramStage};
use super::mapping::{MergedPoll, MergedReady, MergedReply, MergedSource, MergedWalk,
    SubmeshPoll, SubmeshReady, SubmeshReply, SubmeshSource, SubmeshWalk};
use crate::{GeometryRouter, Mesh, Result, SubMeshCollection, ResolvedTextureMap};
use super::mapping::MappedValues;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use rustc_hash::FxHashMap;
use std::sync::{Arc, Mutex};

type Textures = FxHashMap<u32, ResolvedTextureMap>;
enum Walk { Merged(MergedWalk), Styled(SubmeshWalk) }
enum Action {
    MergedSource(MergedSource), MergedReady(MergedReady),
    StyledSource(SubmeshSource), StyledReady(SubmeshReady),
    Child(ProgramRequest), ChildFinished,
    TextureSource(DecodedEntity), TextureReady(TextureRecipe),
}
struct Child { program: Box<GeometryProgram>, mode: ChildMode, policy: bool }
#[derive(Clone, Copy)]
enum ChildMode { Merged, Styled(u32), Shared }
pub(super) struct TextureRecipe { ready: super::inner_product::ReadyTexture, id: u32 }
/// The common ready envelope can move these derived numeric inputs without
/// carrying this adapter, its decoded continuations, or a child program.
pub(super) enum MappingReadyWork {
    Merged(MergedReady), Styled(SubmeshReady), Texture(TextureRecipe),
}
impl MappingReadyWork {
    pub(super) fn tag(&self)->u16 {match self {
        Self::Merged(ready)=>u16::from(ready.reply_tag()),
        Self::Styled(ready)=>64+u16::from(ready.reply_tag()),
        Self::Texture(_)=>131,
    }}
    pub(super) fn execute(self)->MappingReply {
        MappingReply(match self {
            Self::Merged(ready)=>Reply::Merged(ready.execute()),
            Self::Styled(ready)=>Reply::Styled(ready.execute()),
            Self::Texture(recipe)=>Reply::TextureExecuted(recipe.execute()),
        })
    }
}
pub(super) struct MappingReply(Reply);
enum Reply {
    Merged(MergedReply), Styled(SubmeshReply), Child(Box<ProgramReply>), Stopped(crate::Error),
    ChildFinished { mode: ChildMode, result: Result<GeometryOutput> }, TextureLowered(Option<TextureRecipe>),
    TextureExecuted(Result<Option<SubMeshCollection>>),
}
impl MappingReply {
    pub(super) fn wrap_child_reply(reply:ProgramReply)->Self {Self(Reply::Child(Box::new(reply)))}
    pub(super) fn tag(&self)->u16 {match &self.0 {
        Reply::Merged(reply)=>reply.tag() as u16,
        Reply::Styled(reply)=>64+reply.tag() as u16,
        Reply::Child(_)=>128,Reply::ChildFinished {..}=>129,Reply::TextureLowered(_)=>130,
        Reply::TextureExecuted(_)=>131,Reply::Stopped(_)=>132,
    }}
}
pub(super) struct MappingControl {
    id: u64, walk: Walk, action: Option<Action>, child: Option<Child>,
    output: Option<Result<GeometryOutput>>, offset: (f64, f64, f64),
    cleanup: Option<Arc<Mutex<Vec<u64>>>>,
    retained: Option<super::retained::RetainedContract>,
}
impl MappingControl {
    pub(super) fn merged(item: &DecodedEntity, router: &GeometryRouter, id: u64) -> Result<Self> {
        Ok(Self { id, walk:Walk::Merged(MergedWalk::new(item, router)?), action:None, child:None,
            output:None, offset:router.rtc_offset(), cleanup:None,retained:None })
    }
    pub(super) fn select_retained(&mut self, contract: super::retained::RetainedContract, cache: super::mapping::SharedRetainedCache) {
        self.retained=Some(contract);
        let Walk::Merged(walk)=&mut self.walk else { unreachable!("retained merged walk") };
        walk.select_retained(self.id,contract,cache);
    }
    pub(super) fn styled(item: &DecodedEntity, allow_instancing: bool, router: &GeometryRouter, id: u64) -> Result<Self> {
        Ok(Self { id, walk:Walk::Styled(SubmeshWalk::new(item, allow_instancing, router)?), action:None,
            child:None, output:None, offset:router.rtc_offset(), cleanup:None,retained:None })
    }
    pub(super) fn poll(&mut self) -> std::result::Result<Option<ProgramStage>, ProgramError> {
        if self.output.is_some() { return Ok(None) }
        if let Some(action) = &self.action { return Ok(Some(action.stage())) }
        if let Some(child) = &mut self.child {
            self.action = Some(match child.program.request()? {
                Some(request) => Action::Child(request), None => Action::ChildFinished,
            });
            return Ok(self.action.as_ref().map(Action::stage));
        }
        let action = match &mut self.walk {
            Walk::Merged(walk) => match walk.poll() {
                MergedPoll::Source(source) => Action::MergedSource(source),
                MergedPoll::Ready(ready) => Action::MergedReady(ready),
                MergedPoll::Child { item, policy } => {
                    self.child = Some(Child { program:Box::new(match self.retained {Some(contract)=>GeometryProgram::retained_item(item,contract),None=>GeometryProgram::item(item,self.offset)}), mode:ChildMode::Merged, policy });
                    return self.poll();
                }
                MergedPoll::Complete(result) => { self.output = Some(result.map(|(parts, _)| match parts {MappedValues::Mesh(parts)=>GeometryOutput::Parts(parts),MappedValues::Retained(values)=>GeometryOutput::Retained(values)})); return Ok(None) }
            },
            Walk::Styled(walk) => match walk.poll() {
                SubmeshPoll::Source(source) => Action::StyledSource(source),
                SubmeshPoll::Ready(ready) => Action::StyledReady(ready),
                SubmeshPoll::Child { item, policy, shared, .. } => {
                    let mode = if shared { ChildMode::Shared } else { ChildMode::Styled(item.id) };
                    let program = if shared { GeometryProgram::item(item.clone(), self.offset) }
                        else { GeometryProgram::representation_item(item.clone(), self.offset) };
                    self.child = Some(Child { program:Box::new(program), mode, policy });
                    if shared { return self.poll() }
                    Action::TextureSource(item)
                }
                SubmeshPoll::Complete(result) => { self.output = Some(result.map(GeometryOutput::Submeshes)); return Ok(None) }
            },
        };
        let stage = action.stage(); self.action = Some(action); Ok(Some(stage))
    }
    pub(super) fn take_ready(&mut self)->Option<MappingReadyWork> {
        if !matches!(self.action,Some(Action::MergedReady(_) | Action::StyledReady(_) | Action::TextureReady(_))) {return None}
        Some(match self.action.take().expect("reached mapping numerical action") {
            Action::MergedReady(ready)=>MappingReadyWork::Merged(ready),
            Action::StyledReady(ready)=>MappingReadyWork::Styled(ready),
            Action::TextureReady(recipe)=>MappingReadyWork::Texture(recipe),
            _=>unreachable!(),
        })
    }
    pub(super) fn take_child_ready(&mut self)->std::result::Result<Option<super::inner::ReadyOperation>,ProgramError> {
        let Some(Action::Child(request))=self.action.as_ref() else {return Ok(None)};
        if request.stage()!=ProgramStage::Numerical {return Ok(None)}
        let ready=self.child.as_mut().expect("reached mapping child").program.take_ready(*request)?;
        self.action=None;Ok(Some(ready))
    }
    pub(super) fn execute(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>, textures: Option<&Textures>)
        -> std::result::Result<MappingReply, ProgramError> {
        self.cleanup.get_or_insert_with(|| router.mapping_cleanup_queue());
        if let Some(ready)=self.take_ready() {return Ok(ready.execute())}
        if let Err(stop) = crate::resource::check_current() { return Ok(MappingReply(Reply::Stopped(stop.into()))) }
        Ok(MappingReply(match self.action.take().expect("requested mapping action") {
            Action::MergedSource(source) => {
                let Walk::Merged(walk)=&self.walk else {unreachable!()};
                Reply::Merged(walk.execute_source(source,router,decoder))
            },
            Action::MergedReady(_) | Action::StyledReady(_) | Action::TextureReady(_) => unreachable!("numerical action extracted above"),
            Action::StyledSource(source) => Reply::Styled(router.with_mapping_program_store(self.id,
                |store| source.execute(router, decoder, textures, store))),
            Action::Child(request) => {
                let child = self.child.as_mut().expect("reached mapping child");
                Reply::Child(Box::new(router.with_unsupported_policy(child.policy, ||
                    child.program.execute_with_textures(request, router, decoder, textures))?))
            }
            Action::ChildFinished => {
                let mut child = self.child.take().expect("completed mapping child");
                let result = if self.retained.is_some() { child.program.take_geometry_output() }
                    else { (*child.program).finish().map(GeometryOutput::Mesh) };
                Reply::ChildFinished { mode:child.mode, result }
            },
            Action::TextureSource(item) => {
                let recipe = if matches!(item.ifc_type, IfcType::IfcTriangulatedFaceSet | IfcType::IfcTriangulatedIrregularNetwork) {
                    match textures.and_then(|index| index.get(&item.id)) {
                        Some(texture) => match super::inner_product::ReadyTexture::admit(&item, texture,
                            Some(self.offset), router, decoder) {
                            Ok(ready) => ready.map(|ready| TextureRecipe { ready, id:item.id }),
                            Err(error) => return Ok(MappingReply(Reply::Stopped(error))),
                        }
                        None => None,
                    }
                } else { None };
                Reply::TextureLowered(recipe)
            }
        }))
    }
    /// Recursively authenticate nested work while the caller still owns the
    /// complete linear packet; no cleanup or publication runs during validation.
    pub(super) fn validate_reply(&self,reply:&MappingReply,router:&GeometryRouter)
        ->std::result::Result<(),ProgramError> {
        match &reply.0 {
            Reply::Child(reply)=>self.child.as_ref().ok_or(ProgramError::StaleRequest)?
                .program.validate_reply(reply,router),
            _=>Ok(()),
        }
    }
    pub(super) fn accept(&mut self, reply: MappingReply, router: &GeometryRouter) {
        if !matches!(&reply.0,Reply::Child(_)) {
            if let Err(stop)=crate::resource::check_current() {
                self.cancel_with_reports(router);self.output=Some(Err(stop.into()));return;
            }
        }
        match reply.0 {
            Reply::Stopped(error) => { self.action = None; self.child = None; self.output = Some(Err(error)); }
            Reply::Merged(reply) => {
                let Walk::Merged(walk) = &mut self.walk else { unreachable!() };
                walk.accept(reply, router);
            }
            Reply::Styled(reply) => {
                let Walk::Styled(walk) = &mut self.walk else { unreachable!() };
                router.with_mapping_program_store(self.id, |store| walk.accept(reply, router, store));
            }
            Reply::Child(reply) => {
                let child = self.child.as_mut().expect("pending mapping child");
                router.with_unsupported_policy(child.policy, || child.program.accept(*reply, router))
                    .expect("validated mapping child reply");
            }
            Reply::ChildFinished { mode, result } => {
                match (&mut self.walk, mode) {
                    (Walk::Merged(walk), ChildMode::Merged) => walk.accept_values(result.and_then(|value| match value {
                        GeometryOutput::Retained(values)=>Ok(MappedValues::Retained(values)),
                        GeometryOutput::Mesh(mesh)=>Ok(MappedValues::Mesh(vec![mesh])),
                        _=>Err(crate::Error::geometry("mapped child contract mismatch")),
                    }), router),
                    (Walk::Styled(walk), ChildMode::Shared) => walk.accept_shared_child(result.and_then(exact_child).map(|mesh|vec![mesh]), router),
                    (Walk::Styled(walk), ChildMode::Styled(id)) => {
                        let result = result.and_then(exact_child).and_then(|mesh| {
                            let mut meshes = SubMeshCollection::new();
                            if !mesh.is_empty() { super::mapping::admit_styled_output(&mesh, 0, &mut meshes)?; meshes.add(id, mesh); }
                            Ok(meshes)
                        });
                        walk.accept_child(result, router);
                    }
                    _ => unreachable!(),
                }
            }
            Reply::TextureExecuted(Err(error)) => { self.child = None; self.output = Some(Err(error)); }
            Reply::TextureLowered(Some(recipe)) => self.action = Some(Action::TextureReady(recipe)),
            Reply::TextureLowered(None) | Reply::TextureExecuted(Ok(None)) => {},
            Reply::TextureExecuted(Ok(Some(meshes))) => {
                self.child = None;
                let Walk::Styled(walk) = &mut self.walk else { unreachable!() };
                walk.accept_child(Ok(meshes), router);
            }
        }
        if let Err(stop)=crate::resource::check_current() {
            self.cancel_with_reports(router);self.output=Some(Err(stop.into()));
        }
    }
    pub(super) fn take_output(&mut self) -> Option<Result<GeometryOutput>> {
        let output = self.output.take()?;
        self.queue_cleanup();
        Some(output)
    }
    pub(super) fn cancel(&mut self) { self.action = None; self.child = None; self.queue_cleanup(); }
    fn queue_cleanup(&mut self) {
        if let Some(queue) = self.cleanup.take() { queue.lock().unwrap_or_else(|e| e.into_inner()).push(self.id); }
    }
}
impl Drop for MappingControl { fn drop(&mut self) { self.queue_cleanup(); } }
impl Action {
    fn stage(&self) -> ProgramStage {
        match self {
            Self::MergedReady(_) | Self::StyledReady(_) | Self::TextureReady(_) => ProgramStage::Numerical,
            Self::Child(request) => request.stage(),
            _ => ProgramStage::Source,
        }
    }
}
impl TextureRecipe {
    fn execute(self) -> Result<Option<SubMeshCollection>> {
        let Some((mesh, uvs, attachment)) = self.ready.execute()? else { return Ok(None) };
        let mut meshes = SubMeshCollection::new();
        super::mapping::admit_styled_output(&mesh, uvs.len(), &mut meshes)?;
        meshes.add_textured(self.id, mesh, uvs, attachment);
        Ok(Some(meshes))
    }
}

impl MappingControl {
    pub(super) fn cancel_with_reports(&mut self,router:&GeometryRouter) {
        if let Some(child)=&mut self.child {child.program.cancel_with_reports(router).expect("validated cancellation router");}
        self.cancel();
    }
}

#[cfg(test)]
#[path="inner_mapping_tests.rs"]
mod tests;

fn exact_child(value: GeometryOutput) -> Result<Mesh> {
    match value { GeometryOutput::Mesh(mesh)=>Ok(mesh),
        _=>Err(crate::Error::geometry("styled mapped child requires exact mesh")) }
}
