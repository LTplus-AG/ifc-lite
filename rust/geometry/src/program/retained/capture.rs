// SPDX-License-Identifier: MPL-2.0
use super::failure::{FailureHandle, FailureSite, OriginCause};
use super::*;
use crate::document::{RetainedExtrusion, RetainedSweptDisk};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
pub(super) fn capture(
    item: &DecodedEntity,
    decoder: &mut EntityDecoder,
    scale: f64,
    contract: RetainedContract,
    program: u64,
    failure: &FailureHandle,
) -> crate::Result<RetainedPlanOperation> {
    #[cfg(feature = "retained-runtime")]
    crate::resource::source_step()?;
    crate::resource::charge(crate::resource::Cost {
        work: 1,
        ..Default::default()
    })?
    .retain();
    let recipe = crate::analytic::with_source_capture(|| match item.ifc_type {
        IfcType::IfcExtrudedAreaSolid => Ok(RetainedRecipe::Extrusion(RetainedExtrusion {
            #[cfg(feature = "retained-runtime")]
            source: crate::analytic::try_extract_analytic_extrusion(item, decoder)?,
            #[cfg(not(feature = "retained-runtime"))]
            source: crate::analytic::extract_analytic_extrusion(item, decoder),
            length_unit_scale: scale,
        })),
        IfcType::IfcSweptDiskSolid => Ok(RetainedRecipe::SweptDisk(RetainedSweptDisk {
            solid_id: item.id,
            source: crate::analytic::extract_swept_disk(item, decoder).map_err(|error| {
                if let crate::Error::ProgramStopped(_) = error {
                    return error;
                }
                let diagnostic = crate::Error::geometry(error.to_string());
                let cause = match error {
                    crate::Error::CoreError(core) => OriginCause::Core(core),
                    other => OriginCause::Opaque(other),
                };
                failure.record(FailureSite::Constructor, Some(item.id), cause);
                diagnostic
            })?,
            length_unit_scale: scale,
        })),
        _ => Err(recipe_error(
            failure,
            item.id,
            crate::document::RetainedRefusal::UnsupportedSource(format!("{}", item.ifc_type)),
        )),
    });
    #[cfg(feature = "retained-runtime")]
    crate::resource::source_step()?;
    let recipe = recipe?;
    let payload = recipe
        .lower()
        .map_err(|refusal| recipe_error(failure, item.id, refusal))?;
    let world_from_source = crate::math::mat4::col_major_array(
        &nalgebra::Matrix4::new_nonuniform_scaling(&nalgebra::Vector3::repeat(scale)),
    );
    let object_frame = compose_frame(&world_from_source, &payload.source_from_evaluation)
        .map_err(|reason| reason.into_common(failure, FailureSite::Constructor, Some(item.id)))?;
    let slot = next_slot(program)?;
    let value = LogicalRetainedValue {
        definition: LogicalRetainedDefinition::Source {
            slot,
            source_epoch: contract.source_epoch,
            source_revision: contract.source_revision,
            source_id: item.id,
        },
        placements: Vec::new(),
        presentation: Vec::new(),
        product_placed: false,
        outcome: outcome::new()?,
        slot,
        source_from_evaluation: payload.source_from_evaluation,
        evaluation_from_source: payload.evaluation_from_source,
        object_frame,
        world_from_source,
        contract,
        length_unit_scale: scale,
    };
    Ok(RetainedPlanOperation {
        value,
        kind: RetainedOperationKind::Construction(recipe),
    })
}

fn recipe_error(
    failure: &FailureHandle,
    id: u32,
    refusal: crate::document::RetainedRefusal,
) -> crate::Error {
    let diagnostic = crate::Error::geometry(refusal.to_string());
    failure.record(
        FailureSite::Constructor,
        Some(id),
        OriginCause::Recipe(refusal),
    );
    diagnostic
}
