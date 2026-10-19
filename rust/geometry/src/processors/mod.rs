// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Geometry Processors - P0 implementations
//!
//! High-priority processors for common IFC geometry types.
//! Each sub-module handles a category of geometry processors:
//!
//! - `extrusion`: ExtrudedAreaSolid (most common - extruded profiles)
//! - `tessellated`: TriangulatedFaceSet, PolygonalFaceSet (pre-tessellated meshes)
//! - `brep`: FacetedBrep, FaceBasedSurfaceModel, ShellBasedSurfaceModel (boundary representations)
//! - `surface`: SurfaceOfLinearExtrusion (swept surfaces)
//! - `boolean`: BooleanClippingResult (CSG operations)
//! - `swept`: SweptDiskSolid, RevolvedAreaSolid (swept geometry)
//! - `advanced`: AdvancedBrep (NURBS/B-spline)
//! - `advanced_face`: Shared IfcAdvancedFace processing (B-spline, planar, cylindrical)
//! - `helpers`: Shared parse functions used by multiple processors

mod advanced;
mod advanced_face;
mod advanced_plan;
mod alignment;
mod boolean;
mod brep;
mod csg_primitive;
mod sphere;
pub(crate) mod extrusion;
pub(crate) mod extrusion_params;
mod extrusion_tapered;
mod helpers;
mod sectioned;
mod structural_edge;
mod structural_face;
mod structural_face_plan;
mod surface;
mod swept;
mod tessellated;
pub mod texture;

#[cfg(test)]
mod tests;

// Re-export all processor types
pub use advanced::{AdvancedBrepProcessor, BSplineSurfaceProcessor};
// Drained by the router once per representation item to report a capped
// B-spline curve edge (#4901); see `advanced_face::bspline_budget`.
pub(crate) use advanced_face::{restore_reports, take_curve_capped, take_face_refused};
pub use alignment::IfcAlignmentProcessor;
pub use boolean::BooleanClippingProcessor;
pub use brep::{
    FaceBasedSurfaceModelProcessor, FacetedBrepProcessor, ShellBasedSurfaceModelProcessor,
};
pub use csg_primitive::{BlockProcessor, CsgSolidProcessor};
pub use sphere::SphereProcessor;
pub use extrusion::ExtrudedAreaSolidProcessor;
pub use extrusion_tapered::ExtrudedAreaSolidTaperedProcessor;
pub use sectioned::SectionedSolidHorizontalProcessor;
pub use structural_edge::IfcEdgeProcessor;
pub use structural_face::IfcFaceSurfaceProcessor;
pub use surface::SurfaceOfLinearExtrusionProcessor;
pub use swept::{
    RevolvedAreaSolidProcessor, SurfaceCurveSweptAreaSolidProcessor, SweptDiskSolidProcessor,
};
pub use tessellated::{PolygonalFaceSetProcessor, TriangulatedFaceSetProcessor};
pub use texture::{
    binary_textures_refused, build_texture_index, embedded_raster_dimensions, MAX_TEXTURE_DIMENSION, ImageTextureRef, MeshTexture, ResolvedTextureMap, TextureAttachment,
    TextureSource,
};
