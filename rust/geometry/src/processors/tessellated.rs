// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tessellated geometry processors - pre-tessellated/polygon meshes.
//!
//! Handles IfcTriangulatedFaceSet (explicit triangle meshes) and
//! IfcPolygonalFaceSet (polygon meshes requiring triangulation).

use crate::{Error, Mesh, Result};
use ifc_lite_core::{AttributeValue, DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use crate::router::GeometryProcessor;

/// TriangulatedFaceSet processor (P0)
/// Handles IfcTriangulatedFaceSet - explicit triangle meshes
pub struct TriangulatedFaceSetProcessor;

impl TriangulatedFaceSetProcessor {
    pub fn new() -> Self {
        Self
    }
}

impl GeometryProcessor for TriangulatedFaceSetProcessor {
    #[inline]
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
    ) -> Result<Mesh> {
        // IfcTriangulatedFaceSet attributes:
        // 0: Coordinates (IfcCartesianPointList3D)
        // 1: Normals (optional)
        // 2: Closed (optional)
        // 3: CoordIndex (list of list of IfcPositiveInteger)

        // Get coordinate entity reference
        let coords_attr = entity.get(0).ok_or_else(|| {
            Error::geometry("TriangulatedFaceSet missing Coordinates".to_string())
        })?;

        let coord_entity_id = coords_attr.as_entity_ref().ok_or_else(|| {
            Error::geometry("Expected entity reference for Coordinates".to_string())
        })?;

        // FAST PATH: Try direct parsing of raw bytes (3-5x faster)
        // This bypasses Token/AttributeValue allocations entirely
        use ifc_lite_core::{extract_coordinate_list_from_entity, parse_indices_direct};

        let positions = if let Some(raw_bytes) = decoder.get_raw_bytes(coord_entity_id) {
            // Fast path: parse coordinates directly from raw bytes
            // Use extract_coordinate_list_from_entity to skip entity header (#N=IFCTYPE...)
            extract_coordinate_list_from_entity(raw_bytes).unwrap_or_default()
        } else {
            // Fallback path: use standard decoding
            let coords_entity = decoder.decode_by_id(coord_entity_id)?;

            let coord_list_attr = coords_entity.get(0).ok_or_else(|| {
                Error::geometry("CartesianPointList3D missing CoordList".to_string())
            })?;

            let coord_list = coord_list_attr
                .as_list()
                .ok_or_else(|| Error::geometry("Expected coordinate list".to_string()))?;

            use ifc_lite_core::AttributeValue;
            AttributeValue::parse_coordinate_list_3d(coord_list)
        };

        // Get face indices - try fast path first
        let indices_attr = entity
            .get(3)
            .ok_or_else(|| Error::geometry("TriangulatedFaceSet missing CoordIndex".to_string()))?;

        // For indices, we need to extract from the main entity's raw bytes
        // Fast path: parse directly if we can get the raw CoordIndex section
        let indices = if let Some(raw_entity_bytes) = decoder.get_raw_bytes(entity.id) {
            // Find the CoordIndex attribute (4th attribute, index 3)
            // and parse directly
            if let Some(coord_index_bytes) = super::extract_coord_index_bytes(raw_entity_bytes) {
                parse_indices_direct(coord_index_bytes)
            } else {
                // Fallback to standard parsing
                let face_list = indices_attr
                    .as_list()
                    .ok_or_else(|| Error::geometry("Expected face index list".to_string()))?;
                use ifc_lite_core::AttributeValue;
                AttributeValue::parse_index_list(face_list)
            }
        } else {
            let face_list = indices_attr
                .as_list()
                .ok_or_else(|| Error::geometry("Expected face index list".to_string()))?;
            use ifc_lite_core::AttributeValue;
            AttributeValue::parse_index_list(face_list)
        };

        // Create mesh (normals will be computed later)
        let mut mesh = Mesh {
            positions,
            normals: Vec::new(),
            indices,
            rtc_applied: false,
        };
        // Validate: IFC files (especially Revit exports) may have indices beyond vertex count
        mesh.validate_indices();
        Ok(mesh)
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcTriangulatedFaceSet]
    }
}

impl Default for TriangulatedFaceSetProcessor {
    fn default() -> Self {
        Self::new()
    }
}

/// Handles IfcPolygonalFaceSet - explicit polygon meshes that need triangulation
/// Unlike IfcTriangulatedFaceSet, faces can be arbitrary polygons (not just triangles)
pub struct PolygonalFaceSetProcessor;

impl PolygonalFaceSetProcessor {
    pub fn new() -> Self {
        Self
    }

    #[inline]
    fn parse_index_loop(indices: &[AttributeValue], pn_index: Option<&[u32]>) -> Vec<u32> {
        indices
            .iter()
            .filter_map(|value| {
                let idx = value.as_int()?;
                if idx <= 0 {
                    return None;
                }
                let idx = idx as usize;

                if let Some(remap) = pn_index {
                    remap.get(idx - 1).copied().filter(|mapped| *mapped > 0)
                } else {
                    Some(idx as u32)
                }
            })
            .collect()
    }

    /// Triangulate a polygon (optionally with holes) using ear-clipping (earcutr)
    /// This works correctly for both convex and concave polygons
    /// IFC indices are 1-based, so we subtract 1 to get 0-based indices
    /// positions is flattened [x0, y0, z0, x1, y1, z1, ...]
    fn triangulate_polygon(
        outer_indices: &[u32],
        inner_indices: &[Vec<u32>],
        positions: &[f32],
        output: &mut Vec<u32>,
    ) {
        if outer_indices.len() < 3 {
            return;
        }

        // Helper to get 3D position from flattened array
        let get_pos = |idx: u32| -> Option<(f32, f32, f32)> {
            if idx == 0 {
                return None;
            }
            let base = ((idx - 1) * 3) as usize;
            if base + 2 < positions.len() {
                Some((positions[base], positions[base + 1], positions[base + 2]))
            } else {
                None
            }
        };

        // Guard: empty outer_indices would panic on any [0] access below
        if outer_indices.is_empty() {
            return;
        }

        // For complex polygons (5+ vertices), use ear-clipping triangulation
        // This handles concave polygons correctly (like opening cutouts)

        // Extract 2D coordinates by projecting to best-fit plane
        // Find dominant normal direction to choose projection plane
        let mut sum_x = 0.0f64;
        let mut sum_y = 0.0f64;
        let mut sum_z = 0.0f64;

        // Calculate centroid-based normal approximation using Newell's method
        for i in 0..outer_indices.len() {
            let v0 = match get_pos(outer_indices[i]) {
                Some(p) => p,
                None => {
                    // Invalid vertex index — skip this polygon entirely.
                    // We cannot safely fan-triangulate with unresolvable vertices.
                    return;
                }
            };
            let v1 = match get_pos(outer_indices[(i + 1) % outer_indices.len()]) {
                Some(p) => p,
                None => {
                    return;
                }
            };

            sum_x += (v0.1 - v1.1) as f64 * (v0.2 + v1.2) as f64;
            sum_y += (v0.2 - v1.2) as f64 * (v0.0 + v1.0) as f64;
            sum_z += (v0.0 - v1.0) as f64 * (v0.1 + v1.1) as f64;
        }
        let expected_normal = (sum_x, sum_y, sum_z);

        let mut push_oriented_triangle = |a: u32, b: u32, c: u32| {
            if a == 0 || b == 0 || c == 0 {
                return;
            }
            let i0 = a - 1;
            let mut i1 = b - 1;
            let mut i2 = c - 1;

            if expected_normal.0.abs() + expected_normal.1.abs() + expected_normal.2.abs() > 1e-12 {
                if let (Some(p0), Some(p1), Some(p2)) = (get_pos(a), get_pos(b), get_pos(c)) {
                    let e1 = (
                        (p1.0 - p0.0) as f64,
                        (p1.1 - p0.1) as f64,
                        (p1.2 - p0.2) as f64,
                    );
                    let e2 = (
                        (p2.0 - p0.0) as f64,
                        (p2.1 - p0.1) as f64,
                        (p2.2 - p0.2) as f64,
                    );
                    let tri_normal = (
                        e1.1 * e2.2 - e1.2 * e2.1,
                        e1.2 * e2.0 - e1.0 * e2.2,
                        e1.0 * e2.1 - e1.1 * e2.0,
                    );
                    let dot = tri_normal.0 * expected_normal.0
                        + tri_normal.1 * expected_normal.1
                        + tri_normal.2 * expected_normal.2;
                    if dot < 0.0 {
                        std::mem::swap(&mut i1, &mut i2);
                    }
                }
            }

            output.push(i0);
            output.push(i1);
            output.push(i2);
        };

        // For triangles, no triangulation needed (but still enforce orientation)
        if inner_indices.is_empty() && outer_indices.len() == 3 {
            push_oriented_triangle(outer_indices[0], outer_indices[1], outer_indices[2]);
            return;
        }

        // For quads, use fan triangulation with orientation correction
        if inner_indices.is_empty() && outer_indices.len() == 4 {
            push_oriented_triangle(outer_indices[0], outer_indices[1], outer_indices[2]);
            push_oriented_triangle(outer_indices[0], outer_indices[2], outer_indices[3]);
            return;
        }

        // Choose projection plane based on dominant axis
        let abs_x = sum_x.abs();
        let abs_y = sum_y.abs();
        let abs_z = sum_z.abs();

        let valid_holes: Vec<&[u32]> = inner_indices
            .iter()
            .filter(|loop_indices| loop_indices.len() >= 3)
            .map(|loop_indices| loop_indices.as_slice())
            .collect();

        // Flatten all loops for earcut (outer ring first, then holes)
        let total_vertices = outer_indices.len()
            + valid_holes
                .iter()
                .map(|loop_indices| loop_indices.len())
                .sum::<usize>();
        let mut coords_2d: Vec<f64> = Vec::with_capacity(total_vertices * 2);
        let mut flattened_indices: Vec<u32> = Vec::with_capacity(total_vertices);
        let mut hole_starts: Vec<usize> = Vec::with_capacity(valid_holes.len());

        for &idx in outer_indices {
            let Some(p) = get_pos(idx) else {
                // Invalid vertex — skip polygon (fan-triangulate would include bad vertices)
                return;
            };
            flattened_indices.push(idx);

            // Project to 2D based on dominant normal axis
            if abs_z >= abs_x && abs_z >= abs_y {
                // XY plane (Z is dominant)
                coords_2d.push(p.0 as f64);
                coords_2d.push(p.1 as f64);
            } else if abs_y >= abs_x {
                // XZ plane (Y is dominant)
                coords_2d.push(p.0 as f64);
                coords_2d.push(p.2 as f64);
            } else {
                // YZ plane (X is dominant)
                coords_2d.push(p.1 as f64);
                coords_2d.push(p.2 as f64);
            }
        }

        for hole in valid_holes {
            hole_starts.push(flattened_indices.len());
            for &idx in hole {
                let Some(p) = get_pos(idx) else {
                    // Invalid hole vertex — skip polygon
                    return;
                };
                flattened_indices.push(idx);

                // Project to 2D based on dominant normal axis
                if abs_z >= abs_x && abs_z >= abs_y {
                    // XY plane (Z is dominant)
                    coords_2d.push(p.0 as f64);
                    coords_2d.push(p.1 as f64);
                } else if abs_y >= abs_x {
                    // XZ plane (Y is dominant)
                    coords_2d.push(p.0 as f64);
                    coords_2d.push(p.2 as f64);
                } else {
                    // YZ plane (X is dominant)
                    coords_2d.push(p.1 as f64);
                    coords_2d.push(p.2 as f64);
                }
            }
        }

        if flattened_indices.len() < 3 {
            return;
        }

        // Run ear-clipping triangulation
        match earcutr::earcut(&coords_2d, &hole_starts, 2) {
            Ok(tri_indices) => {
                for tri in tri_indices.chunks(3) {
                    if tri.len() != 3
                        || tri[0] >= flattened_indices.len()
                        || tri[1] >= flattened_indices.len()
                        || tri[2] >= flattened_indices.len()
                    {
                        continue;
                    }
                    push_oriented_triangle(
                        flattened_indices[tri[0]],
                        flattened_indices[tri[1]],
                        flattened_indices[tri[2]],
                    );
                }
            }
            Err(_) => {
                // Fallback to fan triangulation on the outer loop
                let first = outer_indices[0];
                for i in 1..outer_indices.len() - 1 {
                    push_oriented_triangle(first, outer_indices[i], outer_indices[i + 1]);
                }
            }
        }
    }

    #[inline]
    fn parse_face_inner_indices(
        face_entity: &DecodedEntity,
        pn_index: Option<&[u32]>,
    ) -> Vec<Vec<u32>> {
        if face_entity.ifc_type != IfcType::IfcIndexedPolygonalFaceWithVoids {
            return Vec::new();
        }

        let Some(inner_attr) = face_entity.get(1).and_then(|a| a.as_list()) else {
            return Vec::new();
        };

        let mut result = Vec::with_capacity(inner_attr.len());
        for loop_attr in inner_attr {
            let Some(loop_values) = loop_attr.as_list() else {
                continue;
            };
            let parsed = Self::parse_index_loop(loop_values, pn_index);
            if parsed.len() >= 3 {
                result.push(parsed);
            }
        }

        result
    }

    #[inline]
    fn orient_closed_shell_outward(positions: &[f32], indices: &mut [u32]) {
        if indices.len() < 3 || positions.len() < 9 {
            return;
        }

        let vertex_count = positions.len() / 3;
        if vertex_count == 0 {
            return;
        }

        // Mesh centroid
        let mut cx = 0.0f64;
        let mut cy = 0.0f64;
        let mut cz = 0.0f64;
        for p in positions.chunks_exact(3) {
            cx += p[0] as f64;
            cy += p[1] as f64;
            cz += p[2] as f64;
        }
        let inv_n = 1.0 / vertex_count as f64;
        cx *= inv_n;
        cy *= inv_n;
        cz *= inv_n;

        let mut sign_accum = 0.0f64;
        for tri in indices.chunks_exact(3) {
            let i0 = tri[0] as usize;
            let i1 = tri[1] as usize;
            let i2 = tri[2] as usize;
            if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
                continue;
            }

            let p0 = (
                positions[i0 * 3] as f64,
                positions[i0 * 3 + 1] as f64,
                positions[i0 * 3 + 2] as f64,
            );
            let p1 = (
                positions[i1 * 3] as f64,
                positions[i1 * 3 + 1] as f64,
                positions[i1 * 3 + 2] as f64,
            );
            let p2 = (
                positions[i2 * 3] as f64,
                positions[i2 * 3 + 1] as f64,
                positions[i2 * 3 + 2] as f64,
            );

            let e1 = (p1.0 - p0.0, p1.1 - p0.1, p1.2 - p0.2);
            let e2 = (p2.0 - p0.0, p2.1 - p0.1, p2.2 - p0.2);
            let n = (
                e1.1 * e2.2 - e1.2 * e2.1,
                e1.2 * e2.0 - e1.0 * e2.2,
                e1.0 * e2.1 - e1.1 * e2.0,
            );

            let tc = (
                (p0.0 + p1.0 + p2.0) / 3.0,
                (p0.1 + p1.1 + p2.1) / 3.0,
                (p0.2 + p1.2 + p2.2) / 3.0,
            );
            let out = (tc.0 - cx, tc.1 - cy, tc.2 - cz);
            sign_accum += n.0 * out.0 + n.1 * out.1 + n.2 * out.2;
        }

        // If most triangles point inward, flip all winding.
        if sign_accum < 0.0 {
            for tri in indices.chunks_exact_mut(3) {
                tri.swap(1, 2);
            }
        }
    }

    #[inline]
    fn build_flat_shaded_mesh(positions: &[f32], indices: &[u32]) -> Mesh {
        let mut flat_positions: Vec<f32> = Vec::with_capacity(indices.len() * 3);
        let mut flat_normals: Vec<f32> = Vec::with_capacity(indices.len() * 3);
        let mut flat_indices: Vec<u32> = Vec::with_capacity(indices.len());

        let vertex_count = positions.len() / 3;
        let mut next_index: u32 = 0;

        for tri in indices.chunks_exact(3) {
            let i0 = tri[0] as usize;
            let i1 = tri[1] as usize;
            let i2 = tri[2] as usize;
            if i0 >= vertex_count || i1 >= vertex_count || i2 >= vertex_count {
                continue;
            }

            let p0 = (
                positions[i0 * 3] as f64,
                positions[i0 * 3 + 1] as f64,
                positions[i0 * 3 + 2] as f64,
            );
            let p1 = (
                positions[i1 * 3] as f64,
                positions[i1 * 3 + 1] as f64,
                positions[i1 * 3 + 2] as f64,
            );
            let p2 = (
                positions[i2 * 3] as f64,
                positions[i2 * 3 + 1] as f64,
                positions[i2 * 3 + 2] as f64,
            );

            let e1 = (p1.0 - p0.0, p1.1 - p0.1, p1.2 - p0.2);
            let e2 = (p2.0 - p0.0, p2.1 - p0.1, p2.2 - p0.2);
            let nx = e1.1 * e2.2 - e1.2 * e2.1;
            let ny = e1.2 * e2.0 - e1.0 * e2.2;
            let nz = e1.0 * e2.1 - e1.1 * e2.0;
            let len = (nx * nx + ny * ny + nz * nz).sqrt();
            let (nx, ny, nz) = if len > 1e-12 {
                (nx / len, ny / len, nz / len)
            } else {
                (0.0, 0.0, 1.0)
            };

            for &idx in &[i0, i1, i2] {
                flat_positions.push(positions[idx * 3]);
                flat_positions.push(positions[idx * 3 + 1]);
                flat_positions.push(positions[idx * 3 + 2]);
                flat_normals.push(nx as f32);
                flat_normals.push(ny as f32);
                flat_normals.push(nz as f32);
                flat_indices.push(next_index);
                next_index += 1;
            }
        }

        Mesh {
            positions: flat_positions,
            normals: flat_normals,
            indices: flat_indices,
            rtc_applied: false,
        }
    }
}

impl GeometryProcessor for PolygonalFaceSetProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
    ) -> Result<Mesh> {
        // IfcPolygonalFaceSet attributes:
        // 0: Coordinates (IfcCartesianPointList3D)
        // 1: Closed (optional BOOLEAN)
        // 2: Faces (LIST of IfcIndexedPolygonalFace)
        // 3: PnIndex (optional - point index remapping)

        // Get coordinate entity reference
        let coords_attr = entity
            .get(0)
            .ok_or_else(|| Error::geometry("PolygonalFaceSet missing Coordinates".to_string()))?;

        let coord_entity_id = coords_attr.as_entity_ref().ok_or_else(|| {
            Error::geometry("Expected entity reference for Coordinates".to_string())
        })?;

        // Parse coordinates - try fast path first
        use ifc_lite_core::extract_coordinate_list_from_entity;

        let positions = if let Some(raw_bytes) = decoder.get_raw_bytes(coord_entity_id) {
            extract_coordinate_list_from_entity(raw_bytes).unwrap_or_default()
        } else {
            // Fallback path
            let coords_entity = decoder.decode_by_id(coord_entity_id)?;
            let coord_list_attr = coords_entity.get(0).ok_or_else(|| {
                Error::geometry("CartesianPointList3D missing CoordList".to_string())
            })?;
            let coord_list = coord_list_attr
                .as_list()
                .ok_or_else(|| Error::geometry("Expected coordinate list".to_string()))?;
            AttributeValue::parse_coordinate_list_3d(coord_list)
        };

        if positions.is_empty() {
            return Ok(Mesh::new());
        }

        // Get faces list (attribute 2)
        let faces_attr = entity
            .get(2)
            .ok_or_else(|| Error::geometry("PolygonalFaceSet missing Faces".to_string()))?;

        let face_refs = faces_attr
            .as_list()
            .ok_or_else(|| Error::geometry("Expected faces list".to_string()))?;

        // Optional point remapping list for IfcPolygonalFaceSet.
        // CoordIndex values refer to this list when present.
        let pn_index = entity.get(3).and_then(|attr| attr.as_list()).map(|list| {
            list.iter()
                .filter_map(|value| value.as_int())
                .filter(|v| *v > 0)
                .map(|v| v as u32)
                .collect::<Vec<u32>>()
        });

        // Pre-allocate indices - estimate 2 triangles per face average
        let mut indices = Vec::with_capacity(face_refs.len() * 6);

        // Process each face
        for face_ref in face_refs {
            let face_id = face_ref
                .as_entity_ref()
                .ok_or_else(|| Error::geometry("Expected entity reference for face".to_string()))?;

            let face_entity = decoder.decode_by_id(face_id)?;

            // IfcIndexedPolygonalFace has CoordIndex at attribute 0
            // IfcIndexedPolygonalFaceWithVoids has CoordIndex at 0 and InnerCoordIndices at 1
            let coord_index_attr = face_entity.get(0).ok_or_else(|| {
                Error::geometry("IndexedPolygonalFace missing CoordIndex".to_string())
            })?;

            let coord_indices = coord_index_attr
                .as_list()
                .ok_or_else(|| Error::geometry("Expected coord index list".to_string()))?;

            // Parse face indices (1-based in IFC), with optional PnIndex remapping.
            let face_indices = Self::parse_index_loop(coord_indices, pn_index.as_deref());
            if face_indices.len() < 3 {
                continue;
            }

            // Parse optional inner loops for IfcIndexedPolygonalFaceWithVoids.
            let inner_indices = Self::parse_face_inner_indices(&face_entity, pn_index.as_deref());

            // Triangulate the polygon face (including holes when present).
            Self::triangulate_polygon(&face_indices, &inner_indices, &positions, &mut indices);
        }

        // Closed shells from some exporters may be consistently inward.
        // Flip globally to outward winding when needed.
        let is_closed = entity
            .get(1)
            .and_then(|a| a.as_enum())
            .map(|v| v == "T")
            .unwrap_or(false);
        if is_closed {
            Self::orient_closed_shell_outward(&positions, &mut indices);
        }

        Ok(Self::build_flat_shaded_mesh(&positions, &indices))
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcPolygonalFaceSet]
    }
}

impl Default for PolygonalFaceSetProcessor {
    fn default() -> Self {
        Self::new()
    }
}
