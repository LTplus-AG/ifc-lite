// SPDX-License-Identifier: MPL-2.0
//! Retained admission of authored mapping directions, before exact recovery.
use ifc_lite_core::{slot, AttributeValue, DecodedEntity, EntityDecoder, IfcType};
use crate::{Result, Vector3};

fn refused() -> crate::Error {
    crate::Error::geometry("retained mapping direction admission refused")
}

// Shared leaf reading owns numeric/category validity. The retained boundary
// additionally distinguishes `$` from `*`, enforces the frame's dimension and
// rejects zero ratios. Rescaling here is only for admission predicates; the
// canonical readers still compute every output transform from the raw source.
fn direction(entity: &DecodedEntity, index: usize, dimension: usize,
    decoder: &mut EntityDecoder) -> Result<Option<Vector3<f64>>> {
    let id = match entity.get(index) {
        None | Some(AttributeValue::Null) => return Ok(None),
        Some(AttributeValue::EntityRef(id)) => *id,
        _ => return Err(refused()),
    };
    let leaf = decoder.decode_by_id(id)?;
    if leaf.ifc_type != IfcType::IfcDirection {
        return Err(refused());
    }
    let ratios = leaf.get(slot::IfcDirection::DIRECTION_RATIOS.index())
        .and_then(AttributeValue::as_list).ok_or_else(refused)?;
    if ratios.len() != dimension {
        return Err(refused());
    }
    let raw = decoder.direction3(id)?;
    let scale = raw.iter().fold(0.0_f64, |largest, v| largest.max(v.abs()));
    if scale == 0.0 {
        return Err(refused());
    }
    Ok(Some(Vector3::from(raw) / scale))
}

fn independent(a: Vector3<f64>, b: Vector3<f64>) -> bool {
    a.cross(&b).iter().any(|v| *v != 0.0)
}

fn admit_pair(a: Vector3<f64>, b: Vector3<f64>) -> Result<()> {
    if !independent(a, b) { return Err(refused()); }
    Ok(())
}

pub(super) fn origin(entity: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<()> {
    match entity.ifc_type {
        IfcType::IfcAxis2Placement2D => {
            direction(entity, slot::IfcAxis2Placement2D::REF_DIRECTION.index(), 2, decoder)?;
        }
        IfcType::IfcAxis2Placement3D => {
            let z = direction(entity, slot::IfcAxis2Placement3D::AXIS.index(), 3, decoder)?;
            let x = direction(entity, slot::IfcAxis2Placement3D::REF_DIRECTION.index(), 3, decoder)?;
            // Omitted RefDirection permits canonical perpendicular derivation,
            // including Axis=+X. An explicit X must project against Z.
            if let Some(x) = x { admit_pair(z.unwrap_or_else(Vector3::z), x)?; }
        }
        _ => return Err(refused()),
    }
    Ok(())
}

pub(super) fn target(entity: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<()> {
    let dimension = match entity.ifc_type {
        IfcType::IfcCartesianTransformationOperator2D
        | IfcType::IfcCartesianTransformationOperator2DnonUniform => 2,
        IfcType::IfcCartesianTransformationOperator3D
        | IfcType::IfcCartesianTransformationOperator3DnonUniform => 3,
        _ => return Err(refused()),
    };
    let x = direction(entity, slot::IfcCartesianTransformationOperator::AXIS1.index(), dimension, decoder)?;
    let y = direction(entity, slot::IfcCartesianTransformationOperator::AXIS2.index(), dimension, decoder)?;
    if dimension == 2 {
        // Either axis alone determines a valid planar frame. In particular,
        // Axis2 alone must not be compared with a fabricated default +X.
        if let (Some(x), Some(y)) = (x, y) { admit_pair(x, y)?; }
    } else {
        let z = direction(entity, slot::IfcCartesianTransformationOperator3D::AXIS3.index(), 3, decoder)?
            .unwrap_or_else(Vector3::z);
        if let Some(x) = x { admit_pair(z, x)?; }
        if let Some(y) = y {
            // Test the projection's span without computing a transform. Only
            // an omitted X may select a perpendicular default when Z is ±X.
            let x = x.unwrap_or_else(|| if independent(z, Vector3::x()) {
                Vector3::x()
            } else { Vector3::y() });
            if z.cross(&x).dot(&y) == 0.0 { return Err(refused()); }
        }
    }
    Ok(())
}
