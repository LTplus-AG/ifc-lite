// SPDX-License-Identifier: MPL-2.0
//! A Boolean output owns a new logical definition in the left input's frame.
use super::*;
pub(in crate::program) fn boolean_operation(inputs: [LogicalRetainedValue; 2], operation: crate::BoolOp)
    -> crate::Result<RetainedPlanOperation> {
    if !matches!(operation, crate::BoolOp::Union | crate::BoolOp::Intersection | crate::BoolOp::Difference)
        || inputs[0].slot.program != inputs[1].slot.program
        || inputs[0].contract != inputs[1].contract
        || inputs[0].length_unit_scale != inputs[1].length_unit_scale {
        return Err(crate::Error::geometry("invalid retained Boolean inputs"));
    }
    for value in &inputs { value.validate_identity()?; proper_rigid(&value.world_from_evaluation())?; }
    crate::resource::charge(crate::resource::Cost { work: 1, occurrences: 1,
        live_bytes: std::mem::size_of::<[LogicalRetainedValue; 2]>() as u64, ..Default::default() })?.retain();
    let slot = next_slot(inputs[0].slot.program)?;
    let identity = crate::math::mat4::col_major_array(&nalgebra::Matrix4::identity());
    let value = LogicalRetainedValue {
        definition: LogicalRetainedDefinition::Operation(slot), slot,
        length_unit_scale: inputs[0].length_unit_scale, contract: inputs[0].contract,
        object_frame: inputs[0].object_frame,
        source_from_evaluation: identity, evaluation_from_source: identity, world_from_source: identity,
        placements: Vec::new(), presentation: Vec::new(), product_placed: false, outcome: outcome::new()?,
    };
    Ok(RetainedPlanOperation { value, kind: RetainedOperationKind::Boolean { inputs: Box::new(inputs), operation } })
}
