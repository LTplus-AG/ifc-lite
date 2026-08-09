// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcMappedItem` placement: the map's `MappingOrigin` composed under the
//! item's `MappingTarget`.

use super::super::GeometryRouter;
use crate::{Error, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;

impl GeometryRouter {
    /// The full `IfcMappedItem` transform: `MappingTarget · MappingOrigin`.
    ///
    /// `item` is the `IfcMappedItem` (attr 1 = MappingTarget), `source` its
    /// `IfcRepresentationMap` (attr 0 = MappingOrigin, an `IfcAxis2Placement`).
    /// The mapped representation's items are authored in the mapping source's
    /// coordinate system, whose placement within the map IS `MappingOrigin`, so
    /// it applies INNERMOST — the same composition IfcOpenShell performs
    /// (`gtrsf(MappingTarget).Multiply(trsf(MappingOrigin))`).
    ///
    /// Before #1985 `MappingOrigin` was dropped everywhere, so any map whose
    /// origin was not the identity placed its geometry at the wrong spot
    /// (scaled by the target, so a Scale=1000 target multiplied the error
    /// 1000-fold). Returns `None` when neither attribute contributes, keeping
    /// the "no transform to apply" fast path for the overwhelmingly common
    /// identity-origin file.
    pub(crate) fn mapped_item_transform(
        &self,
        item: &DecodedEntity,
        source: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<Matrix4<f64>>> {
        let target = match item.get(1) {
            Some(attr) if !attr.is_null() => match decoder.resolve_ref(attr)? {
                Some(entity) => Some(self.parse_cartesian_transformation_operator(&entity, decoder)?),
                None => None,
            },
            _ => None,
        };
        let origin = self.mapping_origin_transform(source, decoder)?;
        Ok(match (target, origin) {
            (Some(t), Some(o)) => Some(t * o),
            (Some(t), None) => Some(t),
            (None, Some(o)) => Some(o),
            (None, None) => None,
        })
    }

    /// `IfcRepresentationMap.MappingOrigin` (attr 0) as a 4x4, or `None` when it
    /// is absent or null (nothing to compose), or the identity.
    ///
    /// A PRESENT origin that cannot be turned into a placement — a dangling
    /// reference, or an entity that is not an `IfcAxis2Placement` — is an ERROR,
    /// not a silent identity. Every other consumer of a broken mapped-item
    /// transform now behaves that way: the `MappingTarget` operator parse has
    /// always propagated (a non-`IfcDirection` axis errors), the void fast-path
    /// probes defer the opening to the exact kernel, and the 2D drawing extractor
    /// abandons the profile. Substituting the identity here would render the item
    /// at a position nothing else agrees with. #1985
    pub(crate) fn mapping_origin_transform(
        &self,
        source: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<Matrix4<f64>>> {
        let Some(origin_attr) = source.get(0).filter(|a| !a.is_null()) else {
            return Ok(None);
        };
        let Some(origin) = decoder.resolve_ref(origin_attr)? else {
            return Err(Error::geometry(
                "RepresentationMap MappingOrigin does not resolve".to_string(),
            ));
        };
        let m = match origin.ifc_type {
            IfcType::IfcAxis2Placement3D => self.parse_axis2_placement_3d(&origin, decoder)?,
            // A 2D mapping origin places a 2D representation in the XY plane.
            IfcType::IfcAxis2Placement2D => self.parse_axis2_placement_2d(&origin, decoder)?,
            other => {
                return Err(Error::geometry(format!(
                    "RepresentationMap MappingOrigin is {other}, not an IfcAxis2Placement"
                )))
            }
        };
        Ok(if m.is_identity(1e-12) { None } else { Some(m) })
    }

    /// Parse IfcAxis2Placement2D (Location, RefDirection) into a 4x4 acting in
    /// the XY plane (Z untouched).
    #[inline]
    pub(crate) fn parse_axis2_placement_2d(
        &self,
        placement: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Matrix4<f64>> {
        axis2_placement_2d_matrix(placement, decoder)
    }
}

/// The router-free form of [`GeometryRouter::parse_axis2_placement_2d`], so the
/// 2D drawing extractor shares this definition instead of copying it. #1985
pub(crate) fn axis2_placement_2d_matrix(
    placement: &DecodedEntity,
    decoder: &mut EntityDecoder,
) -> Result<Matrix4<f64>> {
    let location = super::cartesian_point_at(placement, decoder, 0)?;
    // A present RefDirection that is not an IfcDirection is a structural error and
    // propagates, matching the 3D sibling and this module's contract that a broken
    // MappingOrigin fails the item rather than being silently substituted. A
    // dangling reference or a zero-length direction still falls back to +X: those
    // are the degenerate-but-recoverable cases every placement parser here absorbs
    // (see `build_axis2_matrix`), and erroring on them would drop geometry that
    // renders fine today.
    let ref_dir = match placement.get(1) {
        Some(attr) if !attr.is_null() => match decoder.resolve_ref(attr)? {
            Some(e) => super::operator::parse_direction_ratios(&e)?
                .try_normalize(1e-9)
                .unwrap_or_else(|| Vector3::new(1.0, 0.0, 0.0)),
            None => Vector3::new(1.0, 0.0, 0.0),
        },
        _ => Vector3::new(1.0, 0.0, 0.0),
    };
    let mut m = Matrix4::identity();
    m[(0, 0)] = ref_dir.x;
    m[(1, 0)] = ref_dir.y;
    m[(0, 1)] = -ref_dir.y;
    m[(1, 1)] = ref_dir.x;
    m[(0, 3)] = location.x;
    m[(1, 3)] = location.y;
    m[(2, 3)] = location.z;
    Ok(m)
}
