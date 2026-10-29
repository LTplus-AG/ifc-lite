// SPDX-License-Identifier: MPL-2.0
//! CUT-0 dispatch preserves today's refusal; M5/M6 replace individual stubs.
mod plane;
mod boxed;
mod bounded;
pub(in crate::program) mod plane_source;
use super::{cutter::CutterStep, failure::{FailureHandle, FailureSite, OriginCause}, LogicalRetainedValue};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
#[allow(dead_code)] // #7955: inputs consumed when M5/M6 replace the stubs.
pub(in crate::program) struct Context<'a, 'b> {
    pub host: &'a LogicalRetainedValue,
    pub second: &'a DecodedEntity,
    pub operator: crate::BoolOp,
    pub decoder: &'a mut EntityDecoder<'b>,
    pub failure: &'a FailureHandle,
}
pub(in crate::program) fn step(ctx: Context<'_, '_>) -> crate::Result<CutterStep> {
    match ctx.second.ifc_type {
        IfcType::IfcHalfSpaceSolid => plane::step(ctx),
        IfcType::IfcBoxedHalfSpace => boxed::step(ctx),
        IfcType::IfcPolygonalBoundedHalfSpace => bounded::step(ctx),
        _ => refuse(ctx),
    }
}
fn refuse(ctx: Context<'_, '_>) -> crate::Result<CutterStep> {
    let refusal = crate::document::RetainedRefusal::UnsupportedSource(ctx.second.ifc_type.to_string());
    let error = crate::Error::geometry(refusal.to_string());
    ctx.failure.record(FailureSite::BooleanSecondOperand, Some(ctx.second.id), OriginCause::Recipe(refusal));
    Err(error)
}
