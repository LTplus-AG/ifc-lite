// SPDX-License-Identifier: MPL-2.0
//! One reached merged mapping admission at a time. Cache and source-claim
//! publications remain owned reply effects until the common accept validates.
use super::{Source,Finish,Frame,MergedReply,Reply};
use super::super::{source,representation,frames,GeometryRouter,ItemIdentity};
use crate::{Mesh,Result,Error};
use super::super::values::{MappedValues, RetainedCache};
use ifc_lite_core::{DecodedEntity,EntityDecoder};
use nalgebra::Matrix4;
use crate::program::{ItemProgram,ItemListPolicy};
use std::sync::Arc;

pub(crate) struct MergedSource(pub(super) SourceAction);
pub(super) enum SourceAction {
    Work(frames::Admission<Frame>),
    MappingSource {item:DecodedEntity,depth:usize,policy:bool},
    Transform {item:DecodedEntity,source:DecodedEntity,depth:usize,policy:bool},
    Cache {source:DecodedEntity,depth:usize,policy:bool,transform:Option<Matrix4<f64>>},
    Representation {source:DecodedEntity,depth:usize,policy:bool,transform:Option<Matrix4<f64>>},
    WholeItems {id:u32,representation:DecodedEntity,depth:usize,policy:bool,transform:Option<Matrix4<f64>>},
    Claim {source:Source,representation:DecodedEntity},
    Publish {finish:Finish,parts:MappedValues}, PlaceCached {finish:Finish,mesh:Mesh},
    Dropped {parent:Source,item:ItemIdentity,error:Error},
}
pub(super) enum SourceValue {
    Next(MergedSource), Source(Source,DecodedEntity),
    RetainedCached {values:Vec<crate::program::retained::LogicalRetainedValue>,id:u32,transform:Option<Matrix4<f64>>},
    Cached {mesh:Arc<Mesh>,id:u32,transform:Option<Matrix4<f64>>},
    Publish {finish:Finish,parts:MappedValues,instancing:bool},
    Place {finish:Finish,parts:MappedValues,instancing:bool},
    Dropped {parent:Source,item:ItemIdentity,error:Error},
}
impl MergedSource {
    #[cfg(test)]
    pub(crate) fn execute(self,router:&GeometryRouter,decoder:&mut EntityDecoder<'_>)->MergedReply {
        self.execute_contract(router,decoder,None)
    }
    pub(crate) fn execute_contract(self,router:&GeometryRouter,decoder:&mut EntityDecoder<'_>,
        retained:Option<&RetainedCache>)->MergedReply {
        if let SourceAction::Work(work)=self.0 {return MergedReply(Reply::Admission(work.execute()))}
        let tag=match &self.0 {
            SourceAction::MappingSource {..}=>0,SourceAction::Transform {..}=>1,SourceAction::Cache {..}=>2,
            SourceAction::Representation {..}=>3,SourceAction::WholeItems {..}=>4,SourceAction::Claim {..}=>5,
            SourceAction::Publish {..}=>6,SourceAction::PlaceCached {..}=>7,SourceAction::Dropped {..}=>8,
            SourceAction::Work(_)=>unreachable!(),
        };
        let value=(||->Result<SourceValue> {
            crate::resource::check_current()?;
            Ok(match self.0 {
                SourceAction::MappingSource {item,depth,policy}=> {
                    let source=source(&item,decoder)?;
                    SourceValue::Next(Self(SourceAction::Transform {item,source,depth,policy}))
                }
                SourceAction::Transform {item,source,depth,policy}=> {
                    let mut transform=router.mapped_item_transform(&item,&source,decoder)?;
                    if let Some(matrix)=&mut transform {router.scale_transform(matrix)}
                    if retained.is_some() {
                        crate::program::retained::validate_affine(&transform.unwrap_or_else(Matrix4::identity))?;
                    }
                    SourceValue::Next(Self(SourceAction::Cache {source,depth,policy,transform}))
                }
                SourceAction::Cache {source,depth,policy,transform} if retained.is_some()=>match retained.expect("retained cache").get(source.id)? {
                    Some(values)=>SourceValue::RetainedCached {values,id:source.id,transform},
                    None=>SourceValue::Next(Self(SourceAction::Representation {source,depth,policy,transform})),
                },
                SourceAction::Cache {source,depth,policy,transform}=>match router.cached_mapped_source(source.id) {
                    Some(mesh)=>SourceValue::Cached {mesh,id:source.id,transform},
                    None=>SourceValue::Next(Self(SourceAction::Representation {source,depth,policy,transform})),
                },
                SourceAction::Representation {source,depth,policy,transform}=> {
                    let representation=representation(&source,decoder)?;
                    SourceValue::Next(Self(SourceAction::WholeItems {id:source.id,representation,depth,policy,transform}))
                }
                SourceAction::WholeItems {id,representation,depth,policy,transform}=> {
                    let items=ItemProgram::admit(&representation,decoder,ItemListPolicy::RequiredMap)?;
                    let source=Source {id,depth,policy,transform,items,parts:Default::default(),truncated:false};
                    SourceValue::Next(Self(SourceAction::Claim {source,representation}))
                }
                SourceAction::Claim {source,representation}=>SourceValue::Source(source,representation),
                SourceAction::Publish {finish,parts}=>SourceValue::Publish {finish,parts,
                    instancing:crate::router::transforms::instancing_enabled()},
                SourceAction::PlaceCached {finish,mesh}=>SourceValue::Place {finish,parts:MappedValues::Mesh(vec![mesh]),
                    instancing:crate::router::transforms::instancing_enabled()},
                SourceAction::Dropped {parent,item,error}=>SourceValue::Dropped {parent,item,error},
                SourceAction::Work(_)=>unreachable!(),
            })
        })();
        MergedReply(Reply::Source {tag,value})
    }
}
