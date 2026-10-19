// SPDX-License-Identifier: MPL-2.0
//! Owned source-free styled range, append and shared source assembly packets.
use super::*;
impl Range {
    pub(crate) fn execute(mut self) -> SubmeshReply {
        let result = (|| {
            resource::check_current()?;
            if matches!(self.meshes,StyledValues::Retained(_)) {
                let template=if self.capture {let StyledValues::Retained(v)=&self.meshes else {unreachable!()};
                    Some(MappedValues::Retained(crate::program::retained::copy_values(&v[self.start..])?))} else {None};
                if self.placeholder.is_some() {
                    let mut incoming=StyledValues::from_parts(self.cached.take().ok_or_else(||Error::geometry("retained placeholder missing definitions"))?)?;
                    incoming.retained_range(0,self.transform,self.program,self.source_id,self.binding)?;
                    self.meshes=self.meshes.append(incoming,None)?;
                } else if !self.finish {
                    self.meshes.retained_range(self.start,self.transform,self.program,self.source_id,self.binding)?;
                }
                resource::check_current()?;
                return Ok(Reply::Transformed {meshes:self.meshes,template});
            }
            let StyledValues::Mesh(meshes)=&mut self.meshes else {unreachable!()};
            if let Some((solid_id, source_id)) = self.placeholder {
                let mut mesh = Mesh::new();
                mesh.instance_meta = Some(crate::InstanceMeta { transform: crate::math::mat4::IDENTITY,
                    local_transform: self.transform.map(|m| crate::math::mat4::from_na(&m)),
                    canonical_transform: None, rep_identity: source_id as u128, instanceable: true });
                resource::charge(Cost { output_bytes: std::mem::size_of::<crate::SubMesh>() as u64,
                    live_bytes: std::mem::size_of::<crate::SubMesh>() as u64, ..Cost::default() })?.retain();
                resource::reserve_headers(&mut meshes.sub_meshes, 1)?.retain();
                meshes.sub_meshes.push(crate::SubMesh::new(solid_id, mesh));
            } else if let Some(source_id) = self.retag {
                for sub in &mut meshes.sub_meshes[self.start..] {
                    if let Some(instance) = sub.mesh.instance_meta.as_mut() {
                        instance.rep_identity = source_id as u128;
                        instance.local_transform = self.transform.map(|m| crate::math::mat4::from_na(&m));
                    }
                }
            } else if !self.finish {
                occurrence::transform_children_owned(self.transform, self.start, meshes);
            }
            resource::check_current()?;
            Ok(Reply::Transformed { meshes: self.meshes, template:None })
        })();
        SubmeshReply {value:result.unwrap_or_else(Reply::Fault),tag:20}
    }
}
impl SubmeshReady {
    pub(crate) fn admit_retained(self)->Result<(SubmeshReply,Vec<crate::program::RetainedPlanOperation>)> {
        // The template is captured before transformation by Range::execute.
        // Only the reached occurrence range is physically baked; prior values
        // and reusable source templates keep their original identities/frames.
        let start=match &self {
            Self::Range(range) if matches!(range.meshes,StyledValues::Retained(_))=> {
                if range.placeholder.is_some() {Some(range.meshes.len())}
                else if !range.finish {Some(range.start)} else {None}
            }
            _=>None,
        };
        let mut reply=self.execute();let mut operations=Vec::new();
        if let (Some(start),Reply::Transformed {meshes:StyledValues::Retained(values),..})=(start,&mut reply.value) {
            for value in &mut values[start..] {
                crate::program::retained_walk::charge(1)?;
                if let Some(operation)=value.bake()? {
                    resource::reserve_headers(&mut operations,1)?.retain();operations.push(operation);
                }
            }
        }
        Ok((reply,operations))
    }
    pub(crate) fn reply_tag(&self)->u8 {match self {
        Self::Range(_)=>20,Self::Append {..}=>21,Self::MergeShared {..}=>22,Self::FinishShared(_)=>23,
    }}
    pub(crate) fn execute(self)->SubmeshReply {
        if let Self::Range(range)=self {return range.execute()}
        let tag=self.reply_tag();
        let result=(||->Result<Reply> {
            resource::check_current()?;
            Ok(match self {
                Self::Append {meshes,incoming,rtc}=>Reply::Transformed {meshes:meshes.append(incoming,rtc)?,template:None},
                Self::MergeShared {parts,incoming,rtc}=>Reply::SharedMerged(parts.merge(incoming,Some(rtc))?),
                Self::FinishShared(parts)=>Reply::SharedFinished(parts.finish()?),
                Self::Range(_)=>unreachable!(),
            })
        })();
        SubmeshReply {value:result.unwrap_or_else(Reply::Fault),tag}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn p1_detached_retained_styled_append_refuses_before_allocating_output_headers() {
        use crate::program::{GeometryProgram,RetainedContract};
        use crate::resource::{ExecutionAccount,ExecutionPolicy,ResourceLimits,ProgramStop,Dimension};
        let source=crate::program::retained_styled_tests::SOURCE;
        let mut decoder=EntityDecoder::new(source);let router=GeometryRouter::new();
        let mut program=GeometryProgram::retained_submeshes(decoder.decode_by_id(10).unwrap(),
            RetainedContract {source_epoch:3,source_revision:7});
        crate::program::retained_styled_tests::drive(&mut program,&router,&mut decoder).unwrap();
        let values=program.finish_retained().unwrap().values;
        assert_eq!(values.len(),2);
        let ready=SubmeshReady::Append {meshes:StyledValues::Retained(Vec::new()),incoming:StyledValues::Retained(values),rtc:None};
        let account=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {live_bytes:Some(0),..Default::default()}));
        let reply=account.scope(||ready.execute());
        assert!(matches!(reply.value,Reply::Fault(Error::ProgramStopped(ProgramStop::ResourceRefused(f))) if f.dimension==Dimension::LiveBytes));
    }
}
