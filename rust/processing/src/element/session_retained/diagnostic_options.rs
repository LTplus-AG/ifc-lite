// SPDX-License-Identifier: MPL-2.0
//! Decode the existing private options contract at the actual native entry.
use super::*;
use crate::retained_native_contract as wire;

pub(super) struct Options {
    pub(super) wire: wire::Options,
    pub(super) limits: runtime::NumericalLimits,
    pub(super) budget: resource::InspectionBudget,
    pub(super) mode: TypeGeometryMode,
}
impl Options {
    pub(super) fn decode(json: &str) -> Result<Self, RetainedExecutionError> {
        let start = resource::InspectionStart::now();
        resource::check_current().map_err(RetainedExecutionError::Stopped)?;
        let invalid = || protocol(ReceiptFailure::InvalidRetainedNumericalLimits);
        if json.len() > 4096 { return Err(invalid()); }
        let wire = wire::decode_options(json).map_err(|_| invalid())?;
        let max_work = wire.max_work.parse().map_err(|_| invalid())?;
        let max_bytes = wire.max_bytes.parse().map_err(|_| invalid())?;
        let deadline_ms = wire.deadline_ms.parse().map_err(|_| invalid())?;
        let limits = runtime::NumericalLimits { chord_metres: wire.chord_tolerance_metres,
            angle_degrees: wire.angle_tolerance_radians.to_degrees(),
            max_bytes: usize::try_from(max_bytes).map_err(|_| invalid())? };
        IssuedCommonConstruction::validate_numerical_limits(limits.chord_metres, limits.angle_degrees, limits.max_bytes)?;
        let mode = match wire.type_geometry_mode {
            wire::TypeGeometryMode::SuppressInstanced => TypeGeometryMode::SuppressInstanced,
            wire::TypeGeometryMode::EmitTagged => TypeGeometryMode::EmitTagged,
        };
        Ok(Self { wire, limits, mode, budget: resource::InspectionBudget::new(start, max_work, max_bytes, deadline_ms) })
    }
}
