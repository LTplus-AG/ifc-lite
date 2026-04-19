// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Void (opening) subtraction: 3D CSG, AABB clipping, and triangle-box intersection.

use super::GeometryRouter;
use crate::csg::{ClippingProcessor, Plane, Triangle, TriangleVec};
use crate::mesh::{SubMesh, SubMeshCollection};
use crate::{Error, Mesh, Point3, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;
use rustc_hash::{FxHashMap, FxHashSet};

/// Epsilon for normalizing direction vectors (guards against zero-length).
const NORMALIZE_EPSILON: f64 = 1e-12;
/// Minimum opening volume (m³) below which CSG is skipped to avoid BSP instability.
/// 0.0001 m³ ≈ 0.1 litre — filters artefacts while allowing small real openings (e.g. sleeves).
const MIN_OPENING_VOLUME: f64 = 0.0001;
/// Fraction of pre-CSG triangles the result must retain. CSG outputs with fewer
/// triangles than `pre_count / CSG_TRIANGLE_RETENTION_DIVISOR` are rejected as
/// BSP blowups.
const CSG_TRIANGLE_RETENTION_DIVISOR: usize = 4;
/// Minimum triangle count for a valid CSG result.
const MIN_VALID_TRIANGLES: usize = 4;
/// Maximum wrapper depth when drilling through mapped/boolean items to find an extrusion.
const MAX_EXTRUSION_EXTRACT_DEPTH: usize = 32;

/// Extract rotation columns from a 4x4 transform matrix.
fn extract_rotation_columns(m: &Matrix4<f64>) -> (Vector3<f64>, Vector3<f64>, Vector3<f64>) {
    (
        Vector3::new(m[(0, 0)], m[(1, 0)], m[(2, 0)]),
        Vector3::new(m[(0, 1)], m[(1, 1)], m[(2, 1)]),
        Vector3::new(m[(0, 2)], m[(1, 2)], m[(2, 2)]),
    )
}

/// Apply rotation from columns to a direction and normalize.
fn rotate_and_normalize(
    rot: &(Vector3<f64>, Vector3<f64>, Vector3<f64>),
    dir: &Vector3<f64>,
) -> Result<Vector3<f64>> {
    (rot.0 * dir.x + rot.1 * dir.y + rot.2 * dir.z)
        .try_normalize(NORMALIZE_EPSILON)
        .ok_or_else(|| Error::geometry("Zero-length direction vector".to_string()))
}

// ---------------------------------------------------------------------------
// Reveal face generation helpers
// ---------------------------------------------------------------------------

/// Determine the primary extrusion axis (0=X, 1=Y, 2=Z) from the opening's
/// extrusion direction, or fall back to the wall's thinnest AABB dimension.
#[inline]
fn determine_extrusion_axis(
    extrusion_dir: Option<&Vector3<f64>>,
    wall_min: &Point3<f64>,
    wall_max: &Point3<f64>,
) -> usize {
    if let Some(dir) = extrusion_dir {
        let ax = dir.x.abs();
        let ay = dir.y.abs();
        let az = dir.z.abs();
        if ax >= ay && ax >= az {
            0
        } else if ay >= az {
            1
        } else {
            2
        }
    } else {
        let dx = (wall_max.x - wall_min.x).abs();
        let dy = (wall_max.y - wall_min.y).abs();
        let dz = (wall_max.z - wall_min.z).abs();
        if dx <= dy && dx <= dz {
            0
        } else if dy <= dz {
            1
        } else {
            2
        }
    }
}

/// Read a coordinate from a `Point3` by axis index (0=X, 1=Y, 2=Z).
#[inline(always)]
fn axis_val(p: &Point3<f64>, axis: usize) -> f64 {
    match axis {
        0 => p.x,
        1 => p.y,
        _ => p.z,
    }
}

/// Build a `Point3` given values for three named axes.
#[inline(always)]
fn point_from_axes(a: usize, va: f64, b: usize, vb: f64, c: usize, vc: f64) -> Point3<f64> {
    let mut coords = [0.0_f64; 3];
    coords[a] = va;
    coords[b] = vb;
    coords[c] = vc;
    Point3::new(coords[0], coords[1], coords[2])
}

/// Build a unit `Vector3` pointing along the given axis with the given sign.
#[inline(always)]
fn vec_along_axis(axis: usize, sign: f64) -> Vector3<f64> {
    let mut coords = [0.0_f64; 3];
    coords[axis] = sign;
    Vector3::new(coords[0], coords[1], coords[2])
}

/// Add a single reveal quad (2 triangles) to the mesh, auto-correcting winding
/// order so the face normal matches the desired direction.
#[inline]
fn add_reveal_quad(
    mesh: &mut Mesh,
    p0: Point3<f64>,
    p1: Point3<f64>,
    p2: Point3<f64>,
    p3: Point3<f64>,
    desired_normal: Vector3<f64>,
) {
    let edge1 = p1 - p0;
    let edge2 = p2 - p0;
    let computed = edge1.cross(&edge2);

    let base = mesh.vertex_count() as u32;
    mesh.add_vertex(p0, desired_normal);
    mesh.add_vertex(p1, desired_normal);
    mesh.add_vertex(p2, desired_normal);
    mesh.add_vertex(p3, desired_normal);

    if computed.dot(&desired_normal) >= 0.0 {
        mesh.add_triangle(base, base + 1, base + 2);
        mesh.add_triangle(base, base + 2, base + 3);
    } else {
        mesh.add_triangle(base, base + 2, base + 1);
        mesh.add_triangle(base, base + 3, base + 2);
    }
}

/// Generate 4 reveal quads for a rectangular opening.
///
/// Reveals are the inner surfaces of the hole cut through the wall.  Each face
/// spans the wall thickness (along the extrusion direction) and sits at one
/// edge of the opening (top, bottom, left, right).
///
/// A reveal is **skipped** when the opening edge coincides with the wall
/// boundary (e.g. a door that starts at floor level has no sill reveal).
fn generate_reveal_quads(
    mesh: &mut Mesh,
    open_min: &Point3<f64>,
    open_max: &Point3<f64>,
    wall_min: &Point3<f64>,
    wall_max: &Point3<f64>,
    extrusion_dir: Option<&Vector3<f64>>,
) {
    let ea = determine_extrusion_axis(extrusion_dir, wall_min, wall_max);

    // Reveal depth along the extrusion axis, clamped to the wall-opening
    // intersection so reveals never extend beyond either surface.
    let d_min = axis_val(wall_min, ea).max(axis_val(open_min, ea));
    let d_max = axis_val(wall_max, ea).min(axis_val(open_max, ea));
    if d_max - d_min < 1e-4 {
        return; // No wall thickness to reveal
    }

    // The two cross-axes (the ones that are NOT the extrusion axis).
    let cross: [usize; 2] = match ea {
        0 => [1, 2],
        1 => [0, 2],
        _ => [0, 1],
    };

    // Require positive overlap on both cross-axes before emitting any quads.
    // Guards callers that apply voids per sub-mesh (multi-layer walls) where a
    // sub-mesh AABB may not overlap the opening at all — without this check,
    // floating reveal faces would be emitted far from the sub-mesh geometry.
    for &ax in &cross {
        let ov_min = axis_val(open_min, ax).max(axis_val(wall_min, ax));
        let ov_max = axis_val(open_max, ax).min(axis_val(wall_max, ax));
        if ov_max - ov_min < 1e-4 {
            return;
        }
    }

    for (i, &ca) in cross.iter().enumerate() {
        let oa = cross[1 - i]; // the *other* cross-axis
        // Clamp the orthogonal cross-axis extent to the wall so reveals never
        // overshoot the mesh boundary (e.g. an opening taller than its slab).
        let o_min = axis_val(open_min, oa).max(axis_val(wall_min, oa));
        let o_max = axis_val(open_max, oa).min(axis_val(wall_max, oa));

        // --- Face at open_min[ca] — normal points +ca (into opening) ---
        let face_lo = axis_val(open_min, ca);
        if face_lo > axis_val(wall_min, ca) + 1e-4 {
            add_reveal_quad(
                mesh,
                point_from_axes(ea, d_min, ca, face_lo, oa, o_min),
                point_from_axes(ea, d_max, ca, face_lo, oa, o_min),
                point_from_axes(ea, d_max, ca, face_lo, oa, o_max),
                point_from_axes(ea, d_min, ca, face_lo, oa, o_max),
                vec_along_axis(ca, 1.0),
            );
        }

        // --- Face at open_max[ca] — normal points −ca (into opening) ---
        let face_hi = axis_val(open_max, ca);
        if face_hi < axis_val(wall_max, ca) - 1e-4 {
            add_reveal_quad(
                mesh,
                point_from_axes(ea, d_min, ca, face_hi, oa, o_max),
                point_from_axes(ea, d_max, ca, face_hi, oa, o_max),
                point_from_axes(ea, d_max, ca, face_hi, oa, o_min),
                point_from_axes(ea, d_min, ca, face_hi, oa, o_min),
                vec_along_axis(ca, -1.0),
            );
        }
    }
}

/// Whether the representation type is geometry we can process.
fn is_body_representation(rep_type: &str) -> bool {
    matches!(
        rep_type,
        "Body"
            | "SweptSolid"
            | "Brep"
            | "CSG"
            | "Clipping"
            | "Tessellation"
            | "MappedRepresentation"
            | "SolidModel"
            | "SurfaceModel"
            | "AdvancedSweptSolid"
            | "AdvancedBrep"
    )
}

/// Classification of an opening for void subtraction.
#[derive(Clone)]
enum OpeningType {
    /// Rectangular opening with AABB clipping
    /// Fields: (min_bounds, max_bounds, extrusion_direction)
    Rectangular(Point3<f64>, Point3<f64>, Option<Vector3<f64>>),
    /// Diagonal rectangular opening with mesh geometry for batched rotation clipping
    /// Fields: (opening_mesh, extrusion_direction)
    DiagonalRectangular(Mesh, Vector3<f64>),
    /// Non-rectangular opening (circular, arched, or floor openings with rotated footprint)
    /// Uses full CSG subtraction with actual mesh geometry
    NonRectangular(Mesh),
}

/// Reusable buffers for triangle clipping operations
///
/// This struct eliminates per-triangle allocations in clip_triangle_against_box
/// by reusing Vec buffers across multiple clipping operations.
struct ClipBuffers {
    /// Triangles to output (outside the box)
    result: TriangleVec,
    /// Triangles remaining to be processed
    remaining: TriangleVec,
    /// Next iteration's remaining triangles (swap buffer)
    next_remaining: TriangleVec,
}

impl ClipBuffers {
    /// Create new empty buffers
    fn new() -> Self {
        Self {
            result: TriangleVec::new(),
            remaining: TriangleVec::new(),
            next_remaining: TriangleVec::new(),
        }
    }

    /// Clear all buffers for reuse
    #[inline]
    fn clear(&mut self) {
        self.result.clear();
        self.remaining.clear();
        self.next_remaining.clear();
    }
}

/// Pre-computed per-element void subtraction data.
///
/// Building this is expensive: `classify_openings` re-runs `process_element`
/// on each `IfcOpeningElement`, and clipping-plane extraction resolves the
/// element's representation. Once built, it can be reused across every
/// sub-mesh of the same element without re-doing any of that work, so the
/// per-sub-mesh void path in
/// [`GeometryRouter::process_element_with_submeshes_and_voids`] pays the
/// classification cost once per element rather than once per sub-mesh.
pub(super) struct VoidContext {
    /// All classified openings. The diagonal-opening pass needs the raw list
    /// (unmerged) so its per-item box rotation stays accurate.
    openings: Vec<OpeningType>,
    /// Rectangular openings merged into larger boxes to prevent O(2^N)
    /// triangle growth when many adjacent openings tile a surface.
    merged_openings: Vec<OpeningType>,
    /// Clipping planes (e.g. roof clips) already transformed to world space.
    world_clipping_planes: Vec<(Point3<f64>, Vector3<f64>, bool)>,
}

impl VoidContext {
    fn is_noop(&self) -> bool {
        self.openings.is_empty() && self.world_clipping_planes.is_empty()
    }
}

impl GeometryRouter {
    /// Get individual bounding boxes for each representation item in an opening element.
    /// This handles disconnected geometry (e.g., two separate window openings in one IfcOpeningElement)
    /// by returning separate bounds for each item instead of one combined bounding box.

    /// Extract extrusion direction and position transform from IfcExtrudedAreaSolid
    /// Returns (local_direction, position_transform)
    fn extract_extrusion_direction_from_solid(
        &self,
        solid: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(Vector3<f64>, Option<Matrix4<f64>>)> {
        // Get ExtrudedDirection (attribute 2: IfcDirection)
        let direction_attr = solid.get(2)?;
        let direction_entity = decoder.resolve_ref(direction_attr).ok()??;
        let local_dir = self.parse_direction(&direction_entity).ok()?;

        // Get Position transform (attribute 1: IfcAxis2Placement3D)
        let position_transform = if let Some(pos_attr) = solid.get(1) {
            if !pos_attr.is_null() {
                if let Ok(Some(pos_entity)) = decoder.resolve_ref(pos_attr) {
                    if pos_entity.ifc_type == IfcType::IfcAxis2Placement3D {
                        self.parse_axis2_placement_3d(&pos_entity, decoder).ok()
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        Some((local_dir, position_transform))
    }

    /// Recursively extract extrusion direction and position transform from representation item
    /// Handles IfcExtrudedAreaSolid, IfcBooleanClippingResult, and IfcMappedItem
    /// Returns (local_direction, position_transform) where direction is in local space
    fn extract_extrusion_direction_recursive(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(Vector3<f64>, Option<Matrix4<f64>>)> {
        let mut current = item.clone();
        let mut visited = FxHashSet::default();
        let mut mapping_chain: Option<Matrix4<f64>> = None;

        for _depth in 0..MAX_EXTRUSION_EXTRACT_DEPTH {
            if !visited.insert(current.id) {
                return None;
            }

            match current.ifc_type {
                IfcType::IfcExtrudedAreaSolid => {
                    let (dir, position_transform) =
                        self.extract_extrusion_direction_from_solid(&current, decoder)?;
                    let combined = match (mapping_chain.as_ref(), position_transform) {
                        (Some(chain), Some(pos)) => Some(chain * pos),
                        (Some(chain), None) => Some(chain.clone()),
                        (None, Some(pos)) => Some(pos),
                        (None, None) => None,
                    };
                    return Some((dir, combined));
                }
                IfcType::IfcBooleanClippingResult | IfcType::IfcBooleanResult => {
                    // FirstOperand (attribute 1) contains base geometry
                    let first_attr = current.get(1)?;
                    current = decoder.resolve_ref(first_attr).ok()??;
                }
                IfcType::IfcMappedItem => {
                    // MappingSource (attribute 0) -> MappedRepresentation -> Items
                    let source_attr = current.get(0)?;
                    let source = decoder.resolve_ref(source_attr).ok()??;
                    // RepresentationMap.MappedRepresentation is attribute 1
                    let rep_attr = source.get(1)?;
                    let rep = decoder.resolve_ref(rep_attr).ok()??;

                    // MappingTarget (attribute 1) -> instance transform
                    if let Some(target_attr) = current.get(1) {
                        if !target_attr.is_null() {
                            if let Ok(Some(target)) = decoder.resolve_ref(target_attr) {
                                if let Ok(map) =
                                    self.parse_cartesian_transformation_operator(&target, decoder)
                                {
                                    mapping_chain = Some(match mapping_chain.take() {
                                        Some(chain) => chain * map,
                                        None => map,
                                    });
                                }
                            }
                        }
                    }

                    // Get first item from representation
                    let items_attr = rep.get(3)?;
                    let items = decoder.resolve_ref_list(items_attr).ok()?;
                    current = items.first()?.clone();
                }
                _ => return None,
            }
        }

        None
    }

    /// Get per-item meshes for an opening element, transformed to world coordinates.
    /// Uses the same `transform_mesh` path as `process_element` to ensure identical
    /// coordinate handling (ObjectPlacement, unit scaling, conditional RTC offset).
    pub fn get_opening_item_meshes_world(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Mesh>> {
        let representation_attr = element.get(6).ok_or_else(|| {
            Error::geometry("Element has no representation attribute".to_string())
        })?;
        if representation_attr.is_null() {
            return Ok(vec![]);
        }

        let representation = decoder
            .resolve_ref(representation_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve representation".to_string()))?;
        let representations_attr = representation.get(2).ok_or_else(|| {
            Error::geometry("ProductDefinitionShape missing Representations".to_string())
        })?;
        let representations = decoder.resolve_ref_list(representations_attr)?;

        // Get the same placement transform that apply_placement uses
        let mut placement_transform = self
            .get_placement_transform_from_element(element, decoder)
            .unwrap_or_else(|_| Matrix4::identity());
        self.scale_transform(&mut placement_transform);

        let mut item_meshes = Vec::new();

        for shape_rep in representations {
            if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
                continue;
            }
            if let Some(rep_type_attr) = shape_rep.get(2) {
                if let Some(rep_type) = rep_type_attr.as_string() {
                    if !is_body_representation(rep_type) {
                        continue;
                    }
                }
            }
            let items_attr = match shape_rep.get(3) {
                Some(attr) => attr,
                None => continue,
            };
            let items = match decoder.resolve_ref_list(items_attr) {
                Ok(items) => items,
                Err(_) => continue,
            };

            for item in items {
                let mut mesh = match self.process_representation_item(&item, decoder) {
                    Ok(m) if !m.is_empty() => m,
                    _ => continue,
                };

                // Use the same transform_mesh as process_element → apply_placement
                // This handles ObjectPlacement, unit scaling, and conditional RTC
                self.transform_mesh_world(&mut mesh, &placement_transform);

                item_meshes.push(mesh);
            }
        }

        Ok(item_meshes)
    }

    /// Extrusion direction is in world coordinates, normalized
    /// Returns None for extrusion direction if it cannot be extracted (fallback to bounds-only)
    pub fn get_opening_item_bounds_with_direction(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<(Point3<f64>, Point3<f64>, Option<Vector3<f64>>)>> {
        // Get representation (attribute 6 for most building elements)
        let representation_attr = element.get(6).ok_or_else(|| {
            Error::geometry("Element has no representation attribute".to_string())
        })?;

        if representation_attr.is_null() {
            return Ok(vec![]);
        }

        let representation = decoder
            .resolve_ref(representation_attr)?
            .ok_or_else(|| Error::geometry("Failed to resolve representation".to_string()))?;

        // Get representations list
        let representations_attr = representation.get(2).ok_or_else(|| {
            Error::geometry("ProductDefinitionShape missing Representations".to_string())
        })?;

        let representations = decoder.resolve_ref_list(representations_attr)?;

        // Get placement transform
        let mut placement_transform = self
            .get_placement_transform_from_element(element, decoder)
            .unwrap_or_else(|_| Matrix4::identity());
        self.scale_transform(&mut placement_transform);

        let mut bounds_list = Vec::new();

        for shape_rep in representations {
            if shape_rep.ifc_type != IfcType::IfcShapeRepresentation {
                continue;
            }

            // Check representation type
            if let Some(rep_type_attr) = shape_rep.get(2) {
                if let Some(rep_type) = rep_type_attr.as_string() {
                    if !is_body_representation(rep_type) {
                        continue;
                    }
                }
            }

            // Get items list
            let items_attr = match shape_rep.get(3) {
                Some(attr) => attr,
                None => continue,
            };

            let items = match decoder.resolve_ref_list(items_attr) {
                Ok(items) => items,
                Err(_) => continue,
            };

            // Process each item separately to get individual bounds
            for item in items {
                // Try to extract extrusion direction recursively (handles wrappers)
                let extrusion_direction = if let Some((local_dir, position_transform)) =
                    self.extract_extrusion_direction_recursive(&item, decoder)
                {
                    // Transform extrusion direction from local to world coordinates
                    if let Some(pos_transform) = position_transform {
                        let pos_rot = extract_rotation_columns(&pos_transform);
                        let world_dir = rotate_and_normalize(&pos_rot, &local_dir)?;

                        let element_rot = extract_rotation_columns(&placement_transform);
                        let final_dir = rotate_and_normalize(&element_rot, &world_dir)?;

                        Some(final_dir)
                    } else {
                        let element_rot = extract_rotation_columns(&placement_transform);
                        let final_dir = rotate_and_normalize(&element_rot, &local_dir)?;

                        Some(final_dir)
                    }
                } else {
                    None
                };

                // Get mesh bounds (same as original function)
                let mesh = match self.process_representation_item(&item, decoder) {
                    Ok(m) if !m.is_empty() => m,
                    _ => continue,
                };

                // Get bounds and transform to world coordinates
                let (mesh_min, mesh_max) = mesh.bounds();

                // Transform corner points to world coordinates
                let corners = [
                    Point3::new(mesh_min.x as f64, mesh_min.y as f64, mesh_min.z as f64),
                    Point3::new(mesh_max.x as f64, mesh_min.y as f64, mesh_min.z as f64),
                    Point3::new(mesh_min.x as f64, mesh_max.y as f64, mesh_min.z as f64),
                    Point3::new(mesh_max.x as f64, mesh_max.y as f64, mesh_min.z as f64),
                    Point3::new(mesh_min.x as f64, mesh_min.y as f64, mesh_max.z as f64),
                    Point3::new(mesh_max.x as f64, mesh_min.y as f64, mesh_max.z as f64),
                    Point3::new(mesh_min.x as f64, mesh_max.y as f64, mesh_max.z as f64),
                    Point3::new(mesh_max.x as f64, mesh_max.y as f64, mesh_max.z as f64),
                ];

                // Transform all corners and compute new AABB
                let transformed: Vec<Point3<f64>> = corners
                    .iter()
                    .map(|p| placement_transform.transform_point(p))
                    .collect();

                let world_min = Point3::new(
                    transformed
                        .iter()
                        .map(|p| p.x)
                        .fold(f64::INFINITY, f64::min),
                    transformed
                        .iter()
                        .map(|p| p.y)
                        .fold(f64::INFINITY, f64::min),
                    transformed
                        .iter()
                        .map(|p| p.z)
                        .fold(f64::INFINITY, f64::min),
                );
                let world_max = Point3::new(
                    transformed
                        .iter()
                        .map(|p| p.x)
                        .fold(f64::NEG_INFINITY, f64::max),
                    transformed
                        .iter()
                        .map(|p| p.y)
                        .fold(f64::NEG_INFINITY, f64::max),
                    transformed
                        .iter()
                        .map(|p| p.z)
                        .fold(f64::NEG_INFINITY, f64::max),
                );

                // Apply RTC offset to opening bounds so they match wall mesh coordinate system
                // Wall mesh positions have RTC subtracted during transform_mesh, so opening bounds must match
                let rtc = self.rtc_offset;
                let rtc_min = Point3::new(
                    world_min.x - rtc.0,
                    world_min.y - rtc.1,
                    world_min.z - rtc.2,
                );
                let rtc_max = Point3::new(
                    world_max.x - rtc.0,
                    world_max.y - rtc.1,
                    world_max.z - rtc.2,
                );

                bounds_list.push((rtc_min, rtc_max, extrusion_direction));
            }
        }

        Ok(bounds_list)
    }

    /// Process element with void subtraction (openings)
    /// Process element with voids using optimized plane clipping
    ///
    /// This approach is more efficient than full 3D CSG for rectangular openings:
    /// 1. Get chamfered wall mesh (preserves chamfered corners)
    /// 2. For each opening, use optimized box cutting with internal face generation
    /// 3. Apply any clipping operations (roof clips) from original representation
    #[inline]
    /// Process an element with void subtraction (openings).
    ///
    /// This function handles three distinct cases for cutting openings:
    ///
    /// 1. **Floor/Slab openings** (vertical Z-extrusion): Uses CSG with actual mesh geometry
    ///    because the XY footprint may be rotated relative to the slab orientation.
    ///
    /// 2. **Wall openings** (horizontal X/Y-extrusion, axis-aligned): Uses AABB clipping
    ///    for fast, accurate cutting of rectangular openings.
    ///
    /// 3. **Diagonal wall openings**: Uses AABB clipping without internal face generation
    ///    to avoid rotation artifacts.
    ///
    /// Reveal faces (inner surfaces of the opening holes) are generated as a
    /// post-clipping step for rectangular and diagonal openings.  For diagonal
    /// walls the geometry is computed in a rotated axis-aligned frame and
    /// rotated back, giving correct results for any wall orientation.
    pub fn process_element_with_voids(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        void_index: &FxHashMap<u32, Vec<u32>>,
    ) -> Result<Mesh> {
        let opening_ids = match void_index.get(&element.id) {
            Some(ids) if !ids.is_empty() => ids,
            _ => {
                return self.process_element(element, decoder);
            }
        };

        let wall_mesh = match self.process_element(element, decoder) {
            Ok(m) => m,
            Err(_) => {
                return self.process_element(element, decoder);
            }
        };

        Ok(self.apply_voids_to_mesh(wall_mesh, element, opening_ids, decoder))
    }

    /// Apply opening subtraction and clipping planes to an already-built mesh.
    ///
    /// Shared entry point used by both the single-mesh path
    /// ([`process_element_with_voids`]) and the per-sub-mesh path
    /// ([`process_element_with_submeshes_and_voids`]). The incoming mesh is
    /// expected to be in the same (world) coordinate space as the element —
    /// i.e. placement already applied — because opening and clip geometry are
    /// resolved in world coordinates.
    ///
    /// Returns the input mesh unchanged when it is invalid or when no
    /// openings/clips apply, so callers never lose their input on a
    /// degenerate opening set.
    pub(super) fn apply_voids_to_mesh(
        &self,
        mesh: Mesh,
        element: &DecodedEntity,
        opening_ids: &[u32],
        decoder: &mut EntityDecoder,
    ) -> Mesh {
        let ctx = self.build_void_context(element, opening_ids, decoder);
        self.apply_void_context(mesh, &ctx)
    }

    /// Classify openings and extract clipping planes for an element.
    ///
    /// This is the expensive half of void subtraction — it decodes every
    /// `IfcOpeningElement` (running `process_element` on each), classifies
    /// them as rectangular / diagonal / non-rectangular, merges adjacent
    /// rectangles, and transforms clipping planes to world space. The
    /// output is reusable across every sub-mesh of the same element.
    pub(super) fn build_void_context(
        &self,
        element: &DecodedEntity,
        opening_ids: &[u32],
        decoder: &mut EntityDecoder,
    ) -> VoidContext {
        let world_clipping_planes: Vec<(Point3<f64>, Vector3<f64>, bool)> =
            if self.has_clipping_planes(element, decoder) {
                let mut object_placement_transform =
                    match self.get_placement_transform_from_element(element, decoder) {
                        Ok(t) => t,
                        Err(_) => Matrix4::identity(),
                    };
                self.scale_transform(&mut object_placement_transform);

                let clipping_planes = match self.extract_base_profile_and_clips(element, decoder) {
                    Ok((_profile, _depth, _axis, _origin, _transform, clips)) => clips,
                    Err(_) => Vec::new(),
                };

                clipping_planes
                    .iter()
                    .map(|(point, normal, agreement)| {
                        let world_point = object_placement_transform.transform_point(point);
                        let rotation = object_placement_transform.fixed_view::<3, 3>(0, 0);
                        let world_normal = (rotation * normal).normalize();
                        (world_point, world_normal, *agreement)
                    })
                    .collect()
            } else {
                Vec::new()
            };

        let openings = self.classify_openings(opening_ids, decoder);
        let merged_openings = Self::merge_rectangular_openings(&openings);

        VoidContext {
            openings,
            merged_openings,
            world_clipping_planes,
        }
    }

    /// Apply a pre-built `VoidContext` to a single mesh.
    ///
    /// This is the cheap per-mesh half of void subtraction: it re-reads the
    /// mesh bounds (which differ per sub-mesh), extends rectangular openings
    /// along their extrusion axis so they fully penetrate the mesh, runs the
    /// batched rectangular clip, then applies the CSG and clipping-plane
    /// passes. All the classification work has already been done in
    /// [`GeometryRouter::build_void_context`].
    pub(super) fn apply_void_context(&self, mesh: Mesh, ctx: &VoidContext) -> Mesh {
        if ctx.is_noop() {
            return mesh;
        }

        let clipper = ClippingProcessor::new();
        let mut result = mesh;

        let (wall_min_f32, wall_max_f32) = result.bounds();
        let wall_min = Point3::new(
            wall_min_f32.x as f64,
            wall_min_f32.y as f64,
            wall_min_f32.z as f64,
        );
        let wall_max = Point3::new(
            wall_max_f32.x as f64,
            wall_max_f32.y as f64,
            wall_max_f32.z as f64,
        );

        let wall_valid = !result.is_empty()
            && result.positions.iter().all(|&v| v.is_finite())
            && result.triangle_count() >= 4;

        if !wall_valid {
            return result;
        }

        let mut csg_operation_count = 0;
        const MAX_CSG_OPERATIONS: usize = 10;

        self.apply_diagonal_openings(&mut result, &ctx.openings, &wall_min, &wall_max);

        let mut rect_boxes: Vec<(Point3<f64>, Point3<f64>)> = Vec::new();
        // Keep extrusion directions alongside boxes for reveal generation.
        let mut rect_dirs: Vec<Option<Vector3<f64>>> = Vec::new();
        let mut non_rect_openings: Vec<&OpeningType> = Vec::new();

        for opening in &ctx.merged_openings {
            match opening {
                OpeningType::Rectangular(open_min, open_max, extrusion_dir) => {
                    let (final_min, final_max) = if let Some(dir) = extrusion_dir {
                        self.extend_opening_along_direction(
                            *open_min, *open_max, wall_min, wall_max, *dir,
                        )
                    } else {
                        (*open_min, *open_max)
                    };
                    rect_boxes.push((final_min, final_max));
                    rect_dirs.push(*extrusion_dir);
                }
                other => {
                    non_rect_openings.push(other);
                }
            }
        }

        if !rect_boxes.is_empty() {
            let (new_result, processed) =
                self.cut_multiple_rectangular_openings(&result, &rect_boxes);
            result = new_result;

            // Generate reveal faces only for openings that were actually cut.
            // The triangle cap inside `cut_multiple_rectangular_openings` may
            // have short-circuited the loop, leaving a suffix of boxes
            // unprocessed — emitting reveals for them would add floating
            // interior faces without a matching cutout.
            for (i, (open_min, open_max)) in rect_boxes.iter().enumerate().take(processed) {
                generate_reveal_quads(
                    &mut result,
                    open_min,
                    open_max,
                    &wall_min,
                    &wall_max,
                    rect_dirs[i].as_ref(),
                );
            }
        }

        for opening in &non_rect_openings {
            match *opening {
                OpeningType::Rectangular(..) | OpeningType::DiagonalRectangular(..) => {}
                OpeningType::NonRectangular(ref opening_mesh) => {
                    if csg_operation_count >= MAX_CSG_OPERATIONS {
                        continue;
                    }

                    let opening_valid = !opening_mesh.is_empty()
                        && opening_mesh.positions.iter().all(|&v| v.is_finite())
                        && opening_mesh.positions.len() >= 9;

                    if !opening_valid {
                        continue;
                    }

                    let (result_min, result_max) = result.bounds();
                    let (open_min_f32, open_max_f32) = opening_mesh.bounds();
                    let no_overlap = open_max_f32.x < result_min.x
                        || open_min_f32.x > result_max.x
                        || open_max_f32.y < result_min.y
                        || open_min_f32.y > result_max.y
                        || open_max_f32.z < result_min.z
                        || open_min_f32.z > result_max.z;
                    if no_overlap {
                        continue;
                    }

                    let open_vol = (open_max_f32.x - open_min_f32.x)
                        * (open_max_f32.y - open_min_f32.y)
                        * (open_max_f32.z - open_min_f32.z);
                    if open_vol < MIN_OPENING_VOLUME as f32 {
                        continue;
                    }

                    let tri_before = result.triangle_count();
                    match clipper.subtract_mesh(&result, opening_mesh) {
                        Ok(csg_result) => {
                            let min_tris = (tri_before / CSG_TRIANGLE_RETENTION_DIVISOR)
                                .max(MIN_VALID_TRIANGLES);
                            if !csg_result.is_empty() && csg_result.triangle_count() >= min_tris {
                                result = csg_result;
                            }
                        }
                        Err(_) => {}
                    }
                    csg_operation_count += 1;
                }
            }
        }

        if !ctx.world_clipping_planes.is_empty() {
            for (plane_point, plane_normal, agreement) in &ctx.world_clipping_planes {
                let clip_normal = if *agreement {
                    *plane_normal
                } else {
                    -*plane_normal
                };

                let plane = Plane::new(*plane_point, clip_normal);
                if let Ok(clipped) = clipper.clip_mesh(&result, &plane) {
                    if !clipped.is_empty() {
                        result = clipped;
                    }
                }
            }
        }

        result
    }

    /// Process an element into per-item sub-meshes with opening subtraction.
    ///
    /// Mirrors [`process_element_with_voids`] but preserves each
    /// `IfcShapeRepresentation` item as its own sub-mesh so that callers can
    /// look up a direct `IfcStyledItem` color per geometry item (e.g. the
    /// three extrusion layers of a multi-layer wall). The opening(s) are
    /// subtracted from each sub-mesh independently so that windows and doors
    /// cut through every material layer they intersect.
    ///
    /// Returns an empty collection when there are no openings (callers should
    /// fall back to [`process_element_with_submeshes`]) or when every
    /// sub-mesh is destroyed by void subtraction.
    pub fn process_element_with_submeshes_and_voids(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
        void_index: &FxHashMap<u32, Vec<u32>>,
    ) -> Result<SubMeshCollection> {
        // Layered single-solid path: slice the element's base mesh by its
        // material-layer buildup AFTER subtracting voids. This produces one
        // sub-mesh per layer keyed by IfcMaterial id, so layers show up as
        // individual colors even when the underlying geometry is a single
        // swept solid.
        if let Some(layered) = self.try_layered_sub_meshes(element, decoder, Some(void_index)) {
            return Ok(layered);
        }

        let opening_ids = match void_index.get(&element.id) {
            Some(ids) if !ids.is_empty() => ids.clone(),
            _ => return Ok(SubMeshCollection::new()),
        };

        let sub_meshes = self.process_element_with_submeshes(element, decoder)?;
        if sub_meshes.is_empty() {
            return Ok(SubMeshCollection::new());
        }

        // Classify openings + resolve clipping planes ONCE per element. Doing
        // this per sub-mesh would re-run `process_element` on every opening
        // and re-extract clipping planes N times, multiplying the expensive
        // parsing/CSG setup by the sub-mesh count on the exact elements this
        // path targets (multi-layer walls with windows).
        let ctx = self.build_void_context(element, &opening_ids, decoder);

        let mut voided = SubMeshCollection::new();
        for sub in sub_meshes.sub_meshes {
            let geometry_id = sub.geometry_id;
            let voided_mesh = self.apply_void_context(sub.mesh, &ctx);
            if !voided_mesh.is_empty() {
                voided.sub_meshes.push(SubMesh::new(geometry_id, voided_mesh));
            }
        }

        Ok(voided)
    }

    fn classify_openings(
        &self,
        opening_ids: &[u32],
        decoder: &mut EntityDecoder,
    ) -> Vec<OpeningType> {
        let mut openings: Vec<OpeningType> = Vec::new();
        for &opening_id in opening_ids.iter() {
            let opening_entity = match decoder.decode_by_id(opening_id) {
                Ok(e) => e,
                Err(_) => continue,
            };

            let opening_mesh = match self.process_element(&opening_entity, decoder) {
                Ok(m) if !m.is_empty() => m,
                _ => continue,
            };

            let vertex_count = opening_mesh.positions.len() / 3;

            if vertex_count > 100 {
                openings.push(OpeningType::NonRectangular(opening_mesh));
            } else {
                let item_bounds_with_dir = self
                    .get_opening_item_bounds_with_direction(&opening_entity, decoder)
                    .unwrap_or_default();

                if !item_bounds_with_dir.is_empty() {
                    let is_floor_opening = item_bounds_with_dir
                        .iter()
                        .any(|(_, _, dir)| dir.map(|d| d.z.abs() > 0.95).unwrap_or(false));

                    if is_floor_opening && vertex_count > 0 {
                        openings.push(OpeningType::NonRectangular(opening_mesh.clone()));
                    } else {
                        let any_diagonal = item_bounds_with_dir.iter().any(|(_, _, dir)| {
                            dir.map(|d| {
                                const AXIS_THRESHOLD: f64 = 0.95;
                                let abs_x = d.x.abs();
                                let abs_y = d.y.abs();
                                let abs_z = d.z.abs();
                                !(abs_x > AXIS_THRESHOLD
                                    || abs_y > AXIS_THRESHOLD
                                    || abs_z > AXIS_THRESHOLD)
                            })
                            .unwrap_or(false)
                        });

                        if any_diagonal {
                            // Only use the diagonal path if we have an actual extrusion direction;
                            // without one the rotation would be arbitrary and produce wrong cuts.
                            if let Some(dir) = item_bounds_with_dir.iter().find_map(|(_, _, d)| *d)
                            {
                                let item_meshes = self
                                    .get_opening_item_meshes_world(&opening_entity, decoder)
                                    .unwrap_or_default();
                                if item_meshes.is_empty() {
                                    openings.push(OpeningType::DiagonalRectangular(
                                        opening_mesh.clone(),
                                        dir,
                                    ));
                                } else {
                                    for item_mesh in item_meshes {
                                        openings
                                            .push(OpeningType::DiagonalRectangular(item_mesh, dir));
                                    }
                                }
                            } else {
                                // No direction available — fall back to CSG
                                openings.push(OpeningType::NonRectangular(opening_mesh.clone()));
                            }
                        } else {
                            for (min_pt, max_pt, extrusion_dir) in item_bounds_with_dir {
                                openings.push(OpeningType::Rectangular(
                                    min_pt,
                                    max_pt,
                                    extrusion_dir,
                                ));
                            }
                        }
                    }
                } else {
                    let (open_min, open_max) = opening_mesh.bounds();
                    let min_f64 =
                        Point3::new(open_min.x as f64, open_min.y as f64, open_min.z as f64);
                    let max_f64 =
                        Point3::new(open_max.x as f64, open_max.y as f64, open_max.z as f64);

                    openings.push(OpeningType::Rectangular(min_f64, max_f64, None));
                }
            }
        }
        openings
    }

    /// Merge adjacent/overlapping rectangular openings into larger boxes.
    /// This prevents exponential triangle growth when many small openings
    /// tile a wall surface — each clip creates boundary triangles that get
    /// re-split by the next clip, causing O(2^N) growth.
    fn merge_rectangular_openings(openings: &[OpeningType]) -> Vec<OpeningType> {
        const MERGE_TOLERANCE: f64 = 0.01; // 1cm tolerance for adjacency

        // Separate rectangular and non-rectangular openings
        let mut rects: Vec<(Point3<f64>, Point3<f64>, Option<Vector3<f64>>)> = Vec::new();
        let mut others: Vec<OpeningType> = Vec::new();

        for opening in openings {
            match opening {
                OpeningType::Rectangular(min, max, dir) => {
                    rects.push((*min, *max, *dir));
                }
                other => others.push(other.clone()),
            }
        }

        // Iteratively merge overlapping/adjacent rectangles
        let mut merged = true;
        while merged {
            merged = false;
            let mut i = 0;
            while i < rects.len() {
                let mut j = i + 1;
                while j < rects.len() {
                    let (a_min, a_max, _) = &rects[i];
                    let (b_min, b_max, _) = &rects[j];

                    // Check if boxes overlap or are adjacent (within tolerance)
                    let overlaps_x = a_min.x <= b_max.x + MERGE_TOLERANCE
                        && a_max.x >= b_min.x - MERGE_TOLERANCE;
                    let overlaps_y = a_min.y <= b_max.y + MERGE_TOLERANCE
                        && a_max.y >= b_min.y - MERGE_TOLERANCE;
                    let overlaps_z = a_min.z <= b_max.z + MERGE_TOLERANCE
                        && a_max.z >= b_min.z - MERGE_TOLERANCE;

                    // Check direction compatibility before merging
                    let dirs_compatible = match (&rects[i].2, &rects[j].2) {
                        (Some(a), Some(b)) => {
                            let dot = a.x * b.x + a.y * b.y + a.z * b.z;
                            dot.abs() > 0.99 // Nearly parallel directions
                        }
                        (None, None) => true,
                        _ => false, // One has direction, other doesn't
                    };

                    if overlaps_x && overlaps_y && overlaps_z && dirs_compatible {
                        // Merge into box i
                        let dir = rects[i].2;
                        rects[i] = (
                            Point3::new(
                                a_min.x.min(b_min.x),
                                a_min.y.min(b_min.y),
                                a_min.z.min(b_min.z),
                            ),
                            Point3::new(
                                a_max.x.max(b_max.x),
                                a_max.y.max(b_max.y),
                                a_max.z.max(b_max.z),
                            ),
                            dir,
                        );
                        rects.remove(j);
                        merged = true;
                    } else {
                        j += 1;
                    }
                }
                i += 1;
            }
        }

        // Reconstruct the opening list
        let mut result: Vec<OpeningType> = rects
            .into_iter()
            .map(|(min, max, dir)| OpeningType::Rectangular(min, max, dir))
            .collect();
        result.extend(others);
        result
    }

    fn apply_diagonal_openings(
        &self,
        result: &mut Mesh,
        openings: &[OpeningType],
        wall_min: &Point3<f64>,
        wall_max: &Point3<f64>,
    ) {
        use nalgebra::Rotation3;

        let diagonal_openings: Vec<(&Mesh, &Vector3<f64>)> = openings
            .iter()
            .filter_map(|o| match o {
                OpeningType::DiagonalRectangular(mesh, dir) => Some((mesh, dir)),
                _ => None,
            })
            .collect();

        if diagonal_openings.is_empty() {
            return;
        }

        // Group openings by extrusion direction so each group gets its own
        // rotate-clip-unrotate pass (directions considered equal within a
        // small angular tolerance).
        const DIR_DOT_THRESHOLD: f64 = 0.9998; // ~1° tolerance
        let mut groups: Vec<(Vector3<f64>, Vec<&Mesh>)> = Vec::new();
        for (mesh, dir) in &diagonal_openings {
            let d = *dir;
            if let Some(group) = groups
                .iter_mut()
                .find(|(g, _)| d.dot(g).abs() > DIR_DOT_THRESHOLD)
            {
                group.1.push(mesh);
            } else {
                groups.push((*d, vec![mesh]));
            }
        }

        let wall_corners = [
            Point3::new(wall_min.x, wall_min.y, wall_min.z),
            Point3::new(wall_max.x, wall_min.y, wall_min.z),
            Point3::new(wall_min.x, wall_max.y, wall_min.z),
            Point3::new(wall_max.x, wall_max.y, wall_min.z),
            Point3::new(wall_min.x, wall_min.y, wall_max.z),
            Point3::new(wall_max.x, wall_min.y, wall_max.z),
            Point3::new(wall_min.x, wall_max.y, wall_max.z),
            Point3::new(wall_max.x, wall_max.y, wall_max.z),
        ];

        for (extrusion_dir, group_meshes) in &groups {
            let target = Vector3::new(1.0, 0.0, 0.0);
            let rotation = Rotation3::rotation_between(extrusion_dir, &target)
                .unwrap_or(Rotation3::identity());
            let inv_rotation = rotation.inverse();

            // Rotate positions and normals into the aligned frame
            for chunk in result.positions.chunks_exact_mut(3) {
                let p = rotation * Point3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64);
                chunk[0] = p.x as f32;
                chunk[1] = p.y as f32;
                chunk[2] = p.z as f32;
            }
            for chunk in result.normals.chunks_exact_mut(3) {
                let n = rotation * Vector3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64);
                chunk[0] = n.x as f32;
                chunk[1] = n.y as f32;
                chunk[2] = n.z as f32;
            }

            // Compute full rotated wall AABB (needed for reveal depth clamping).
            let mut rot_wall_min =
                Point3::new(f64::INFINITY, f64::INFINITY, f64::INFINITY);
            let mut rot_wall_max =
                Point3::new(f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
            for wc in &wall_corners {
                let rwc = rotation * wc;
                rot_wall_min.x = rot_wall_min.x.min(rwc.x);
                rot_wall_min.y = rot_wall_min.y.min(rwc.y);
                rot_wall_min.z = rot_wall_min.z.min(rwc.z);
                rot_wall_max.x = rot_wall_max.x.max(rwc.x);
                rot_wall_max.y = rot_wall_max.y.max(rwc.y);
                rot_wall_max.z = rot_wall_max.z.max(rwc.z);
            }

            for opening_mesh in group_meshes {
                let mut rot_min = Point3::new(f64::INFINITY, f64::INFINITY, f64::INFINITY);
                let mut rot_max =
                    Point3::new(f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
                for chunk in opening_mesh.positions.chunks_exact(3) {
                    let p =
                        rotation * Point3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64);
                    rot_min.x = rot_min.x.min(p.x);
                    rot_min.y = rot_min.y.min(p.y);
                    rot_min.z = rot_min.z.min(p.z);
                    rot_max.x = rot_max.x.max(p.x);
                    rot_max.y = rot_max.y.max(p.y);
                    rot_max.z = rot_max.z.max(p.z);
                }
                rot_min.x = rot_min.x.min(rot_wall_min.x);
                rot_max.x = rot_max.x.max(rot_wall_max.x);

                *result = self.cut_rectangular_opening_no_faces(result, rot_min, rot_max);

                // Generate reveal faces in the rotated (X-aligned) frame.
                // They rotate back to world space together with the rest of the mesh.
                let x_dir = Vector3::new(1.0, 0.0, 0.0);
                generate_reveal_quads(
                    result,
                    &rot_min,
                    &rot_max,
                    &rot_wall_min,
                    &rot_wall_max,
                    Some(&x_dir),
                );
            }

            // Rotate positions and normals back to world frame
            for chunk in result.positions.chunks_exact_mut(3) {
                let p =
                    inv_rotation * Point3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64);
                chunk[0] = p.x as f32;
                chunk[1] = p.y as f32;
                chunk[2] = p.z as f32;
            }
            for chunk in result.normals.chunks_exact_mut(3) {
                let n =
                    inv_rotation * Vector3::new(chunk[0] as f64, chunk[1] as f64, chunk[2] as f64);
                chunk[0] = n.x as f32;
                chunk[1] = n.y as f32;
                chunk[2] = n.z as f32;
            }
        }
    }

    /// Cut a rectangular opening from a mesh using optimized plane clipping
    ///
    /// This is more efficient than full CSG because:
    /// 1. Only processes triangles that intersect the opening bounds
    /// Extend opening bounds along extrusion direction to match wall extent
    ///
    /// Projects wall corners onto the extrusion axis and extends the opening
    /// min/max to cover the wall's full extent along that direction.
    /// This ensures openings penetrate multi-layer walls correctly without
    /// causing artifacts for angled walls.
    fn extend_opening_along_direction(
        &self,
        open_min: Point3<f64>,
        open_max: Point3<f64>,
        wall_min: Point3<f64>,
        wall_max: Point3<f64>,
        extrusion_direction: Vector3<f64>, // World-space, normalized
    ) -> (Point3<f64>, Point3<f64>) {
        // Use opening center as reference point for projection
        let open_center = Point3::new(
            (open_min.x + open_max.x) * 0.5,
            (open_min.y + open_max.y) * 0.5,
            (open_min.z + open_max.z) * 0.5,
        );

        // Project all 8 corners of the wall box onto the extrusion axis
        let wall_corners = [
            Point3::new(wall_min.x, wall_min.y, wall_min.z),
            Point3::new(wall_max.x, wall_min.y, wall_min.z),
            Point3::new(wall_min.x, wall_max.y, wall_min.z),
            Point3::new(wall_max.x, wall_max.y, wall_min.z),
            Point3::new(wall_min.x, wall_min.y, wall_max.z),
            Point3::new(wall_max.x, wall_min.y, wall_max.z),
            Point3::new(wall_min.x, wall_max.y, wall_max.z),
            Point3::new(wall_max.x, wall_max.y, wall_max.z),
        ];

        // Find min/max projections of wall corners onto extrusion axis
        let mut wall_min_proj = f64::INFINITY;
        let mut wall_max_proj = f64::NEG_INFINITY;

        for corner in &wall_corners {
            // Project corner onto extrusion axis relative to opening center
            let proj = (corner - open_center).dot(&extrusion_direction);
            wall_min_proj = wall_min_proj.min(proj);
            wall_max_proj = wall_max_proj.max(proj);
        }

        // Project opening corners onto extrusion axis
        let open_corners = [
            Point3::new(open_min.x, open_min.y, open_min.z),
            Point3::new(open_max.x, open_min.y, open_min.z),
            Point3::new(open_min.x, open_max.y, open_min.z),
            Point3::new(open_max.x, open_max.y, open_min.z),
            Point3::new(open_min.x, open_min.y, open_max.z),
            Point3::new(open_max.x, open_min.y, open_max.z),
            Point3::new(open_min.x, open_max.y, open_max.z),
            Point3::new(open_max.x, open_max.y, open_max.z),
        ];

        let mut open_min_proj = f64::INFINITY;
        let mut open_max_proj = f64::NEG_INFINITY;

        for corner in &open_corners {
            let proj = (corner - open_center).dot(&extrusion_direction);
            open_min_proj = open_min_proj.min(proj);
            open_max_proj = open_max_proj.max(proj);
        }

        // Calculate how much to extend in each direction along the extrusion axis
        // If wall extends beyond opening, we need to extend the opening
        let extend_backward = (open_min_proj - wall_min_proj).max(0.0); // How much wall extends before opening
        let extend_forward = (wall_max_proj - open_max_proj).max(0.0); // How much wall extends after opening

        // Extend opening bounds along the extrusion direction
        let extended_min = open_min - extrusion_direction * extend_backward;
        let extended_max = open_max + extrusion_direction * extend_forward;

        // Create new AABB that encompasses both original opening and extended points
        // This ensures we don't shrink the opening in other dimensions
        let all_points = [open_min, open_max, extended_min, extended_max];

        let new_min = Point3::new(
            all_points.iter().map(|p| p.x).fold(f64::INFINITY, f64::min),
            all_points.iter().map(|p| p.y).fold(f64::INFINITY, f64::min),
            all_points.iter().map(|p| p.z).fold(f64::INFINITY, f64::min),
        );
        let new_max = Point3::new(
            all_points
                .iter()
                .map(|p| p.x)
                .fold(f64::NEG_INFINITY, f64::max),
            all_points
                .iter()
                .map(|p| p.y)
                .fold(f64::NEG_INFINITY, f64::max),
            all_points
                .iter()
                .map(|p| p.z)
                .fold(f64::NEG_INFINITY, f64::max),
        );

        (new_min, new_max)
    }

    /// Cut a rectangular opening from a mesh using AABB clipping.
    ///
    /// This method clips triangles against the opening bounding box using axis-aligned
    /// clipping planes. Reveal faces are generated separately in the caller after
    /// all clipping is complete (see `generate_reveal_quads`).
    /// Single-pass multi-box rectangular clipping.
    /// Instead of iterating boxes one-by-one (O(2^N) triangle growth from boundary
    /// re-splitting), this tests each triangle against ALL boxes simultaneously.
    /// A triangle is discarded if it falls completely inside ANY box.
    /// A triangle is kept as-is if it doesn't intersect ANY box.
    /// Triangles that partially intersect are clipped against the intersecting box.
    fn cut_multiple_rectangular_openings(
        &self,
        mesh: &Mesh,
        boxes: &[(Point3<f64>, Point3<f64>)],
    ) -> (Mesh, usize) {
        let mut current = mesh.clone();

        // Process each box, but only clip triangles that actually intersect THIS box.
        // The key insight: after clipping against box N, the new boundary triangles
        // are at box N's edges. Box N+1 only clips triangles that intersect IT —
        // if box N+1 doesn't overlap box N's edges, no re-splitting occurs.
        //
        // The exponential growth happened because adjacent boxes shared edges,
        // causing every boundary triangle from box N to be re-split by box N+1.
        // With merged boxes, adjacency is eliminated.
        //
        // Safety: cap triangle count to prevent OOM from pathological cases.
        // When the cap trips, the remaining suffix of boxes is left uncut; the
        // processed count is returned so the caller can skip reveal generation
        // for openings that didn't actually leave a hole in the mesh.
        const MAX_TRIANGLES: usize = 500_000;

        let mut processed = 0;
        for (open_min, open_max) in boxes.iter() {
            if current.indices.len() / 3 > MAX_TRIANGLES {
                break;
            }
            current = self.cut_rectangular_opening(&current, *open_min, *open_max);
            processed += 1;
        }

        (current, processed)
    }

    pub(super) fn cut_rectangular_opening(
        &self,
        mesh: &Mesh,
        open_min: Point3<f64>,
        open_max: Point3<f64>,
    ) -> Mesh {
        self.cut_rectangular_opening_no_faces(mesh, open_min, open_max)
    }

    /// Cut a rectangular opening using AABB clipping WITHOUT generating internal faces.
    /// Used for diagonal openings where internal face generation causes rotation artifacts.
    fn cut_rectangular_opening_no_faces(
        &self,
        mesh: &Mesh,
        open_min: Point3<f64>,
        open_max: Point3<f64>,
    ) -> Mesh {
        use nalgebra::Vector3;

        const EPSILON: f64 = 1e-6;

        let mut result = Mesh::with_capacity(mesh.positions.len() / 3, mesh.indices.len() / 3);

        let mut clip_buffers = ClipBuffers::new();

        let num_vertices = mesh.positions.len() / 3;
        for chunk in mesh.indices.chunks_exact(3) {
            let i0 = chunk[0] as usize;
            let i1 = chunk[1] as usize;
            let i2 = chunk[2] as usize;

            // Bounds check: skip triangles with out-of-range vertex indices
            if i0 >= num_vertices || i1 >= num_vertices || i2 >= num_vertices {
                continue;
            }

            let v0 = Point3::new(
                mesh.positions[i0 * 3] as f64,
                mesh.positions[i0 * 3 + 1] as f64,
                mesh.positions[i0 * 3 + 2] as f64,
            );
            let v1 = Point3::new(
                mesh.positions[i1 * 3] as f64,
                mesh.positions[i1 * 3 + 1] as f64,
                mesh.positions[i1 * 3 + 2] as f64,
            );
            let v2 = Point3::new(
                mesh.positions[i2 * 3] as f64,
                mesh.positions[i2 * 3 + 1] as f64,
                mesh.positions[i2 * 3 + 2] as f64,
            );

            let n0 = if mesh.normals.len() >= mesh.positions.len() {
                Vector3::new(
                    mesh.normals[i0 * 3] as f64,
                    mesh.normals[i0 * 3 + 1] as f64,
                    mesh.normals[i0 * 3 + 2] as f64,
                )
            } else {
                let edge1 = v1 - v0;
                let edge2 = v2 - v0;
                edge1
                    .cross(&edge2)
                    .try_normalize(1e-10)
                    .unwrap_or(Vector3::new(0.0, 0.0, 1.0))
            };

            let tri_min_x = v0.x.min(v1.x).min(v2.x);
            let tri_max_x = v0.x.max(v1.x).max(v2.x);
            let tri_min_y = v0.y.min(v1.y).min(v2.y);
            let tri_max_y = v0.y.max(v1.y).max(v2.y);
            let tri_min_z = v0.z.min(v1.z).min(v2.z);
            let tri_max_z = v0.z.max(v1.z).max(v2.z);

            // If triangle is completely outside opening, keep it as-is
            if tri_max_x <= open_min.x - EPSILON
                || tri_min_x >= open_max.x + EPSILON
                || tri_max_y <= open_min.y - EPSILON
                || tri_min_y >= open_max.y + EPSILON
                || tri_max_z <= open_min.z - EPSILON
                || tri_min_z >= open_max.z + EPSILON
            {
                let base = result.vertex_count() as u32;
                result.add_vertex(v0, n0);
                result.add_vertex(v1, n0);
                result.add_vertex(v2, n0);
                result.add_triangle(base, base + 1, base + 2);
                continue;
            }

            // Check if triangle is completely inside opening (remove it)
            if tri_min_x >= open_min.x + EPSILON
                && tri_max_x <= open_max.x - EPSILON
                && tri_min_y >= open_min.y + EPSILON
                && tri_max_y <= open_max.y - EPSILON
                && tri_min_z >= open_min.z + EPSILON
                && tri_max_z <= open_max.z - EPSILON
            {
                continue;
            }

            // Triangle may intersect opening - clip it
            if self.triangle_intersects_box(&v0, &v1, &v2, &open_min, &open_max) {
                self.clip_triangle_against_box(
                    &mut result,
                    &mut clip_buffers,
                    &v0,
                    &v1,
                    &v2,
                    &n0,
                    &open_min,
                    &open_max,
                );
            } else {
                let base = result.vertex_count() as u32;
                result.add_vertex(v0, n0);
                result.add_vertex(v1, n0);
                result.add_vertex(v2, n0);
                result.add_triangle(base, base + 1, base + 2);
            }
        }

        // Reveal faces are generated by the caller (see generate_reveal_quads)
        result
    }

    /// Test if a triangle intersects an axis-aligned bounding box using Separating Axis Theorem (SAT)
    /// Returns true if triangle and box intersect, false if they are separated
    fn triangle_intersects_box(
        &self,
        v0: &Point3<f64>,
        v1: &Point3<f64>,
        v2: &Point3<f64>,
        box_min: &Point3<f64>,
        box_max: &Point3<f64>,
    ) -> bool {
        use nalgebra::Vector3;

        // Box center and half-extents
        let box_center = Point3::new(
            (box_min.x + box_max.x) * 0.5,
            (box_min.y + box_max.y) * 0.5,
            (box_min.z + box_max.z) * 0.5,
        );
        let box_half_extents = Vector3::new(
            (box_max.x - box_min.x) * 0.5,
            (box_max.y - box_min.y) * 0.5,
            (box_max.z - box_min.z) * 0.5,
        );

        // Translate triangle to box-local space
        let t0 = v0 - box_center;
        let t1 = v1 - box_center;
        let t2 = v2 - box_center;

        // Triangle edges
        let e0 = t1 - t0;
        let e1 = t2 - t1;
        let e2 = t0 - t2;

        // Test 1: Box axes (X, Y, Z)
        // Project triangle onto each axis and check overlap
        for axis_idx in 0..3 {
            let axis = match axis_idx {
                0 => Vector3::new(1.0, 0.0, 0.0),
                1 => Vector3::new(0.0, 1.0, 0.0),
                2 => Vector3::new(0.0, 0.0, 1.0),
                _ => unreachable!(),
            };

            let p0 = t0.dot(&axis);
            let p1 = t1.dot(&axis);
            let p2 = t2.dot(&axis);

            let tri_min = p0.min(p1).min(p2);
            let tri_max = p0.max(p1).max(p2);
            let box_extent = box_half_extents[axis_idx];

            if tri_max < -box_extent || tri_min > box_extent {
                return false; // Separated on this axis
            }
        }

        // Test 2: Triangle face normal
        let triangle_normal = e0.cross(&e2);
        let triangle_offset = t0.dot(&triangle_normal);

        // Project box onto triangle normal
        let mut box_projection = 0.0;
        for i in 0..3 {
            let axis = match i {
                0 => Vector3::new(1.0, 0.0, 0.0),
                1 => Vector3::new(0.0, 1.0, 0.0),
                2 => Vector3::new(0.0, 0.0, 1.0),
                _ => unreachable!(),
            };
            box_projection += box_half_extents[i] * triangle_normal.dot(&axis).abs();
        }

        if triangle_offset.abs() > box_projection {
            return false; // Separated by triangle plane
        }

        // Test 3: 9 cross-product axes (3 box edges x 3 triangle edges)
        let box_axes = [
            Vector3::new(1.0, 0.0, 0.0),
            Vector3::new(0.0, 1.0, 0.0),
            Vector3::new(0.0, 0.0, 1.0),
        ];
        let tri_edges = [e0, e1, e2];

        for box_axis in &box_axes {
            for tri_edge in &tri_edges {
                let axis = box_axis.cross(tri_edge);

                // Skip degenerate axes (parallel edges)
                if axis.norm_squared() < 1e-10 {
                    continue;
                }

                let axis_normalized = axis.normalize();

                // Project triangle onto axis
                let p0 = t0.dot(&axis_normalized);
                let p1 = t1.dot(&axis_normalized);
                let p2 = t2.dot(&axis_normalized);
                let tri_min = p0.min(p1).min(p2);
                let tri_max = p0.max(p1).max(p2);

                // Project box onto axis
                let mut box_projection = 0.0;
                for i in 0..3 {
                    let box_axis_vec = box_axes[i];
                    box_projection +=
                        box_half_extents[i] * axis_normalized.dot(&box_axis_vec).abs();
                }

                if tri_max < -box_projection || tri_min > box_projection {
                    return false; // Separated on this axis
                }
            }
        }

        // No separating axis found - triangle and box intersect
        true
    }

    /// Clip a triangle against an opening box using clip-and-collect algorithm.
    /// Removes the part of the triangle that's inside the box.
    /// Collects "outside" parts directly to result, continues processing "inside" parts.
    ///
    /// Uses reusable ClipBuffers to avoid per-triangle allocations (6+ Vec allocations
    /// per intersecting triangle without buffers).
    ///
    /// ## FIX (2026-03-18): Direct back-part computation
    ///
    /// The previous implementation clipped the original triangle against a **flipped plane**
    /// to obtain "outside" parts. When triangle vertices were within epsilon (1e-6) of the
    /// clipping plane, `clip_triangle` classified them as "front" for **both** the original
    /// and flipped planes — returning `Split` on the original but `AllFront` on the flipped.
    /// This added the **entire original triangle** to the result as an "outside" piece while
    /// the clipped front parts also continued processing, duplicating geometry.
    ///
    fn clip_triangle_against_box(
        &self,
        result: &mut Mesh,
        buffers: &mut ClipBuffers,
        v0: &Point3<f64>,
        v1: &Point3<f64>,
        v2: &Point3<f64>,
        normal: &Vector3<f64>,
        open_min: &Point3<f64>,
        open_max: &Point3<f64>,
    ) {
        let clipper = ClippingProcessor::new();
        let epsilon = clipper.epsilon;

        // Clear buffers for reuse (retains capacity)
        buffers.clear();

        // Planes with INWARD normals (so "front" = inside box, "behind" = outside box)
        // We clip to keep geometry OUTSIDE the box (behind these planes)
        let planes = [
            // +X inward: inside box where x >= open_min.x
            Plane::new(
                Point3::new(open_min.x, 0.0, 0.0),
                Vector3::new(1.0, 0.0, 0.0),
            ),
            // -X inward: inside box where x <= open_max.x
            Plane::new(
                Point3::new(open_max.x, 0.0, 0.0),
                Vector3::new(-1.0, 0.0, 0.0),
            ),
            // +Y inward: inside box where y >= open_min.y
            Plane::new(
                Point3::new(0.0, open_min.y, 0.0),
                Vector3::new(0.0, 1.0, 0.0),
            ),
            // -Y inward: inside box where y <= open_max.y
            Plane::new(
                Point3::new(0.0, open_max.y, 0.0),
                Vector3::new(0.0, -1.0, 0.0),
            ),
            // +Z inward: inside box where z >= open_min.z
            Plane::new(
                Point3::new(0.0, 0.0, open_min.z),
                Vector3::new(0.0, 0.0, 1.0),
            ),
            // -Z inward: inside box where z <= open_max.z
            Plane::new(
                Point3::new(0.0, 0.0, open_max.z),
                Vector3::new(0.0, 0.0, -1.0),
            ),
        ];

        // Guard: skip if input vertices contain NaN (from degenerate prior clips)
        if !v0.x.is_finite()
            || !v0.y.is_finite()
            || !v0.z.is_finite()
            || !v1.x.is_finite()
            || !v1.y.is_finite()
            || !v1.z.is_finite()
            || !v2.x.is_finite()
            || !v2.y.is_finite()
            || !v2.z.is_finite()
        {
            // Keep the triangle as-is (don't clip degenerate geometry)
            let base = result.vertex_count() as u32;
            result.add_vertex(*v0, *normal);
            result.add_vertex(*v1, *normal);
            result.add_vertex(*v2, *normal);
            result.add_triangle(base, base + 1, base + 2);
            return;
        }
        // Initialize remaining with the input triangle
        buffers.remaining.push(Triangle::new(*v0, *v1, *v2));

        // Clip-and-collect: collect "outside" parts, continue processing "inside" parts
        for plane in &planes {
            buffers.next_remaining.clear();

            for tri in &buffers.remaining {
                // Compute signed distances
                let d0 = plane.signed_distance(&tri.v0);
                let d1 = plane.signed_distance(&tri.v1);
                let d2 = plane.signed_distance(&tri.v2);

                // Guard: NaN distances from degenerate vertices (from prior interpolation)
                if !d0.is_finite() || !d1.is_finite() || !d2.is_finite() {
                    buffers.result.push(tri.clone()); // keep as-is
                    continue;
                }

                let f0 = d0 >= -epsilon;
                let f1 = d1 >= -epsilon;
                let f2 = d2 >= -epsilon;
                let front_count = f0 as u8 + f1 as u8 + f2 as u8;

                match front_count {
                    3 => {
                        buffers.next_remaining.push(tri.clone());
                    }
                    0 => {
                        buffers.result.push(tri.clone());
                    }
                    1 => {
                        let (front, back1, back2, d_f, d_b1, d_b2) = if f0 {
                            (tri.v0, tri.v1, tri.v2, d0, d1, d2)
                        } else if f1 {
                            (tri.v1, tri.v2, tri.v0, d1, d2, d0)
                        } else {
                            (tri.v2, tri.v0, tri.v1, d2, d0, d1)
                        };

                        let denom1 = d_f - d_b1;
                        let denom2 = d_f - d_b2;
                        if denom1.abs() < 1e-12 || denom2.abs() < 1e-12 {
                            buffers.next_remaining.push(tri.clone());
                            continue;
                        }
                        let t1 = (d_f / denom1).clamp(0.0, 1.0);
                        let t2 = (d_f / denom2).clamp(0.0, 1.0);
                        let p1 = front + (back1 - front) * t1;
                        let p2 = front + (back2 - front) * t2;

                        // Validate interpolated points
                        if !p1.x.is_finite()
                            || !p1.y.is_finite()
                            || !p1.z.is_finite()
                            || !p2.x.is_finite()
                            || !p2.y.is_finite()
                            || !p2.z.is_finite()
                        {
                            buffers.next_remaining.push(tri.clone());
                            continue;
                        }

                        buffers.next_remaining.push(Triangle::new(front, p1, p2));
                        buffers.result.push(Triangle::new(p1, back1, back2));
                        buffers.result.push(Triangle::new(p1, back2, p2));
                    }
                    2 => {
                        let (front1, front2, back, d_f1, d_f2, d_b) = if !f0 {
                            (tri.v1, tri.v2, tri.v0, d1, d2, d0)
                        } else if !f1 {
                            (tri.v2, tri.v0, tri.v1, d2, d0, d1)
                        } else {
                            (tri.v0, tri.v1, tri.v2, d0, d1, d2)
                        };

                        let denom1 = d_f1 - d_b;
                        let denom2 = d_f2 - d_b;
                        if denom1.abs() < 1e-12 || denom2.abs() < 1e-12 {
                            buffers.next_remaining.push(tri.clone());
                            continue;
                        }
                        let t1 = (d_f1 / denom1).clamp(0.0, 1.0);
                        let t2 = (d_f2 / denom2).clamp(0.0, 1.0);
                        let p1 = front1 + (back - front1) * t1;
                        let p2 = front2 + (back - front2) * t2;

                        // Validate interpolated points
                        if !p1.x.is_finite()
                            || !p1.y.is_finite()
                            || !p1.z.is_finite()
                            || !p2.x.is_finite()
                            || !p2.y.is_finite()
                            || !p2.z.is_finite()
                        {
                            buffers.next_remaining.push(tri.clone());
                            continue;
                        }

                        buffers
                            .next_remaining
                            .push(Triangle::new(front1, front2, p1));
                        buffers.next_remaining.push(Triangle::new(front2, p2, p1));
                        buffers.result.push(Triangle::new(p1, p2, back));
                    }
                    _ => {
                        // Should be unreachable, but guard against corruption
                        buffers.result.push(tri.clone());
                    }
                }
            }

            // Swap buffers instead of reallocating
            std::mem::swap(&mut buffers.remaining, &mut buffers.next_remaining);
        }

        // 'remaining' triangles are inside ALL planes = inside box = discard
        // Add collected result_triangles to mesh
        for tri in &buffers.result {
            let base = result.vertex_count() as u32;
            result.add_vertex(tri.v0, *normal);
            result.add_vertex(tri.v1, *normal);
            result.add_vertex(tri.v2, *normal);
            result.add_triangle(base, base + 1, base + 2);
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod reveal_tests {
    use super::*;
    use crate::Mesh;

    /// Build a simple box mesh (12 triangles) for testing.
    #[allow(dead_code)]
    fn make_box_mesh(
        min: Point3<f64>,
        max: Point3<f64>,
    ) -> Mesh {
        let mut m = Mesh::with_capacity(24, 36);

        let corners = [
            Point3::new(min.x, min.y, min.z), // 0
            Point3::new(max.x, min.y, min.z), // 1
            Point3::new(max.x, max.y, min.z), // 2
            Point3::new(min.x, max.y, min.z), // 3
            Point3::new(min.x, min.y, max.z), // 4
            Point3::new(max.x, min.y, max.z), // 5
            Point3::new(max.x, max.y, max.z), // 6
            Point3::new(min.x, max.y, max.z), // 7
        ];

        // 6 faces × 4 vertices each with face normals
        let faces: [(Vector3<f64>, [usize; 4]); 6] = [
            (Vector3::new(0.0, 0.0, -1.0), [0, 2, 1, 3]),  // -Z
            (Vector3::new(0.0, 0.0, 1.0), [4, 5, 6, 7]),   // +Z
            (Vector3::new(0.0, -1.0, 0.0), [0, 1, 5, 4]),   // -Y
            (Vector3::new(0.0, 1.0, 0.0), [2, 3, 7, 6]),    // +Y
            (Vector3::new(-1.0, 0.0, 0.0), [0, 4, 7, 3]),   // -X
            (Vector3::new(1.0, 0.0, 0.0), [1, 2, 6, 5]),    // +X
        ];
        for (n, idx) in &faces {
            let b = m.vertex_count() as u32;
            m.add_vertex(corners[idx[0]], *n);
            m.add_vertex(corners[idx[1]], *n);
            m.add_vertex(corners[idx[2]], *n);
            m.add_vertex(corners[idx[3]], *n);
            m.add_triangle(b, b + 1, b + 2);
            m.add_triangle(b, b + 2, b + 3);
        }
        m
    }

    /// Extract the dominant normal (first triangle's normal) of all reveal
    /// triangles (those added after `pre_count` triangles).
    fn reveal_normals(mesh: &Mesh, pre_tri_count: usize) -> Vec<Vector3<f64>> {
        let mut normals = Vec::new();
        let indices = &mesh.indices[pre_tri_count * 3..];
        for tri in indices.chunks_exact(3) {
            let i = tri[0] as usize;
            let nx = mesh.normals[i * 3] as f64;
            let ny = mesh.normals[i * 3 + 1] as f64;
            let nz = mesh.normals[i * 3 + 2] as f64;
            normals.push(Vector3::new(nx, ny, nz));
        }
        normals
    }

    #[test]
    fn test_reveals_generated_for_axis_aligned_opening() {
        // Wall: 10m long (X), 0.3m thick (Y), 3m tall (Z)
        let wall_min = Point3::new(0.0, -0.15, 0.0);
        let wall_max = Point3::new(10.0, 0.15, 3.0);

        // Opening: 2m wide at X=4..6, full Y depth, 1m..2.5m in Z
        let open_min = Point3::new(4.0, -0.3, 1.0);
        let open_max = Point3::new(6.0, 0.3, 2.5);

        let mut mesh = Mesh::new();
        let extrusion_dir = Vector3::new(0.0, 1.0, 0.0); // Through the wall

        generate_reveal_quads(
            &mut mesh,
            &open_min,
            &open_max,
            &wall_min,
            &wall_max,
            Some(&extrusion_dir),
        );

        // Should have 4 reveal quads = 8 triangles = 16 vertices
        assert_eq!(mesh.triangle_count(), 8, "Expected 4 reveal quads (8 triangles)");
        assert_eq!(mesh.vertex_count(), 16, "Expected 16 vertices (4 per quad)");
    }

    #[test]
    fn test_reveal_normals_point_inward() {
        let wall_min = Point3::new(0.0, -0.15, 0.0);
        let wall_max = Point3::new(10.0, 0.15, 3.0);
        let open_min = Point3::new(4.0, -0.3, 1.0);
        let open_max = Point3::new(6.0, 0.3, 2.5);

        let mut mesh = Mesh::new();
        let dir = Vector3::new(0.0, 1.0, 0.0);
        generate_reveal_quads(&mut mesh, &open_min, &open_max, &wall_min, &wall_max, Some(&dir));

        let normals = reveal_normals(&mesh, 0);

        // Opening center in X/Z cross-section is (5.0, 1.75)
        // Left face at X=4.0 → normal should have +X component
        // Right face at X=6.0 → normal should have −X component
        // Bottom at Z=1.0 → normal should have +Z component
        // Top at Z=2.5 → normal should have −Z component
        let has_pos_x = normals.iter().any(|n| n.x > 0.5);
        let has_neg_x = normals.iter().any(|n| n.x < -0.5);
        let has_pos_z = normals.iter().any(|n| n.z > 0.5);
        let has_neg_z = normals.iter().any(|n| n.z < -0.5);

        assert!(has_pos_x, "Should have +X normal (left reveal)");
        assert!(has_neg_x, "Should have −X normal (right reveal)");
        assert!(has_pos_z, "Should have +Z normal (bottom reveal)");
        assert!(has_neg_z, "Should have −Z normal (top reveal)");
    }

    #[test]
    fn test_no_reveals_when_opening_at_wall_boundary() {
        // Door-like opening that starts at wall bottom (Z=0) and spans full width
        let wall_min = Point3::new(0.0, -0.15, 0.0);
        let wall_max = Point3::new(10.0, 0.15, 3.0);
        // Opening at Z=0 (floor) to Z=2.1 (door height), X covers full wall
        let open_min = Point3::new(0.0, -0.3, 0.0);
        let open_max = Point3::new(10.0, 0.3, 2.1);

        let mut mesh = Mesh::new();
        let dir = Vector3::new(0.0, 1.0, 0.0);
        generate_reveal_quads(&mut mesh, &open_min, &open_max, &wall_min, &wall_max, Some(&dir));

        // X edges at wall boundary → no left/right reveals
        // Z bottom at wall boundary → no bottom reveal
        // Only top reveal at Z=2.1 should exist
        assert_eq!(mesh.triangle_count(), 2, "Only top reveal expected (1 quad = 2 tris)");
    }

    #[test]
    fn test_reveals_with_extrusion_along_x() {
        // Wall oriented along Y, thickness along X
        let wall_min = Point3::new(-0.15, 0.0, 0.0);
        let wall_max = Point3::new(0.15, 10.0, 3.0);
        let open_min = Point3::new(-0.3, 4.0, 1.0);
        let open_max = Point3::new(0.3, 6.0, 2.5);

        let mut mesh = Mesh::new();
        let dir = Vector3::new(1.0, 0.0, 0.0);
        generate_reveal_quads(&mut mesh, &open_min, &open_max, &wall_min, &wall_max, Some(&dir));

        assert_eq!(mesh.triangle_count(), 8, "4 reveal quads for X-extrusion");
    }

    #[test]
    fn test_reveals_with_extrusion_along_z() {
        // Slab-like: thickness along Z (horizontal openings)
        let wall_min = Point3::new(0.0, 0.0, -0.15);
        let wall_max = Point3::new(10.0, 10.0, 0.15);
        let open_min = Point3::new(3.0, 3.0, -0.3);
        let open_max = Point3::new(5.0, 5.0, 0.3);

        let mut mesh = Mesh::new();
        let dir = Vector3::new(0.0, 0.0, 1.0);
        generate_reveal_quads(&mut mesh, &open_min, &open_max, &wall_min, &wall_max, Some(&dir));

        assert_eq!(mesh.triangle_count(), 8, "4 reveal quads for Z-extrusion");
    }

    #[test]
    fn test_reveals_clamp_to_wall_depth() {
        // Wall: 0.3m thick along Y
        let wall_min = Point3::new(0.0, 0.0, 0.0);
        let wall_max = Point3::new(10.0, 0.3, 3.0);
        // Opening extends well beyond wall in Y (simulating extend_opening_along_direction)
        let open_min = Point3::new(4.0, -1.0, 1.0);
        let open_max = Point3::new(6.0, 1.3, 2.5);

        let mut mesh = Mesh::new();
        let dir = Vector3::new(0.0, 1.0, 0.0);
        generate_reveal_quads(&mut mesh, &open_min, &open_max, &wall_min, &wall_max, Some(&dir));

        // Reveal depth should be clamped to wall: Y=0.0..0.3 (not -1.0..1.3)
        for chunk in mesh.positions.chunks_exact(3) {
            let y = chunk[1] as f64;
            assert!(
                y >= -1e-3 && y <= 0.3 + 1e-3,
                "Reveal vertex Y={y} should be within wall bounds [0.0, 0.3]"
            );
        }
    }

    #[test]
    fn test_no_reveals_when_no_wall_thickness() {
        // Degenerate wall with zero thickness along extrusion
        let wall_min = Point3::new(0.0, 0.0, 0.0);
        let wall_max = Point3::new(10.0, 0.0, 3.0);
        let open_min = Point3::new(4.0, -0.1, 1.0);
        let open_max = Point3::new(6.0, 0.1, 2.5);

        let mut mesh = Mesh::new();
        let dir = Vector3::new(0.0, 1.0, 0.0);
        generate_reveal_quads(&mut mesh, &open_min, &open_max, &wall_min, &wall_max, Some(&dir));

        assert_eq!(mesh.triangle_count(), 0, "No reveals for zero-thickness wall");
    }

    #[test]
    fn test_no_reveals_when_opening_misses_submesh_on_cross_axis() {
        // Sub-mesh slab: Z=[0..0.5]. Opening is at Z=[1.0..2.0] — fully above.
        // Extrusion along Y (wall thickness). Without cross-axis overlap
        // guards, reveals would be emitted floating above the slab.
        let wall_min = Point3::new(0.0, -0.15, 0.0);
        let wall_max = Point3::new(10.0, 0.15, 0.5);
        let open_min = Point3::new(4.0, -0.3, 1.0);
        let open_max = Point3::new(6.0, 0.3, 2.0);

        let mut mesh = Mesh::new();
        let dir = Vector3::new(0.0, 1.0, 0.0);
        generate_reveal_quads(&mut mesh, &open_min, &open_max, &wall_min, &wall_max, Some(&dir));

        assert_eq!(
            mesh.triangle_count(),
            0,
            "No reveals when opening lies outside sub-mesh on a cross-axis"
        );
    }

    #[test]
    fn test_reveals_clamp_to_wall_on_orthogonal_cross_axis() {
        // Sub-mesh Z extent is [0..2.0], but opening spans Z=[1.0..3.0] —
        // taller than the sub-mesh. The left/right reveals (cross-axis X)
        // must be clamped in Z to the sub-mesh bound, not the opening's.
        let wall_min = Point3::new(0.0, -0.15, 0.0);
        let wall_max = Point3::new(10.0, 0.15, 2.0);
        let open_min = Point3::new(4.0, -0.3, 1.0);
        let open_max = Point3::new(6.0, 0.3, 3.0);

        let mut mesh = Mesh::new();
        let dir = Vector3::new(0.0, 1.0, 0.0);
        generate_reveal_quads(&mut mesh, &open_min, &open_max, &wall_min, &wall_max, Some(&dir));

        for chunk in mesh.positions.chunks_exact(3) {
            let z = chunk[2] as f64;
            assert!(
                z >= -1e-3 && z <= 2.0 + 1e-3,
                "Reveal vertex Z={z} should stay within sub-mesh [0.0, 2.0]"
            );
        }
    }

    #[test]
    fn test_determine_extrusion_axis() {
        let wmin = Point3::new(0.0, 0.0, 0.0);
        let wmax = Point3::new(10.0, 0.3, 3.0);

        assert_eq!(
            determine_extrusion_axis(Some(&Vector3::new(1.0, 0.0, 0.0)), &wmin, &wmax),
            0
        );
        assert_eq!(
            determine_extrusion_axis(Some(&Vector3::new(0.0, 1.0, 0.0)), &wmin, &wmax),
            1
        );
        assert_eq!(
            determine_extrusion_axis(Some(&Vector3::new(0.0, 0.0, 1.0)), &wmin, &wmax),
            2
        );
        // Diagonal direction — picks dominant axis
        assert_eq!(
            determine_extrusion_axis(Some(&Vector3::new(0.7, 0.7, 0.0)), &wmin, &wmax),
            0 // X and Y tied, X wins via >=
        );
        // No direction → thinnest wall dim (Y=0.3)
        assert_eq!(
            determine_extrusion_axis(None, &wmin, &wmax),
            1
        );
    }
}
