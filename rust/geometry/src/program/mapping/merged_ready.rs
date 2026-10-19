// SPDX-License-Identifier: MPL-2.0
//! Source-free mapped geometry operations. Only derived meshes, frame origins,
//! transforms and numeric policy enter these consuming packets.
use super::{MergedReply,Reply};
use crate::{Mesh,Result,InstanceMeta,math::mat4};
use crate::router::frame_parts::SourceParts;
use nalgebra::Matrix4;
use std::sync::Arc;
use crate::resource::{self,Cost};

pub(crate) struct MergedReady(pub(super) Numerical);
pub(super) enum Numerical {
    Clone(Arc<Mesh>), Merge {parts:SourceParts,incoming:Vec<Mesh>,rtc:Option<(f64,f64,f64)>},
    Finish(SourceParts), Place(Place),
}
pub(super) struct Place {
    pub parts:Vec<Mesh>,pub id:u32,pub transform:Option<Matrix4<f64>>,pub instancing:bool,pub truncated:bool,
}
impl MergedReady {
    pub(crate) fn reply_tag(&self)->u8 {match &self.0 {
        Numerical::Merge {..}=>20,Numerical::Finish(_)=>21,Numerical::Clone(_)=>22,Numerical::Place(_)=>23,
    }}
    pub(crate) fn execute(self)->MergedReply {
        MergedReply(match self.0 {
            Numerical::Clone(mesh)=>Reply::Cloned((||->Result<Mesh> {
                resource::check_current()?;
                if resource::is_active() {let (mesh,permit)=resource::mesh::clone_mesh(&mesh)?;permit.retain();Ok(mesh)}
                else {Ok(mesh.as_ref().clone())}
            })()),
            Numerical::Merge {mut parts,incoming,rtc}=>Reply::Merged((||->Result<SourceParts> {
                resource::check_current()?;
                for mut mesh in incoming {
                    if let Some(rtc)=rtc {super::super::keep_rebase_in_origin(&mut mesh,rtc)}
                    parts.merge(&mesh);resource::check_current()?;
                }
                Ok(parts)
            })()),
            Numerical::Finish(parts)=>Reply::Finished((||->Result<Vec<Mesh>> {
                resource::check_current()?;let parts=parts.into_parts();resource::check_current()?;Ok(parts)
            })()),
            Numerical::Place(place)=>Reply::Ready(place.execute()),
        })
    }
}
impl Place {
    fn execute(mut self)->Result<(Vec<Mesh>,bool)> {
        resource::check_current()?;
        if resource::is_active() {
            let work=self.parts.iter().try_fold(0u64,|n,mesh|n.checked_add(mesh.positions.len() as u64)).ok_or_else(resource::overflow)?;
            resource::charge(Cost {work,..Default::default()})?;
        }
        let mut local_rm=None;
        if let Some(transform)=self.transform {
            if self.instancing {local_rm=Some(mat4::from_na(&transform))}
            for part in &mut self.parts {crate::router::transforms::transform_mesh_local(part,&transform)}
        }
        if self.instancing && self.parts.len()==1 {
            self.parts[0].instance_meta=Some(InstanceMeta {transform:mat4::IDENTITY,local_transform:local_rm,
                canonical_transform:None,rep_identity:self.id as u128,instanceable:true});
        }
        Ok((self.parts,self.truncated))
    }
}
