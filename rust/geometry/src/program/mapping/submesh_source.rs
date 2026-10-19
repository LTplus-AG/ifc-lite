// SPDX-License-Identifier: MPL-2.0
//! Styled mapping source order: source, representation, transform, instancing
//! eligibility, template claim, source claim, then the whole optional item list.
use super::*;
impl SubmeshSource {
    pub(crate) fn execute(self,router:&GeometryRouter,decoder:&mut EntityDecoder<'_>,
        textures:Option<&FxHashMap<u32,ResolvedTextureMap>>,store:&mut MappingStore)->SubmeshReply {
        self.execute_contract(router,decoder,textures,store,None)
    }
    pub(crate) fn execute_contract(self,router:&GeometryRouter,decoder:&mut EntityDecoder<'_>,
        textures:Option<&FxHashMap<u32,ResolvedTextureMap>>,store:&mut MappingStore,
        mut retained:Option<&mut super::super::values::RetainedCache>)->SubmeshReply {
        if let SourceAction::Work(work)=self.0 {return SubmeshReply {value:Reply::Work(work.execute()),tag:0}}
        let tag=match &self.0 {
            SourceAction::MappingSource(_)=>1,SourceAction::Representation(_)=>2,SourceAction::Transform(_)=>3,
            SourceAction::Eligibility(_)=>4,SourceAction::Template(..)=>5,SourceAction::Claim(_)=>6,
            SourceAction::Items(_)=>7,SourceAction::Placeholder(_)=>8,SourceAction::SharedItems(_)=>9,
            SourceAction::SharedFinished {..}=>10,SourceAction::Finish {..}=>11,SourceAction::Dropped {..}=>12,
            SourceAction::Work(_)=>unreachable!(),
        };
        let result=(||->Result<Reply> {
            resource::check_current()?;
            Ok(match self.0 {
                SourceAction::MappingSource(mut state)=> {
                    state.source=Some(super::super::source(&state.item,decoder)?);
                    Reply::Next(Self(SourceAction::Representation(state)))
                }
                SourceAction::Representation(mut state)=> {
                    state.representation=Some(super::super::representation(state.source.as_ref().expect("mapped source"),decoder)?);
                    Reply::Next(Self(SourceAction::Transform(state)))
                }
                SourceAction::Transform(mut state)=> {
                    let mut transform=router.mapped_item_transform(&state.item,state.source.as_ref().expect("mapped source"),decoder)?;
                    if let Some(matrix)=&mut transform {router.scale_transform(matrix)}
                    if retained.is_some() {crate::program::retained::proper_rigid(&transform.unwrap_or_else(Matrix4::identity))?;}
                    state.transform=transform;Reply::Next(Self(SourceAction::Eligibility(state)))
                }
                SourceAction::Eligibility(state)=> {
                    let solid_id=occurrence::solid_id(state.source.as_ref().expect("mapped source").id,
                        state.representation.as_ref().expect("mapped representation"),state.depth,state.allow_instancing,
                        textures,router,decoder);
                    Reply::Next(Self(SourceAction::Template(state,solid_id)))
                }
                SourceAction::Template(mut state,solid_id)=> {
                    let admission=occurrence::claim_contract(&state.item,state.source.as_ref().expect("mapped source").id,
                        state.representation.take().expect("mapped representation"),state.transform,solid_id,router,store,retained.as_deref_mut())?;
                    Reply::Admitted(Source {item_id:state.item.id,depth:state.depth,policy:state.policy,start:state.start,
                        admission,items:ItemProgram::empty(),retained_template:Vec::new()})
                }
                SourceAction::Claim(source)=>Reply::Claimed(source),
                SourceAction::Items(mut source)=> {
                    source.items=match ItemProgram::admit(&source.admission.representation,decoder,ItemListPolicy::OptionalMap) {
                        Ok(items)=>items,Err(error)=> {occurrence::release(&source.admission,store);return Err(error)}
                    };Reply::Source(source)
                }
                SourceAction::Placeholder(source) if retained.is_some()=>match retained.as_deref().expect("retained cache").get_styled(source.admission.source_id)? {
                    Some(values)=>Reply::CachedPlaceholder {source,values},None=>Reply::SharedClaim(source),
                },
                SourceAction::Placeholder(source)=>if !router.shared_mapped_source_needed(source.admission.source_id) {
                    Reply::Entered(source)
                } else {Reply::SharedClaim(source)},
                SourceAction::SharedItems(mut source)=> {
                    source.items=ItemProgram::admit(&source.admission.representation,decoder,ItemListPolicy::OptionalMap)
                        .unwrap_or_else(|_|ItemProgram::empty());
                    resource::check_current()?;Reply::Shared(Shared {source,parts:Accumulator::new(retained.is_some())})
                }
                SourceAction::SharedFinished {source,parts}=>Reply::Publish {source,parts},
                SourceAction::Finish {source,nonempty}=>Reply::Commit {source,nonempty},
                SourceAction::Dropped {parent,item,error}=>Reply::Dropped {parent,item,error},
                SourceAction::Work(_)=>unreachable!(),
            })
        })();
        SubmeshReply {value:result.unwrap_or_else(Reply::Fault),tag}
    }
}
