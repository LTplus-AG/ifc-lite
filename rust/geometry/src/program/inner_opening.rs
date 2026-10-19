// SPDX-License-Identifier: MPL-2.0
//! Common linear protocol adapter for opening sources, numerics and real children.
use super::inner::{
    GeometryOutput, GeometryProgram, ProgramError, ProgramReply, ProgramRequest, ProgramStage,
};
use super::openings::{
    OpeningChild, OpeningControl, OpeningOutput, OpeningPoll, OpeningReady, OpeningReply,
    OpeningSource,
};
use crate::{GeometryRouter, Mesh, ResolvedTextureMap, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use rustc_hash::FxHashMap;

enum Action {
    Source(OpeningSource),
    Ready(OpeningReady),
    Admit(OpeningChild),
    Child(ProgramRequest),
    ChildFinished,
}
struct Child {
    program: Box<GeometryProgram>,
    mesh: bool,
}
pub(super) struct OpeningAdapterReply(Reply);
enum Reply {
    Opening(OpeningReply),
    Admitted(Result<Child>),
    Child(Box<ProgramReply>),
    Parts(Result<Vec<Mesh>>),
    RetainedParts(Result<Vec<super::retained::LogicalRetainedValue>>),
    Stopped(crate::Error),
}
pub(super) struct OpeningAdapter {
    control: OpeningControl,
    retained: Option<super::retained::RetainedContract>,
    action: Option<Action>,
    child: Option<Child>,
    output: Option<Result<GeometryOutput>>,
}
impl OpeningAdapter {
    pub(super) fn new(element: DecodedEntity, ids: Vec<u32>) -> Self {
        Self {
            control: OpeningControl::context(element, ids),
            retained:None,
            action: None,
            child: None,
            output: None,
        }
    }
    pub(super) fn select_retained(&mut self,contract:super::retained::RetainedContract) {
        self.retained=Some(contract);self.control.select_retained();
    }
    pub(super) fn poll(&mut self) -> std::result::Result<Option<ProgramStage>, ProgramError> {
        if self.output.is_some() {
            return Ok(None);
        }
        if let Some(action) = &self.action {
            return Ok(Some(action.stage()));
        }
        if let Some(child) = &mut self.child {
            self.action = Some(match child.program.request()? {
                Some(request) => Action::Child(request),
                None => Action::ChildFinished,
            });
        } else {
            self.action = Some(match self.control.poll() {
                OpeningPoll::Source(source) => Action::Source(source),
                OpeningPoll::Ready(ready) => Action::Ready(ready),
                OpeningPoll::Geometry(child) => Action::Admit(child),
                OpeningPoll::Complete(output) => {
                    self.output = Some(output.and_then(|output| match output {
                        OpeningOutput::RetainedContext(context)=>Ok(GeometryOutput::RetainedOpeningContext(context)),
                        OpeningOutput::Context(context) => {
                            Ok(GeometryOutput::OpeningContext(context))
                        }
                        _ => Err(crate::Error::geometry(
                            "Opening root returned a non-context output",
                        )),
                    }));
                    return Ok(None);
                }
                OpeningPoll::Pending => return Err(ProgramError::Outstanding),
            });
        }
        Ok(self.action.as_ref().map(Action::stage))
    }
    pub(super) fn execute(
        &mut self,
        router: &GeometryRouter,
        decoder: &mut EntityDecoder<'_>,
        textures: Option<&FxHashMap<u32, ResolvedTextureMap>>,
        voids: Option<&FxHashMap<u32, Vec<u32>>>,
    ) -> std::result::Result<OpeningAdapterReply, ProgramError> {
        if let Err(stop) = crate::resource::check_current() {
            return Ok(OpeningAdapterReply(Reply::Stopped(stop.into())));
        }
        if self.retained.is_some() {super::retained_walk::charge(1).map_err(|error|match error {
            crate::Error::ProgramStopped(stop)=>ProgramError::TraversalStopped(stop),_=>ProgramError::UnsupportedRetained,
        })?;}
        let reply = match self.action.take().expect("requested opening action") {
            Action::Source(source) => Reply::Opening(source.execute(router, decoder)),
            Action::Ready(ready) => Reply::Opening(ready.execute()),
            Action::Admit(child) => {
                let admitted=match self.retained {Some(contract)=>child.admit_retained(router,contract),None=>child.admit(router)};
                Reply::Admitted(admitted.map(|(program, mesh)| Child {
                    program: Box::new(program),
                    mesh,
                }))
            }
            Action::Child(request) => Reply::Child(Box::new(
                self.child
                    .as_mut()
                    .expect("opening geometry child")
                    .program
                    .execute_with_inputs(request, router, decoder, textures, voids)?,
            )),
            Action::ChildFinished => {
                let mut child = self.child.take().expect("completed opening geometry child");
                if self.retained.is_some() {
                    return Ok(OpeningAdapterReply(Reply::RetainedParts(child.program.take_geometry_output().and_then(|output|match output {
                        GeometryOutput::Retained(values)=>Ok(values),
                        _=>Err(crate::Error::geometry("opening child did not return retained values")),
                    }))));
                }
                Reply::Parts(if child.mesh {
                    (*child.program).finish().map(|mesh| vec![mesh])
                } else {
                    (*child.program).finish_parts()
                })
            }
        };
        Ok(OpeningAdapterReply(reply))
    }
    pub(super) fn validate_reply(
        &self,
        reply: &OpeningAdapterReply,
        router: &GeometryRouter,
    ) -> std::result::Result<(), ProgramError> {
        if let Reply::Child(reply) = &reply.0 {
            self.child
                .as_ref()
                .ok_or(ProgramError::WrongPayload)?
                .program
                .validate_reply(reply, router)?;
        }
        Ok(())
    }
    pub(super) fn accept(&mut self, reply: OpeningAdapterReply, router: &GeometryRouter) {
        match reply.0 {
            Reply::Opening(reply) => self.control.resume(reply, router),
            Reply::Admitted(reply) => match reply {
                Ok(child) => self.child = Some(child),
                Err(error) => self.control.resume(if self.retained.is_some() {
                    OpeningReply::RetainedParts(Err(error))
                } else {OpeningReply::Parts(Err(error))}, router),
            },
            Reply::Child(reply) => self
                .child
                .as_mut()
                .expect("pending opening child")
                .program
                .accept(*reply, router)
                .expect("validated opening child reply"),
            Reply::RetainedParts(reply)=>self.control.resume(OpeningReply::RetainedParts(reply),router),
            Reply::Parts(reply) => self.control.resume(OpeningReply::Parts(reply), router),
            Reply::Stopped(error) => {
                self.cancel_with_reports(router);
                self.output = Some(Err(error));
            }
        }
        if let Err(stop) = crate::resource::check_current() {
            self.cancel_with_reports(router);
            self.output = Some(Err(stop.into()));
        }
        if self.output.is_none() && self.action.is_none() {
            if let Err(error) = self.poll() {
                panic!("accepted opening transition cannot remain outstanding: {error:?}")
            }
        }
        if self.output.is_some() {
            self.publish_reports(router);
        }
    }
    pub(super) fn take_ready(&mut self) -> Option<OpeningReady> {
        if !matches!(self.action, Some(Action::Ready(_))) {
            return None;
        }
        let Some(Action::Ready(ready)) = self.action.take() else {
            unreachable!()
        };
        Some(ready)
    }
    pub(super) fn take_child_ready(
        &mut self,
    ) -> std::result::Result<Option<super::ReadyOperation>, ProgramError> {
        let Some(Action::Child(request)) = self.action.as_ref() else {
            return Ok(None);
        };
        if request.stage() != ProgramStage::Numerical {
            return Ok(None);
        }
        let ready = self
            .child
            .as_mut()
            .expect("reached opening child")
            .program
            .take_ready(*request)?;
        self.action = None;
        Ok(Some(ready))
    }
    pub(super) fn take_output(&mut self) -> Option<Result<GeometryOutput>> {
        self.output.take()
    }
    fn publish_reports(&mut self, router: &GeometryRouter) {
        let reports = self.control.take_reports();
        if reports.curve_capped {
            router.record_unsupported_item(ifc_lite_core::IfcType::IfcBSplineCurveWithKnots);
        }
        for ty in reports.face_refused {
            router.record_unsupported_item(ty);
        }
    }
    pub(super) fn cancel_with_reports(&mut self, router: &GeometryRouter) {
        self.publish_reports(router);
        if let Some(child) = &mut self.child {
            child.program.cancel_with_reports(router).expect("validated cancellation router");
        }
        self.action = None;
        self.child = None;
        self.control.cancel();
    }
}
impl Action {
    fn stage(&self) -> ProgramStage {
        match self {
            Self::Ready(_) => ProgramStage::Numerical,
            Self::Child(request) => request.stage(),
            Self::Source(_) | Self::Admit(_) | Self::ChildFinished => ProgramStage::Source,
        }
    }
}

impl OpeningAdapterReply {
    pub(super) fn tag(&self) -> u16 {
        match &self.0 {
            Reply::Opening(reply) => reply.numerical_tag().unwrap_or(0),
            Reply::Admitted(_) => 100,
            Reply::Child(_) => 101,
            Reply::Parts(_) | Reply::RetainedParts(_) => 102,
            Reply::Stopped(_) => 103,
        }
    }
    pub(super) fn child_reply_mut(&mut self)->Option<&mut ProgramReply> {
        match &mut self.0 {Reply::Child(reply)=>Some(reply),_=>None}
    }
    pub(super) fn from_ready(reply: OpeningReply) -> Self {
        Self(Reply::Opening(reply))
    }
    pub(super) fn wrap_child_reply(reply: ProgramReply) -> Self {
        Self(Reply::Child(Box::new(reply)))
    }
}
