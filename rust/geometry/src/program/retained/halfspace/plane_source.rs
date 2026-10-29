// SPDX-License-Identifier: MPL-2.0
//! Shared plane source semantics. Exact HalfSpacePlan is read without changes.
#![allow(dead_code)] // #7955: consumed by the M5/M6 step implementations.
use super::LogicalRetainedValue;
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use nalgebra::{Matrix4, Vector4};
pub(in crate::program) fn lower(host: &LogicalRetainedValue, halfspace: &DecodedEntity, decoder: &mut EntityDecoder)
    -> crate::Result<([f64; 3], [f64; 3])> {
    let (p, n, agreement) = crate::processors::boolean::HalfSpacePlan::lower(halfspace, decoder)?.components();
    let frame = host.world_from_evaluation();
    super::super::proper_rigid(&frame)?;
    let identity = crate::math::mat4::col_major_array(&Matrix4::identity());
    let inverse = crate::document::retained_frames::relative(*host.object_frame(), identity)
        .map_err(crate::Error::geometry)?;
    let inverse = Matrix4::from_column_slice(&inverse);
    let p = inverse * Vector4::new(p.x * host.length_unit_scale, p.y * host.length_unit_scale, p.z * host.length_unit_scale, 1.);
    let r = if agreement { -n } else { n };
    let r = inverse * r.push(0.);
    Ok(([p.x, p.y, p.z], [r.x, r.y, r.z]))
}
