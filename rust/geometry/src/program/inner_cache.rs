// SPDX-License-Identifier: MPL-2.0
//! Item cache ownership surrounds the same selected item program.
use super::inner::{GeometryProgram, ProgramRequest, ProgramReply, ProgramStage, ProgramError};
use crate::{GeometryRouter, Mesh, Result};
use crate::router::item_cache_program::{CacheAdmission, CacheContext};
use ifc_lite_core::{DecodedEntity, EntityDecoder};

enum State {
    Begin(DecodedEntity, (f64,f64,f64)),
    Child(CacheContext, Box<GeometryProgram>),
    Local(CacheContext, Mesh),
    Hash(ReadyCache),
    Pending,
    Complete(Result<Mesh>),
}
enum Action { Begin(DecodedEntity,(f64,f64,f64)), Child(ProgramRequest), Local(CacheContext,Mesh), Hash(ReadyCache) }
pub(super) struct CacheControl { state: State, action: Option<Action>, hash_context:Option<CacheContext> }
pub(super) enum CacheReply {
    Begin(Result<CacheAdmission>, DecodedEntity, (f64,f64,f64)),
    Child(Box<ProgramReply>), Local(CacheContext,Mesh), Hash(Result<(Mesh,Option<u128>)>),
}
struct ReadyCache { context: CacheContext, mesh: Mesh }
/// Hashing owns derived geometry only. Source identity, failure-log marks and
/// publication capability remain in CacheControl until validated acceptance.
pub(super) struct ReadyCacheWork { mesh:Mesh }
impl ReadyCacheWork {
    pub(super) fn tag(&self)->u16 {3}
    pub(super) fn execute(self)->CacheReply {
        CacheReply::Hash((|| {
            crate::resource::check_current()?;
            let rep=if crate::router::transforms::instancing_enabled()
                && self.mesh.instance_meta.is_none() && !self.mesh.positions.is_empty() {
                Some(GeometryRouter::compute_mesh_hash_full(&self.mesh)|(1u128<<127))
            } else {None};
            Ok((self.mesh,rep))
        })())
    }
}
impl CacheReply {
    pub(super) fn wrap_child_reply(reply:ProgramReply)->Self {Self::Child(Box::new(reply))}
    pub(super) fn tag(&self)->u16 {match self {Self::Begin(..)=>0,Self::Child(_)=>1,Self::Local(..)=>2,Self::Hash(_)=>3}}
}
impl CacheControl {
    pub(super) fn new(item: DecodedEntity, offset: (f64,f64,f64)) -> Self {
        Self { state:State::Begin(item,offset), action:None, hash_context:None }
    }
    pub(super) fn poll(&mut self) -> std::result::Result<Option<ProgramStage>, ProgramError> {
        loop {
            let stage = match &mut self.state {
                State::Begin(_,_) => ProgramStage::Source,
                State::Local(_,_) => ProgramStage::Source,
                State::Hash(_) => ProgramStage::Numerical,
                State::Complete(_) => return Ok(None),
                State::Pending => return Err(ProgramError::Outstanding),
                State::Child(_,child) => match child.request()? {
                    Some(request) => { self.action=Some(Action::Child(request)); return Ok(Some(request.stage())) }
                    None => {
                        let State::Child(context,child) = std::mem::replace(&mut self.state,State::Pending) else { unreachable!() };
                        self.state = match child.finish() { Ok(mesh)=>State::Local(context,mesh), Err(error)=>State::Complete(Err(error)) };
                        continue;
                    }
                },
            };
            self.action = Some(match std::mem::replace(&mut self.state,State::Pending) {
                State::Begin(item,offset) => Action::Begin(item,offset),
                State::Local(context,mesh) => Action::Local(context,mesh),
                State::Hash(ready) => Action::Hash(ready), _=>unreachable!(),
            });
            return Ok(Some(stage))
        }
    }
    pub(super) fn take_ready(&mut self)->Option<ReadyCacheWork> {
        if !matches!(self.action,Some(Action::Hash(_))) {return None}
        let Some(Action::Hash(ready))=self.action.take() else {unreachable!()};
        self.hash_context=Some(ready.context);Some(ReadyCacheWork {mesh:ready.mesh})
    }
    pub(super) fn take_child_ready(&mut self)->std::result::Result<Option<super::inner::ReadyOperation>,ProgramError> {
        let Some(Action::Child(request))=self.action.as_ref() else {return Ok(None)};
        if request.stage()!=ProgramStage::Numerical {return Ok(None)}
        let State::Child(_,child)=&mut self.state else {unreachable!("selected cache child")};
        let ready=child.take_ready(*request)?;
        self.action=None;Ok(Some(ready))
    }
    pub(super) fn execute(&mut self, router:&GeometryRouter, decoder:&mut EntityDecoder<'_>)
        -> std::result::Result<CacheReply,ProgramError> {
        if let Some(ready)=self.take_ready() {return Ok(ready.execute())}
        Ok(match self.action.take().expect("requested cache action") {
            Action::Begin(item,offset) => CacheReply::Begin(router.admit_item_cache(&item,decoder,offset),item,offset),
            Action::Child(request) => {
                let State::Child(_,child)=&mut self.state else { unreachable!() };
                CacheReply::Child(Box::new(child.execute(request,router,decoder)?))
            }
            Action::Local(context,mesh) => CacheReply::Local(context,mesh),
            Action::Hash(_) => unreachable!("numerical action extracted above"),
        })
    }
    pub(super) fn validate_reply(&self,reply:&CacheReply,router:&GeometryRouter)
        ->std::result::Result<(),ProgramError> {
        match reply {
            CacheReply::Child(reply)=> {
                let State::Child(_,child)=&self.state else {return Err(ProgramError::StaleRequest)};
                child.validate_reply(reply,router)
            }
            _=>Ok(()),
        }
    }
    pub(super) fn accept(&mut self, reply:CacheReply, router:&GeometryRouter) {
        if !matches!(&reply,CacheReply::Child(_)) {
            if let Err(stop)=crate::resource::check_current() {
                self.cancel_with_reports(router);self.state=State::Complete(Err(stop.into()));return;
            }
        }
        match reply {
            CacheReply::Begin(admission,item,offset) => self.state=match admission {
                Ok(CacheAdmission::Hit(mesh))=>State::Complete(Ok(mesh)),
                Ok(CacheAdmission::Miss(context))=>State::Child(context,Box::new(GeometryProgram::item(item,offset))),
                Err(error)=>State::Complete(Err(error)),
            },
            CacheReply::Child(reply) => {
                let State::Child(_,child)=&mut self.state else { unreachable!() };
                child.accept(*reply,router).expect("validated selected item reply");
            }
            CacheReply::Local(context,mesh) => self.state=match router.accept_local_item_cache(mesh) {
                Ok(mesh)=>State::Hash(ReadyCache {context,mesh}), Err(error)=>State::Complete(Err(error)),
            },
            CacheReply::Hash(result)=> {
                let context=self.hash_context.take().expect("pending cache publication context");
                self.state=State::Complete(result.and_then(|(mesh,rep)|router.publish_item_cache(context,mesh,rep)));
            }
        }
        if let Err(stop)=crate::resource::check_current() {
            self.cancel_with_reports(router);self.state=State::Complete(Err(stop.into()));
        }
    }
    pub(super) fn take_output(&mut self)->Result<Mesh> {
        let State::Complete(value)=std::mem::replace(&mut self.state,State::Pending) else { panic!("cache output pending") };
        value
    }
}

impl CacheControl {
    pub(super) fn cancel_with_reports(&mut self,router:&GeometryRouter) {
        if let State::Child(_,child)=&mut self.state {child.cancel_with_reports(router).expect("validated cancellation router");}
    }
}

#[cfg(test)]
#[path="inner_cache_tests.rs"]
mod tests;
