// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Standalone planar `IfcFaceSurface` processing for structural surface topology.

use crate::router::GeometryProcessor;
use crate::{Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

pub struct IfcFaceSurfaceProcessor;

impl IfcFaceSurfaceProcessor {
    pub fn new() -> Self {
        Self
    }

    fn process_planar(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        quality: TessellationQuality,
        rtc_file_units: Option<(f64, f64, f64)>,
    ) -> Result<Mesh> {
        super::structural_face_plan::lower(entity, decoder, quality, rtc_file_units)?.evaluate()
    }
}

impl Default for IfcFaceSurfaceProcessor {
    fn default() -> Self {
        Self::new()
    }
}

impl GeometryProcessor for IfcFaceSurfaceProcessor {
    fn lower_owned(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        quality: crate::TessellationQuality, rtc_file_units: Option<(f64, f64, f64)>)
        -> Option<crate::Result<crate::program::OwnedConstructor>> {
        use crate::program::constructor::Constructor;
        Some(super::structural_face_plan::lower(entity, decoder, quality, rtc_file_units).map(|plan| crate::program::OwnedConstructor::new(Constructor::FaceSurface(plan))))
    }

    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
    ) -> Result<Mesh> {
        // Non-planar direct faces remain intentionally empty until their
        // arbitrary bounds can clip the analytic surface safely.
        self.process_planar(entity, decoder, quality, None)
    }

    fn process_in_rtc_frame(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        quality: TessellationQuality,
        rtc_file_units: (f64, f64, f64),
    ) -> Option<Result<Mesh>> {
        Some(self.process_planar(entity, decoder, quality, Some(rtc_file_units)))
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcFaceSurface, IfcType::IfcAdvancedFace]
    }
}

/// The faces of a structural member's topology (#9668): the built-in face
/// processor's rule plus what analysis exporters write
/// (`structural_face_plan::lower_member_face`). Not registered: the product
/// walk selects it for a structural member's face item when that type's
/// processor is the built-in one, so every other product keeps the
/// registered processor.
pub(crate) struct StructuralMemberFaceProcessor;

/// The item types [`StructuralMemberFaceProcessor`] meshes.
const MEMBER_FACE_TYPES: [IfcType; 3] = [IfcType::IfcFace, IfcType::IfcFaceSurface, IfcType::IfcAdvancedFace];

/// Whether `item` is a face of structural member `element`: the one case the
/// product walk hands to [`StructuralMemberFaceProcessor`]. The item type is
/// compared first, so every other item pays one compare.
pub(crate) fn is_member_face_item(item: &DecodedEntity, element: &DecodedEntity) -> bool {
    is_member_face_type(&item.ifc_type) && element.ifc_type.is_subtype_of(IfcType::IfcStructuralMember)
}

/// Whether `ifc_type` is one [`StructuralMemberFaceProcessor`] meshes.
pub(crate) fn is_member_face_type(ifc_type: &IfcType) -> bool {
    MEMBER_FACE_TYPES.contains(ifc_type)
}

impl GeometryProcessor for StructuralMemberFaceProcessor {
    fn lower_owned(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        quality: crate::TessellationQuality, rtc_file_units: Option<(f64, f64, f64)>)
        -> Option<crate::Result<crate::program::OwnedConstructor>> {
        use crate::program::constructor::Constructor;
        Some(super::structural_face_plan::lower_member_face(entity, decoder, quality, rtc_file_units)
            .map(|plan| crate::program::OwnedConstructor::new(Constructor::FaceSurface(plan))))
    }

    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder, _schema: &IfcSchema,
        quality: TessellationQuality) -> Result<Mesh> {
        super::structural_face_plan::lower_member_face(entity, decoder, quality, None)?.evaluate()
    }

    fn process_in_rtc_frame(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder, _schema: &IfcSchema,
        quality: TessellationQuality, rtc_file_units: (f64, f64, f64)) -> Option<Result<Mesh>> {
        Some(super::structural_face_plan::lower_member_face(entity, decoder, quality, Some(rtc_file_units))
            .and_then(|plan| plan.evaluate()))
    }

    fn supported_types(&self) -> Vec<IfcType> {
        MEMBER_FACE_TYPES.to_vec()
    }
}
