// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The transform of one `IfcMappedItem` level, router-free and unscaled (file
//! units): `MappingTarget · MappingOrigin`. The router scales its translation
//! (`scale_transform`), the symbolic walk scales by its own unit. The router's
//! `mapped_item_transform`, `mapping_origin_transform` and the walk's
//! [`MappedLevel::local_transform`](super::MappedLevel::local_transform) are
//! this one definition.

use crate::math::tol;
use ifc_lite_core::slot::{IfcMappedItem, IfcRepresentationMap};
use crate::{Error, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;

/// `MappingTarget · MappingOrigin` of `item` (an `IfcMappedItem`, attr 1 =
/// MappingTarget) over its `source` (an `IfcRepresentationMap`, attr 0 =
/// MappingOrigin), or `None` when neither contributes.
///
/// The mapped representation's items are authored in the mapping source's
/// coordinate system, whose placement within the map IS `MappingOrigin`, so it
/// applies INNERMOST — the same composition IfcOpenShell performs
/// (`gtrsf(MappingTarget).Multiply(trsf(MappingOrigin))`). Before #1985
/// `MappingOrigin` was dropped everywhere. Returning `None` keeps the "no
/// transform to apply" fast path for the overwhelmingly common identity-origin
/// file.
pub(crate) fn mapped_item_local_transform(
    item: &DecodedEntity,
    source: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Option<Matrix4<f64>>> {
    let target = mapping_target(item, decoder)?;
    let origin = mapping_origin(source, decoder)?;
    Ok(compose(target, origin))
}

/// `IfcMappedItem.MappingTarget` (attr 1) as a 4x4, `None` when absent.
pub(crate) fn mapping_target(
    item: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Option<Matrix4<f64>>> {
    match item.attr(IfcMappedItem::MAPPING_TARGET) {
        Some(attr) if !attr.is_null() => match decoder.resolve_ref(attr)? {
            Some(entity) => Ok(Some(crate::router::transforms::operator::parse_transformation_operator(
                &entity, decoder,
            )?)),
            None => Ok(None),
        },
        _ => Ok(None),
    }
}

pub(crate) fn compose(
    target: Option<Matrix4<f64>>,
    origin: Option<Matrix4<f64>>,
) -> Option<Matrix4<f64>> {
    match (target, origin) {
        (Some(t), Some(o)) => Some(t * o),
        (Some(t), None) => Some(t),
        (None, Some(o)) => Some(o),
        (None, None) => None,
    }
}

/// `IfcRepresentationMap.MappingOrigin` (attr 0) as a 4x4, or `None` when it
/// is absent or null (nothing to compose), or the identity.
///
/// A PRESENT origin that cannot be turned into a placement — a dangling
/// reference, or an entity that is not an `IfcAxis2Placement` — is an ERROR,
/// not a silent identity: substituting the identity would render the item at a
/// position nothing else agrees with (#1985).
pub(crate) fn mapping_origin(
    source: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Option<Matrix4<f64>>> {
    let Some(origin_attr) = source.attr(IfcRepresentationMap::MAPPING_ORIGIN).filter(|a| !a.is_null()) else {
        return Ok(None);
    };
    let Some(origin) = decoder.resolve_ref(origin_attr)? else {
        return Err(Error::geometry("RepresentationMap MappingOrigin does not resolve".to_string()));
    };
    let m = match origin.ifc_type {
        IfcType::IfcAxis2Placement3D => crate::transform::parse_axis2_placement_3d(&origin, decoder)?,
        // A 2D mapping origin places a 2D representation in the XY plane.
        IfcType::IfcAxis2Placement2D => crate::transform::parse_axis2_placement_2d(&origin, decoder)?,
        other => {
            return Err(Error::geometry(format!(
                "RepresentationMap MappingOrigin is {other}, not an IfcAxis2Placement"
            )))
        }
    };
    Ok(if m.is_identity(tol::IDENTITY_EPS_STRICT) { None } else { Some(m) })
}
