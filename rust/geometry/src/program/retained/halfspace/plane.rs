// SPDX-License-Identifier: MPL-2.0
//! Plane clips use the shared finite cutter and the ordinary retained Difference.
use super::super::{cutter::{self, CutterError}, failure::OriginCause};
use crate::{document::RetainedRefusal, BoolOp};

pub(super) fn step(ctx: super::Context<'_, '_>) -> crate::Result<super::CutterStep> {
    match ctx.operator {
        BoolOp::Difference => {}
        BoolOp::Union => return Err(refuse(&ctx, RetainedRefusal::UnsupportedSource("halfspace_union".into()))),
        BoolOp::Intersection => return Err(refuse(&ctx, RetainedRefusal::UnsupportedSource("halfspace_intersection".into()))),
        _ => return Err(refuse(&ctx, RetainedRefusal::InvalidSource("unknown halfspace operator"))),
    }
    // Mapped operands have already gone through MappingControl's existing bake.
    // Never invent a second affine transform or approximate a non-rigid normal.
    super::super::proper_rigid(&ctx.host.world_from_evaluation()).map_err(|_| {
        refuse(&ctx, RetainedRefusal::UnsupportedSource("unbaked_halfspace_host".into()))
    })?;
    let (p, r) = match super::plane_source::lower(ctx.host, ctx.second, ctx.decoder) {
        Ok(plane) => plane,
        Err(error @ crate::Error::ProgramStopped(_)) => return Err(error),
        Err(error) => {
            ctx.failure.record(super::FailureSite::BooleanSecondOperand, Some(ctx.second.id), OriginCause::Opaque(error));
            return Err(crate::Error::geometry("invalid halfspace plane source"));
        }
    };
    cutter::halfspace_box(ctx.host, ctx.second.id, p, r).map_err(|error| match error {
        CutterError::Recipe(error) => refuse(&ctx, error),
        CutterError::Control(error) => error,
    })
}

fn refuse(ctx: &super::Context<'_, '_>, refusal: RetainedRefusal) -> crate::Error {
    let error = crate::Error::geometry(refusal.to_string());
    ctx.failure.record(super::FailureSite::BooleanSecondOperand, Some(ctx.second.id), OriginCause::Recipe(refusal));
    error
}
