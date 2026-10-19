// SPDX-License-Identifier: MPL-2.0
//! Styled mapping continuation. Source admissions, child execution and numerical
//! range transforms are distinct owned actions; no router borrow survives poll.
use super::{frames, GeometryRouter, ItemIdentity, Path, occurrence, skipped, MappingStore};
#[path="submesh_source.rs"] mod source_admission;
#[path="submesh_ready.rs"] mod numerical;
use crate::{Error, Mesh, Result, SubMeshCollection};
use crate::processors::texture::ResolvedTextureMap;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use rustc_hash::FxHashMap;
use crate::program::{ItemProgram, ItemListPolicy};
use crate::resource::{self, Cost};
use super::values::{Accumulator, MappedValues, SharedRetainedCache};
use super::StyledValues;
use crate::program::retained::RetainedContract;
use nalgebra::Matrix4;

pub(crate) struct Source {
    item_id: u32, depth: usize, policy: bool, start: usize,
    admission: occurrence::Admission, items: ItemProgram,
    retained_template: Vec<crate::program::retained::LogicalRetainedValue>,
}
struct Shared { source: Source, parts: Accumulator }
enum Frame {
    Enter { item: DecodedEntity, depth: usize, policy: bool, allow_instancing: bool },
    Source(Source), AfterChild { parent: Source, item: ItemIdentity, start: usize },
    AwaitPlain { item: ItemIdentity, depth: usize, policy: bool },
    Shared(Shared), AwaitShared { shared: Shared, item: ItemIdentity },
}
pub(crate) enum SubmeshPoll {
    Source(SubmeshSource), Ready(SubmeshReady),
    Child { item: DecodedEntity, policy: bool, shared: bool },
    Complete(Result<StyledValues>),
}
pub(crate) struct SubmeshSource(SourceAction);
struct Entering {
    item:DecodedEntity,depth:usize,policy:bool,allow_instancing:bool,start:usize,
    source:Option<DecodedEntity>,representation:Option<DecodedEntity>,transform:Option<Matrix4<f64>>,
}
enum SourceAction {
    Work(frames::Admission<Frame>),
    MappingSource(Entering), Representation(Entering), Transform(Entering), Eligibility(Entering), Template(Entering,Option<u32>),
    Claim(Source), Items(Source), Placeholder(Source), SharedItems(Source), SharedFinished { source:Source, parts:MappedValues },
    Finish { source: Source, nonempty: bool },
    Dropped { parent: Source, item: ItemIdentity, error: Error },
}
pub(crate) struct Range { meshes: StyledValues, transform: Option<Matrix4<f64>>, start: usize,
    retag: Option<u32>, placeholder: Option<(u32, u32)>, finish: bool, program: u64, source_id: u32, capture: bool, binding: Option<crate::program::RetainedPresentation>, cached: Option<MappedValues> }
pub(crate) enum SubmeshReady {
    Range(Range), Append {meshes:StyledValues,incoming:StyledValues,rtc:Option<(f64,f64,f64)>},
    MergeShared {parts:Accumulator,incoming:MappedValues,rtc:(f64,f64,f64)}, FinishShared(Accumulator),
}
enum ReadyNext { Source(Source), Finish(Source), Placeholder(u32), PlainDone, Shared(Source), SharedFinish(Source) }
pub(crate) struct SubmeshReply { value:Reply, tag:u8 }
impl SubmeshReply {pub(crate) fn tag(&self)->u8 {self.tag}}
enum Reply { CachedPlaceholder {source:Source,values:Vec<crate::program::LogicalRetainedValue>}, Next(SubmeshSource), Work(Result<frames::Admitted<Frame>>), SharedMerged(Accumulator), SharedFinished(MappedValues), Admitted(Source), Entered(Source), Claimed(Source), SharedClaim(Source), Source(Source), Shared(Shared),
    Publish {source:Source,parts:MappedValues}, Commit { source: Source, nonempty: bool }, Dropped { parent: Source, item: ItemIdentity, error: Error },
    Transformed { meshes: StyledValues, template: Option<MappedValues> }, Fault(Error) }
pub(crate) struct SubmeshWalk {
    frames: frames::Frames<Frame>, path: Path, value: Option<Result<()>>, meshes: StyledValues,
    pending: Option<SubmeshSource>, ready: Option<SubmeshReady>, ready_next: Option<ReadyNext>, child:Option<(DecodedEntity,bool,bool)>,
    program:u64, retained:Option<(RetainedContract,SharedRetainedCache)>,
}
impl SubmeshWalk {
    pub(crate) fn new(item: &DecodedEntity, allow_instancing: bool, router: &GeometryRouter) -> Result<Self> {
        Ok(Self { frames:frames::Frames::new(Frame::Enter {item:item.clone(),depth:0,policy:router.unsupported_policy(),allow_instancing}),
            path:Path::default(),value:None,meshes:StyledValues::default(),pending:None,ready:None,ready_next:None,child:None,program:0,retained:None })
    }
    pub(crate) fn select_retained(&mut self, program:u64, contract:RetainedContract, cache:SharedRetainedCache) {
        self.program=program; self.retained=Some((contract,cache)); self.meshes=StyledValues::new(true);
    }
    pub(crate) fn execute_source(&self,source:SubmeshSource,router:&GeometryRouter,decoder:&mut EntityDecoder<'_>,
        textures:Option<&FxHashMap<u32,ResolvedTextureMap>>,store:&mut MappingStore)->SubmeshReply {
        match &self.retained {
            Some((contract,cache))=> {
                let mut cache=cache.lock().unwrap_or_else(|e|e.into_inner());
                if let Err(error)=cache.admit(router,decoder,*contract) {return SubmeshReply {value:Reply::Fault(error),tag:0}}
                source.execute_contract(router,decoder,textures,store,Some(&mut cache))
            }
            None=>source.execute(router,decoder,textures,store),
        }
    }
    pub(crate) fn poll(&mut self) -> SubmeshPoll {
        loop {
            if let Some(work)=self.frames.pending_admission() {return SubmeshPoll::Source(SubmeshSource(SourceAction::Work(work)))}
            if let Some(source)=self.pending.take() {return SubmeshPoll::Source(source)}
            if let Some(ready)=self.ready.take() {return SubmeshPoll::Ready(ready)}
            if let Some((item,policy,shared))=self.child.take() {return SubmeshPoll::Child {item,policy,shared}}
            let frame=match self.frames.next(|frame|matches!(frame,Frame::Enter {..})) {
                frames::Next::Admission(work)=>return SubmeshPoll::Source(SubmeshSource(SourceAction::Work(work))),
                frames::Next::Frame(frame)=>frame,
                frames::Next::Complete=>return SubmeshPoll::Complete(self.value.take().expect("completed styled source")
                    .map(|()|self.meshes.take())),
            };
            match frame {
                Frame::Enter { item, depth, policy, allow_instancing } => {
                    let result=Path::depth(depth,item.id);
                    if let Err(error) = result { self.value = Some(Err(error)); continue }
                    if item.ifc_type != IfcType::IfcMappedItem {
                        self.push(Frame::AwaitPlain { item: ItemIdentity::from(&item), depth, policy });
                        self.child=Some((item,policy,false));continue;
                    }
                    if let Err(error) = self.path.enter(item.id) { self.value = Some(Err(error)); continue }
                    return SubmeshPoll::Source(SubmeshSource(SourceAction::MappingSource(Entering {item,depth,policy,allow_instancing,
                        start:self.meshes.len(),source:None,representation:None,transform:None})));
                }
                Frame::Source(mut parent) => match parent.items.next() {
                    Some(item) => {
                        let depth = parent.depth + 1; let policy = parent.policy;
                        let start = self.meshes.len();
                        self.push(Frame::AfterChild { parent, item: ItemIdentity::from(&item), start });
                        self.push(Frame::Enter { item, depth, policy, allow_instancing: false });
                    }
                    None => {
                        let mut transform = parent.admission.transform;
                        // Already scaled at admission; Ready never owns the router.
                        let retag = (parent.admission.solid_id.is_some() && parent.admission.template).then_some(parent.admission.source_id);
                        if retag.is_none() { transform = None; }
                        let start = parent.start;
                        self.ready_next = Some(ReadyNext::Finish(parent));
                        return SubmeshPoll::Ready(SubmeshReady::Range(Range { meshes: self.meshes.take(), transform,
                            start, retag, placeholder: None, finish: true, program:self.program, source_id:0, capture:false, binding:None, cached:None }));
                    }
                },
                Frame::AfterChild { parent, item, start } => match self.value.take().expect("submesh child returned") {
                    Ok(()) => {
                        let transform = parent.admission.transform;
                        let source_id=parent.admission.source_id;
                        let capture=self.retained.is_some() && parent.admission.solid_id.is_some() && parent.admission.template;
                        let binding=self.retained.as_ref().map(|_|crate::program::RetainedPresentation::occurrence(
                            parent.item_id,source_id,parent.admission.solid_id,parent.admission.template));
                        self.ready_next = Some(ReadyNext::Source(parent));
                        return SubmeshPoll::Ready(SubmeshReady::Range(Range { meshes: self.meshes.take(),
                            transform, start, retag: None, placeholder: None, finish: false, program:self.program,source_id,capture,binding,cached:None }));
                    }
                    Err(error) if self.retained.is_some() || matches!(error,Error::ProgramStopped(_))=>{self.fail(error);continue},
                    Err(error) => return SubmeshPoll::Source(SubmeshSource(SourceAction::Dropped { parent, item, error })),
                },
                Frame::Shared(mut shared) => match shared.source.items.next() {
                    Some(item) if item.ifc_type != IfcType::IfcMappedItem => {
                        let policy = shared.source.policy;
                        self.push(Frame::AwaitShared { shared, item: ItemIdentity::from(&item) });
                        self.child=Some((item,policy,true));continue;
                    }
                    Some(_) => self.placeholder_ready(shared.source), // Explicit flat-source guard: no partial cache.
                    None => {
                        self.ready_next=Some(ReadyNext::SharedFinish(shared.source));
                        return SubmeshPoll::Ready(SubmeshReady::FinishShared(shared.parts));
                    }
                },
                Frame::AwaitPlain { .. } | Frame::AwaitShared { .. } => panic!("mapping child must be accepted before polling"),
            }
        }
    }
    fn placeholder_ready(&mut self, source: Source) { self.placeholder_cached(source,None); }
    fn placeholder_cached(&mut self,source:Source,cached:Option<MappedValues>) {
        self.ready_next = Some(ReadyNext::Placeholder(source.item_id));
        self.ready = Some(SubmeshReady::Range(Range { meshes: self.meshes.take(), transform: source.admission.transform,
            start: 0, retag: None, placeholder: Some((source.admission.solid_id.expect("placeholder solid"), source.admission.source_id)),
            finish: false,program:self.program,source_id:source.admission.source_id,capture:false,
            binding:self.retained.as_ref().map(|_|crate::program::RetainedPresentation::occurrence(source.item_id,source.admission.source_id,source.admission.solid_id,false)),cached }));
    }
    pub(crate) fn accept(&mut self, reply: SubmeshReply, router: &GeometryRouter, store: &mut MappingStore) {
        match reply.value {
            Reply::Next(source)=>self.pending=Some(source),
            Reply::Work(reply)=>if let Err(error)=self.frames.accept(reply) {self.fail(error)},
            Reply::SharedMerged(parts)=> {
                let Some(ReadyNext::Shared(source))=self.ready_next.take() else {panic!("shared merge continuation")};
                self.push(Frame::Shared(Shared {source,parts}));
            }
            Reply::SharedFinished(parts)=> {
                let Some(ReadyNext::SharedFinish(source))=self.ready_next.take() else {panic!("shared finish continuation")};
                self.pending=Some(SubmeshSource(SourceAction::SharedFinished {source,parts}));
            }
            Reply::Admitted(source) if source.admission.solid_id.is_some() && !source.admission.template => {
                self.pending = Some(SubmeshSource(SourceAction::Placeholder(source)));
            }
            Reply::Admitted(source) => self.pending = Some(SubmeshSource(SourceAction::Claim(source))),
            Reply::Entered(source) if source.admission.solid_id.is_some() && !source.admission.template => {
                // Initial placeholder admission needs the reached recovery-cache read.
                // A returned empty item cursor means that read has completed.
                self.placeholder_ready(source);
            }
            Reply::Entered(source) => self.pending = Some(SubmeshSource(SourceAction::Claim(source))),
            Reply::Claimed(mut source) => {
                source.policy = router.claim_unsupported_source(source.admission.source_id, &source.admission.representation);
                self.pending = Some(SubmeshSource(SourceAction::Items(source)));
            }
            Reply::SharedClaim(mut source) => {
                source.policy = router.claim_unsupported_source(source.admission.source_id, &source.admission.representation);
                self.pending = Some(SubmeshSource(SourceAction::SharedItems(source)));
            }
            Reply::Publish {source,parts} => {
                let result=match parts {
                    MappedValues::Retained(values)=>match &self.retained {
                        Some((_,cache))=>cache.lock().unwrap_or_else(|e|e.into_inner()).publish_styled(source.admission.source_id,&values),
                        None=>Err(Error::geometry("styled publication contract mismatch")),
                    },
                    MappedValues::Mesh(parts) if self.retained.is_none()=>router.publish_shared_source_parts(source.admission.source_id,parts),
                    _=>Err(Error::geometry("styled publication contract mismatch")),
                };
                if let Err(error) = result {
                    self.value = Some(Err(error)); return;
                }
                let cached_result=self.retained.as_ref().map(|(_,cache)|cache.lock().unwrap_or_else(|e|e.into_inner()).get_styled(source.admission.source_id));
                let cached=match cached_result {
                    Some(Ok(Some(values)))=>Some(MappedValues::Retained(values)),Some(Err(error))=>{self.fail(error);return},_=>None,
                };
                self.placeholder_cached(source,cached);
            }
            Reply::CachedPlaceholder {source,values}=>self.placeholder_cached(source,Some(MappedValues::Retained(values))),
            Reply::Commit { source, nonempty } => {
                if let Some((_,cache))=&self.retained {
                    if nonempty && source.admission.solid_id.is_some() && source.admission.template {
                        let result=cache.lock().unwrap_or_else(|e|e.into_inner()).publish_styled(source.admission.source_id,&source.retained_template);
                        if let Err(error)=result {self.fail(error);return;}
                    }
                }
                occurrence::commit(&source.admission, nonempty, router, store);
                occurrence::release(&source.admission, store);
                self.path.exit(source.item_id); self.value = Some(Ok(()));
            }
            Reply::Dropped { parent, item, error } => {
                router.with_unsupported_policy(parent.policy, || skipped(router, &item, &error, false));
                self.push(Frame::Source(parent));
            }
            Reply::Source(source) => self.push(Frame::Source(source)),
            Reply::Shared(shared) => self.push(Frame::Shared(shared)),
            Reply::Transformed { meshes, template } => {
                self.meshes = meshes;
                match self.ready_next.take().expect("pending mapping numerical continuation") {
                    ReadyNext::Source(mut source) => {
                        if let Some(MappedValues::Retained(mut values))=template {debug_assert!(source.retained_template.is_empty()); source.retained_template=std::mem::take(&mut values);}
                        self.push(Frame::Source(source));
                    },
                    ReadyNext::Finish(source) => {
                        let nonempty = self.meshes.nonempty(source.start);
                        self.pending = Some(SubmeshSource(SourceAction::Finish { source, nonempty }));
                    }
                    ReadyNext::Placeholder(id) => { self.path.exit(id); self.value = Some(Ok(())); }
                    ReadyNext::PlainDone=>self.value=Some(Ok(())),
                    _=>panic!("wrong styled numerical result"),
                }
            }
            Reply::Fault(error) => self.value = Some(Err(error)),
        }
    }
    pub(crate) fn accept_child(&mut self,result:Result<SubMeshCollection>,router:&GeometryRouter) {
        self.accept_values(result.map(StyledValues::Mesh),router)
    }
    pub(crate) fn accept_values(&mut self,result:Result<StyledValues>,router:&GeometryRouter) {
        let Frame::AwaitPlain {item,depth,policy}=self.frames.pop_control().expect("pending styled child") else {panic!("wrong styled child")};
        match result {
            Ok(output)=> {
                self.ready_next=Some(ReadyNext::PlainDone);
                self.ready=Some(SubmeshReady::Append {meshes:self.meshes.take(),incoming:output,
                    rtc:(depth>0).then(||router.rtc_offset())});
            }
            Err(error) if self.retained.is_some() || matches!(error,Error::ProgramStopped(_))=>self.fail(error),
            Err(error)=> {
                router.with_unsupported_policy(policy,||skipped(router,&item,&error,false));
                self.value=Some(Ok(()));
            }
        }
    }
    #[cfg(test)]
    pub(crate) fn accept_shared_child(&mut self,result:Result<Vec<Mesh>>,router:&GeometryRouter) {
        self.accept_shared_values(result.map(MappedValues::Mesh),router)
    }
    pub(crate) fn accept_shared_values(&mut self, result: Result<MappedValues>, router: &GeometryRouter) {
        let Frame::AwaitShared { shared, item } = self.frames.pop_control().expect("pending shared child") else { panic!("wrong shared child") };
        match result {
            Ok(parts) => {
                self.ready_next=Some(ReadyNext::Shared(shared.source));
                self.ready=Some(SubmeshReady::MergeShared {parts:shared.parts,incoming:parts,rtc:router.rtc_offset()});return;
            },
            Err(error) if self.retained.is_some() || matches!(error,Error::ProgramStopped(_))=>{self.fail(error);return},
            Err(error) => router.with_unsupported_policy(shared.source.policy, || skipped(router, &item, &error, false)),
        }
        self.push(Frame::Shared(shared));
    }
    fn push(&mut self,frame:Frame) {self.frames.push(frame)}
    fn fail(&mut self,error:Error) {self.frames.clear();self.pending=None;self.ready=None;self.child=None;self.ready_next=None;self.value=Some(Err(error));}
    #[cfg(test)]
    pub(crate) fn run(mut self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>, meshes: &mut SubMeshCollection,
        textures: Option<&FxHashMap<u32, ResolvedTextureMap>>) -> Result<()> {
        let mut store = MappingStore::default();
        loop {
            let reply = match self.poll() {
                SubmeshPoll::Source(source) => source.execute(router, decoder, textures, &mut store),
                SubmeshPoll::Ready(ready) => ready.execute(),
                SubmeshPoll::Child { item, policy, shared } => {
                    if shared {
                        let result = router.with_unsupported_policy(policy, || {
                            crate::program::GeometryProgram::item(item.clone(), router.rtc_offset()).drain(router, decoder).map(|mesh| vec![mesh])
                        }); self.accept_shared_child(result, router);
                    } else {
                        let mut output = SubMeshCollection::new();
                        let result = router.with_unsupported_policy(policy, || plain(&item, 0, router, decoder, &mut output, textures));
                        self.accept_child(result.map(|()| output), router);
                    }
                    continue;
                }
                SubmeshPoll::Complete(result) => {
                    resource::check_current()?;
                    let StyledValues::Mesh(mut output) = result? else {unreachable!()};
                    resource::reserve_headers(&mut meshes.sub_meshes, output.len())?.retain();
                    meshes.sub_meshes.append(&mut output.sub_meshes); return Ok(())
                }
            }; self.accept(reply, router, &mut store);
        }
    }
    #[cfg(test)]
    pub(super) fn advance(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>,
        _: &mut SubMeshCollection, textures: Option<&FxHashMap<u32, ResolvedTextureMap>>) -> bool {
        match self.poll() {
            SubmeshPoll::Source(source) => { let mut store = MappingStore::default();
                self.accept(source.execute(router, decoder, textures, &mut store), router, &mut store); true }
            _ => panic!("test advance requires source boundary"),
        }
    }
}
#[cfg(test)]
fn plain(item: &DecodedEntity, depth: usize, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>,
    meshes: &mut SubMeshCollection, textures: Option<&FxHashMap<u32, ResolvedTextureMap>>) -> Result<()> {
    resource::check_current()?;
    if let Some(map) = textures.and_then(|index| index.get(&item.id)) {
        if let Some((mut mesh, uvs)) = router.textured_face_set(item, decoder, map, Some(router.rtc_offset())) {
            if depth > 0 { super::keep_rebase_in_origin(&mut mesh,router.rtc_offset()); }
            admit_styled_output(&mesh, uvs.len(), meshes)?;
            meshes.add_textured(item.id, mesh, uvs, map.attachment());
            resource::check_current()?;
            return Ok(());
        }
        resource::check_current()?;
    }
    let result = router.process_representation_item(item, decoder);
    resource::check_current()?;
    match result {
        Ok(mut mesh) => {
            if depth > 0 { super::keep_rebase_in_origin(&mut mesh,router.rtc_offset()); }
            if !mesh.is_empty() { admit_styled_output(&mesh, 0, meshes)?; meshes.add(item.id, mesh); }
        }
        Err(error) => {
            router.record_unsupported_item(item.ifc_type.clone());
            crate::diag::diag_debug!(
                { item_id = item.id, ifc_type = ?item.ifc_type, error = %error,
                    "skipping unsupported geometry item" }
                else { #[cfg(debug_assertions)]
                    eprintln!("[ifc-lite] Skipping unsupported geometry #{} ({:?}): {}", item.id, item.ifc_type, error);
                }
            );
            let _ = error;
        }
    }
    Ok(())
}

pub(crate) fn admit_styled_output(mesh: &crate::Mesh, uv_len: usize, meshes: &mut SubMeshCollection) -> Result<()> {
    if !resource::is_active() { return Ok(()) }
    let bytes = resource::mesh::MeshLengths::of(mesh).bytes().map_err(|_| resource::overflow())?;
    let uv_bytes = uv_len.checked_mul(4).and_then(|n| u64::try_from(n).ok()).ok_or_else(resource::overflow)?;
    let bytes = bytes.checked_add(uv_bytes).and_then(|n| n.checked_add(std::mem::size_of::<crate::SubMesh>() as u64))
        .ok_or_else(resource::overflow)?;
    resource::charge(Cost { output_bytes: bytes, live_bytes: bytes, ..Cost::default() })?.retain();
    resource::reserve_headers(&mut meshes.sub_meshes, 1)?.retain();
    Ok(())
}
