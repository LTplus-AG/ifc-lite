// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Ordered owned surface-model faces before triangulation, including the
//! intentional per-face skipping and a terminal collection error. RTC stays
//! f64 until output narrowing.
//!
//! Source admission (loop reads, advanced-face tessellation) runs while
//! lowering, with its refusal reports captured per face. Evaluation replays
//! each face's reports and then triangulates, so the report order is the
//! authored face order, exactly as the single-pass walk produced it.

use super::super::advanced_face::note_face_refused;
use super::super::advanced_face::{capture_reports, process_advanced_face, FaceReports};
use super::super::helpers::FaceData;
use super::faceted::FacetedBrepProcessor;
use super::surface_model::{read_simple_face_bounds, trace_capped_face};
use crate::{Error, Mesh, Point3, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};

enum SurfaceFace {
    Simple {
        face_type: IfcType,
        outer: Vec<Point3<f64>>,
        holes: Vec<Vec<Point3<f64>>>,
    },
    /// The advanced face's tessellation or its refusal, kept for ordered replay.
    Advanced {
        face_id: u32,
        outcome: Result<(Vec<f32>, Vec<u32>)>,
    },
}

struct FaceEntry {
    face: Option<SurfaceFace>,
    source_reports: FaceReports,
}

pub(super) struct SurfaceModelPlan {
    faces: Vec<FaceEntry>,
    rtc_file_units: Option<(f64, f64, f64)>,
    // An invalid later collection must still return the original error after
    // earlier admitted faces have had their refusal diagnostics.
    terminal_collection_error: Option<String>,
}

/// Lower a surface model whose attribute 0 lists its face collections.
/// `collection_slot` is the attribute holding the collections; `names` is the (missing-attribute message, collection noun) for errors.
pub(super) fn lower(
    entity: &DecodedEntity,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
    rtc_file_units: Option<(f64, f64, f64)>,
    names: (&str, &str),
    collection_slot: usize,
) -> Result<SurfaceModelPlan> {
    let (missing_attribute, collection_noun) = names;
    let collections = entity
        .get(collection_slot)
        .ok_or_else(|| Error::geometry(missing_attribute.to_string()))?
        .as_list()
        .ok_or_else(|| Error::geometry(format!("Expected {collection_noun} list")))?;
    let mut plan = SurfaceModelPlan {
        faces: Vec::new(),
        rtc_file_units,
        terminal_collection_error: None,
    };
    for collection_ref in collections {
        let Some(collection_id) = collection_ref.as_entity_ref() else {
            plan.terminal_collection_error =
                Some(format!("Expected entity reference for {collection_noun}"));
            break;
        };
        // Face IDs straight from the collection's raw bytes (attribute 0)
        let Some(face_ids) = decoder.get_entity_ref_list_fast(collection_id) else {
            continue;
        };
        for face_id in face_ids {
            let (face, source_reports) =
                capture_reports(|| lower_entry(face_id, decoder, quality, rtc_file_units));
            plan.faces.push(FaceEntry {
                face,
                source_reports,
            });
        }
    }
    Ok(plan)
}

fn lower_entry(
    face_id: u32,
    decoder: &mut EntityDecoder,
    quality: TessellationQuality,
    rtc_file_units: Option<(f64, f64, f64)>,
) -> Option<SurfaceFace> {
    // Decode the face entity to check its type: some exporters use
    // IfcAdvancedFace here, which requires surface processing.
    let face = decoder.decode_by_id(face_id).ok()?;
    if face.ifc_type == IfcType::IfcAdvancedFace {
        // A capped B-spline curve EDGE (#4901) inside a still-OK face is
        // deliberately NOT drained here: the router owns the single
        // authoritative drain, and the captured report is replayed in order.
        return Some(SurfaceFace::Advanced {
            face_id,
            outcome: process_advanced_face(&face, decoder, quality, rtc_file_units),
        });
    }
    let bound_ids = decoder.get_entity_ref_list_fast(face_id)?;
    let (outer, holes) = read_simple_face_bounds(&face.ifc_type, bound_ids, decoder)?;
    let outer = outer.filter(|points| points.len() >= 3)?;
    Some(SurfaceFace::Simple {
        face_type: face.ifc_type,
        outer,
        holes,
    })
}

impl SurfaceModelPlan {
    pub(super) fn evaluate(self) -> Result<Mesh> {
        let mut all_positions = Vec::new();
        let mut all_indices = Vec::new();
        for entry in self.faces {
            entry.source_reports.restore();
            let Some(face) = entry.face else { continue };
            let (positions, indices) = match face {
                SurfaceFace::Simple {
                    face_type,
                    outer,
                    holes,
                } => {
                    // Triangulate through the shared FacetedBrep face
                    // triangulator (tri/quad fast paths, convexity test, and
                    // ear-clipping with hole support).
                    let face_data = FaceData {
                        outer_points: outer,
                        hole_points: holes,
                    };
                    let result = FacetedBrepProcessor::triangulate_face(
                        &face_data,
                        self.rtc_file_units.unwrap_or((0.0, 0.0, 0.0)),
                    );
                    if result.refused {
                        note_face_refused(&face_type);
                    }
                    (result.positions, result.indices)
                }
                SurfaceFace::Advanced { face_id, outcome } => match outcome {
                    Ok(result) => result,
                    Err(error) => {
                        trace_capped_face(face_id, &error);
                        continue;
                    }
                },
            };
            if !positions.is_empty() {
                let base_idx = (all_positions.len() / 3) as u32;
                all_positions.extend(positions);
                for index in indices {
                    all_indices.push(base_idx + index);
                }
            }
        }
        if let Some(error) = self.terminal_collection_error {
            return Err(Error::geometry(error));
        }
        Ok(Mesh {
            positions: all_positions,
            normals: Vec::new(),
            indices: all_indices,
            rtc_applied: self.rtc_file_units.is_some(),
            welded_in_object_frame: false,
            plane_tags: None,
            origin: [0.0; 3],
            instance_meta: None,
            local_bounds: None,
            local_to_world: None,
        })
    }
}

#[cfg(test)]
#[path = "surface_model_plan_tests.rs"]
mod tests;
