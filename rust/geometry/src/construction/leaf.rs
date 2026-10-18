// SPDX-License-Identifier: MPL-2.0
//! Optional eager graphs reuse actual processor-owned constructor admission.
use super::{Construction, ConstructionRequirement, source::Role};
use crate::{GeometryRouter, router::builtin_processor};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema};

pub(super) fn lower_leaf(router: &GeometryRouter, schema: &IfcSchema,
    decoder: &mut EntityDecoder, entity: &DecodedEntity,
    role: Role) -> std::result::Result<Construction, ConstructionRequirement> {
    // Root dispatch uses the configured registration. Boolean operands have
    // always used fresh builtins, independently of custom router overrides.
    let operand = if role == Role::Root { None } else { builtin_processor(entity.ifc_type.clone(), schema) };
    let processor = if role == Role::Root { router.processor_for(&entity.ifc_type).map(|p| p.as_ref()) }
        else { operand.as_deref() }.ok_or(ConstructionRequirement::ConstructorNotLowered)?;
    let result = processor.lower_owned(entity, decoder, router.tessellation_quality(), None)
        .ok_or(ConstructionRequirement::ConstructorNotLowered)?;
    let plan = result.map_err(|error| ConstructionRequirement::SourceAdmission(error.to_string()))?;
    // Retain eager source evidence even when another root prevents execution.
    // Numerical evaluation still replays per-face reports in their own order.
    plan.restore_source_reports();
    Ok(Construction::Builtin(plan))
}
