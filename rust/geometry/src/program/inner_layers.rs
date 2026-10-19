// SPDX-License-Identifier: MPL-2.0
//! Canonical layer attempt: real voided child, empty gate, late frame and slice.
use super::inner::{GeometryOutput, GeometryProgram, ProgramError, ProgramReply, ProgramRequest, ProgramStage};
use super::layers::{LayerProgram, LayerPlaneRequest, LayerSkip, ReadyLayerPlanes, ReadyLayerSlice, LayerSliceResult};
use crate::{GeometryRouter, Mesh, Result, SubMeshCollection, ResolvedTextureMap};
use crate::material_layer_index::LayerBuildup;
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use rustc_hash::FxHashMap;

enum Action {
    Eligibility(Option<LayerBuildup>), Child(ProgramRequest), ChildFinished,
    Frame(LayerPlaneRequest), Planes(ReadyLayerPlanes), Slice(ReadyLayerSlice), Cleanup(ReadyLayerCleanup),
}
pub(super) struct LayerReply(Reply);
enum Reply {
    Eligible(Result<std::result::Result<Option<LayerProgram>, LayerSkip>>),
    Child(Box<ProgramReply>), Host(Result<Vec<Mesh>>),
    Frame(Result<std::result::Result<ReadyLayerPlanes, LayerSkip>>),
    Planes(std::result::Result<ReadyLayerSlice, LayerSkip>), Sliced(LayerSliceResult),
    Cleaned(SubMeshCollection), Stopped(crate::Error),
    StoppedNumerical { tag: u16, error: crate::Error },
}
pub(super) enum LayerReadyWork {
    Planes(ReadyLayerPlanes), Slice(ReadyLayerSlice), Cleanup(ReadyLayerCleanup),
}
impl LayerReadyWork {
    pub(super) fn tag(&self) -> u16 { match self { Self::Planes(_)=>4, Self::Slice(_)=>5, Self::Cleanup(_)=>6 } }
    pub(super) fn execute(self) -> LayerReply {
        let tag=self.tag();
        if let Err(stop)=crate::resource::check_current() {
            return LayerReply(Reply::StoppedNumerical {tag,error:stop.into()});
        }
        LayerReply(match self {
            Self::Planes(ready)=>Reply::Planes(ready.execute()),
            Self::Slice(ready)=>Reply::Sliced(ready.execute()),
            Self::Cleanup(ready)=>Reply::Cleaned(ready.execute()),
        })
    }
}
impl LayerReply {
    pub(super) fn wrap_child_reply(reply:ProgramReply)->Self {Self(Reply::Child(Box::new(reply)))}
    pub(super) fn tag(&self)->u16 {match &self.0 {
        Reply::Eligible(_)=>0, Reply::Child(_)=>1, Reply::Host(_)=>2, Reply::Frame(_)=>3,
        Reply::Planes(_)=>4, Reply::Sliced(_)=>5, Reply::Cleaned(_)=>6, Reply::Stopped(_)=>7,
        Reply::StoppedNumerical {tag,..}=>*tag,
    }}
}
pub(super) struct LayerControl {
    element: DecodedEntity, use_openings: bool, gateway: bool,
    action: Option<Action>, program: Option<LayerProgram>, child: Option<Box<GeometryProgram>>,
    output: Option<Result<GeometryOutput>>,
}
impl LayerControl {
    pub(super) fn take_ready(&mut self)->Option<LayerReadyWork> {
        Some(match self.action.take()? {
            Action::Planes(ready)=>LayerReadyWork::Planes(ready),
            Action::Slice(ready)=>LayerReadyWork::Slice(ready),
            Action::Cleanup(ready)=>LayerReadyWork::Cleanup(ready),
            source=>{self.action=Some(source);return None},
        })
    }
    pub(super) fn take_child_ready(&mut self)->std::result::Result<Option<super::inner::ReadyOperation>,ProgramError> {
        let Some(Action::Child(request))=self.action.as_ref() else {return Ok(None)};
        if request.stage()!=ProgramStage::Numerical {return Ok(None)}
        let ready=self.child.as_mut().expect("reached layer host").take_ready(*request)?;
        self.action=None;Ok(Some(ready))
    }
    pub(super) fn from_index(element: DecodedEntity, use_openings: bool) -> Self {
        Self::new(element, use_openings, true, None)
    }
    pub(super) fn from_buildup(element: DecodedEntity, buildup: LayerBuildup) -> Self {
        Self::new(element, true, false, Some(buildup))
    }
    fn new(element: DecodedEntity, use_openings: bool, gateway: bool, buildup: Option<LayerBuildup>) -> Self {
        Self { element, use_openings, gateway, action: Some(Action::Eligibility(buildup)),
            program: None, child: None, output: None }
    }
    pub(super) fn poll(&mut self) -> std::result::Result<Option<ProgramStage>, ProgramError> {
        if self.output.is_some() { return Ok(None) }
        if let Some(action) = &self.action { return Ok(Some(action.stage())) }
        let child = self.child.as_mut().expect("active layer host child");
        self.action = Some(match child.request()? { Some(request) => Action::Child(request), None => Action::ChildFinished });
        Ok(self.action.as_ref().map(Action::stage))
    }
    pub(super) fn execute(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>,
        _textures: Option<&FxHashMap<u32, ResolvedTextureMap>>, voids: Option<&FxHashMap<u32, Vec<u32>>>)
        -> std::result::Result<LayerReply, ProgramError> {
        if let Some(ready)=self.take_ready() {return Ok(ready.execute())}
        if let Err(stop) = crate::resource::check_current() { return Ok(LayerReply(Reply::Stopped(stop.into()))) }
        let reply = match self.action.take().expect("requested layer action") {
            Action::Eligibility(buildup) => Reply::Eligible((|| {
                let buildup = match &buildup {
                    Some(buildup) => Some(buildup),
                    None => router.material_layer_index().and_then(|index| index.get(self.element.id))
                        .filter(|buildup| buildup.is_sliceable()),
                };
                let admitted = buildup.map_or(Ok(None), |buildup| LayerProgram::admit(
                    &self.element, decoder, buildup, router.unit_scale()));
                crate::resource::check_current()?;
                Ok(admitted)
            })()),
            Action::Child(request) => Reply::Child(Box::new(self.child.as_mut().expect("layer host")
                .execute_with_inputs(request, router, decoder, None, if self.use_openings { voids } else { None })?)),
            Action::ChildFinished => Reply::Host((*self.child.take().expect("completed layer host")).finish_parts()),
            Action::Frame(request) => Reply::Frame(request.admit_frame(&self.element, decoder, router)),
            Action::Planes(_) | Action::Slice(_) | Action::Cleanup(_) =>
                unreachable!("layer numerical action extracted above"),
        };
        Ok(LayerReply(reply))
    }
    pub(super) fn validate_reply(&self, reply:&LayerReply, router:&GeometryRouter)
        -> std::result::Result<(),ProgramError> {
        if let Reply::Child(reply)=&reply.0 {
            let child=self.child.as_ref().ok_or(ProgramError::WrongPayload)?;
            child.validate_reply(reply,router)?;
        }
        Ok(())
    }

    pub(super) fn accept(&mut self, reply: LayerReply, router: &GeometryRouter) {
        let result = (|| {
            if !matches!(&reply.0, Reply::Child(_)) { crate::resource::check_current()?; }
            self.accept_inner(reply.0, router)?;
            crate::resource::check_current()?;
            Ok(())
        })();
        if let Err(error) = result {
            self.cancel_with_reports(router);
            self.output = Some(Err(error));
        }
    }
    fn accept_inner(&mut self, reply: Reply, router: &GeometryRouter) -> Result<()> {
        match reply {
            Reply::Eligible(result) => match result? {
                Ok(Some(program)) => {
                    self.program = Some(program);
                    self.child = Some(Box::new(GeometryProgram::voided_parts(self.element.clone())));
                }
                Ok(None) => self.complete(None),
                Err(skip) => self.skip(skip, router),
            },
            Reply::Child(reply) => self.child.as_mut().expect("pending layer child").accept(*reply, router)
                .expect("validated layer child reply"),
            Reply::Host(result) => {
                let host = match result.and_then(|parts| crate::router::frame_parts::single_frame(self.element.id, parts)) {
                    Ok(host) => host,
                    Err(error @ crate::Error::ProgramStopped(_)) => return Err(error),
                    Err(error) if self.gateway => { self.base_error(router); let _ = error; return Ok(()) }
                    Err(error) => return Err(error),
                };
                match self.program.take().expect("admitted layer plan").accept_host(host) {
                    Ok(request) => self.action = Some(Action::Frame(request)),
                    Err(skip) => self.skip(skip, router),
                }
            }
            Reply::Frame(result) => match result? {
                Ok(ready) => self.action = Some(Action::Planes(ready)), Err(skip) => self.skip(skip, router),
            },
            Reply::Planes(result) => match result {
                Ok(ready) => self.action = Some(Action::Slice(ready)), Err(skip) => self.skip(skip, router),
            },
            Reply::Sliced(result) => {
                let collection = result.publish(router, self.element.id)?;
                if !self.gateway { self.complete(Some(collection)); }
                else if collection.sub_meshes.len() < 2 { self.too_few(&collection, router); }
                else { self.sliced(&collection); self.action = Some(Action::Cleanup(ReadyLayerCleanup { collection })); }
            }
            Reply::Cleaned(collection) => self.complete(Some(collection)),
            Reply::Stopped(error) | Reply::StoppedNumerical {error,..} => return Err(error),
        }
        Ok(())
    }
    fn complete(&mut self, collection: Option<SubMeshCollection>) {
        self.program = None;
        self.output = Some(Ok(GeometryOutput::LayerCandidate(collection)));
    }
    fn skip(&mut self, skip: LayerSkip, router: &GeometryRouter) {
        router.push_layer_slice_diag(self.element.id, skip.reason()); self.complete(None);
    }
    fn base_error(&mut self, router: &GeometryRouter) {
        router.push_layer_slice_diag(self.element.id, "skip:base-mesh-error");
        crate::diag::diag_warn!(
            { element_id = self.element.id, reason = "base-mesh-error",
              "material-layers: sliceable element failed to slice, keeping single solid" }
            else { eprintln!("[material-layers] #{}: sliceable but slicing errored", self.element.id); }
        );
        self.complete(None);
    }
    fn too_few(&mut self, collection: &SubMeshCollection, _router: &GeometryRouter) {
        crate::diag::diag_warn!(
            { element_id = self.element.id, sub_meshes = collection.sub_meshes.len(), reason = "fewer-than-two-sub-meshes",
              "material-layers: sliceable element produced too few sub-meshes, keeping single solid" }
            else { eprintln!("[material-layers] #{}: sliceable but produced {} sub-mesh(es) (<2) — keeping single solid",
                self.element.id, collection.sub_meshes.len()); }
        );
        self.complete(None);
    }
    fn sliced(&self, collection: &SubMeshCollection) {
        crate::diag::diag_debug!(
            { element_id = self.element.id, sub_meshes = collection.sub_meshes.len(),
              "material-layers: sliced element into layer sub-meshes" }
            else { eprintln!("[material-layers] #{}: sliced into {} layer sub-meshes", self.element.id, collection.sub_meshes.len()); }
        );
    }
    pub(super) fn take_output(&mut self) -> Option<Result<GeometryOutput>> { self.output.take() }
    pub(super) fn cancel(&mut self) { self.action = None; self.program = None; self.child = None; self.output = None; }
    pub(super) fn cancel_with_reports(&mut self, router: &GeometryRouter) {
        if let Some(child) = &mut self.child { child.cancel_with_reports(router).expect("validated cancellation router"); }
        self.cancel();
    }
}
pub(super) struct ReadyLayerCleanup { collection: SubMeshCollection }
impl ReadyLayerCleanup {
    fn execute(mut self) -> SubMeshCollection {
        for sub in &mut self.collection.sub_meshes { sub.mesh.clean_degenerate(); }
        self.collection
    }
}
impl Action {
    fn stage(&self) -> ProgramStage {
        match self {
            Self::Planes(_) | Self::Slice(_) | Self::Cleanup(_) => ProgramStage::Numerical,
            Self::Child(request) => request.stage(),
            _ => ProgramStage::Source,
        }
    }
}

#[cfg(test)]
#[path = "inner_layers_tests.rs"]
mod tests;
