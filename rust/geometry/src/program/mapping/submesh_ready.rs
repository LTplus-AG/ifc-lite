// SPDX-License-Identifier: MPL-2.0
//! Owned source-free styled range, append and shared source assembly packets.
use super::*;
impl Range {
    pub(crate) fn execute(mut self) -> SubmeshReply {
        let result = (|| {
            resource::check_current()?;
            if let Some((solid_id, source_id)) = self.placeholder {
                let mut mesh = Mesh::new();
                mesh.instance_meta = Some(crate::InstanceMeta { transform: crate::math::mat4::IDENTITY,
                    local_transform: self.transform.map(|m| crate::math::mat4::from_na(&m)),
                    canonical_transform: None, rep_identity: source_id as u128, instanceable: true });
                resource::charge(Cost { output_bytes: std::mem::size_of::<crate::SubMesh>() as u64,
                    live_bytes: std::mem::size_of::<crate::SubMesh>() as u64, ..Cost::default() })?.retain();
                resource::reserve_headers(&mut self.meshes.sub_meshes, 1)?.retain();
                self.meshes.sub_meshes.push(crate::SubMesh::new(solid_id, mesh));
            } else if let Some(source_id) = self.retag {
                for sub in &mut self.meshes.sub_meshes[self.start..] {
                    if let Some(instance) = sub.mesh.instance_meta.as_mut() {
                        instance.rep_identity = source_id as u128;
                        instance.local_transform = self.transform.map(|m| crate::math::mat4::from_na(&m));
                    }
                }
            } else if !self.finish {
                occurrence::transform_children_owned(self.transform, self.start, &mut self.meshes);
            }
            resource::check_current()?;
            Ok(Reply::Transformed { meshes: self.meshes })
        })();
        SubmeshReply {value:result.unwrap_or_else(Reply::Fault),tag:20}
    }
}

impl SubmeshReady {
    pub(crate) fn reply_tag(&self)->u8 {match self {
        Self::Range(_)=>20,Self::Append {..}=>21,Self::MergeShared {..}=>22,Self::FinishShared(_)=>23,
    }}
    pub(crate) fn execute(self)->SubmeshReply {
        if let Self::Range(range)=self {return range.execute()}
        let tag=match &self {Self::Append {..}=>21,Self::MergeShared {..}=>22,Self::FinishShared(_)=>23,Self::Range(_)=>unreachable!()};
        let result=(||->Result<Reply> {
            resource::check_current()?;
            Ok(match self {
                Self::Append {mut meshes,mut incoming,rtc}=> {
                    if let Some(rtc)=rtc {for sub in &mut incoming.sub_meshes {super::super::keep_rebase_in_origin(&mut sub.mesh,rtc)}}
                    resource::reserve_headers(&mut meshes.sub_meshes,incoming.len())?.retain();
                    meshes.sub_meshes.append(&mut incoming.sub_meshes);Reply::Transformed {meshes}
                }
                Self::MergeShared {mut parts,incoming,rtc}=> {
                    for mut mesh in incoming {super::super::keep_rebase_in_origin(&mut mesh,rtc);parts.merge(&mesh);resource::check_current()?;}
                    Reply::SharedMerged(parts)
                }
                Self::FinishShared(parts)=> {
                    let parts=parts.into_parts();resource::check_current()?;Reply::SharedFinished(parts)
                }
                Self::Range(_)=>unreachable!(),
            })
        })();
        SubmeshReply {value:result.unwrap_or_else(Reply::Fault),tag}
    }
}
