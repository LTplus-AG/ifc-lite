// SPDX-License-Identifier: MPL-2.0
//! A Boolean output owns a new logical definition in the left input's frame.
use super::*;
/// Opening operands are already placed by their own products. Reuse the M1
/// Boolean frame checks and retain the host's presentation and object frame.
#[cfg(any(test, feature = "retained-runtime"))]
pub(in crate::program) fn opening_difference(host: LogicalRetainedValue, cutter: LogicalRetainedValue,
    failure: &failure::FailureHandle, opening: u32) -> crate::Result<RetainedPlanOperation> {
    use value_error::ValueReason;
    let check = || -> Result<(), ValueReason> {
        if host.slot.program != cutter.slot.program || host.contract != cutter.contract {
            return Err(ValueReason::OperationProgram);
        }
        if host.length_unit_scale != cutter.length_unit_scale { return Err(ValueReason::UnitDomain); }
        if !host.product_placed || !cutter.product_placed { return Err(ValueReason::PlacementDomain); }
        for value in [&host, &cutter] {
            value.validate_identity()?;
            proper_rigid(&value.world_from_evaluation())?;
        }
        Ok(())
    };
    check().map_err(|reason| reason.into_common(failure, failure::FailureSite::OpeningCut, Some(opening)))?;
    let mut result = boolean_operation([host, cutter], crate::BoolOp::Difference)?;
    if let RetainedOperationKind::Boolean { inputs, .. } = &result.kind {
        crate::resource::reserve_headers(&mut result.value.presentation, inputs[0].presentation.len())?.retain();
        result.value.presentation.extend_from_slice(&inputs[0].presentation);
    }
    result.value.product_placed = true;
    Ok(result)
}
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
        #[cfg(any(all(test, any(not(target_arch = "wasm32"), feature = "wasm_source_capture")), feature = "retained-runtime"))]
        bounds: bounds::boolean_bounds(&inputs, operation),
        definition: LogicalRetainedDefinition::Operation(slot), slot,
        length_unit_scale: inputs[0].length_unit_scale, contract: inputs[0].contract,
        object_frame: inputs[0].object_frame,
        source_from_evaluation: identity, evaluation_from_source: identity, world_from_source: identity,
        placements: Vec::new(), presentation: Vec::new(), product_placed: false, outcome: outcome::new()?,
    };
    Ok(RetainedPlanOperation { #[cfg(any(test, feature = "retained-runtime"))] opening: None, value, kind: RetainedOperationKind::Boolean { inputs: Box::new(inputs), operation } })
}
