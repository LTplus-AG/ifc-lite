// SPDX-License-Identifier: MPL-2.0
//! Common owned payloads used by reached production and optional construction graphs.
use crate::processors::{csg_primitive::plan::{BlockPlan, SpherePlan},
    extrusion::plan::ExtrusionPlan, extrusion_tapered::plan::TaperedExtrusionPlan,
    swept::revolved::plan::RevolvedPlan, SweptDiskPlan, SurfaceCurveSweepPlan,
    polygonal_plan::PolygonalFaceSetPlan, triangulated_plan::TriangulatedFaceSetPlan};
use crate::processors::{faceted_plan::FacetedBrepPlan,
    advanced_plan::{AdvancedBrepPlan, BSplineSurfacePlan},
    structural_face_plan::StructuralFacePlan, structural_edge::EdgePlan,
    SurfaceModelPlan, sectioned::plan::SectionedPlan,
    alignment::plan::AlignmentPlan, surface::plan::LinearExtrusionSurfacePlan};

#[derive(Debug, Clone)]
pub(crate) enum Constructor {
    Empty,
    Extrusion(ExtrusionPlan),
    TaperedExtrusion(TaperedExtrusionPlan),
    Revolved(RevolvedPlan),
    SweptDisk(SweptDiskPlan),
    SweptArea(SurfaceCurveSweepPlan),
    Block(BlockPlan),
    Sphere(SpherePlan),
    Triangles(TriangulatedFaceSetPlan),
    Polygons(PolygonalFaceSetPlan),
    FacetedBrep(FacetedBrepPlan),
    SectionedSolid(SectionedPlan),
    AdvancedBrep(AdvancedBrepPlan),
    BSplineSurface(BSplineSurfacePlan),
    SurfaceModel(SurfaceModelPlan),
    Alignment(AlignmentPlan),
    Edge(EdgePlan),
    FaceSurface(StructuralFacePlan),
    LinearExtrusionSurface(LinearExtrusionSurfacePlan),
}
