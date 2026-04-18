// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! # IFC-Lite Geometry Processing
//!
//! Efficient geometry processing for IFC models using [earcutr](https://docs.rs/earcutr)
//! triangulation and [nalgebra](https://docs.rs/nalgebra) for transformations.
//!
//! ## Overview
//!
//! This crate transforms IFC geometry representations into GPU-ready triangle meshes:
//!
//! - **Profile Handling**: Extract and process 2D profiles (rectangle, circle, arbitrary)
//! - **Extrusion**: Generate 3D meshes from extruded profiles
//! - **Triangulation**: Polygon triangulation with hole support via earcutr
//! - **CSG Operations**: Full boolean operations (difference, union, intersection)
//! - **Mesh Processing**: Normal calculation and coordinate transformations
//!
//! ## Supported Geometry Types
//!
//! | Type | Status | Description |
//! |------|--------|-------------|
//! | `IfcExtrudedAreaSolid` | Full | Most common - extruded profiles |
//! | `IfcFacetedBrep` | Full | Boundary representation meshes |
//! | `IfcTriangulatedFaceSet` | Full | Pre-triangulated (IFC4) |
//! | `IfcBooleanClippingResult` | Full | CSG operations (difference, union, intersection) |
//! | `IfcMappedItem` | Full | Instanced geometry |
//! | `IfcSweptDiskSolid` | Full | Pipe/tube geometry |
//!
//! ## Quick Start
//!
//! ```rust,ignore
//! use ifc_lite_geometry::{
//!     Profile2D, extrude_profile, triangulate_polygon,
//!     Point2, Point3, Vector3
//! };
//!
//! // Create a rectangular profile
//! let profile = Profile2D::rectangle(2.0, 1.0);
//!
//! // Extrude to 3D
//! let direction = Vector3::new(0.0, 0.0, 1.0);
//! let mesh = extrude_profile(&profile, direction, 3.0)?;
//!
//! println!("Generated {} triangles", mesh.triangle_count());
//! ```
//!
//! ## Geometry Router
//!
//! Use the [`GeometryRouter`] to automatically dispatch entities to appropriate processors:
//!
//! ```rust,ignore
//! use ifc_lite_geometry::{GeometryRouter, GeometryProcessor};
//!
//! let router = GeometryRouter::new();
//!
//! // Process entity
//! if let Some(mesh) = router.process(&decoder, &entity)? {
//!     renderer.add_mesh(mesh);
//! }
//! ```
//!
//! ## Performance
//!
//! - **Simple extrusions**: ~2000 entities/sec
//! - **Complex Breps**: ~200 entities/sec
//! - **Boolean operations**: ~20 entities/sec

pub mod bool2d;
mod bsp_csg;
pub mod csg;
pub mod error;
pub mod extrusion;
pub mod mesh;
pub mod processors;
pub mod profile;
pub mod profile_extractor;
pub mod profiles;
pub mod router;
pub mod transform;
pub mod triangulation;
pub mod void_analysis;
pub mod void_index;

// Re-export nalgebra types for convenience
pub use nalgebra::{Point2, Point3, Vector2, Vector3};

pub use bool2d::{
    compute_signed_area, ensure_ccw, ensure_cw, is_valid_contour, point_in_contour, subtract_2d,
    subtract_multiple_2d, union_contours,
};
pub use csg::{calculate_normals, ClippingProcessor, Plane, Triangle};
pub use error::{Error, Result};
pub use extrusion::{extrude_profile, extrude_profile_with_voids};
pub use mesh::{CoordinateShift, Mesh, SubMesh, SubMeshCollection};
pub use processors::{
    AdvancedBrepProcessor, BooleanClippingProcessor, ExtrudedAreaSolidProcessor,
    FaceBasedSurfaceModelProcessor, FacetedBrepProcessor, MappedItemProcessor,
    PolygonalFaceSetProcessor, RevolvedAreaSolidProcessor, SurfaceOfLinearExtrusionProcessor,
    SweptDiskSolidProcessor, TriangulatedFaceSetProcessor,
};
pub use profile::{Profile2D, Profile2DWithVoids, ProfileType, VoidInfo};
pub use profile_extractor::{extract_profiles, ExtractedProfile};
pub use profiles::ProfileProcessor;
pub use router::{GeometryProcessor, GeometryRouter};
pub use transform::{
    apply_rtc_offset, parse_axis2_placement_3d, parse_axis2_placement_3d_from_id,
    parse_cartesian_point, parse_cartesian_point_from_id, parse_direction, parse_direction_from_id,
};
pub use triangulation::triangulate_polygon;
pub use void_analysis::{
    classify_voids_batch, extract_coplanar_voids, extract_nonplanar_voids, VoidAnalyzer,
    VoidClassification,
};
pub use void_index::{propagate_voids_to_parts, VoidIndex, VoidStatistics};
