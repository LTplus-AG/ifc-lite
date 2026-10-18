// SPDX-License-Identifier: MPL-2.0
//! One immutable model snapshot around the canonical transition implementation.
use super::*;
use super::session::ProductState;
use super::session_protocol::{RejectedReply,WorkError,WorkReply,WorkRequest};
use std::sync::Arc;

/// Private scheduling boundary. All later transitions use the captured context;
/// only dormant work may move to another compatible execution owner.
pub(super) struct OwnedProductExecution {
    pub(super) state:ProductState,
    context:Arc<OwnedMeshProductionContext>,
}
impl OwnedProductExecution {
    /// Independent resumable sessions always use strict owner admission.
    pub fn new(job:&ElementMeshJob<'_>,context:&Arc<OwnedMeshProductionContext>,
        opts:&MeshProductionOptions,decoder:&mut EntityDecoder,router:&GeometryRouter)->Result<Self,WorkError> {
        context.validate_source().map_err(|_|WorkError::StaleSource)?;
        let state=ProductState::new(job,&context.borrowed(),opts,decoder,router);
        Ok(Self::bind(state,context))
    }
    pub(super) fn canonical(job:&ElementMeshJob<'_>,context:&Arc<OwnedMeshProductionContext>,
        opts:&MeshProductionOptions,decoder:&mut EntityDecoder,router:&GeometryRouter)->Result<Self,WorkError> {
        context.validate_source().map_err(|_|WorkError::StaleSource)?;
        match session_canonical::inherited_owner(decoder,router).expect("canonical synchronous ancestor owner") {
            Some(owner)=> {
                let state=ProductState::new_with_owner(job,&context.borrowed(),opts,decoder,router,Some(owner));
                Ok(Self::bind(state,context))
            }
            None=>Self::new(job,context,opts,decoder,router),
        }
    }
    fn bind(mut state:ProductState,context:&Arc<OwnedMeshProductionContext>)->Self {
        state.bind_context(context.id());
        state.presentation_context = Some(Arc::clone(context));
        Self {state,context:Arc::clone(context)}
    }
    fn validate(&self)->Result<(),WorkError> {self.context.validate_source().map_err(|_|WorkError::StaleSource)}
    pub fn request(&mut self)->Result<Option<WorkRequest>,WorkError> {
        self.validate()?;
        self.state.request()
    }
    pub fn execute(&mut self,request:WorkRequest,decoder:&mut EntityDecoder,router:&GeometryRouter)->Result<WorkReply,WorkError> {
        self.validate()?;
        self.state.execute(request,&self.context.borrowed(),decoder,router)
    }
    pub fn accept(&mut self,reply:WorkReply,decoder:&mut EntityDecoder,router:&GeometryRouter)->Result<(),Box<RejectedReply>> {
        if let Err(error)=self.validate() {return Err(Box::new(RejectedReply {error,reply}))}
        self.state.accept(reply,&self.context.borrowed(),decoder,router)
    }
    pub fn advance(&mut self,decoder:&mut EntityDecoder,router:&GeometryRouter)->Result<bool,WorkError> {
        let Some(request)=self.request()? else {return Ok(false)};
        let reply=self.execute(request,decoder,router)?;
        self.accept(reply,decoder,router).map_err(|rejected|rejected.error)?;
        Ok(true)
    }
    pub fn finish(self,decoder:&EntityDecoder,router:&GeometryRouter)->Result<ProducedElementMeshes,WorkError> {
        self.validate()?;
        let result=self.state.finish(decoder,router);
        // A final diagnostic callback may explicitly invalidate the model.
        self.context.validate_source().map_err(|_|WorkError::StaleSource)?;
        Ok(result)
    }
}

/// Canonical synchronous production using one owned immutable model snapshot.
/// Returns `StaleSource` when the caller explicitly expired its source lifecycle.
/// Decoder/router callback and lexical child behavior matches the borrowed entry.
pub fn produce_element_meshes_owned(job:&ElementMeshJob<'_>,context:&Arc<OwnedMeshProductionContext>,
    opts:&MeshProductionOptions,decoder:&mut EntityDecoder,router:&GeometryRouter)->Result<ProducedElementMeshes,ProductionContextError> {
    session_canonical::with_source_resources(decoder, |decoder| {
    if ifc_lite_geometry::resource::check_current().is_err() {
        return Ok(session_canonical::stopped_output());
    }
    let mut execution=OwnedProductExecution::canonical(job,context,opts,decoder,router).map_err(public_error)?;
    while execution.advance(decoder,router).map_err(public_error)? {}
    execution.finish(decoder,router).map_err(public_error)
    })
}
fn public_error(error:WorkError)->ProductionContextError {
    match error {WorkError::StaleSource=>ProductionContextError::StaleSource,
        _=>panic!("canonical owned production invariant: {error:?}")}
}
