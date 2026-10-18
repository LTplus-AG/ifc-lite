// SPDX-License-Identifier: MPL-2.0
//! Source admission of the CSG wrapper's one tree-root reference.
use crate::{Error, Result};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};

pub(crate) fn resolve_tree_root(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<DecodedEntity> {
    // Preserve positional-compatible malformed wrappers without introducing
    // a typed-slot owner assertion ahead of the existing admission errors.
    let root_attr = entity
        .get(slot::IfcCsgSolid::TREE_ROOT_EXPRESSION.index())
        .ok_or_else(|| Error::geometry("IfcCsgSolid missing TreeRootExpression".to_string()))?;
    let root = decoder
        .resolve_ref(root_attr)?
        .ok_or_else(|| Error::geometry("IfcCsgSolid TreeRootExpression unresolved".to_string()))?;
    match root.ifc_type {
        IfcType::IfcBooleanResult
        | IfcType::IfcBooleanClippingResult
        | IfcType::IfcBlock
        | IfcType::IfcSphere => Ok(root),
        IfcType::IfcCsgSolid => Err(Error::geometry(
            "IfcCsgSolid TreeRootExpression must be IfcBooleanResult or \
             IfcCsgPrimitive3D, not another IfcCsgSolid (spec violation)"
                .to_string(),
        )),
        other => Err(Error::geometry(format!(
            "Unsupported IfcCsgSolid TreeRootExpression: {other}"
        ))),
    }
}

#[cfg(test)]
#[path = "csg_root_tests.rs"]
mod tests;
