// SPDX-License-Identifier: MPL-2.0
//! Common orphan-map root: whole Items, accepted claim, ordered children, late origin.
use super::inner::{GeometryOutput, GeometryProgram, ProgramError, ProgramReply, ProgramRequest, ProgramStage};
use super::inner_product::{ReadyTexture, TexturePart};
use super::type_map::{ReadyTypeMap, ReadyTypeMerge, TypeItemOutput, TypeMap, TypeMapItemsAdmission,
    TypeMapItemsSource, TypeMapOrigin, TypeMapParts, TypeMapSource};
use crate::{GeometryRouter, Mesh, ResolvedTextureMap, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use rustc_hash::FxHashMap;

enum Action {
    Decode(u32), Representation(TypeMapSource), Items(TypeMapItemsSource),
    Texture(DecodedEntity), TextureReady(ReadyTexture), AdmitChild(DecodedEntity),
    Child(ProgramRequest), ChildFinished, Restore(ReadyRestore),
    Merge(ReadyTypeMerge), Origin(TypeMapOrigin), Finish(ReadyTypeMap),
}
struct Child { program: Box<GeometryProgram>, mapped: bool, policy: bool, rtc: (f64, f64, f64) }
pub(super) struct TypeMapReply(Reply);
enum Reply {
    Decoded(Result<DecodedEntity>), Representation(Result<TypeMapItemsSource>),
    Items(Result<TypeMapItemsAdmission>), Texture(Result<Option<ReadyTexture>>),
    TextureExecuted(Result<Option<TexturePart>>), ChildAdmitted(Result<Child>),
    Child(Box<ProgramReply>), ChildFinished { mapped: bool, rtc: (f64, f64, f64), result: Result<TypeItemOutput> },
    Restored(TypeItemOutput), Merged(Result<TypeMapParts>), Origin(Result<ReadyTypeMap>),
    Finished(Result<super::type_map::TypeMapValues>), Stopped(crate::Error),
    StoppedNumerical { tag: u16, error: crate::Error },
}
pub(super) enum TypeMapReadyWork {
    Texture(ReadyTexture), Restore(ReadyRestore), Merge(ReadyTypeMerge), Finish(ReadyTypeMap),
}
impl TypeMapReadyWork {
    pub(super) fn tag(&self) -> u16 { match self {
        Self::Texture(_)=>4, Self::Restore(_)=>8, Self::Merge(_)=>9, Self::Finish(_)=>11,
    }}
    pub(super) fn execute(self) -> TypeMapReply {
        let tag = self.tag();
        if let Err(stop) = crate::resource::check_current() {
            return TypeMapReply(Reply::StoppedNumerical { tag, error: stop.into() });
        }
        TypeMapReply(match self {
            Self::Texture(ready)=>Reply::TextureExecuted(ready.execute()),
            Self::Restore(ready)=>Reply::Restored(ready.execute()),
            Self::Merge(ready)=>Reply::Merged(ready.execute_checked()),
            Self::Finish(ready)=>Reply::Finished(ready.execute_values()),
        })
    }
}
impl TypeMapReply {
    pub(super) fn wrap_child_reply(reply: ProgramReply) -> Self { Self(Reply::Child(Box::new(reply))) }
    pub(super) fn tag(&self) -> u16 { match &self.0 {
        Reply::Decoded(_)=>0, Reply::Representation(_)=>1, Reply::Items(_)=>2, Reply::Texture(_)=>3,
        Reply::TextureExecuted(_)=>4, Reply::ChildAdmitted(_)=>5, Reply::Child(_)=>6,
        Reply::ChildFinished {..}=>7, Reply::Restored(_)=>8, Reply::Merged(_)=>9,
        Reply::Origin(_)=>10, Reply::Finished(_)=>11, Reply::Stopped(_)=>12,
        Reply::StoppedNumerical {tag,..}=>*tag,
    }}
}
pub(super) struct TypeMapControl {
    action: Option<Action>, program: Option<TypeMap>, child: Option<Child>,
    item: Option<DecodedEntity>, output: Option<Result<GeometryOutput>>,
    retained:Option<super::retained::RetainedContract>,cache:Option<super::mapping::SharedRetainedCache>,
    presentation:Option<super::retained_presentation::RetainedPresentation>,
}
impl TypeMapControl {
    pub(super) fn select_retained(&mut self,contract:super::retained::RetainedContract) {self.retained=Some(contract);self.cache=Some(Default::default());}
    pub(super) fn take_ready(&mut self) -> Option<TypeMapReadyWork> {
        Some(match self.action.take()? {
            Action::TextureReady(ready)=>TypeMapReadyWork::Texture(ready),
            Action::Restore(ready)=>TypeMapReadyWork::Restore(ready),
            Action::Merge(ready)=>TypeMapReadyWork::Merge(ready),
            Action::Finish(ready)=>TypeMapReadyWork::Finish(ready),
            source=>{ self.action=Some(source); return None },
        })
    }
    pub(super) fn take_child_ready(&mut self) -> std::result::Result<Option<super::inner::ReadyOperation>, ProgramError> {
        let Some(Action::Child(request)) = self.action.as_ref() else { return Ok(None) };
        if request.stage()!=ProgramStage::Numerical { return Ok(None) }
        let ready=self.child.as_mut().expect("reached TypeMap child").program.take_ready(*request)?;
        self.action=None;
        Ok(Some(ready))
    }

    pub(super) fn from_id(id: u32) -> Self { Self::initial(Action::Decode(id)) }
    pub(super) fn from_entity(map: DecodedEntity) -> Self {
        Self::initial(Action::Representation(TypeMap::begin(&map)))
    }
    fn initial(action: Action) -> Self {
        Self { action: Some(action), program: None, child: None, item: None, output: None,retained:None,cache:Default::default(),presentation:None }
    }

    pub(super) fn poll(&mut self) -> std::result::Result<Option<ProgramStage>, ProgramError> {
        if self.output.is_some() { return Ok(None) }
        if let Some(action) = &self.action { return Ok(Some(action.stage())) }
        if let Some(child) = &mut self.child {
            self.action = Some(match child.program.request()? {
                Some(request) => Action::Child(request), None => Action::ChildFinished,
            });
        } else {
            let program = self.program.as_mut().expect("admitted TypeMap owns traversal");
            self.action = Some(match program.next() {
                Some(item) => {
                    let mapped = item.ifc_type == IfcType::IfcMappedItem;
                    self.item = Some(item.clone());
                    if mapped { Action::AdmitChild(item) } else { Action::Texture(item) }
                }
                None => Action::Origin(self.program.take().expect("finished TypeMap").origin()),
            });
        }
        Ok(self.action.as_ref().map(Action::stage))
    }

    pub(super) fn execute(&mut self, router: &GeometryRouter, decoder: &mut EntityDecoder<'_>,
        textures: Option<&FxHashMap<u32, ResolvedTextureMap>>)
        -> std::result::Result<TypeMapReply, ProgramError> {
        if let Some(ready)=self.take_ready() { return Ok(ready.execute()) }
        if let Err(stop) = crate::resource::check_current() { return Ok(TypeMapReply(Reply::Stopped(stop.into()))) }
        let policy = self.program.as_ref().map_or_else(|| router.unsupported_policy(), TypeMap::policy);
        let reply = router.with_unsupported_policy(policy, || -> std::result::Result<Reply, ProgramError> {
            Ok(match self.action.take().expect("requested TypeMap action") {
            Action::Decode(id) => Reply::Decoded(decoder.decode_by_id(id).map_err(Into::into)),
            Action::Representation(source) => Reply::Representation(source.admit(decoder)),
            Action::Items(source) => Reply::Items(source.lower(decoder)),
            Action::Texture(item) => {
                if self.retained.is_some() {
                    match super::retained_presentation::RetainedPresentation::item(item.id,router,textures.and_then(|index|index.get(&item.id))) {
                        Ok(binding)=>self.presentation=Some(binding),Err(error)=>return Ok(Reply::Stopped(error)),
                    }
                    return Ok(Reply::Texture(Ok(None)));
                }
                let result = match textures.and_then(|index| index.get(&item.id)).filter(|_| matches!(
                    item.ifc_type, IfcType::IfcTriangulatedFaceSet | IfcType::IfcTriangulatedIrregularNetwork)) {
                    Some(map) => ReadyTexture::admit(&item, map, Some(router.rtc_offset()), router, decoder),
                    None => Ok(None),
                };
                Reply::Texture(result)
            }
            Action::TextureReady(_) | Action::Restore(_) | Action::Merge(_) | Action::Finish(_) =>
                unreachable!("TypeMap numerical action extracted above"),
            Action::AdmitChild(item) => {
                let policy = self.program.as_ref().expect("map traversal").policy();
                let result = router.with_unsupported_policy(policy, || {
                    let mapped = item.ifc_type == IfcType::IfcMappedItem;
                    let rtc = router.rtc_offset();
                    let program = if let Some(contract)=self.retained {
                        if mapped {GeometryProgram::retained_styled(&item,false,contract,router,self.cache.as_ref().expect("retained type-map cache").clone())?}
                        else {GeometryProgram::retained_item(item,contract)}
                    } else if mapped { GeometryProgram::mapped_merged(&item, router)? }
                        else if router.processor_for(&item.ifc_type).is_some() { GeometryProgram::item(item, rtc) }
                        else { return Err(crate::Error::geometry("no processor")) };
                    Ok(Child { program: Box::new(program), mapped, policy, rtc })
                });
                Reply::ChildAdmitted(result)
            }
            Action::Child(request) => {
                let child = self.child.as_mut().expect("reached child");
                Reply::Child(Box::new(router.with_unsupported_policy(child.policy, || {
                    child.program.execute_with_textures(request, router, decoder, textures)
                })?))
            }
            Action::ChildFinished => {
                let mut child = self.child.take().expect("completed child");
                let result = if self.retained.is_some() {
                    child.program.take_geometry_output().and_then(|output|match output {
                        GeometryOutput::Retained(mut values)=> {
                            for value in &mut values {if let Some(binding)=&self.presentation {value.present(binding.clone())?;}}
                            Ok(TypeItemOutput::Retained(values))
                        }
                        _=>Err(crate::Error::geometry("type-map retained child contract mismatch")),
                    })
                } else if child.mapped { (*child.program).finish_parts().map(TypeItemOutput::Parts) }
                    else { (*child.program).finish().map(|mesh|TypeItemOutput::Parts(vec![mesh])) };
                Reply::ChildFinished { mapped: child.mapped, rtc: child.rtc, result }
            }
            Action::Origin(source) => Reply::Origin(source.admit(router, decoder)),
            })
        })?;
        Ok(TypeMapReply(reply))
    }

    pub(super) fn validate_reply(&self, reply:&TypeMapReply, router:&GeometryRouter)
        -> std::result::Result<(),ProgramError> {
        if let Reply::Child(reply)=&reply.0 {
            let child=self.child.as_ref().ok_or(ProgramError::WrongPayload)?;
            child.program.validate_reply(reply,router)?;
        }
        Ok(())
    }

    pub(super) fn accept(&mut self, reply: TypeMapReply, router: &GeometryRouter) {
        let result = (|| {
            // Let the child consume its own reached numerical reports first.
            // Other replies cannot claim sources or install partial results
            // once a void-returning numerical helper has observed a stop.
            if !matches!(&reply.0, Reply::Child(_)) { crate::resource::check_current()?; }
            self.accept_inner(reply.0, router)?;
            crate::resource::check_current()?;
            Ok(())
        })();
        if let Err(error) = result {
            self.cancel_with_reports(router);
            self.action = None; self.child = None; self.program = None; self.item = None;
            self.output = Some(Err(error));
        }
    }
    fn accept_inner(&mut self, reply: Reply, router: &GeometryRouter) -> Result<()> {
        match reply {
            Reply::Decoded(map) => self.action = Some(Action::Representation(TypeMap::begin(&map?))),
            Reply::Representation(source) => self.action = Some(Action::Items(source?)),
            Reply::Items(admission) => {let mut program=admission?.accept(router);
                if self.retained.is_some() {program.select_retained();}self.program=Some(program);},
            Reply::Texture(reply) => self.action = Some(match reply? {
                Some(ready) => Action::TextureReady(ready),
                None => Action::AdmitChild(self.item.as_ref().expect("texture candidate").clone()),
            }),
            Reply::TextureExecuted(reply) => self.action = Some(match reply? {
                Some((mesh, uvs, attachment)) => Action::Restore(ReadyRestore {
                    output: TypeItemOutput::Textured(mesh, uvs, attachment), rtc: router.rtc_offset() }),
                None => Action::AdmitChild(self.item.as_ref().expect("texture candidate").clone()),
            }),
            Reply::ChildAdmitted(reply) => match reply {
                Ok(child) => self.child = Some(child),
                Err(error) => self.drop_item(error, router)?,
            },
            Reply::Child(reply) => {
                let child = self.child.as_mut().expect("pending child");
                router.with_unsupported_policy(child.policy, || child.program.accept(*reply, router))
                    .expect("validated TypeMap child reply");
            }
            Reply::ChildFinished { mapped, rtc, result } => match result {
                Ok(output) => {
                    self.action = Some(if mapped { self.merge(output) }
                        else { Action::Restore(ReadyRestore { output, rtc }) });
                }
                Err(error) => self.drop_item(error, router)?,
            },
            Reply::Restored(output) => self.action = Some(self.merge(output)),
            Reply::Merged(parts) => { self.program.as_mut().expect("map traversal").accept_merge(parts?); self.item = None; self.presentation=None; }
            Reply::Origin(ready) => self.action = Some(Action::Finish(ready?)),
            Reply::Finished(parts) => self.output=Some(Ok(match parts? {
                super::type_map::TypeMapValues::Mesh(v)=>GeometryOutput::TypeParts(v),
                super::type_map::TypeMapValues::Retained(v)=>GeometryOutput::Retained(v),
            })),
            Reply::Stopped(error) | Reply::StoppedNumerical {error,..} => return Err(error),
        }
        Ok(())
    }

    fn merge(&mut self, output: TypeItemOutput) -> Action {
        Action::Merge(self.program.as_mut().expect("map traversal").merge(output))
    }
    fn drop_item(&mut self, error: crate::Error, router: &GeometryRouter) -> Result<()> {
        if self.retained.is_some() || matches!(error, crate::Error::ProgramStopped(_)) { return Err(error) }
        crate::resource::check_current()?;
        let item = self.item.take().expect("failed item occurrence");
        let policy = self.program.as_ref().expect("map traversal").policy();
        router.with_unsupported_policy(policy, || {
            router.record_unsupported_item(item.ifc_type.clone());
            if item.ifc_type == IfcType::IfcMappedItem {
                crate::diag::diag_debug!(
                    { item_id = item.id, error = %error,
                      "skipping unsupported nested IfcMappedItem in representation map" }
                    else {
                        #[cfg(debug_assertions)]
                        eprintln!("[ifc-lite] Skipping unsupported nested IfcMappedItem #{} in representation map: {}",
                            item.id, error);
                    }
                );
            } else {
                let walk = "representation-map";
                let _ = walk;
                crate::diag::diag_debug!(
                    { item_id = item.id, ifc_type = ?item.ifc_type, walk, error = %error,
                      "skipping unsupported source item" }
                    else {
                        #[cfg(debug_assertions)]
                        eprintln!("[ifc-lite] Skipping unsupported {walk} item #{} ({:?}): {}",
                            item.id, item.ifc_type, error);
                    }
                );
            }
        });
        Ok(())
    }
    pub(super) fn take_output(&mut self) -> Option<Result<GeometryOutput>> { self.output.take() }
    pub(super) fn cancel(&mut self) { self.action = None; self.child = None; self.program = None; self.item = None; }
}

/// Same keep_rebase_in_origin arithmetic; only actual plain/textured children
/// take it. Nested mapped parts already own their correct transformed frames.
pub(super) struct ReadyRestore { output: TypeItemOutput, rtc: (f64, f64, f64) }
impl ReadyRestore {
    fn execute(mut self) -> TypeItemOutput {
        let restore = |mesh: &mut Mesh| super::mapping::keep_rebase_in_origin(mesh, self.rtc);
        match &mut self.output {
            TypeItemOutput::Retained(_)=>{},
            TypeItemOutput::Parts(parts) => parts.iter_mut().for_each(restore),
            TypeItemOutput::Textured(mesh, _, _) => restore(mesh),
        }
        self.output
    }
}
impl Action {
    fn stage(&self) -> ProgramStage {
        match self {
            Self::TextureReady(_) | Self::Restore(_) | Self::Merge(_) | Self::Finish(_) => ProgramStage::Numerical,
            Self::Child(request) => request.stage(),
            _ => ProgramStage::Source,
        }
    }
}

#[cfg(test)]
#[path = "inner_type_map_tests.rs"]
mod tests;

impl TypeMapControl {
    pub(super) fn cancel_with_reports(&mut self,router:&GeometryRouter) {
        if let Some(child)=&mut self.child {child.program.cancel_with_reports(router).expect("validated cancellation router");}
        self.cancel();
    }
}
