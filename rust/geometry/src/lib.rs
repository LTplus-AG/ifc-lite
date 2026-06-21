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
//! | `IfcExtrudedAreaSolidTapered` | Full | Lofted extrusion between two profiles |
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

pub mod alignment;
pub mod bool2d;
/// Deterministic Constrained Delaunay Triangulation + bounded Ruppert
/// min-angle refinement. Backs the quality triangulators in `triangulation`.
mod cdt;
pub mod csg;
/// Measurement-only CSG corpus capture (off-by-default `csg_capture` feature).
#[cfg(feature = "csg_capture")]
pub mod csg_capture;
/// Deterministic near-coplanar facet weld for faceted-BREP host meshes.
/// Corrects f32 import jitter (~0.09°) so authored-coplanar roof slope facets
/// are EXACTLY coplanar before the exact-kernel opening cut (issue #1007).
pub mod facet_weld;
pub mod diagnostics;
pub mod error;
pub mod congruence;
pub mod geom_hash;
pub mod extrusion;
pub mod instancing;
/// Pure-Rust exact mesh-arrangement CSG kernel — the only CSG kernel, on
/// every target (see docs/architecture/geometry-pipeline.md).
pub mod kernel;
pub mod material_layer_index;
pub mod mesh;
pub mod processors;
pub mod profile;
pub mod profile_extractor;
pub mod profiles;
pub mod projection_outline;
pub mod rect_fast;
pub mod router;
pub mod tessellation;
pub mod space_dcel;
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
pub use diagnostics::{BoolFailure, BoolFailureReason, BoolOp};
pub use error::{Error, Result};
pub use geom_hash::{hash_mesh_world, GeometryHasher, DEFAULT_GEOM_HASH_TOLERANCE};
pub use extrusion::{extrude_profile, extrude_profile_lofted, extrude_profile_with_voids};
pub use instancing::{
    collate_and_encode, collate_instances, collate_refs, decode_instanced, encode_instanced,
    encode_refs, verify_recomposition, Collated, DecodedInstance, DecodedInstanced,
    DecodedTemplate, InstanceMeshRef, InstanceOccurrence, InstanceTemplate, INSTANCED_MAGIC,
    INSTANCED_VERSION,
};
pub use material_layer_index::{LayerAxis, LayerBuildup, LayerInfo, MaterialLayerIndex};
pub use mesh::{CoordinateShift, InstanceMeta, Mesh, SubMesh, SubMeshCollection};
pub use processors::{
    AdvancedBrepProcessor, BooleanClippingProcessor, ExtrudedAreaSolidProcessor,
    ExtrudedAreaSolidTaperedProcessor, FaceBasedSurfaceModelProcessor, FacetedBrepProcessor,
    build_texture_index, MappedItemProcessor, MeshTexture, PolygonalFaceSetProcessor,
    ResolvedTextureMap, RevolvedAreaSolidProcessor, SurfaceOfLinearExtrusionProcessor,
    SweptDiskSolidProcessor, TriangulatedFaceSetProcessor,
};
pub use alignment::{AlignmentCurve, AlignmentFrame};
pub use profile::{Profile2D, Profile2DWithVoids, ProfileType, VoidInfo};
pub use profile_extractor::{extract_profiles, ExtractedProfile};
pub use profiles::ProfileProcessor;
pub use router::{
    ClassificationStats, GeometryProcessor, GeometryRouter, HostOpeningDiagnostic, ItemDedupCache,
    OpeningDiagnostic, OpeningKindDiag, RectParam,
};
pub use tessellation::{scale_segments, TessellationQuality};
pub use transform::{
    apply_rtc_offset, parse_axis2_placement_3d, parse_axis2_placement_3d_from_id,
    parse_cartesian_point, parse_cartesian_point_from_id, parse_direction, parse_direction_from_id,
    rotation_angle_about_z,
};
pub use triangulation::triangulate_polygon;
pub use void_analysis::{
    classify_voids_batch, extract_coplanar_voids, extract_nonplanar_voids, VoidAnalyzer,
    VoidClassification,
};
pub use void_index::{
    build_aggregate_children_index, compute_parts_to_skip, propagate_voids_to_parts,
    propagate_voids_via_aggregates, VoidIndex, VoidStatistics,
};
