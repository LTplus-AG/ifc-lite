// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::document::{RetainedExtrusion, RetainedSweptDisk};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
pub(super) fn capture(
    item: &DecodedEntity,
    decoder: &mut EntityDecoder,
    scale: f64,
    contract: RetainedContract,
    program: u64,
) -> crate::Result<RetainedPlanOperation> {
    crate::resource::charge(crate::resource::Cost {
        work: 1,
        ..Default::default()
    })?
    .retain();
    let recipe = crate::analytic::with_source_capture(|| match item.ifc_type {
        IfcType::IfcExtrudedAreaSolid => Ok(RetainedRecipe::Extrusion(RetainedExtrusion {
            source: crate::analytic::extract_analytic_extrusion(item, decoder),
            length_unit_scale: scale,
        })),
        IfcType::IfcSweptDiskSolid => Ok(RetainedRecipe::SweptDisk(RetainedSweptDisk {
            solid_id: item.id,
            source: crate::analytic::extract_swept_disk(item, decoder)?,
            length_unit_scale: scale,
        })),
        _ => Err(crate::Error::geometry(
            crate::document::RetainedRefusal::UnsupportedSource(format!("{}", item.ifc_type))
                .to_string(),
        )),
    })?;
    let payload = recipe
        .lower()
        .map_err(|refusal| crate::Error::geometry(refusal.to_string()))?;
    let world_from_source = crate::math::mat4::col_major_array(
        &nalgebra::Matrix4::new_nonuniform_scaling(&nalgebra::Vector3::repeat(scale)),
    );
    let object_frame = compose_frame(&world_from_source, &payload.source_from_evaluation)?;
    let slot = next_slot(program)?;
    let value = LogicalRetainedValue {
        definition: LogicalRetainedDefinition::Source {
            slot,
            source_epoch: contract.source_epoch,
            source_revision: contract.source_revision,
            source_id: item.id,
        },
        length_unit_scale: scale,
        placements: Vec::new(),
        presentation: Vec::new(),
        product_placed: false,
        empty: false,
        slot,
        source_from_evaluation: payload.source_from_evaluation,
        evaluation_from_source: payload.evaluation_from_source,
        object_frame,
        world_from_source,
        contract,
    };
    Ok(RetainedPlanOperation {
        value,
        kind: RetainedOperationKind::Construction(recipe),
    })
}
