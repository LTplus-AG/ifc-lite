// SPDX-License-Identifier: MPL-2.0
//! Detached numerical completion must report the reservation it actually refused.
use super::*;
use crate::resource::{ExecutionAccount,ExecutionPolicy,ResourceLimits,ProgramStop,Dimension};
use crate::{GeometryProcessor,TessellationQuality};

#[test]
fn p1_detached_finish_returns_typed_header_stop_instead_of_successful_empty() {
    let mut decoder=EntityDecoder::new("#10=IFCBLOCK($,2.,3.,4.);");
    let item=decoder.decode_by_id(10).unwrap();
    let mesh=crate::processors::BlockProcessor::new().lower_owned(
        &item,&mut decoder,TessellationQuality::Medium,None).unwrap().unwrap().evaluate().unwrap();
    let mut parts=crate::router::frame_parts::SourceParts::default();
    parts.merge(&mesh);
    let account=ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        live_bytes:Some(0),..Default::default()
    }));
    let ready=MergedReady(Numerical::Finish(Accumulator::Mesh(parts)));
    let reply=account.scope(||ready.execute());
    // No common acceptor runs: the detached reply itself must carry the error.
    assert!(matches!(reply.0,Reply::Finished(Err(Error::ProgramStopped(
        ProgramStop::ResourceRefused(failure)))) if failure.dimension==Dimension::LiveBytes));
}
