// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use crate::{Error, Mesh, Point3, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};

use super::super::advanced_face::note_face_refused;
use super::super::helpers::{push_rebased, read_loop_points_by_id, FaceData, FaceResult};
use crate::router::GeometryProcessor;

/// Minimum face count at which parallel (rayon) triangulation pays off. Below
/// this, the fork-join dispatch overhead exceeds the work — real-world BReps are
/// overwhelmingly tiny (6–50 faces of trivial tri/quad/convex fast-path geometry),
/// so dispatching each tiny shell through rayon costs far more than it saves
/// (worse under the per-element worker pool, where this is nested parallelism).
/// The serial and parallel paths produce byte-identical output: `collect`
/// preserves index order and each face's f32 result is computed identically.
const PAR_FACE_THRESHOLD: usize = 64;

// ---------- FacetedBrepProcessor ----------

/// FacetedBrep processor
/// Handles IfcFacetedBrep - explicit mesh with faces
/// Supports faces with inner bounds (holes)
/// Uses parallel triangulation for large BREPs
pub struct FacetedBrepProcessor;

impl FacetedBrepProcessor {
    pub fn new() -> Self {
        Self
    }

    /// Extract polygon points from a loop entity
    /// Uses fast path for CartesianPoint extraction to avoid decode overhead
    #[allow(dead_code)]
    #[inline]
    fn extract_loop_points(
        &self,
        loop_entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<Vec<Point3<f64>>> {
        // Try to get Polygon attribute (attribute 0) - IfcPolyLoop has this
        let polygon_attr = loop_entity.get(0)?;

        // Get the list of point references directly
        let point_refs = polygon_attr.as_list()?;

        // Pre-allocate with known size
        let mut polygon_points = Vec::with_capacity(point_refs.len());

        for point_ref in point_refs {
            let point_id = point_ref.as_entity_ref()?;

            // Try fast path first
            if let Some((x, y, z)) = decoder.get_cartesian_point_fast(point_id) {
                polygon_points.push(Point3::new(x, y, z));
            } else {
                // Fallback to standard path if fast extraction fails
                let point = decoder.decode_by_id(point_id).ok()?;
                let coords_attr = point.get(0)?;
                let coords = coords_attr.as_list()?;
                use ifc_lite_core::AttributeValue;
                let x = coords.first().and_then(|v: &AttributeValue| v.as_float())?;
                let y = coords.get(1).and_then(|v: &AttributeValue| v.as_float())?;
                let z = coords.get(2).and_then(|v: &AttributeValue| v.as_float())?;
                polygon_points.push(Point3::new(x, y, z));
            }
        }

        if polygon_points.len() >= 3 {
            Some(polygon_points)
        } else {
            None
        }
    }

    /// Extract polygon points using ultra-fast path from loop entity ID
    /// Uses cached coordinate extraction - points are cached across faces
    /// This is the fastest path for files with shared cartesian points
    ///
    /// `None` means the loop does not read; a loop of under three points
    /// reads and is returned as is, for the caller to skip (#7686, D14).
    #[inline]
    fn extract_loop_points_fast(
        &self,
        loop_entity_id: u32,
        decoder: &mut EntityDecoder,
    ) -> Option<Vec<Point3<f64>>> {
        // ULTRA-FAST PATH with CACHING: Get coordinates with point cache
        // Many faces share the same cartesian points, so caching avoids
        // re-parsing the same point data multiple times
        let Some(coords) = decoder.get_polyloop_coords_cached(loop_entity_id) else {
            // The cached reader also returns `None` for a loop of under three
            // points. Re-read on this failure path only, so a degenerate loop
            // is told apart from one that does not read (#7686, D14).
            return read_loop_points_by_id(loop_entity_id, decoder).filter(|p| p.len() < 3);
        };

        // Convert to Point3 - pre-allocated in get_polyloop_coords_cached
        let polygon_points: Vec<Point3<f64>> = coords
            .into_iter()
            .map(|(x, y, z)| Point3::new(x, y, z))
            .collect();

        Some(polygon_points)
    }

    /// Triangulate a single face (can be called in parallel)
    /// Optimized with fast paths for simple faces.
    ///
    /// `rtc`: RTC offset subtracted from f64 coordinates BEFORE f32 conversion.
    /// For infrastructure models with world-space coordinates (e.g. Y ≈ 6.2M),
    /// f32 only has ~0.5m precision. Subtracting RTC in f64 first brings
    /// values near origin where f32 has sub-mm precision, eliminating jitter.
    #[inline]
    pub(super) fn triangulate_face(face: &FaceData, rtc: (f64, f64, f64)) -> FaceResult {
        use crate::triangulation::{calculate_polygon_normal, quad_split_3d, triangulate_planar_face};
        let n = face.outer_points.len();
        let mut positions = Vec::with_capacity(n * 3);

        // FAST PATH: triangle, or convex polygon of up to 8 corners, without
        // holes: a fan, no triangulation needed. A quad takes the interior
        // diagonal (a concave quad's `0-2` split lies outside the ring,
        // #7686 GEOM-3 / PROC-S10).
        if face.hole_points.is_empty() && (3..=8).contains(&n) {
            let fan = |n: usize| -> Vec<u32> {
                (1..n as u32 - 1).flat_map(|i| [0, i, i + 1]).collect()
            };
            let indices = match n {
                3 => Some(vec![0, 1, 2]),
                4 => Some(quad_split_3d(&face.outer_points).to_vec()),
                _ => Self::is_convex_3d(&face.outer_points, &calculate_polygon_normal(&face.outer_points))
                    .then(|| fan(n)),
            };
            if let Some(indices) = indices {
                push_rebased(&mut positions, &face.outer_points, rtc);
                return FaceResult { positions, indices, refused: false };
            }
        }

        // SLOW PATH: complex polygon or polygon with holes. A failed holed
        // triangulation refuses the face; it is never filled over its
        // authored openings (#7686 PROC-S5).
        let Ok(indices) = triangulate_planar_face(&face.outer_points, &face.hole_points) else {
            return FaceResult { positions: Vec::new(), indices: Vec::new(), refused: true };
        };
        let all_points = face.outer_points.iter().chain(face.hole_points.iter().flatten());
        push_rebased(&mut positions, all_points, rtc);
        FaceResult { positions, indices, refused: false }
    }

    /// Whether every corner of the ring turns the same way about `normal`.
    #[inline]
    fn is_convex_3d(ring: &[Point3<f64>], normal: &nalgebra::Vector3<f64>) -> bool {
        let n = ring.len();
        let mut sign = 0i8;
        for i in 0..n {
            let (p0, p1, p2) = (&ring[i], &ring[(i + 1) % n], &ring[(i + 2) % n]);
            let dot = (p1 - p0).cross(&(p2 - p1)).dot(normal);
            if dot.abs() > 1e-10 {
                let current_sign = if dot > 0.0 { 1i8 } else { -1i8 };
                if sign == 0 {
                    sign = current_sign;
                } else if sign != current_sign {
                    return false;
                }
            }
        }
        true
    }
}

impl FacetedBrepProcessor {
    /// Mesh the Brep. With `rtc_file_units`, the offset is subtracted from the
    /// f64 loop coordinates during f32 conversion, preserving sub-centimetre
    /// detail at national-grid magnitudes (e.g. Y ≈ 6.2M metres).
    fn process_rebased(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        rtc_file_units: Option<(f64, f64, f64)>,
    ) -> Result<Mesh> {
        use rayon::prelude::*;

        // IfcFacetedBrep attributes:
        // 0: Outer (IfcClosedShell)
        let shell_attr = entity
            .get(0)
            .ok_or_else(|| Error::geometry("FacetedBrep missing Outer shell".to_string()))?;
        let shell_id = shell_attr
            .as_entity_ref()
            .ok_or_else(|| Error::geometry("Expected entity ref for Outer shell".to_string()))?;

        // FAST PATH: Get face IDs directly from ClosedShell raw bytes
        let face_ids = decoder
            .get_entity_ref_list_fast(shell_id)
            .ok_or_else(|| Error::geometry("Failed to get faces from ClosedShell".to_string()))?;

        // PHASE 1: Sequential - Extract all face data from IFC entities
        let mut face_data_list: Vec<FaceData> = Vec::with_capacity(face_ids.len());
        for face_id in face_ids {
            // FAST PATH: Get bound IDs directly from Face raw bytes
            let bound_ids = match decoder.get_entity_ref_list_fast(face_id) {
                Some(ids) => ids,
                None => continue,
            };

            // Separate outer bound from inner bounds (holes)
            let bound_count = bound_ids.len();
            let mut degenerate = 0usize;
            let mut outer_bound_points: Option<Vec<Point3<f64>>> = None;
            let mut hole_points: Vec<Vec<Point3<f64>>> = Vec::new();
            for bound_id in bound_ids {
                // (loop_id, orientation, is_outer) straight from raw bytes
                let (loop_id, orientation, is_outer) = match decoder.get_face_bound_fast(bound_id) {
                    Some(data) => data,
                    None => continue,
                };
                let mut points = match self.extract_loop_points_fast(loop_id, decoder) {
                    Some(p) => p,
                    None => continue,
                };
                // Readable but under three points: degenerate, skipped.
                if points.len() < 3 {
                    degenerate += 1;
                    continue;
                }
                if !orientation {
                    points.reverse();
                }
                if is_outer || outer_bound_points.is_none() {
                    if outer_bound_points.is_some() && is_outer {
                        if let Some(prev_outer) = outer_bound_points.take() {
                            hole_points.push(prev_outer);
                        }
                    }
                    outer_bound_points = Some(points);
                } else {
                    hole_points.push(points);
                }
            }
            // A bound that does not read (D14, under D3) refuses the face:
            // dropping a hole drew it filled, dropping the outer bound let a
            // hole become the outline. Read bounds are the outer one, the
            // holes (a demoted outer is among them) and the degenerate ones.
            let read = hole_points.len() + usize::from(outer_bound_points.is_some()) + degenerate;
            if read < bound_count {
                note_face_refused();
                continue;
            }
            if let Some(outer_points) = outer_bound_points {
                face_data_list.push(FaceData {
                    outer_points,
                    hole_points,
                });
            }
        }

        // PHASE 2: Triangulate all faces (serial below PAR_FACE_THRESHOLD to
        // avoid rayon fork-join overhead; both orders are byte-identical).
        let rtc = rtc_file_units.unwrap_or((0.0, 0.0, 0.0));
        let face_results: Vec<FaceResult> = if face_data_list.len() < PAR_FACE_THRESHOLD {
            face_data_list
                .iter()
                .map(|face| Self::triangulate_face(face, rtc))
                .collect()
        } else {
            face_data_list
                .par_iter()
                .map(|face| Self::triangulate_face(face, rtc))
                .collect()
        };

        // PHASE 3: Sequential - Merge all face results into final mesh
        let total_positions: usize = face_results.iter().map(|r| r.positions.len()).sum();
        let total_indices: usize = face_results.iter().map(|r| r.indices.len()).sum();
        let mut positions = Vec::with_capacity(total_positions);
        let mut indices = Vec::with_capacity(total_indices);
        for result in face_results {
            if result.refused {
                note_face_refused();
            }
            let base_idx = (positions.len() / 3) as u32;
            positions.extend(result.positions);
            for idx in result.indices {
                indices.push(base_idx + idx);
            }
        }

        Ok(Mesh {
            positions,
            normals: Vec::new(),
            indices,
            rtc_applied: rtc_file_units.is_some(),
            origin: [0.0; 3],
            instance_meta: None,
            local_bounds: None,
            local_to_world: None,
            welded_in_object_frame: false,
            plane_tags: None,
        })
    }
}

impl FacetedBrepProcessor {
    /// Mesh the Brep rebased by `rtc` (file units) before f32 narrowing; the
    /// same work as [`GeometryProcessor::process_in_rtc_frame`].
    pub fn process_with_rtc(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        rtc: (f64, f64, f64),
    ) -> Result<Mesh> {
        self.process_rebased(entity, decoder, Some(rtc))
    }
}

impl GeometryProcessor for FacetedBrepProcessor {
    fn process(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        _schema: &IfcSchema,
        _quality: TessellationQuality,
    ) -> Result<Mesh> {
        self.process_rebased(entity, decoder, None)
    }

    fn process_in_rtc_frame(
        &self,
        entity: &DecodedEntity,
        decoder: &mut EntityDecoder,
        schema: &IfcSchema,
        _quality: TessellationQuality,
        rtc_file_units: (f64, f64, f64),
    ) -> Option<Result<Mesh>> {
        Some(self.process_with_rtc(entity, decoder, schema, rtc_file_units))
    }

    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcFacetedBrep]
    }
}

impl Default for FacetedBrepProcessor {
    fn default() -> Self {
        Self::new()
    }
}
