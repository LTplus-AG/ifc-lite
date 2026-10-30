// SPDX-License-Identifier: MPL-2.0
//! Retained admission of authored mapping directions, before exact recovery.
use ifc_lite_core::{slot, AttributeValue, DecodedEntity, EntityDecoder, IfcType};
use crate::kernel::{rational, DropAxis, Sign};
use crate::Vector3;
use super::validation::{MappingFailure, Result};
use crate::program::retained::failure::{FailureSite, MappingReason};

fn refused(entity: u32, reason: MappingReason) -> MappingFailure {
    MappingFailure::refused(FailureSite::MappingDirection, entity, reason,
        "retained mapping direction admission refused")
}

// Shared leaf reading owns numeric/category validity. The retained boundary
// additionally distinguishes `$` from `*`, enforces the frame's dimension and
// rejects zero ratios. Keep the represented binary64 values unchanged: even
// max-component division can round a coplanar triple into an independent one.
// Canonical readers still compute every output transform from the raw source.
fn direction(entity: &DecodedEntity, index: usize, dimension: usize,
    decoder: &mut EntityDecoder) -> Result<Option<Vector3<f64>>> {
    let id = match entity.get(index) {
        None | Some(AttributeValue::Null) => return Ok(None),
        Some(AttributeValue::EntityRef(id)) => *id,
        _ => return Err(refused(entity.id, MappingReason::OptionalDirectionReference { attribute: index })),
    };
    let leaf = decoder.decode_by_id(id)
        .map_err(|error| MappingFailure::core(FailureSite::MappingDirection, id, error))?;
    if leaf.ifc_type != IfcType::IfcDirection {
        return Err(refused(id, MappingReason::DirectionCategory));
    }
    let ratios = leaf.get(slot::IfcDirection::DIRECTION_RATIOS.index())
        .and_then(AttributeValue::as_list)
        .ok_or_else(|| refused(id, MappingReason::DirectionRatiosList))?;
    if ratios.len() != dimension {
        return Err(refused(id, MappingReason::DirectionDimension { expected: dimension, actual: ratios.len() }));
    }
    let raw = decoder.direction3(id)
        .map_err(|error| MappingFailure::core(FailureSite::MappingDirection, id, error))?;
    let scale = raw.iter().fold(0.0_f64, |largest, v| largest.max(v.abs()));
    if scale == 0.0 {
        return Err(refused(id, MappingReason::ZeroDirection));
    }
    Ok(Some(Vector3::from(raw)))
}

// Use the existing BigRational tier directly, not the floating-point filter:
// finite binary64 values convert exactly, including subnormals. Each projected
// minor is exact; a pair is independent iff at least one minor is nonzero.
// No normalization, floating product, tolerance or coordinate-range assumption
// intervenes. The leaf reader above supplies the required finite-input contract.
fn independent(a: Vector3<f64>, b: Vector3<f64>) -> bool {
    [DropAxis::X, DropAxis::Y, DropAxis::Z].into_iter().any(|axis|
        rational::orient2d_exact(a.into(), b.into(), [0.0; 3], axis) != Sign::Zero)
}

// With the fourth point at zero, orient3d is precisely the authored scalar
// triple product. Exact zero rejects dependence even when rounded cross/dot
// arithmetic would manufacture a nonzero residual (#7955).
fn independent_triple(a: Vector3<f64>, b: Vector3<f64>, c: Vector3<f64>) -> bool {
    rational::orient3d_exact(a.into(), b.into(), c.into(), [0.0; 3]) != Sign::Zero
}

fn admit_pair(entity: u32, a: Vector3<f64>, b: Vector3<f64>) -> Result<()> {
    if !independent(a, b) { return Err(refused(entity, MappingReason::DependentPair)); }
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
            if let Some(x) = x { admit_pair(entity.id, z.unwrap_or_else(Vector3::z), x)?; }
        }
        _ => return Err(refused(entity.id, MappingReason::Category)),
    }
    Ok(())
}

pub(super) fn target(entity: &DecodedEntity, decoder: &mut EntityDecoder) -> Result<()> {
    let dimension = match entity.ifc_type {
        IfcType::IfcCartesianTransformationOperator2D
        | IfcType::IfcCartesianTransformationOperator2DnonUniform => 2,
        IfcType::IfcCartesianTransformationOperator3D
        | IfcType::IfcCartesianTransformationOperator3DnonUniform => 3,
        _ => return Err(refused(entity.id, MappingReason::Category)),
    };
    let x = direction(entity, slot::IfcCartesianTransformationOperator::AXIS1.index(), dimension, decoder)?;
    let y = direction(entity, slot::IfcCartesianTransformationOperator::AXIS2.index(), dimension, decoder)?;
    if dimension == 2 {
        // Either axis alone determines a valid planar frame. In particular,
        // Axis2 alone must not be compared with a fabricated default +X.
        if let (Some(x), Some(y)) = (x, y) { admit_pair(entity.id, x, y)?; }
    } else {
        let z = direction(entity, slot::IfcCartesianTransformationOperator3D::AXIS3.index(), 3, decoder)?
            .unwrap_or_else(Vector3::z);
        if let Some(x) = x { admit_pair(entity.id, z, x)?; }
        if let Some(y) = y {
            let (z, x) = match x {
                // Actual authored rank stays exact on the original ratios.
                Some(x) => (z, x),
                None => {
                    // First retain the rank of the two authored directions.
                    admit_pair(entity.id, z, y)?;
                    // Omission follows the canonical normalization AND projection
                    // branches, including tiny-Z and near-X fallback. A synthetic
                    // exact-parallel default does not describe that frame (#7955).
                    let [derived_x, derived_z] =
                        crate::axis_projection::operator_xz_axes(z, Vector3::x());
                    if !derived_x.iter().chain(derived_z.iter()).all(|v| v.is_finite()) {
                        return Err(refused(entity.id, MappingReason::NonfiniteDerivedFrame));
                    }
                    // Extreme finite inputs can normalize to a zero vector.
                    // Refuse an unreliable derived frame before exact predicates.
                    admit_pair(entity.id, derived_z, derived_x)?;
                    (derived_z, derived_x)
                }
            };
            if !independent_triple(z, x, y) { return Err(refused(entity.id, MappingReason::DependentTriple)); }
        }
    }
    Ok(())
}
