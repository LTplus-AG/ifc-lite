// SPDX-License-Identifier: MPL-2.0
//! Source-free mapped geometry operations. Only derived meshes, frame origins,
//! transforms and numeric policy enter these consuming packets.
use super::{MergedReply,Reply};
use crate::{Mesh,Result,InstanceMeta,math::mat4};
use super::super::values::{Accumulator, MappedValues};
use nalgebra::Matrix4;
use std::sync::Arc;
use crate::resource::{self,Cost};

pub(crate) struct MergedReady(pub(super) Numerical);
pub(super) enum Numerical {
    Clone(Arc<Mesh>), Merge {parts:Accumulator,incoming:MappedValues,rtc:Option<(f64,f64,f64)>},
    Finish(Accumulator), Place(Place),
}
pub(super) struct Place {
    pub parts:MappedValues,pub program:u64,pub id:u32,pub transform:Option<Matrix4<f64>>,pub instancing:bool,pub truncated:bool,
}
impl MergedReady {
    pub(crate) fn reply_tag(&self)->u8 {match &self.0 {
        Numerical::Merge {..}=>20,Numerical::Finish(_)=>21,Numerical::Clone(_)=>22,Numerical::Place(_)=>23,
    }}
    pub(crate) fn admit_retained(self) -> Result<(MergedReply, Vec<crate::program::RetainedPlanOperation>)> {
        let mut reply = self.execute();
        let mut operations = Vec::new();
        if let Reply::Ready(Ok((MappedValues::Retained(values), _))) = &mut reply.0 {
            for value in values {
                if let Some(operation) = value.bake()? {
                    resource::reserve_headers(&mut operations, 1)?.retain();
                    operations.push(operation);
                }
            }
        }
        Ok((reply, operations))
    }
    pub(crate) fn execute(self)->MergedReply {
        MergedReply(match self.0 {
            Numerical::Clone(mesh)=>Reply::Cloned((||->Result<Mesh> {
                resource::check_current()?;
                if resource::is_active() {let (mesh,permit)=resource::mesh::clone_mesh(&mesh)?;permit.retain();Ok(mesh)}
                else {Ok(mesh.as_ref().clone())}
            })()),
            Numerical::Merge {parts,incoming,rtc}=>Reply::Merged(parts.merge(incoming,rtc)),
            Numerical::Finish(parts)=>Reply::Finished(parts.finish()),
            Numerical::Place(place)=>Reply::Ready(place.execute()),
        })
    }
}
impl Place {
    fn execute(self)->Result<(MappedValues,bool)> {
        if let MappedValues::Retained(values) = self.parts {
            let transform=self.transform.unwrap_or_else(Matrix4::identity);
            let mut output=Vec::new();
            resource::reserve_headers(&mut output,values.len())?.retain();
            for value in values { output.push(value.placed(&transform,self.program,crate::program::retained::RetainedPlacementStage::Mapping {source_id:self.id})?); }
            return Ok((MappedValues::Retained(output),self.truncated));
        }
        let MappedValues::Mesh(mut parts)=self.parts else {unreachable!()};
        resource::check_current()?;
        if resource::is_active() {
            let work=parts.iter().try_fold(0u64,|n,mesh|n.checked_add(mesh.positions.len() as u64)).ok_or_else(resource::overflow)?;
            resource::charge(Cost {work,..Default::default()})?;
        }
        let mut local_rm=None;
        if let Some(transform)=self.transform {
            if self.instancing {local_rm=Some(mat4::from_na(&transform))}
            for part in &mut parts {crate::router::transforms::transform_mesh_local(part,&transform)}
        }
        if self.instancing && parts.len()==1 {
            parts[0].instance_meta=Some(InstanceMeta {transform:mat4::IDENTITY,local_transform:local_rm,
                canonical_transform:None,rep_identity:self.id as u128,instanceable:true});
        }
        Ok((MappedValues::Mesh(parts),self.truncated))
    }
}
