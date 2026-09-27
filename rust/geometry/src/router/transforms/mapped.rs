// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `IfcMappedItem` placement: the map's `MappingOrigin` composed under the
//! item's `MappingTarget`.

use super::super::GeometryRouter;
use crate::{Error, Result};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;

impl GeometryRouter {
    /// Resolve an `IfcMappedItem` placement in metre coordinates. The returned
    /// column-major matrix retains the authored linear part; only translation
    /// receives the IFC length-unit scale.
    pub fn resolve_scaled_mapped_item_transform(
        &self,
        item: &DecodedEntity,
        source: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<[f64; 16]>> {
        self.resolve_scaled_mapped_item_transform_with_origin_loader(item, decoder,
            |decoder| self.mapping_origin_transform(source, decoder))
    }

    /// Resolve a mapped target with a caller-supplied source-origin loader.
    /// The loader runs after target parsing, preserving the standard error
    /// precedence, and may reuse a parsed origin for repeated source maps.
    pub fn resolve_scaled_mapped_item_transform_with_origin_loader<F>(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
        origin: F,
    ) -> Result<Option<[f64; 16]>>
    where F: FnOnce(&mut EntityDecoder) -> Result<Option<Matrix4<f64>>> {
        let target = self.mapping_target_transform(item, decoder)?;
        let origin = origin(decoder)?;
        let Some(mut matrix) = Self::compose_mapped_transform(target, origin) else {
            return Ok(None);
        };
        self.scale_transform(&mut matrix);
        Ok(Some(std::array::from_fn(|i| matrix.as_slice()[i])))
    }

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
        let target = self.mapping_target_transform(item, decoder)?;
        let origin = self.mapping_origin_transform(source, decoder)?;
        Ok(Self::compose_mapped_transform(target, origin))
    }

    fn mapping_target_transform(
        &self, item: &DecodedEntity, decoder: &mut EntityDecoder,
    ) -> Result<Option<Matrix4<f64>>> {
        match item.get(1) {
            Some(attr) if !attr.is_null() => match decoder.resolve_ref(attr)? {
                Some(entity) => Ok(Some(self.parse_cartesian_transformation_operator(&entity, decoder)?)),
                None => Ok(None),
            },
            _ => Ok(None),
        }
    }

    fn compose_mapped_transform(
        target: Option<Matrix4<f64>>, origin: Option<Matrix4<f64>>,
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
    /// not a silent identity. Every other consumer of a broken mapped-item
    /// transform now behaves that way: the `MappingTarget` operator parse has
    /// always propagated (a non-`IfcDirection` axis errors), the void fast-path
    /// probes defer the opening to the exact kernel, and the 2D drawing extractor
    /// abandons the profile. Substituting the identity here would render the item
    /// at a position nothing else agrees with. #1985
    pub fn mapping_origin_transform(
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
        crate::transform::parse_axis2_placement_2d(placement, decoder)
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn issue_5786_cached_origin_uses_standard_mapped_composition() {
        let content = b"#1=IFCCARTESIANPOINT((10.,20.,0.));\n\
            #2=IFCAXIS2PLACEMENT3D(#1,$,$);\n\
            #3=IFCREPRESENTATIONMAP(#2,#9);\n\
            #4=IFCCARTESIANPOINT((100.,0.,0.));\n\
            #5=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,2.,$);\n\
            #6=IFCMAPPEDITEM(#3,#5);";
        let router = GeometryRouter::with_scale(0.001);
        let mut decoder = EntityDecoder::new(content);
        let item = decoder.decode_by_id(6).unwrap();
        let source = decoder.decode_by_id(3).unwrap();
        let standard = router.resolve_scaled_mapped_item_transform(&item, &source, &mut decoder).unwrap();
        let origin = router.mapping_origin_transform(&source, &mut decoder).unwrap();
        let cached = router.resolve_scaled_mapped_item_transform_with_origin_loader(
            &item, &mut decoder, |_| Ok(origin)).unwrap();
        assert_eq!(cached, standard);
        let matrix = cached.unwrap();
        assert!((matrix[12] - 0.12).abs() < 1e-12);
        assert!((matrix[13] - 0.04).abs() < 1e-12);
    }
}
