// SPDX-License-Identifier: MPL-2.0
//! Merged mapping control. Source, resources, merge, cache-copy and placement
//! are separate consumed actions; polling performs owned control reductions.
use super::{frames, GeometryRouter, ItemIdentity, Path, skipped};
use crate::{Error, Mesh, Result};
use super::values::{Accumulator, MappedValues, SharedRetainedCache};
use ifc_lite_core::{DecodedEntity, IfcType};
#[cfg(test)] use ifc_lite_core::EntityDecoder;
use nalgebra::Matrix4;
use crate::program::ItemProgram;
#[path = "merged_source.rs"] mod admission;
#[path = "merged_ready.rs"] mod numerical;
pub(crate) use admission::MergedSource;
pub(crate) use numerical::MergedReady;
use admission::{SourceAction, SourceValue};
use numerical::{Place, Numerical};

type Value = Result<(MappedValues, bool)>;
struct Source {
    id:u32, depth:usize, policy:bool, transform:Option<Matrix4<f64>>,
    items:ItemProgram, parts:Accumulator, truncated:bool,
}
struct Finish { id:u32, transform:Option<Matrix4<f64>>, truncated:bool }
enum Frame {
    Enter { item:DecodedEntity, depth:usize, policy:bool }, Exit(u32), Source(Source),
    AfterChild { parent:Source, item:ItemIdentity }, AwaitPlain { parent:Source, item:ItemIdentity },
}
enum Continuation { Merge(Source), Finish(Finish), Cache(Finish) }
pub(crate) struct MergedWalk {
    frames:frames::Frames<Frame>, value:Option<Value>, path:Path,
    retained: bool, contract: Option<crate::program::retained::RetainedContract>, program: u64, cache: Option<SharedRetainedCache>,
    pending:Option<MergedSource>, ready:Option<MergedReady>, child:Option<(DecodedEntity,bool)>, continuation:Option<Continuation>,
}
pub(crate) enum MergedPoll {
    Source(MergedSource), Ready(MergedReady), Child { item:DecodedEntity, policy:bool }, Complete(Value),
}
pub(crate) struct MergedReply(Reply);
enum Reply {
    Admission(Result<frames::Admitted<Frame>>), Source { tag:u8, value:Result<SourceValue> },
    Merged(Result<Accumulator>), Finished(Result<MappedValues>), Cloned(Result<Mesh>), Ready(Value),
}
impl MergedReply {
    pub(crate) fn tag(&self) -> u8 { match &self.0 {
        Reply::Admission(_) => 0, Reply::Source {tag,..} => 1+tag,
        Reply::Merged(_) => 20, Reply::Finished(_) => 21, Reply::Cloned(_) => 22, Reply::Ready(_) => 23,
    } }
    #[cfg(test)]
    pub(super) fn into_placed(self) -> Result<(Vec<Mesh>, bool)> { let Reply::Ready(value)=self.0 else {panic!("placement reply")};value.map(|(parts, truncated)| { let MappedValues::Mesh(parts)=parts else {panic!("mesh contract")}; (parts, truncated) }) }
}
impl MergedWalk {
    pub(crate) fn new(item:&DecodedEntity, router:&GeometryRouter) -> Result<Self> {
        Ok(Self { frames:frames::Frames::new(Frame::Enter {item:item.clone(),depth:0,policy:router.unsupported_policy()}),
            retained:false,contract:None,program:0,cache:None,value:None,path:Path::default(),pending:None,ready:None,child:None,continuation:None })
    }
    pub(crate) fn select_retained(&mut self, program: u64, contract: crate::program::retained::RetainedContract, cache: SharedRetainedCache) { self.retained = true; self.contract=Some(contract); self.program = program; self.cache=Some(cache); }
    pub(crate) fn execute_source(&self, source: MergedSource, router: &GeometryRouter,
        decoder: &mut ifc_lite_core::EntityDecoder<'_>) -> MergedReply {
        match &self.cache {
            Some(cache)=> {
                let mut cache=cache.lock().unwrap_or_else(|e|e.into_inner());
                if let Err(error)=cache.admit(router,decoder,self.contract.expect("retained contract")) {
                    return MergedReply(Reply::Source {tag:0,value:Err(error)});
                }
                source.execute_contract(router,decoder,Some(&cache))
            }
            None=>source.execute_contract(router,decoder,None),
        }
    }
    pub(crate) fn poll(&mut self) -> MergedPoll {
        loop {
            // Backing/occurrence admission is explicit and precedes the next
            // reached source, callback or numerical operation.
            if let Some(admission)=self.frames.pending_admission() {
                return MergedPoll::Source(MergedSource(SourceAction::Work(admission)));
            }
            if let Some(source)=self.pending.take() {return MergedPoll::Source(source)}
            if let Some(ready)=self.ready.take() {return MergedPoll::Ready(ready)}
            if let Some((item,policy))=self.child.take() {return MergedPoll::Child {item,policy}}
            let frame=match self.frames.next(|frame|matches!(frame,Frame::Enter {..})) {
                frames::Next::Admission(admission)=>return MergedPoll::Source(MergedSource(SourceAction::Work(admission))),
                frames::Next::Frame(frame)=>Some(frame),frames::Next::Complete=>None,
            };
            let Some(frame)=frame else {return MergedPoll::Complete(self.value.take().expect("mapped source complete"))};
            match frame {
                Frame::Enter {item,depth,policy}=> {
                    if let Err(error)=Path::depth(depth,item.id).and_then(|()|self.path.enter(item.id)) {
                        self.value=Some(Err(error)); continue;
                    }
                    self.frames.push(Frame::Exit(item.id));
                    self.pending=Some(MergedSource(SourceAction::MappingSource {item,depth,policy}));
                }
                Frame::Exit(id)=>self.path.exit(id),
                Frame::Source(mut parent)=>match parent.items.next() {
                    Some(item) if item.ifc_type==IfcType::IfcMappedItem=> {
                        let depth=parent.depth+1;let policy=parent.policy;
                        self.frames.push(Frame::AfterChild {parent,item:ItemIdentity::from(&item)});
                        self.frames.push(Frame::Enter {item,depth,policy});
                    }
                    Some(item)=> {
                        let policy=parent.policy;
                        self.frames.push(Frame::AwaitPlain {parent,item:ItemIdentity::from(&item)});
                        self.child=Some((item,policy));
                    }
                    None=> {
                        self.continuation=Some(Continuation::Finish(Finish {id:parent.id,transform:parent.transform,truncated:parent.truncated}));
                        self.ready=Some(MergedReady(Numerical::Finish(parent.parts)));
                    }
                },
                Frame::AfterChild {mut parent,item}=>match self.value.take().expect("mapped child returned") {
                    Ok((parts,truncated))=> {
                        parent.truncated|=truncated;self.queue_merge(parent,parts,None);
                    }
                    Err(error) if self.retained || matches!(error, Error::ProgramStopped(_)) => self.fail(error),
                    Err(error)=> {
                        parent.truncated=true;self.pending=Some(MergedSource(SourceAction::Dropped {parent,item,error}));
                    }
                },
                Frame::AwaitPlain {..}=>panic!("mapping child must be accepted before polling"),
            }
        }
    }
    fn queue_merge(&mut self,mut parent:Source,incoming:MappedValues,rtc:Option<(f64,f64,f64)>) {
        let parts=std::mem::take(&mut parent.parts);
        self.continuation=Some(Continuation::Merge(parent));
        self.ready=Some(MergedReady(Numerical::Merge {parts,incoming,rtc}));
    }
    pub(crate) fn accept(&mut self,reply:MergedReply,router:&GeometryRouter) {
        match reply.0 {
            Reply::Admission(value)=>if let Err(error)=self.frames.accept(value) {self.fail(error)},
            Reply::Source {value:Err(error),..}=> {
                if self.retained || matches!(error,Error::ProgramStopped(_)) {self.fail(error)}
                else {self.value=Some(Err(error))}
            },
            Reply::Source {value:Ok(value),..}=>match value {
                SourceValue::Next(source)=>self.pending=Some(source),
                SourceValue::Source(mut source,representation)=> {
                    source.parts=Accumulator::new(self.retained);
                    source.policy=router.claim_unsupported_source(source.id,&representation);
                    self.frames.push(Frame::Source(source));
                }
                SourceValue::RetainedCached {values,id,transform}=> {
                    let finish=Finish {id,transform,truncated:false};
                    self.ready=Some(MergedReady(Numerical::Place(Place {parts:MappedValues::Retained(values),
                        id:finish.id,transform:finish.transform,truncated:false,instancing:false,program:self.program})));
                }
                SourceValue::Cached {mesh,id,transform}=> {
                    self.continuation=Some(Continuation::Cache(Finish {id,transform,truncated:false}));
                    self.ready=Some(MergedReady(Numerical::Clone(mesh)));
                }
                SourceValue::Place {finish,parts,instancing}=> {
                    self.ready=Some(MergedReady(Numerical::Place(Place {parts,id:finish.id,transform:finish.transform,
                        truncated:finish.truncated,instancing,program:self.program})));
                }
                SourceValue::Publish {finish,parts,instancing}=> {
                    let publication = match &parts {
                        MappedValues::Mesh(parts) if parts.len()==1 => router.publish_mapped_source(finish.id,&parts[0],finish.truncated),
                        MappedValues::Retained(values) if !finish.truncated => self.cache.as_ref().expect("retained cache").lock().unwrap_or_else(|e|e.into_inner()).publish(finish.id,values),
                        _ => Ok(()),
                    };
                    if let Err(error)=publication { self.fail(error); return; }
                    self.ready=Some(MergedReady(Numerical::Place(Place {parts,id:finish.id,transform:finish.transform,
                        truncated:finish.truncated,instancing,program:self.program})));
                }
                SourceValue::Dropped {parent,item,error}=> {
                    router.with_unsupported_policy(parent.policy,||skipped(router,&item,&error,true));
                    self.frames.push(Frame::Source(parent));
                }
            },
            Reply::Merged(Ok(parts))=> {
                let Some(Continuation::Merge(mut parent))=self.continuation.take() else {panic!("merge continuation")};
                parent.parts=parts;self.frames.push(Frame::Source(parent));
            }
            Reply::Finished(Ok(parts))=> {
                let Some(Continuation::Finish(finish))=self.continuation.take() else {panic!("finish continuation")};
                self.pending=Some(MergedSource(SourceAction::Publish {finish,parts}));
            }
            Reply::Cloned(Ok(mesh))=> {
                let Some(Continuation::Cache(finish))=self.continuation.take() else {panic!("cache continuation")};
                self.pending=Some(MergedSource(SourceAction::PlaceCached {finish,mesh}));
            }
            Reply::Merged(Err(error))|Reply::Finished(Err(error))|Reply::Cloned(Err(error))=>self.fail(error),
            Reply::Ready(Err(error)) if self.retained || matches!(error,Error::ProgramStopped(_))=>self.fail(error),
            Reply::Ready(value)=>self.value=Some(value),
        }
    }
    #[cfg(test)]
    pub(crate) fn accept_child(&mut self,result:Result<Vec<Mesh>>,router:&GeometryRouter) {
        self.accept_values(result.map(MappedValues::Mesh),router);
    }
    pub(crate) fn accept_values(&mut self,result:Result<MappedValues>,router:&GeometryRouter) {
        // AwaitPlain is already admitted. Taking it is pure owned control.
        let Some(Frame::AwaitPlain {parent,item})=self.frames.pop_control() else {panic!("pending mapped child")};
        match result {
            Err(error) if self.retained || matches!(error, Error::ProgramStopped(_)) => self.fail(error),
            Ok(parts)=>self.queue_merge(parent,parts,Some(router.rtc_offset())),
            Err(error)=>self.pending=Some(MergedSource(SourceAction::Dropped {parent,item,error})),
        }
    }
    fn fail(&mut self,error:Error) {self.frames.clear();self.pending=None;self.ready=None;self.continuation=None;self.child=None;self.value=Some(Err(error));}
    #[cfg(test)]
    pub(crate) fn run(mut self,router:&GeometryRouter,decoder:&mut EntityDecoder<'_>)->Result<Vec<Mesh>> {
        loop {match self.poll() {
            MergedPoll::Source(source)=> {let reply=source.execute(router,decoder);self.accept(reply,router);}
            MergedPoll::Ready(ready)=>self.accept(ready.execute(),router),
            MergedPoll::Child {item,policy}=> {
                let result=router.with_unsupported_policy(policy,||crate::program::GeometryProgram::item(item,router.rtc_offset()).drain(router,decoder));
                self.accept_child(result.map(|mesh|vec![mesh]),router);
            }
            MergedPoll::Complete(value)=>{crate::resource::check_current()?;return value.and_then(|(parts,_)| match parts {MappedValues::Mesh(parts)=>Ok(parts),_=>Err(Error::geometry("mesh contract"))})}
        }}
    }
    #[cfg(test)]
    pub(super) fn advance(&mut self,router:&GeometryRouter,decoder:&mut EntityDecoder<'_>)->bool {
        match self.poll() {MergedPoll::Source(source)=> {self.accept(source.execute(router,decoder),router);true},_=>panic!("source boundary")}
    }
}

#[cfg(test)]
#[path="merged_tests.rs"]
mod tests;
