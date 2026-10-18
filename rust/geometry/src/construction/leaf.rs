// SPDX-License-Identifier: MPL-2.0
use super::{Construction, ConstructionFamily, ConstructionRequirement};
use crate::GeometryRouter;
use crate::processors::{BlockProcessor, ExtrudedAreaSolidProcessor, SphereProcessor,
    ExtrudedAreaSolidTaperedProcessor, RevolvedAreaSolidProcessor, SweptDiskSolidProcessor,
    SurfaceCurveSweptAreaSolidProcessor, faceted_plan, polygonal_plan, triangulated_plan,
    SectionedSolidHorizontalProcessor, IfcAlignmentProcessor, IfcEdgeProcessor,
    SurfaceOfLinearExtrusionProcessor, FaceBasedSurfaceModelProcessor,
    ShellBasedSurfaceModelProcessor, advanced_plan, structural_face_plan};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema};

pub(super) fn lower_leaf(router: &GeometryRouter, schema: &IfcSchema,
    decoder: &mut EntityDecoder, entity: &DecodedEntity,
    family: Option<ConstructionFamily>) -> std::result::Result<Construction, ConstructionRequirement> {
    let quality = router.tessellation_quality();
    let result = match family {
            Some(ConstructionFamily::Extrusion) => ExtrudedAreaSolidProcessor::new(schema.clone())
                .lower(entity, decoder, quality).map(Construction::Extrusion),
            Some(ConstructionFamily::TaperedExtrusion) => ExtrudedAreaSolidTaperedProcessor::new(schema.clone())
                .lower(entity, decoder, quality).map(Construction::TaperedExtrusion),
            Some(ConstructionFamily::RevolvedAreaSolid) => RevolvedAreaSolidProcessor::new(schema.clone())
                .lower(entity, decoder, quality).map(Construction::Revolved),
            Some(ConstructionFamily::SweptDisk) => SweptDiskSolidProcessor::new(schema.clone())
                .lower(entity, decoder, quality).map(|plan| plan.map_or(Construction::Empty, Construction::SweptDisk)),
            Some(ConstructionFamily::SweptArea) => SurfaceCurveSweptAreaSolidProcessor::new(schema.clone())
                .lower(entity, decoder, quality).map(|plan| plan.map_or(Construction::Empty, Construction::SweptArea)),
            Some(ConstructionFamily::Block) => BlockProcessor::new()
                .lower(entity, decoder).map(Construction::Block),
            Some(ConstructionFamily::Sphere) => SphereProcessor::new()
                .lower(entity, decoder, quality).map(Construction::Sphere),
            Some(ConstructionFamily::TriangulatedFaceSet) => triangulated_plan::lower(entity, decoder, None)
                .map(Construction::Triangles),
            Some(ConstructionFamily::PolygonalFaceSet) => polygonal_plan::lower(entity, decoder, None)
                .map(Construction::Polygons),
            Some(ConstructionFamily::FacetedBrep) => faceted_plan::lower(entity, decoder, None)
                .map(Construction::FacetedBrep),
            Some(ConstructionFamily::SectionedSolid) => SectionedSolidHorizontalProcessor::new(schema.clone())
                .lower(entity, decoder, quality).map(Construction::SectionedSolid),
            Some(ConstructionFamily::AdvancedBrep) => advanced_plan::lower_brep(entity, decoder, quality, None)
                .map(Construction::AdvancedBrep),
            Some(ConstructionFamily::BSplineSurface) => advanced_plan::lower_bspline_surface(entity, decoder, quality, None)
                .map(Construction::BSplineSurface),
            Some(ConstructionFamily::ShellSurfaceModel) => ShellBasedSurfaceModelProcessor::new()
                .lower(entity, decoder, quality, None).map(Construction::SurfaceModel),
            Some(ConstructionFamily::FaceSurfaceModel) => FaceBasedSurfaceModelProcessor::new()
                .lower(entity, decoder, quality, None).map(Construction::SurfaceModel),
            Some(ConstructionFamily::Alignment) => IfcAlignmentProcessor::new()
                .lower(entity, decoder).map(Construction::Alignment),
            Some(ConstructionFamily::Edge) => IfcEdgeProcessor::new()
                .lower(entity, decoder, quality).map(Construction::Edge),
            Some(ConstructionFamily::FaceSurface) => structural_face_plan::lower(entity, decoder, quality, None)
                .map(Construction::FaceSurface),
            Some(ConstructionFamily::LinearExtrusionSurface) => SurfaceOfLinearExtrusionProcessor::new()
                .lower(entity, decoder, None).map(Construction::LinearExtrusionSurface),
            _ => return Err(ConstructionRequirement::ConstructorNotLowered),
        };
    // Production surface models replay source reports in face order during
    // evaluation. Eager graph admission also retains a source-only snapshot,
    // including when a different root prevents execution of the whole batch.
    if let Ok(Construction::SurfaceModel(plan)) = &result {
        crate::processors::diagnostic_capture::restore(&plan.source_reports());
    }
    result.map_err(|error| ConstructionRequirement::SourceAdmission(error.to_string()))
}
