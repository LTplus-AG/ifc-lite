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

// Module visibility: only 8 modules below are reached externally by sibling
// crates via a direct submodule path (`ifc_lite_geometry::<module>::...`) and
// must stay `pub`: csg, csg_capture, kernel, material_layer_index, mesh,
// projection_outline, rect_fast, space_dcel. Everything else is internal
// wiring; external consumers reach its types through the root-level `pub use`
// re-exports below, so those modules are `pub(crate)` (see #C3.2).
pub(crate) mod alignment;
pub(crate) mod bool2d;
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
pub(crate) mod facet_weld;
/// Intra-mesh vertex weld + index dedup applied at the per-element mesh source
/// (`build_mesh_data`), collapsing the faceted-brep per-face vertex duplication
/// while keeping creases (distinct normals) split.
pub mod mesh_weld;
/// Structured-diagnostics macro shims for the `observability` feature
/// (tracing when ON, the legacy eprintln fallback when OFF).
pub(crate) mod diag;
pub(crate) mod diagnostics;
pub(crate) mod error;
pub(crate) mod geom_hash;
/// Shared float-noise-tolerance quantisation constants used by more than one
/// geometry pass (single-sourced so independently-evolving passes can't drift
/// apart on the same tolerance).
pub(crate) mod grid;
pub(crate) mod extrusion;
pub(crate) mod instancing;
/// Pure-Rust exact mesh-arrangement CSG kernel — the only CSG kernel, on
/// every target (see docs/architecture/geometry-pipeline.md).
pub mod kernel;
pub mod material_layer_index;
pub mod mesh;
pub(crate) mod mesh_orient;
pub(crate) mod processors;
pub(crate) mod profile;
pub(crate) mod profile_extractor;
pub(crate) mod profiles;
pub mod projection_outline;
pub mod rect_fast;
pub use rect_fast::RectFastStats;
pub(crate) mod router;
/// Per-element mesh simplification for the demesher (cavity removal, grid
/// vertex-clustering decimation, bounding-box collapse).
pub mod simplify;
pub(crate) mod tessellation;
pub mod space_dcel;
pub(crate) mod transform;
pub(crate) mod triangulation;
pub(crate) mod void_index;

// Re-export nalgebra types for convenience
pub use nalgebra::{Point2, Point3, Vector2, Vector3};

pub use bool2d::{
    compute_signed_area, ensure_ccw, ensure_cw, is_valid_contour, point_in_contour, subtract_2d,
    subtract_multiple_2d, subtract_multiple_2d_counted,
};
pub use csg::{calculate_normals, ClippingProcessor, Plane, Triangle};
pub use diagnostics::{BoolFailure, BoolFailureReason, BoolOp};
pub use error::{Error, Result};
pub use geom_hash::{hash_mesh_world, GeometryHasher, DEFAULT_GEOM_HASH_TOLERANCE};
pub use extrusion::{extrude_profile, extrude_profile_lofted, extrude_profile_with_voids};
pub use instancing::{
    bake_source_at_world, collate_and_encode, collate_instances, collate_refs,
    compose_instance_world_row_major, decode_instanced, encode_instanced, encode_refs,
    instance_rel_row_major_f32, verify_recomposition, Collated, DecodedInstance, DecodedInstanced,
    DecodedTemplate, InstanceMeshRef, InstanceOccurrence, InstanceTemplate, INSTANCED_MAGIC,
    INSTANCED_VERSION,
};
pub use material_layer_index::{
    LayerAxis, LayerBuildup, LayerInfo, MaterialLayerFlat, MaterialLayerIndex,
};
pub use mesh::{InstanceMeta, Mesh, SubMesh, SubMeshCollection};
pub use mesh_orient::orient_mesh_outward;
pub use processors::{
    AdvancedBrepProcessor, BooleanClippingProcessor, ExtrudedAreaSolidProcessor,
    ExtrudedAreaSolidTaperedProcessor, FaceBasedSurfaceModelProcessor, FacetedBrepProcessor,
    build_texture_index, ImageTextureRef, MeshTexture, PolygonalFaceSetProcessor,
    ResolvedTextureMap, RevolvedAreaSolidProcessor, TextureAttachment, TextureSource, SurfaceOfLinearExtrusionProcessor,
    SweptDiskSolidProcessor, TriangulatedFaceSetProcessor,
};
pub use alignment::{AlignmentCurve, AlignmentFrame};
pub use profile::{Profile2D, Profile2DWithVoids, ProfileType, VoidInfo};
pub use profile_extractor::{extract_profiles, ExtractedProfile};
pub use profiles::ProfileProcessor;
pub use router::take_bool2d_stats;
pub use router::{take_prism_defers, take_prism_stats};
pub use router::{
    aggregate_diagnostics, local_frame_set_enabled_override, ClassificationStats,
    GEOMETRY_DIAGNOSTICS_SCHEMA_VERSION,
    ClassificationSummary, GeometryDiagnostics, GeometryProcessor, GeometryRouter,
    HostOpeningDiagnostic, ItemDedupCache, MappedInstancePlan, OpeningDiagnostic, OpeningKindDiag,
    ReasonCount, RectFastSummary, RectParam, SharedMappedItemCache, WorstHost,
};

/// The streaming / needs-shift large-coordinate threshold (metres): a world
/// coordinate whose magnitude exceeds this needs RTC re-basing before it is
/// cast to f32, or the model renders with vertex jitter. Shared by the router's
/// own coordinate sampling (`router::rtc_offset`) and the streaming pre-pass
/// meta resolver (`ifc_lite_processing::stream_meta`) so those two make the same
/// decision. (Other 10 km checks carry their own local constant of the same
/// value.)
pub const LARGE_COORD_THRESHOLD_METERS: f64 = 10000.0;
pub use simplify::{simplify_mesh, SimplifyOptions, SimplifyStats};
pub use tessellation::{scale_segments, TessellationQuality};
pub use transform::{
    parse_axis2_placement_3d, parse_axis2_placement_3d_from_id, parse_cartesian_point,
    parse_cartesian_point_from_id, parse_direction, parse_direction_from_id,
    rotation_angle_about_z,
};
pub use triangulation::triangulate_polygon;
pub use void_index::{
    build_aggregate_children_index, compute_parts_to_skip, propagate_voids_to_parts,
    propagate_voids_via_aggregates, VoidIndex,
};
