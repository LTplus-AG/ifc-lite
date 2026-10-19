// SPDX-License-Identifier: MPL-2.0
//! Owned f64 face loops before planar triangulation. Only the inherited Outer
//! shell is lowered, preserving current faceted-with-voids production semantics.
//! Loop admission/refusals stay in lowering; triangulation refusals are emitted
//! on the evaluating thread. RTC is removed before f32 output narrowing.
use super::super::advanced_face::note_face_refused;
use super::super::helpers::{read_loop_points_by_id, FaceData, FaceResult};
use super::faceted::FacetedBrepProcessor;
use crate::{Error, Mesh, Point3, Result};
use ifc_lite_core::{slot, DecodedEntity, EntityDecoder, IfcType};

/// Minimum face count at which parallel (rayon) triangulation pays off. Below
/// this, the fork-join dispatch overhead exceeds the work — real-world BReps are
/// overwhelmingly tiny (6–50 faces of trivial tri/quad/convex fast-path geometry),
/// so dispatching each tiny shell through rayon costs far more than it saves
/// (worse under the per-element worker pool, where this is nested parallelism).
/// The serial and parallel paths produce byte-identical output: `collect`
/// preserves index order and each face's f32 result is computed identically.
const PAR_FACE_THRESHOLD: usize = 64;

pub(crate) struct FacetedBrepPlan {
    faces: Vec<FaceData>,
    rtc_file_units: Option<(f64, f64, f64)>,
}
impl Clone for FacetedBrepPlan {
    fn clone(&self) -> Self {
        Self {
            faces: self
                .faces
                .iter()
                .map(|face| FaceData {
                    outer_points: face.outer_points.clone(),
                    hole_points: face.hole_points.clone(),
                })
                .collect(),
            rtc_file_units: self.rtc_file_units,
        }
    }
}
impl std::fmt::Debug for FacetedBrepPlan {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("FacetedBrepPlan")
            .field("faces", &self.faces.len())
            .field("rtc_file_units", &self.rtc_file_units)
            .finish()
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

/// Own the production cached-loop decode result without retaining a decoder or
/// pre-triangulated Mesh. Malformed bounds preserve their original refusal path.
pub(crate) fn lower(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    rtc_file_units: Option<(f64, f64, f64)>,
) -> Result<FacetedBrepPlan> {
    // IfcFacetedBrep attributes:
    // 0: Outer (IfcClosedShell)
    let shell_attr = entity
        .attr(slot::IfcFacetedBrep::OUTER)
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
            let mut points = match extract_loop_points_fast(loop_id, decoder) {
                Some(p) => p,
                // A loop point refused by input admission fails the whole
                // brep, counted, instead of opening the shell (#7678);
                // a genuinely corrupt loop is still skipped, as before.
                None => match decoder.polyloop_refusal(loop_id) {
                    Some(refused) => return Err(refused.into()),
                    None => continue,
                },
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
            note_face_refused(&IfcType::IfcFace);
            continue;
        }
        if let Some(outer_points) = outer_bound_points {
            face_data_list.push(FaceData {
                outer_points,
                hole_points,
            });
        }
    }

    Ok(FacetedBrepPlan {
        faces: face_data_list,
        rtc_file_units,
    })
}

impl FacetedBrepPlan {
    pub(crate) fn evaluate(self) -> Mesh {
        use rayon::prelude::*;
        let face_data_list = self.faces;
        let rtc_file_units = self.rtc_file_units;
        // PHASE 2: Triangulate all faces (serial below PAR_FACE_THRESHOLD to
        // avoid rayon fork-join overhead; both orders are byte-identical).
        let rtc = rtc_file_units.unwrap_or((0.0, 0.0, 0.0));
        let face_results: Vec<FaceResult> = if face_data_list.len() < PAR_FACE_THRESHOLD {
            face_data_list
                .iter()
                .map(|face| FacetedBrepProcessor::triangulate_face(face, rtc))
                .collect()
        } else {
            face_data_list
                .par_iter()
                .map(|face| FacetedBrepProcessor::triangulate_face(face, rtc))
                .collect()
        };

        // PHASE 3: Sequential - Merge all face results into final mesh
        let total_positions: usize = face_results.iter().map(|r| r.positions.len()).sum();
        let total_indices: usize = face_results.iter().map(|r| r.indices.len()).sum();
        let mut positions = Vec::with_capacity(total_positions);
        let mut indices = Vec::with_capacity(total_indices);
        for result in face_results {
            if result.refused {
                note_face_refused(&IfcType::IfcFace);
            }
            let base_idx = (positions.len() / 3) as u32;
            positions.extend(result.positions);
            for idx in result.indices {
                indices.push(base_idx + idx);
            }
        }

        Mesh {
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
        }
    }
}

#[cfg(test)]
#[path = "faceted_plan_tests.rs"]
mod tests;
